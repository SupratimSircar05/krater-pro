import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("retries once when a server restart rotates the local session cookie", async () => {
    const expired = new Response(
      JSON.stringify({
        error: {
          message:
            "Local session token missing or expired. Reload the Krater Pro page.",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
    const recovered = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(recovered);
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/status");

    expect(response).toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated authorization failures", async () => {
    const denied = new Response(
      JSON.stringify({ error: { message: "Krater rejected the API key." } }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(denied);
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/models")).resolves.toBe(denied);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
