type RequestBoundSessionOptions = {
  generation: number;
  currentGeneration: () => number;
  signal: AbortSignal;
  currentSession: () => string | null;
  createSession: () => Promise<string>;
  installSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => Promise<unknown> | unknown;
};

function supersededRequestError() {
  return new DOMException(
    "Session creation was cancelled by a newer request.",
    "AbortError",
  );
}

function requestIsCurrent(
  options: Pick<
    RequestBoundSessionOptions,
    "generation" | "currentGeneration" | "signal"
  >,
) {
  return (
    !options.signal.aborted &&
    options.currentGeneration() === options.generation
  );
}

/**
 * Creates a browser session only while its originating agent request is still
 * current. Creation itself is allowed to finish after cancellation so its
 * server-issued ID can be explicitly deleted instead of being leaked.
 */
export async function ensureRequestSession(
  options: RequestBoundSessionOptions,
): Promise<string> {
  if (!requestIsCurrent(options)) throw supersededRequestError();

  const existingSession = options.currentSession();
  if (existingSession) return existingSession;

  const createdSession = await options.createSession();
  if (!requestIsCurrent(options)) {
    await options.deleteSession(createdSession);
    throw supersededRequestError();
  }

  // A second creation may have won while this request was awaiting the server.
  // Keep the already-installed session and dispose of this redundant one.
  const installedSession = options.currentSession();
  if (installedSession) {
    if (installedSession !== createdSession) {
      await options.deleteSession(createdSession);
    }
    return installedSession;
  }

  options.installSession(createdSession);
  return createdSession;
}
