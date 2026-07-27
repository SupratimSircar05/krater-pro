export type StreamEvent =
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
  | { type: "tool"; id: string; name: string; args?: unknown }
  | {
      type: "approval";
      id: string;
      toolCallId?: string;
      tool: string;
      args?: unknown;
      reason?: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output?: unknown;
      ok: boolean;
      cached?: boolean;
    }
  | { type: "usage"; [key: string]: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

export async function consumeSseEvents(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<"done" | "error"> {
  if (!response.body) throw new Error("The server returned an empty response.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: "done" | "error" | undefined;

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;

    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      throw new Error("Krater returned an unreadable stream event.");
    }
    onEvent(event);
    if (event.type === "done" || event.type === "error") terminal = event.type;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(processLine);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
  if (!terminal) {
    throw new Error(
      "Krater connection closed before the response completed. The partial answer may be incomplete; retry the request.",
    );
  }
  return terminal;
}
