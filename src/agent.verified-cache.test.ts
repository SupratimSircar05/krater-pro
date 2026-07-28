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
import { Workspace } from "./workspace.js";

class CacheProvider implements ChatProvider {
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

function mapTurn(): AssistantTurn {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "map-1",
          type: "function",
          function: { name: "workspace_map", arguments: "{}" },
        },
      ],
    },
  };
}

function finalTurn(): AssistantTurn {
  return { message: { role: "assistant", content: "Mapped." } };
}

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentSession verified work cache", () => {
  it("reuses a repository map only while the complete source digest matches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-agent-cache-"));
    temporaryPaths.push(cwd);
    await writeFile(join(cwd, "package.json"), '{"name":"fixture"}\n');
    const cacheRoot = join(cwd, ".krater", "cache");
    const projectMap = vi.spyOn(Workspace.prototype, "projectMap");

    const runMap = async (): Promise<AgentEvent[]> => {
      const provider = new CacheProvider([mapTurn(), finalTurn()]);
      const events: AgentEvent[] = [];
      const agent = new AgentSession({
        provider,
        cwd,
        model: "test/model",
        verifiedCacheRoot: cacheRoot,
        onEvent: (event) => events.push(event),
      });
      await agent.run("Map this repository");
      return events;
    };

    const first = await runMap();
    const second = await runMap();
    expect(projectMap).toHaveBeenCalledTimes(1);
    expect(
      first.find(
        (event) => event.type === "tool_result" && event.name === "workspace_map",
      ),
    ).toMatchObject({ cached: false });
    expect(
      second.find(
        (event) => event.type === "tool_result" && event.name === "workspace_map",
      ),
    ).toMatchObject({ cached: true });

    await writeFile(join(cwd, "src.ts"), "export const changed = true;\n");
    const third = await runMap();
    expect(projectMap).toHaveBeenCalledTimes(2);
    expect(
      third.find(
        (event) => event.type === "tool_result" && event.name === "workspace_map",
      ),
    ).toMatchObject({ cached: false });
  });
});
