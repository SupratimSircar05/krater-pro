const LOCAL_SESSION_ERROR = "Local session token missing or expired";

async function localSessionExpired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const payload = (await response.clone().json()) as {
      error?: { message?: unknown };
    };
    return (
      typeof payload.error?.message === "string" &&
      payload.error.message.includes(LOCAL_SESSION_ERROR)
    );
  } catch {
    return false;
  }
}

/**
 * The localhost server rotates its HttpOnly session token on every restart.
 * Its first 401 response installs the fresh cookie, so retrying that rejected
 * request once restores an already-open GUI without exposing token material to
 * JavaScript. The server rejects the request before any route handler runs,
 * making the retry safe for mutations too.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!(await localSessionExpired(response))) return response;
  return fetch(input, init);
}
