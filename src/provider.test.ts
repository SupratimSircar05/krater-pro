import { beforeEach, describe, expect, it, vi } from "vitest";

const openAIState = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  completionRequests: [] as unknown[],
  chunks: [] as unknown[],
  completionStreams: [] as unknown[][],
  completionError: undefined as unknown,
  completionStreamError: undefined as unknown,
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
          const chunks =
            openAIState.completionStreams.shift() ?? openAIState.chunks;
          return (async function* () {
            for (const chunk of chunks) yield chunk;
            if (openAIState.completionStreamError) {
              throw openAIState.completionStreamError;
            }
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
import { ProviderCompletionError } from "./types.js";

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
  openAIState.completionStreams.length = 0;
  openAIState.completionError = undefined;
  openAIState.completionStreamError = undefined;
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
        providerRequests: 1,
      },
    });
    expect(openAIState.constructorOptions[0]).toMatchObject({
      apiKey: "kr_test",
      baseURL: "https://api.krater.test/v1",
      maxRetries: 0,
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

  it("preserves billed usage on unsuccessful terminal stream outcomes", async () => {
    const cases = [
      {
        finishReason: "length",
        message: /truncated.*output-token limit/i,
      },
      {
        finishReason: "content_filter",
        message: /provider content filtering/i,
      },
      {
        finishReason: undefined,
        message: /without a finish reason/i,
      },
    ] as const;

    for (const testCase of cases) {
      openAIState.completionRequests.length = 0;
      openAIState.chunks = [
        { choices: [{ delta: { content: "Partial response" } }] },
        {
          usage: {
            prompt_tokens: 90,
            completion_tokens: 10,
            total_tokens: 100,
            prompt_tokens_details: { cached_tokens: 40 },
          },
          choices: testCase.finishReason
            ? [{ delta: {}, finish_reason: testCase.finishReason }]
            : [],
        },
      ];

      const error = await provider()
        .complete([{ role: "user", content: "Hello" }], [], () => undefined)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(ProviderCompletionError);
      expect(error).toMatchObject({
        message: expect.stringMatching(testCase.message),
        usage: {
          promptTokens: 90,
          completionTokens: 10,
          totalTokens: 100,
          cachedTokens: 40,
          providerRequests: 1,
        },
      });
      expect(openAIState.completionRequests).toHaveLength(1);
    }
  });

  it("preserves usage and the request count when stream iteration fails", async () => {
    openAIState.chunks = [
      { choices: [{ delta: { content: "Partial" } }] },
      {
        usage: {
          prompt_tokens: 70,
          completion_tokens: 8,
          total_tokens: 78,
          prompt_tokens_details: { cached_tokens: 30 },
        },
        choices: [],
      },
    ];
    openAIState.completionStreamError = new Error("socket reset");

    const error = await provider()
      .complete([{ role: "user", content: "Hello" }], [], () => undefined)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ProviderCompletionError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/Krater API request failed.*socket reset/i),
      usage: {
        promptTokens: 70,
        completionTokens: 8,
        totalTokens: 78,
        cachedTokens: 30,
        providerRequests: 1,
      },
    });
    expect(openAIState.completionRequests).toHaveLength(1);
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

  it("safely retries one unterminated stream before any text or tool execution", async () => {
    openAIState.completionStreams = [
      [
        {
          usage: {
            prompt_tokens: 80,
            completion_tokens: 4,
            total_tokens: 84,
            prompt_tokens_details: { cached_tokens: 50 },
          },
          choices: [],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "partial-call",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"src/',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      [
        { choices: [{ delta: { content: "Recovered" } }] },
        {
          usage: {
            prompt_tokens: 80,
            completion_tokens: 3,
            total_tokens: 83,
            prompt_tokens_details: { cached_tokens: 60 },
          },
          choices: [{ delta: {}, finish_reason: "stop" }],
        },
      ],
    ];
    const streamed: string[] = [];

    await expect(
      provider().complete(
        [{ role: "user", content: "Inspect" }],
        [],
        (text) => streamed.push(text),
      ),
    ).resolves.toMatchObject({
      message: { role: "assistant", content: "Recovered" },
      usage: {
        promptTokens: 160,
        completionTokens: 7,
        totalTokens: 167,
        cachedTokens: 110,
        providerRequests: 2,
      },
    });
    expect(openAIState.completionRequests).toHaveLength(2);
    expect(streamed).toEqual(["Recovered"]);
  });

  it("combines billed usage when the safe incomplete-stream retry also fails", async () => {
    openAIState.completionStreams = [
      [
        {
          usage: {
            prompt_tokens: 50,
            completion_tokens: 2,
            total_tokens: 52,
            prompt_tokens_details: { cached_tokens: 20 },
          },
          choices: [],
        },
      ],
      [
        {
          usage: {
            prompt_tokens: 60,
            completion_tokens: 1,
            total_tokens: 61,
            prompt_tokens_details: { cached_tokens: 30 },
          },
          choices: [{ delta: {}, finish_reason: "content_filter" }],
        },
      ],
    ];

    const error = await provider()
      .complete([{ role: "user", content: "Inspect" }], [], () => undefined)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ProviderCompletionError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/provider content filtering/i),
      usage: {
        promptTokens: 110,
        completionTokens: 3,
        totalTokens: 113,
        cachedTokens: 50,
        providerRequests: 2,
      },
    });
    expect(openAIState.completionRequests).toHaveLength(2);
  });

  it("sorts and filters model discovery results", async () => {
    openAIState.models = [
      { id: "z/model", owned_by: "z" },
      { id: 42, owned_by: "invalid" },
      {
        id: "a/model",
        owned_by: "a",
        context_length: 200_000,
        architecture: {
          modality: "text+image->text",
          input_modalities: ["text", "image", 42],
          output_modalities: ["text", 42],
          unrelated: "ignored",
        },
        supported_parameters: ["tools", "temperature", 42],
        pricing: {
          prompt: "0.000001",
          completion: "0.000004",
          input_cache_read: "0.0000001",
          unrelated: "ignored",
        },
        benchmarks: {
          artificial_analysis: {
            coding_index: 81,
            agentic_index: "75",
            intelligence_index: 79,
            unrelated: 100,
          },
        },
      },
    ];
    await expect(provider().listModels()).resolves.toEqual([
      {
        id: "a/model",
        ownedBy: "a",
        context_length: 200_000,
        architecture: {
          modality: "text+image->text",
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
        supported_parameters: ["tools", "temperature"],
        pricing: {
          prompt: "0.000001",
          completion: "0.000004",
          input_cache_read: "0.0000001",
        },
        benchmarks: {
          artificial_analysis: {
            coding_index: 81,
            agentic_index: "75",
            intelligence_index: 79,
          },
        },
      },
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
