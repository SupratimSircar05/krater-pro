import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent.js";
import type {
  AgentEvent,
  AssistantTurn,
  ChatProvider,
  ModelMessage,
  ToolDefinition,
} from "./types.js";

interface ScriptedTurn {
  turn: AssistantTurn;
  textChunks?: string[];
}

class FakeProvider implements ChatProvider {
  readonly calls: ModelMessage[][] = [];

  constructor(private readonly scripted: ScriptedTurn[]) {}

  async complete(
    messages: ModelMessage[],
    _tools: ToolDefinition[],
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn> {
    if (signal?.aborted) throw new Error("Request cancelled.");
    this.calls.push(structuredClone(messages));
    const next = this.scripted.shift();
    if (!next) throw new Error("Fake provider ran out of scripted turns.");
    for (const chunk of next.textChunks ?? []) onText(chunk);
    return structuredClone(next.turn);
  }

  async listModels(): Promise<Array<{ id: string; ownedBy?: string }>> {
    return [];
  }
}

function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown> | string,
): ScriptedTurn {
  return {
    turn: {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name,
              arguments: typeof args === "string" ? args : JSON.stringify(args),
            },
          },
        ],
      },
    },
  };
}

function finalTurn(text = "Finished."): ScriptedTurn {
  return {
    textChunks: [text],
    turn: {
      message: { role: "assistant", content: text },
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    },
  };
}

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-agent-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentSession tool loop", () => {
  it("executes a read-only tool without approval and feeds its result to the next turn", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "hello\nworld\n");
    const provider = new FakeProvider([
      toolTurn("read-1", "read_file", { path: "note.txt" }),
      finalTurn("The file says hello."),
    ]);
    const requestApproval = vi.fn(async () => true);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Read the note");

    expect(requestApproval).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0][0]).toMatchObject({ role: "system" });
    expect(provider.calls[0][0].content).toContain(
      `Workspace name: ${cwd.split("/").at(-1)}`,
    );
    expect(provider.calls[0][0].content).not.toContain(cwd);
    expect(provider.calls[0][0].content).toContain("AGENTS.md and CLAUDE.md");
    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "read-1",
      content: "    1 | hello\n    2 | world\n    3 | ",
    });
    expect(events).toContainEqual({
      type: "tool",
      id: "read-1",
      name: "read_file",
      args: { path: "note.txt" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "read-1",
        ok: true,
      }),
    );
    expect(events).toContainEqual({ type: "text", text: "The file says hello." });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        sessionTotalTokens: 12,
        requestCount: 1,
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done", steps: 2 });
  });

  it("emits an approval request and does not mutate when approval is denied", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("write-1", "write_file", {
        path: "denied.txt",
        content: "must not be written",
      }),
      finalTurn(),
    ]);
    const requestApproval = vi.fn(async () => false);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Write a file");

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      toolCallId: "write-1",
      tool: "write_file",
      args: { path: "denied.txt", content: "must not be written" },
      reason: expect.stringContaining("must not be written"),
    });
    await expect(stat(join(cwd, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "write-1",
      content: "User denied this action. Do not retry it without a different request.",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        toolCallId: "write-1",
        tool: "write_file",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "write-1",
        ok: false,
        output: expect.stringContaining("User denied"),
      }),
    );
  });

  it("executes an approved mutation and auto-approval bypasses the callback", async () => {
    const approvedCwd = await temporaryDirectory();
    const approvedProvider = new FakeProvider([
      toolTurn("write-approved", "write_file", {
        path: "approved.txt",
        content: "approved",
      }),
      finalTurn(),
    ]);
    const approve = vi.fn(async () => true);
    const approvedAgent = new AgentSession({
      provider: approvedProvider,
      cwd: approvedCwd,
      model: "test/model",
      requestApproval: approve,
    });

    await approvedAgent.run("Write approved.txt");
    expect(approve).toHaveBeenCalledOnce();
    expect(await readFile(join(approvedCwd, "approved.txt"), "utf8")).toBe("approved");

    const automaticCwd = await temporaryDirectory();
    const automaticProvider = new FakeProvider([
      toolTurn("write-auto", "write_file", {
        path: "automatic.txt",
        content: "automatic",
      }),
      finalTurn(),
    ]);
    const shouldNotRun = vi.fn(async () => false);
    const automaticAgent = new AgentSession({
      provider: automaticProvider,
      cwd: automaticCwd,
      model: "test/model",
      autoApprove: true,
      requestApproval: shouldNotRun,
    });

    await automaticAgent.run("Write automatically");
    expect(shouldNotRun).not.toHaveBeenCalled();
    expect(await readFile(join(automaticCwd, "automatic.txt"), "utf8")).toBe(
      "automatic",
    );
  });

  it("returns malformed tool arguments to the model without requesting approval", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("bad-args", "write_file", "[1,2,3]"),
      finalTurn(),
    ]);
    const requestApproval = vi.fn(async () => true);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Use malformed arguments");

    expect(requestApproval).not.toHaveBeenCalled();
    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "bad-args",
      content: expect.stringContaining("Invalid tool arguments"),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "bad-args",
        name: "write_file",
        ok: false,
      }),
    );
  });

  it("keeps the hard destructive-command guard when mutations are auto-approved", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("dangerous", "run_command", { command: "rm -rf /" }),
      finalTurn(),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Destroy everything");

    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "dangerous",
      content: expect.stringContaining("irreversibly destroy data"),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "dangerous",
        ok: false,
      }),
    );
  });

  it("stops a repeated tool loop at maxSteps and remains reusable afterwards", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("list-1", "list_files", {}),
      toolTurn("list-2", "list_files", {}),
      finalTurn("Recovered."),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      maxSteps: 2,
      onEvent: (event) => events.push(event),
    });

    await expect(agent.run("Loop forever")).rejects.toThrow(
      /stopped after 2 steps/,
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Agent stopped after 2 steps to prevent an unbounded tool loop.",
    });

    await agent.run("Try again");
    expect(events.at(-1)).toEqual({ type: "done", steps: 1 });
  });

  it("reuses identical read-only tool results and invalidates them after mutation", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "before\n");
    const provider = new FakeProvider([
      toolTurn("read-1", "read_file", { path: "note.txt" }),
      toolTurn("read-2", "read_file", { path: "note.txt" }),
      toolTurn("write-1", "write_file", { path: "note.txt", content: "after\n" }),
      toolTurn("read-3", "read_file", { path: "note.txt" }),
      finalTurn(),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Read, edit, and read again");

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.name === "read_file",
    );
    expect(results.map((result) => result.cached)).toEqual([false, true, false]);
    expect(results[0].output).toContain("before");
    expect(results[2].output).toContain("after");
  });

  it("drops read caches between user turns so external edits are observed", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "before\n");
    const provider = new FakeProvider([
      toolTurn("first-read", "read_file", { path: "note.txt" }),
      finalTurn("First turn complete."),
      toolTurn("second-read", "read_file", { path: "note.txt" }),
      finalTurn("Second turn complete."),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      onEvent: (event) => events.push(event),
    });

    await agent.run("Read the note");
    await writeFile(join(cwd, "note.txt"), "changed externally\n");
    await agent.run("Read it again");

    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.name === "read_file",
    );
    expect(results.map((result) => result.cached)).toEqual([false, false]);
    expect(results[0].output).toContain("before");
    expect(results[1].output).toContain("changed externally");
  });

  it("rejects oversized parallel tool batches before executing any call", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      {
        turn: {
          message: {
            role: "assistant",
            content: null,
            tool_calls: Array.from({ length: 17 }, (_, index) => ({
              id: `call-${index}`,
              type: "function" as const,
              function: { name: "list_files", arguments: "{}" },
            })),
          },
        },
      },
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      onEvent: (event) => events.push(event),
    });

    await expect(agent.run("Run everything")).rejects.toThrow(
      /17 tools.*limit is 16/i,
    );
    expect(events.some((event) => event.type === "tool")).toBe(false);
  });

  it("keeps reused provider tool IDs distinct in the UI audit stream", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("reused", "list_files", {}),
      toolTurn("reused", "list_files", {}),
      finalTurn(),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      onEvent: (event) => events.push(event),
    });

    await agent.run("List twice");

    expect(
      events
        .filter((event) => event.type === "tool")
        .map((event) => event.id),
    ).toEqual(["reused", "reused#2.1"]);
  });

  it("prunes omitted complete turns from retained session memory", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      finalTurn("one"),
      finalTurn("two"),
      finalTurn("three"),
      finalTurn("four"),
      finalTurn("five"),
    ]);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      contextCharBudget: 4_000,
    });

    await agent.run(`first-secret-marker ${"a".repeat(1_000)}`);
    await agent.run(`second ${"b".repeat(1_000)}`);
    await agent.run(`third ${"c".repeat(1_000)}`);
    await agent.run(`fourth ${"d".repeat(1_000)}`);
    await agent.run(`fifth ${"e".repeat(1_000)}`);

    expect(JSON.stringify(agent.history)).not.toContain("first-secret-marker");
    expect(JSON.stringify(agent.history).length).toBeLessThan(5_000);
  });

  it("stops before another provider request once the session token budget is spent", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([finalTurn("Budget used.")]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      sessionTokenBudget: 12,
      onEvent: (event) => events.push(event),
    });

    await agent.run("First request");
    await expect(agent.run("Second request")).rejects.toThrow(
      /Session token budget reached \(12\/12\)/,
    );
    expect(provider.calls).toHaveLength(1);
  });
});
