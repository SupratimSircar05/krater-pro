import OpenAI from "openai";
import type {
  AssistantTurn,
  ChatProvider,
  ModelMessage,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";

export interface KraterProviderOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  maxOutputTokens?: number;
}

function providerError(error: unknown): Error {
  const candidate = error as {
    status?: number;
    message?: string;
    error?: { message?: string };
  };
  const message = candidate.error?.message ?? candidate.message ?? String(error);
  if (candidate.status === 401) {
    return new Error("Krater rejected the API key. Check KRATER_API_KEY or --api-key.");
  }
  if (candidate.status === 403) {
    return new Error(`Krater denied this request: ${message}`);
  }
  if (candidate.status === 429) {
    return new Error(`Krater rate or credit limit reached: ${message}`);
  }
  return new Error(`Krater API request failed${candidate.status ? ` (${candidate.status})` : ""}: ${message}`);
}

export class KraterProvider implements ChatProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private completionSequence = 0;

  constructor(options: KraterProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: 300_000,
      maxRetries: 2,
    });
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192;
  }

  async complete(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn> {
    try {
      const completionId = ++this.completionSequence;
      const stream: AsyncIterable<any> = await (this.client.chat.completions.create as any)(
        {
          model: this.model,
          messages,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: true,
          max_tokens: this.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );

      let content = "";
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
            cachedTokens:
              chunk.usage.prompt_tokens_details?.cached_tokens ??
              chunk.usage.input_tokens_details?.cached_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const partial of delta.tool_calls ?? []) {
          const index = partial.index ?? calls.size;
          const current = calls.get(index) ?? {
            id: partial.id ?? `tool_${completionId}_${index}`,
            name: "",
            arguments: "",
          };
          if (partial.id) current.id = partial.id;
          if (partial.function?.name) current.name += partial.function.name;
          if (partial.function?.arguments) {
            current.arguments += partial.function.arguments;
          }
          calls.set(index, current);
        }
      }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        }));
      if (!finishReason) {
        throw new Error(
          "Krater ended the response stream without a finish reason; the answer may be incomplete.",
        );
      }
      if (!["stop", "tool_calls"].includes(finishReason)) {
        if (finishReason === "length") {
          throw new Error(
            "Krater truncated the response at the output-token limit. Increase KRATER_MAX_OUTPUT_TOKENS or ask for a smaller step.",
          );
        }
        if (finishReason === "content_filter") {
          throw new Error(
            "Krater stopped the response because of provider content filtering.",
          );
        }
        throw new Error(
          `Krater stopped the response with non-success finish reason "${finishReason}".`,
        );
      }
      if (finishReason === "tool_calls" && !toolCalls.length) {
        throw new Error(
          "Krater ended with tool_calls but did not provide a complete tool call.",
        );
      }
      return {
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        usage,
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      throw providerError(error);
    }
  }

  async listModels(signal?: AbortSignal): Promise<Array<{ id: string; ownedBy?: string }>> {
    try {
      const page: any = await (this.client.models.list as any)({ signal });
      const models: any[] = page.data ?? [];
      return models
        .filter((model) => typeof model.id === "string")
        .map((model) => ({ id: model.id, ownedBy: model.owned_by }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      throw providerError(error);
    }
  }
}
