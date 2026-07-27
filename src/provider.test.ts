import { beforeEach, describe, expect, it, vi } from "vitest";

const openAIState = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  completionRequests: [] as unknown[],
  chunks: [] as unknown[],
  completionError: undefined as unknown,
  models: [] as unknown[],
  modelError: undefined as unknown,
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: async (request: unknown) => {
          openAIState.completionRequests.push(request);
          if (openAIState.completionError) throw openAIState.completionError;
          return (async function* () {
            for (const chunk of openAIState.chunks) yield chunk;
          })();
        },
      },
    };

    models = {
      list: async () => {
        if (openAIState.modelError) throw openAIState.modelError;
        return { data: openAIState.models };
      },
    };

    constructor(options: unknown) {
      openAIState.constructorOptions.push(options);
    }
  },
}));

import { KraterProvider } from "./provider.js";

function provider(): KraterProvider {
  return new KraterProvider({
    apiKey: "kr_test",
    baseURL: "https://api.krater.test/v1",
    model: "test/model",
  });
}

beforeEach(() => {
  openAIState.constructorOptions.length = 0;
  openAIState.completionRequests.length = 0;
  openAIState.chunks = [];
  openAIState.completionError = undefined;
  openAIState.models = [];
  openAIState.modelError = undefined;
});

describe("KraterProvider", () => {
  it("assembles streamed text, tool calls, and cache-aware usage", async () => {
    openAIState.chunks = [
      { choices: [{ delta: { content: "Hello " } }] },
      {
        choices: [
          {
            delta: {
              content: "world",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"src/main.ts"}' } }],
            },
          },
        ],
      },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 75 },
        },
        choices: [],
      },
    ];
    const streamed: string[] = [];

    const result = await provider().complete(
      [{ role: "user", content: "Inspect" }],
      [],
      (text) => streamed.push(text),
    );

    expect(streamed).toEqual(["Hello ", "world"]);
    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "Hello world",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/main.ts"}',
            },
          },
        ],
      },
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: 75,
      },
    });
    expect(openAIState.constructorOptions[0]).toMatchObject({
      apiKey: "kr_test",
      baseURL: "https://api.krater.test/v1",
      maxRetries: 2,
    });
    expect(openAIState.completionRequests[0]).toMatchObject({
      model: "test/model",
      max_tokens: 8_192,
      stream: true,
    });
  });

  it("accepts an explicit stop and rejects truncated or unterminated streams", async () => {
    openAIState.chunks = [
      { choices: [{ delta: { content: "Complete" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    await expect(
      provider().complete([{ role: "user", content: "Hello" }], [], () => undefined),
    ).resolves.toMatchObject({
      message: { role: "assistant", content: "Complete" },
    });

    openAIState.chunks = [
      { choices: [{ delta: { content: "Partial" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    await expect(
      provider().complete([{ role: "user", content: "Hello" }], [], () => undefined),
    ).rejects.toThrow(/truncated.*output-token limit/i);

    openAIState.chunks = [{ choices: [{ delta: { content: "No terminator" } }] }];
    await expect(
      provider().complete([{ role: "user", content: "Hello" }], [], () => undefined),
    ).rejects.toThrow(/without a finish reason/i);
  });

  it("generates completion-unique fallback IDs when a stream omits tool IDs", async () => {
    const instance = provider();
    const toolChunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    openAIState.chunks = [toolChunk];
    const first = await instance.complete(
      [{ role: "user", content: "First" }],
      [],
      () => undefined,
    );
    openAIState.chunks = [toolChunk];
    const second = await instance.complete(
      [{ role: "user", content: "Second" }],
      [],
      () => undefined,
    );

    expect(first.message.tool_calls?.[0].id).toBe("tool_1_0");
    expect(second.message.tool_calls?.[0].id).toBe("tool_2_0");
  });

  it("sorts and filters model discovery results", async () => {
    openAIState.models = [
      { id: "z/model", owned_by: "z" },
      { id: 42, owned_by: "invalid" },
      { id: "a/model", owned_by: "a" },
    ];
    await expect(provider().listModels()).resolves.toEqual([
      { id: "a/model", ownedBy: "a" },
      { id: "z/model", ownedBy: "z" },
    ]);
  });

  it.each([
    [401, "Check KRATER_API_KEY"],
    [403, "Krater denied this request"],
    [429, "rate or credit limit"],
  ])("maps HTTP %s to an actionable error", async (status, expected) => {
    openAIState.completionError = { status, message: "provider detail" };
    await expect(
      provider().complete([{ role: "user", content: "Hello" }], [], () => undefined),
    ).rejects.toThrow(expected);
  });
});
