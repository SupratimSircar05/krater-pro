import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

class TrustProvider implements ChatProvider {
  readonly calls: ModelMessage[][] = [];

  constructor(private readonly turns: AssistantTurn[]) {}

  async complete(
    messages: ModelMessage[],
    _tools: ToolDefinition[],
    onText: (text: string) => void,
  ): Promise<AssistantTurn> {
    this.calls.push(structuredClone(messages));
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted turn.");
    if (turn.message.content) onText(turn.message.content);
    return structuredClone(turn);
  }

  async listModels(): Promise<[]> {
    return [];
  }
}

const temporaryPaths: string[] = [];
const secret = ["kr", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-agent-trust-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentSession live trust enforcement", () => {
  it("does not send a credential from user input to the provider", async () => {
    const cwd = await temporaryDirectory();
    const provider = new TrustProvider([
      { message: { role: "assistant", content: "Done." } },
    ]);
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      knownSecrets: [secret],
    });

    await agent.run(`Use ${secret} but keep it private`);

    expect(JSON.stringify(provider.calls)).not.toContain(secret);
    expect(JSON.stringify(agent.history)).not.toContain(secret);
    expect(provider.calls[0]).toContainEqual({
      role: "user",
      content: "Use [REDACTED] but keep it private",
    });
  });

  it("redacts tool output before it reaches the model or event stream", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "note.txt"), `Bearer ${secret}\n`);
    const provider = new TrustProvider([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "note.txt" }),
              },
            },
          ],
        },
      },
      { message: { role: "assistant", content: "Secret stayed private." } },
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      knownSecrets: [secret],
      onEvent: (event) => events.push(event),
    });

    await agent.run("Read the note safely");

    expect(JSON.stringify(provider.calls)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(provider.calls[1].at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("[REDACTED]"),
    });
  });

  it("blocks a model-generated tool call containing credential material", async () => {
    const cwd = await temporaryDirectory();
    const requestApproval = vi.fn(async () => true);
    const provider = new TrustProvider([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "command-1",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({
                  command: `printf '${secret}'`,
                }),
              },
            },
          ],
        },
      },
      { message: { role: "assistant", content: "Blocked." } },
    ]);
    const events: AgentEvent[] = [];
    const agent = new AgentSession({
      provider,
      cwd,
      model: "test/model",
      knownSecrets: [secret],
      requestApproval,
      onEvent: (event) => events.push(event),
    });

    await agent.run("Run the unsafe command");

    expect(requestApproval).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "command-1",
        ok: false,
        output: expect.stringContaining("credential material"),
      }),
    );
  });
});
