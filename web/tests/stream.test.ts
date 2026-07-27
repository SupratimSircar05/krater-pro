import { describe, expect, it, vi } from "vitest";
import { consumeSseEvents, type StreamEvent } from "../src/stream.js";

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("consumeSseEvents", () => {
  it("parses frames split across transport chunks and requires done", async () => {
    const events: StreamEvent[] = [];
    const response = streamedResponse([
      'data: {"type":"te',
      'xt","text":"hel',
      'lo"}\n\ndata: {"type":"usage","totalTokens":3}\n',
      '\ndata: {"type":"done"}\n\n',
    ]);

    await expect(consumeSseEvents(response, (event) => events.push(event))).resolves.toBe(
      "done",
    );
    expect(events).toEqual([
      { type: "text", text: "hello" },
      { type: "usage", totalTokens: 3 },
      { type: "done" },
    ]);
  });

  it("surfaces premature EOF instead of accepting a partial answer", async () => {
    const onEvent = vi.fn();
    const response = streamedResponse([
      'data: {"type":"text","text":"partial"}\n\n',
    ]);

    await expect(consumeSseEvents(response, onEvent)).rejects.toThrow(
      /closed before the response completed/i,
    );
    expect(onEvent).toHaveBeenCalledWith({ type: "text", text: "partial" });
  });

  it("accepts an explicit error event as a terminal outcome", async () => {
    const events: StreamEvent[] = [];
    const response = streamedResponse([
      'data: {"type":"error","message":"provider unavailable"}\n\n',
    ]);

    await expect(consumeSseEvents(response, (event) => events.push(event))).resolves.toBe(
      "error",
    );
    expect(events).toEqual([
      { type: "error", message: "provider unavailable" },
    ]);
  });
});
