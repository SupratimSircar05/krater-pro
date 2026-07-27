import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_MODEL,
  chatWithKrater,
  validateKraterKey,
} from "../lib/krater";
import { MAX_MESSAGE_BYTES } from "../lib/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Krater cloud BYOK client", () => {
  it("validates against the fixed models endpoint and exact Kimi K3 ID", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      data: [{ id: CLOUD_MODEL }, { id: "another-model" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateKraterKey("private-test-key")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.krater.ai/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer private-test-key",
    );
  });

  it("pins chat to non-streaming Kimi K3 and returns bounded usage fields", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.model).toBe("moonshotai/kimi-k3");
      expect(request.stream).toBe(false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "A safe answer." } }],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatWithKrater(
      "private-test-key",
      [{ role: "user", content: "Write a function." }],
    )).resolves.toEqual({
      reply: "A safe answer.",
      usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.krater.ai/v1/chat/completions",
    );
  });

  it("does not include a rejected API key in provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "bad private-test-key" }),
      { status: 401 },
    )));
    await expect(validateKraterKey("private-test-key")).resolves.toBe(false);
    await expect(chatWithKrater(
      "private-test-key",
      [{ role: "user", content: "Hello" }],
    )).rejects.not.toThrow(/private-test-key/u);
  });

  it("returns only replies that can be persisted in a saved snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "界".repeat(10_000) } }],
      usage: {},
    }), { status: 200 })));
    const result = await chatWithKrater(
      "private-test-key",
      [{ role: "user", content: "Hello" }],
    );
    expect(new TextEncoder().encode(result.reply).byteLength)
      .toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(result.reply).toContain("[Response truncated");
    expect(result.reply).not.toContain("\uFFFD");
  });
});
