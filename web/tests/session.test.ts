import { describe, expect, it, vi } from "vitest";
import { ensureRequestSession } from "../src/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ensureRequestSession", () => {
  it("deletes a session created after Stop aborts its request", async () => {
    const creation = deferred<string>();
    const controller = new AbortController();
    const installSession = vi.fn();
    const deleteSession = vi.fn(async () => undefined);

    const result = ensureRequestSession({
      generation: 1,
      currentGeneration: () => 1,
      signal: controller.signal,
      currentSession: () => null,
      createSession: () => creation.promise,
      installSession,
      deleteSession,
    });

    controller.abort();
    creation.resolve("late-session");

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(installSession).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith("late-session");
  });

  it("deletes a session created after New task advances the generation", async () => {
    const creation = deferred<string>();
    const controller = new AbortController();
    const installSession = vi.fn();
    const deleteSession = vi.fn(async () => undefined);
    let currentGeneration = 4;

    const result = ensureRequestSession({
      generation: 4,
      currentGeneration: () => currentGeneration,
      signal: controller.signal,
      currentSession: () => null,
      createSession: () => creation.promise,
      installSession,
      deleteSession,
    });

    currentGeneration += 1;
    creation.resolve("superseded-session");

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(installSession).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith("superseded-session");
  });

  it("installs a session while its request is still current", async () => {
    const controller = new AbortController();
    let installed: string | null = null;
    const deleteSession = vi.fn(async () => undefined);

    await expect(
      ensureRequestSession({
        generation: 7,
        currentGeneration: () => 7,
        signal: controller.signal,
        currentSession: () => installed,
        createSession: async () => "current-session",
        installSession: (sessionId) => {
          installed = sessionId;
        },
        deleteSession,
      }),
    ).resolves.toBe("current-session");

    expect(installed).toBe("current-session");
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
