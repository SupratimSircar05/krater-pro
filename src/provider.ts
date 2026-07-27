import OpenAI from "openai";
import type { AvailableModel } from "./router.js";
import { ProviderCompletionError } from "./types.js";
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

function singleRequestUsage(usage: Usage | undefined): Usage {
  return { ...(usage ?? {}), providerRequests: 1 };
}

class IncompleteKraterStreamError extends ProviderCompletionError {
  constructor(
    readonly retrySafe: boolean,
    usage: Usage | undefined,
  ) {
    super(
      "Krater ended the response stream without a finish reason; the answer may be incomplete.",
      singleRequestUsage(usage),
    );
    this.name = "IncompleteKraterStreamError";
  }
}

function combinedRetryUsage(first: Usage | undefined, second: Usage | undefined): Usage {
  const add = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  return {
    promptTokens: add(first?.promptTokens, second?.promptTokens),
    completionTokens: add(first?.completionTokens, second?.completionTokens),
    totalTokens: add(first?.totalTokens, second?.totalTokens),
    cachedTokens: add(first?.cachedTokens, second?.cachedTokens),
    providerRequests:
      (first?.providerRequests ?? 0) + (second?.providerRequests ?? 0),
  };
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
      // Krater Pro owns its one deliberately safe retry below. Disabling the
      // SDK's hidden retries keeps providerRequests equal to actual attempts.
      maxRetries: 0,
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
    return this.completeWithIncompleteRetry(
      messages,
      tools,
      onText,
      signal,
      true,
    );
  }

  private async completeWithIncompleteRetry(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    onText: (text: string) => void,
    signal: AbortSignal | undefined,
    retryAvailable: boolean,
  ): Promise<AssistantTurn> {
    // Some fetch implementations retain abort listeners for the lifetime of a
    // streamed request. Give every completion its own signal so a long agent
    // loop never accumulates listeners on the session-wide AbortSignal.
    const requestController = signal ? new AbortController() : undefined;
    const forwardAbort = () => requestController?.abort();
    if (signal?.aborted) requestController?.abort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
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
        { signal: requestController?.signal },
      );

      let content = "";
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<any>;
        try {
          next = await iterator.next();
        } catch (error) {
          // A stream can report usage before its transport fails. Preserve that
          // billed telemetry so the agent's session budget and request counter
          // remain accurate even though no AssistantTurn can be returned.
          throw new ProviderCompletionError(
            providerError(error).message,
            singleRequestUsage(usage),
            { cause: error },
          );
        }
        if (next.done) break;
        const chunk = next.value;
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
        throw new IncompleteKraterStreamError(content.length === 0, usage);
      }
      if (!["stop", "tool_calls"].includes(finishReason)) {
        if (finishReason === "length") {
          throw new ProviderCompletionError(
            "Krater truncated the response at the output-token limit. Increase KRATER_MAX_OUTPUT_TOKENS or ask for a smaller step.",
            singleRequestUsage(usage),
          );
        }
        if (finishReason === "content_filter") {
          throw new ProviderCompletionError(
            "Krater stopped the response because of provider content filtering.",
            singleRequestUsage(usage),
          );
        }
        throw new ProviderCompletionError(
          `Krater stopped the response with non-success finish reason "${finishReason}".`,
          singleRequestUsage(usage),
        );
      }
      if (finishReason === "tool_calls" && !toolCalls.length) {
        throw new ProviderCompletionError(
          "Krater ended with tool_calls but did not provide a complete tool call.",
          singleRequestUsage(usage),
        );
      }
      return {
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        usage: { ...(usage ?? {}), providerRequests: 1 },
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      if (
        retryAvailable &&
        error instanceof IncompleteKraterStreamError &&
        error.retrySafe
      ) {
        // A graceful-but-unterminated stream is not retried by the SDK. Retrying
        // once is safe only when no user-visible text was emitted; buffered
        // partial tool calls have not yet been executed by the agent.
        signal?.removeEventListener("abort", forwardAbort);
        try {
          const retried = await this.completeWithIncompleteRetry(
            messages,
            tools,
            onText,
            signal,
            false,
          );
          return {
            ...retried,
            usage: combinedRetryUsage(error.usage, retried.usage),
          };
        } catch (retryError) {
          const retryUsage =
            retryError instanceof ProviderCompletionError
              ? retryError.usage
              : { providerRequests: 1 };
          throw new ProviderCompletionError(
            retryError instanceof Error ? retryError.message : String(retryError),
            combinedRetryUsage(error.usage, retryUsage),
            { cause: retryError },
          );
        }
      }
      if (error instanceof ProviderCompletionError) throw error;
      throw providerError(error);
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async listModels(signal?: AbortSignal): Promise<AvailableModel[]> {
    try {
      const page: any = await (this.client.models.list as any)({ signal });
      const models: any[] = page.data ?? [];
      return models
        .filter((model) => typeof model.id === "string")
        .map((model): AvailableModel => {
          const pricing =
            model.pricing && typeof model.pricing === "object"
              ? {
                  ...(model.pricing.prompt !== undefined
                    ? { prompt: model.pricing.prompt }
                    : {}),
                  ...(model.pricing.completion !== undefined
                    ? { completion: model.pricing.completion }
                    : {}),
                  ...(model.pricing.input_cache_read !== undefined
                    ? { input_cache_read: model.pricing.input_cache_read }
                    : {}),
                }
              : undefined;
          const artificialAnalysis =
            model.benchmarks?.artificial_analysis &&
            typeof model.benchmarks.artificial_analysis === "object"
              ? {
                  ...(model.benchmarks.artificial_analysis.coding_index !==
                  undefined
                    ? {
                        coding_index:
                          model.benchmarks.artificial_analysis.coding_index,
                      }
                    : {}),
                  ...(model.benchmarks.artificial_analysis.agentic_index !==
                  undefined
                    ? {
                        agentic_index:
                          model.benchmarks.artificial_analysis.agentic_index,
                      }
                    : {}),
                  ...(model.benchmarks.artificial_analysis.intelligence_index !==
                  undefined
                    ? {
                        intelligence_index:
                          model.benchmarks.artificial_analysis.intelligence_index,
                      }
                    : {}),
                }
              : undefined;
          const architecture =
            model.architecture && typeof model.architecture === "object"
              ? {
                  ...(typeof model.architecture.modality === "string"
                    ? { modality: model.architecture.modality }
                    : {}),
                  ...(Array.isArray(model.architecture.input_modalities)
                    ? {
                        input_modalities:
                          model.architecture.input_modalities.filter(
                            (modality: unknown): modality is string =>
                              typeof modality === "string",
                          ),
                      }
                    : {}),
                  ...(Array.isArray(model.architecture.output_modalities)
                    ? {
                        output_modalities:
                          model.architecture.output_modalities.filter(
                            (modality: unknown): modality is string =>
                              typeof modality === "string",
                          ),
                      }
                    : {}),
                }
              : undefined;
          return {
            id: model.id,
            ...(typeof model.owned_by === "string"
              ? { ownedBy: model.owned_by }
              : {}),
            ...(architecture && Object.keys(architecture).length
              ? { architecture }
              : {}),
            ...(pricing && Object.keys(pricing).length ? { pricing } : {}),
            ...(typeof model.context_length === "number" ||
            typeof model.context_length === "string"
              ? { context_length: model.context_length }
              : {}),
            ...(Array.isArray(model.supported_parameters)
              ? {
                  supported_parameters: model.supported_parameters.filter(
                    (parameter: unknown): parameter is string =>
                      typeof parameter === "string",
                  ),
                }
              : {}),
            ...(artificialAnalysis && Object.keys(artificialAnalysis).length
              ? {
                  benchmarks: {
                    artificial_analysis: artificialAnalysis,
                  },
                }
              : {}),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      throw providerError(error);
    }
  }
}
