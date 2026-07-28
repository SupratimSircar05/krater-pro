import type { AvailableModel } from "./router.js";

export type JsonObject = Record<string, unknown>;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  providerRequests?: number;
}

export type ActionGateOutcome =
  | "change_required"
  | "partial_fix_requires_change"
  | "configuration_documentation_or_user_action"
  | "already_satisfied_no_change"
  | "cannot_establish_safely";

export class ProviderCompletionError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderCompletionError";
  }
}

export type AgentEvent =
  | {
      type: "task";
      id: string;
      state:
        | "intake"
        | "discovery"
        | "clarification"
        | "reproduction"
        | "staging"
        | "verification"
        | "review"
        | "publication"
        | "complete"
        | "abstained"
        | "blocked"
        | "accepted_with_gaps"
        | "cancelled";
    }
  | {
      type: "route";
      model: string;
      tier: "economy" | "balanced" | "premium";
      confidence: number;
      complexity: "routine" | "standard" | "advanced" | "expert";
      risk: "low" | "medium" | "high";
      reasons: string[];
      catalog: "live" | "fallback";
    }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: JsonObject }
  | {
      type: "approval";
      id: string;
      toolCallId: string;
      tool: string;
      args: JsonObject;
      reason: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output: string;
      ok: boolean;
      cached?: boolean;
    }
  | {
      type: "action_gate";
      outcome: ActionGateOutcome;
      shouldStageCode: boolean;
      reasons: string[];
      evidenceRefs: string[];
    }
  | {
      type: "evidence";
      id: string;
      kind: string;
      grade:
        | "not_established"
        | "observed"
        | "tested"
        | "stress_tested"
        | "formally_verified";
      summary: string;
      ok: boolean;
    }
  | {
      type: "verdict";
      taskId: string;
      state:
        | "complete"
        | "abstained"
        | "blocked"
        | "accepted_with_gaps"
        | "review";
      evidenceGrade:
        | "not_established"
        | "observed"
        | "tested"
        | "stress_tested"
        | "formally_verified";
      gaps: string[];
    }
  | ({
      type: "usage";
      sessionPromptTokens?: number;
      sessionCompletionTokens?: number;
      sessionTotalTokens?: number;
      sessionCachedTokens?: number;
      requestCount?: number;
    } & Usage)
  | { type: "done"; steps: number }
  | { type: "error"; message: string };

export interface AssistantTurn {
  message: Extract<ModelMessage, { role: "assistant" }>;
  usage?: Usage;
}

export interface ChatProvider {
  complete(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn>;
  listModels(signal?: AbortSignal): Promise<AvailableModel[]>;
}

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  tool: string;
  args: JsonObject;
  reason: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
