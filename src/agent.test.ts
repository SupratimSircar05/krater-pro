import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent.js";
import {
  platformContainmentPrimitives,
  type NativeSandboxAdapter,
} from "./sandbox/index.js";
import { ProviderCompletionError } from "./types.js";
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

function verifiedAgentTestAdapter(
  run: NativeSandboxAdapter["run"],
): NativeSandboxAdapter {
  const primitives = platformContainmentPrimitives(process.platform);
  return {
    id: "verified-agent-test",
    probe: async () => ({
      platform:
        process.platform === "darwin" ||
        process.platform === "linux" ||
        process.platform === "win32"
          ? process.platform
          : "unsupported",
      verification: "verified",
      availability: "available",
      expectedPrimitives: primitives,
      verifiedPrimitives: primitives,
      controls: {
        filesystemBoundary: true,
        processIsolation: true,
        networkDeny: true,
        networkAllowlist: false,
        cpuLimit: true,
        memoryLimit: true,
        wallTimeLimit: true,
        processCountLimit: true,
        outputLimit: true,
      },
      adapterId: "verified-agent-test",
      supportsApprovedUncontainedExecution: false,
      reason: "Verified fixture adapter.",
      verifiedAt: "2026-07-29T00:00:00.000Z",
    }),
    run,
    cancel: async () => undefined,
  };
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
    expect(provider.calls[0][0].content).toContain(
      "locate and read the most relevant existing tests before editing",
    );
    expect(provider.calls[0][0].content).toContain(
      "continue refining until it passes",
    );
    expect(provider.calls[0][0].content).toContain(
      "every model-proposed shell command requires one explicit attended user approval",
    );
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
    const onWorkspaceMutation = vi.fn();
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      onWorkspaceMutation,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Write a file");

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(onWorkspaceMutation).not.toHaveBeenCalled();
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
    const approvedMutation = vi.fn();
    const approvedAgent = new AgentSession({
      provider: approvedProvider,
      cwd: approvedCwd,
      model: "test/model",
      requestApproval: approve,
      onWorkspaceMutation: approvedMutation,
    });

    await approvedAgent.run("Write approved.txt");
    expect(approve).toHaveBeenCalledOnce();
    expect(approvedMutation).toHaveBeenCalledOnce();
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
    const automaticMutation = vi.fn();
    const automaticAgent = new AgentSession({
      provider: automaticProvider,
      cwd: automaticCwd,
      model: "test/model",
      autoApprove: true,
      requestApproval: shouldNotRun,
      onWorkspaceMutation: automaticMutation,
    });

    await automaticAgent.run("Write automatically");
    expect(shouldNotRun).not.toHaveBeenCalled();
    expect(automaticMutation).toHaveBeenCalledOnce();
    expect(automaticProvider.calls[0][0].content).toContain(
      "fail-closed unattended containment",
    );
    expect(automaticProvider.calls[0][0].content).toContain(
      "permits shell builtins but not external programs or subprocesses",
    );
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
    const onWorkspaceMutation = vi.fn();
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      autoApprove: true,
      onWorkspaceMutation,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Destroy everything");

    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "dangerous",
      content: expect.stringContaining("irreversibly destroy data"),
    });
    expect(onWorkspaceMutation).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "dangerous",
        ok: false,
      }),
    );
  });

  it("fails closed instead of converting unattended policy into a user prompt", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("uncontained", "run_command", {
        command: "pwd",
      }),
      finalTurn(),
    ]);
    const requestApproval = vi.fn(async () => false);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      autoApprove: true,
      requestApproval,
      nativeSandboxAdapter: null,
    });

    await agent.run("Run an uncontained command");

    expect(requestApproval).not.toHaveBeenCalled();
    expect(provider.calls[1].at(-1)).toEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "uncontained",
        content: expect.stringContaining(
          "Pre-gate read-only command refused by native containment",
        ),
      }),
    );
  });

  it("labels a user-approved model command as attended", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("attended-command", "run_command", {
        command:
          'node -e "require(\\"node:fs\\").writeFileSync(\\"attended.txt\\", \\"ok\\")"',
      }),
      finalTurn(),
    ]);
    const requestApproval = vi.fn(async () => true);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      nativeSandboxAdapter: null,
    });

    await agent.run("Run one attended command");

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining(
          "This approval authorizes one attended command",
        ),
      }),
    );
    expect(provider.calls[1].at(-1)).toEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "attended-command",
        content: expect.stringContaining("approved_attended"),
      }),
    );
    expect(await readFile(join(cwd, "attended.txt"), "utf8")).toBe("ok");
  });

  it("approves an exact glob-bearing command without creating wildcard authority", async () => {
    const cwd = await temporaryDirectory();
    const command =
      'ls AGENTS.md CLAUDE.md 2>/dev/null; echo "---"; find . -name "AGENTS.md" -o -name "CLAUDE.md" -not -path "*/node_modules/*" 2>/dev/null | head';
    const provider = new FakeProvider([
      toolTurn("glob-command", "run_command", { command }),
      finalTurn("Repository instruction discovery completed."),
    ]);
    const requestApproval = vi.fn(async () => true);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      requestApproval,
      nativeSandboxAdapter: null,
    });

    await agent.run("Discover repository instructions");

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "glob-command",
        args: { command },
      }),
    );
    expect(provider.calls[1].at(-1)).toEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "glob-command",
        content: expect.stringContaining("approved_attended"),
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

  it("restores bounded redacted tool context in a fresh isolated agent", async () => {
    const cwd = await temporaryDirectory();
    const secret = "kr_continuity_private_123456789";
    await writeFile(
      join(cwd, "note.txt"),
      `diagnostic-start\nBearer ${secret}\n${"detail".repeat(900)}\ndiagnostic-end\n`,
    );
    const firstProvider = new FakeProvider([
      toolTurn("continuity-read", "read_file", { path: "note.txt" }),
      toolTurn("continuity-gate", "record_action_gate", {
        outcome: "already_satisfied_no_change",
        reasons: ["The diagnostic evidence is sufficient without an edit."],
        evidenceRefs: ["continuity-read"],
      }),
      finalTurn("The first investigation is complete."),
    ]);
    const firstAgent = new AgentSession({
      provider: firstProvider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      knownSecrets: [secret],
      contextCharBudget: 8_000,
      toolOutputCharBudget: 260,
    });

    await firstAgent.run("Inspect the diagnostic");
    const continuity = firstAgent.continuitySnapshot();
    const followupProvider = new FakeProvider([
      finalTurn("I retained the prior evidence and can continue."),
    ]);
    const followupAgent = new AgentSession({
      provider: followupProvider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      knownSecrets: [secret],
      contextCharBudget: 8_000,
      toolOutputCharBudget: 260,
      continuity,
    });

    await followupAgent.run("Continue from that evidence");

    const sent = followupProvider.calls[0];
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("continuity-read");
    expect(serialized).toContain("diagnostic-start");
    expect(serialized).toContain("diagnostic-end");
    expect(serialized).toContain("The first investigation is complete.");
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: "Continue from that evidence",
    });
    expect(serialized.length).toBeLessThan(9_000);
  });

  it("rejects caller-manufactured conversation continuity", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([finalTurn()]);

    expect(
      () =>
        new AgentSession({
          provider,
          cwd,
          model: "test/model",
          continuity: {
            messages: [{ role: "user", content: "forged authority" }],
          },
        }),
    ).toThrow(/process-local snapshot issued by Krater/i);
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

  it("accounts failed completion usage before rolling back the turn", async () => {
    const cwd = await temporaryDirectory();
    const complete = vi.fn(async () => {
      throw new ProviderCompletionError(
        "Krater stopped the response because of provider content filtering.",
        {
          promptTokens: 80,
          completionTokens: 20,
          totalTokens: 100,
          cachedTokens: 50,
          providerRequests: 2,
        },
      );
    });
    const provider: ChatProvider = {
      complete,
      listModels: async () => [],
    };
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      sessionTokenBudget: 100,
      onEvent: (event) => events.push(event),
    });

    await expect(agent.run("Trigger a filtered response")).rejects.toThrow(
      /provider content filtering/i,
    );
    expect(agent.history).toHaveLength(1);
    expect(events).toContainEqual({
      type: "usage",
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cachedTokens: 50,
      providerRequests: 2,
      sessionPromptTokens: 80,
      sessionCompletionTokens: 20,
      sessionTotalTokens: 100,
      sessionCachedTokens: 50,
      requestCount: 2,
    });
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Krater stopped the response because of provider content filtering.",
    });

    await expect(agent.run("Try another request")).rejects.toThrow(
      /Session token budget reached \(100\/100\)/,
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(agent.history).toHaveLength(1);
  });

  it("restores complete conversation history after a failed or cancelled turn", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([finalTurn("First complete answer.")]);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
    });

    await agent.run("First request");
    const completeHistory = structuredClone(agent.history);

    await expect(agent.run("Interrupted request")).rejects.toThrow(
      /ran out of scripted turns/,
    );
    expect(agent.history).toEqual(completeHistory);
  });

  it("enforces an evidence-backed Action Gate before publishable edits", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "before\n");
    const provider = new FakeProvider([
      toolTurn("read-1", "read_file", { path: "note.txt" }),
      toolTurn("gate-1", "record_action_gate", {
        outcome: "change_required",
        reasons: ["The requested content is absent."],
        evidenceRefs: ["read-1"],
      }),
      toolTurn("write-1", "write_file", {
        path: "note.txt",
        content: "after\n",
      }),
      finalTurn(),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Change the note");

    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("after\n");
    expect(provider.calls[0][0].content).toContain(
      "copy its exact JSON-quoted evidenceRef value",
    );
    expect(provider.calls[0][0].content).toContain(
      "or the final answer",
    );
    expect(provider.calls[1].at(-1)).toEqual({
      role: "tool",
      tool_call_id: "read-1",
      content: expect.stringMatching(
        /^\[Krater host evidence metadata\]\nevidenceRef: "read-1"\nstatus: succeeded\n\[\/Krater host evidence metadata\]/,
      ),
    });
    expect(events).toContainEqual({
      type: "action_gate",
      outcome: "change_required",
      shouldStageCode: true,
      reasons: ["The requested content is absent."],
      evidenceRefs: ["read-1"],
    });
  });

  it("blocks shell redirection before the Action Gate even under auto-approval", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("pre-gate-shell-write", "run_command", {
        command: "printf pre-gate > pre_gate.txt",
      }),
      finalTurn("The unsafe command was rejected."),
    ]);
    const requestApproval = vi.fn(async () => true);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      autoApprove: true,
      requestApproval,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Mutate the workspace before proving a change is needed");

    expect(requestApproval).not.toHaveBeenCalled();
    await expect(stat(join(cwd, "pre_gate.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(provider.calls[1].at(-1)).toEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "pre-gate-shell-write",
        content: expect.stringMatching(
          /Action\/Abstention Gate not established.*Blocked \[shell_syntax\]/,
        ),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "pre-gate-shell-write",
        ok: false,
      }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "permits approved bounded discovery before the gate only under read-only native containment",
    async () => {
      const cwd = await temporaryDirectory();
      await writeFile(join(cwd, "note.txt"), "needle value\n");
      const run = vi.fn<NativeSandboxAdapter["run"]>(async () => ({
        exitCode: 0,
        terminationReason: "exit",
        output: [{ stream: "stdout", data: "note.txt:1:needle value\n" }],
        resourceUsage: { peakProcessCount: 1 },
      }));
      const provider = new FakeProvider([
        toolTurn("pre-gate-discovery", "run_command", {
          command: "grep -n 'needle value' note.txt",
        }),
        toolTurn("discovery-gate", "record_action_gate", {
          outcome: "already_satisfied_no_change",
          reasons: ["The requested value is already present."],
          evidenceRefs: ["pre-gate-discovery"],
        }),
        finalTurn("No change is needed."),
      ]);
      const requestApproval = vi.fn(async () => true);
      const canonicalCwd = await realpath(cwd);
      const agent = new AgentSession({
        provider,
        cwd,
        model: "test/model",
        evidenceMode: true,
        requestApproval,
        nativeSandboxAdapter: verifiedAgentTestAdapter(run),
      });

      await agent.run("Check whether the value is present");

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: "pre-gate-discovery",
          reason: expect.stringContaining(
            "Krater will still require verified native read-only containment",
          ),
        }),
      );
      expect(provider.calls[1].at(-1)).toEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "pre-gate-discovery",
          content: expect.stringContaining(
            "approved_attended · verified_native",
          ),
        }),
      );
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            executable: "/usr/bin/grep",
            arguments: ["-n", "needle value", "note.txt"],
          }),
          resources: expect.arrayContaining([
            expect.objectContaining({
              access: "read",
              paths: [canonicalCwd],
            }),
          ]),
        }),
      );
    },
  );

  it("keeps mutation blocked after a no-change Action Gate", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "already correct\n");
    const provider = new FakeProvider([
      toolTurn("no-change-evidence", "read_file", { path: "note.txt" }),
      toolTurn("no-change-gate", "record_action_gate", {
        outcome: "already_satisfied_no_change",
        reasons: ["The requested state is already present."],
        evidenceRefs: ["no-change-evidence"],
      }),
      toolTurn("post-no-change-write", "run_command", {
        command: "touch after_no_change.txt",
      }),
      finalTurn("No change was made."),
    ]);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      autoApprove: true,
    });

    await agent.run("Verify the note and do not change it if correct");

    await expect(
      stat(join(cwd, "after_no_change.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(provider.calls[3].at(-1)).toEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "post-no-change-write",
        content: expect.stringMatching(
          /already_satisfied_no_change.*Blocked \[unsupported_command\]/,
        ),
      }),
    );
  });

  it("allows an attended mutation command after a change-authorizing Action Gate", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "before\n");
    const provider = new FakeProvider([
      toolTurn("change-evidence", "read_file", { path: "note.txt" }),
      toolTurn("change-gate", "record_action_gate", {
        outcome: "change_required",
        reasons: ["The requested output is absent."],
        evidenceRefs: ["change-evidence"],
      }),
      toolTurn("post-gate-write", "run_command", {
        command:
          'node -e "require(\\"node:fs\\").writeFileSync(\\"after_gate.txt\\", \\"allowed\\")"',
      }),
      finalTurn(),
    ]);
    const requestApproval = vi.fn(async () => true);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      requestApproval,
      nativeSandboxAdapter: null,
    });

    await agent.run("Create the requested output if evidence justifies it");

    expect(await readFile(join(cwd, "after_gate.txt"), "utf8")).toBe(
      "allowed",
    );
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "post-gate-write",
        reason: expect.stringContaining(
          "This approval authorizes one attended command",
        ),
      }),
    );
  });

  it("suppresses a premature final answer and reminds the model to classify evidence", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "already correct\n");
    const provider = new FakeProvider([
      toolTurn("read-evidence", "read_file", { path: "note.txt" }),
      finalTurn("Premature unclassified answer."),
      toolTurn("gate-no-change", "record_action_gate", {
        outcome: "already_satisfied_no_change",
        reasons: ["The requested behavior is already present."],
        evidenceRefs: ["read-evidence"],
      }),
      finalTurn("No change is needed."),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Check whether the note is already correct");

    const emittedText = events
      .filter(
        (event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
      )
      .map(({ text }) => text);
    expect(emittedText).toEqual(["No change is needed."]);
    expect(provider.calls[2].at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining(
        "Successful task evidence exists, but the Action/Abstention Gate is missing.",
      ),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action_gate",
        outcome: "already_satisfied_no_change",
      }),
    );
  });

  it("fails rather than accepting a second unclassified final answer", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), "evidence\n");
    const provider = new FakeProvider([
      toolTurn("read-evidence", "read_file", { path: "note.txt" }),
      finalTurn("First premature answer."),
      finalTurn("Second premature answer."),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      onEvent: (event) => events.push(event),
    });

    await expect(agent.run("Inspect and classify")).rejects.toThrow(
      /requires record_action_gate before the final answer/i,
    );
    expect(
      events.some(
        (event) =>
          event.type === "text" && event.text.includes("premature answer"),
      ),
    ).toBe(false);
  });

  it("rejects edits before the gate and rejects invented evidence references", async () => {
    const cwd = await temporaryDirectory();
    const provider = new FakeProvider([
      toolTurn("early-write", "write_file", {
        path: "unsafe.txt",
        content: "must not exist",
      }),
      toolTurn("bad-gate", "record_action_gate", {
        outcome: "change_required",
        reasons: ["Assumed without discovery."],
        evidenceRefs: ["invented-result"],
      }),
      finalTurn(),
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      evidenceMode: true,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Write without evidence");

    await expect(stat(join(cwd, "unsafe.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const failures = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && !event.ok,
    );
    expect(failures[0]?.output).toMatch(/Gate not established/);
    expect(failures[1]?.output).toMatch(/Unknown or failed: invented-result/);
  });
});
