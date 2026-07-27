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
}

export type AgentEvent =
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
  listModels(signal?: AbortSignal): Promise<Array<{ id: string; ownedBy?: string }>>;
}

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  tool: string;
  args: JsonObject;
  reason: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
