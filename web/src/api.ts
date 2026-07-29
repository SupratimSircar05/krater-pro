const LOCAL_SESSION_FRAGMENT = "__krater_session";
const LOCAL_SESSION_STORAGE_KEY = "krater_pro_local_session";
const LOCAL_SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

let inMemoryToken: string | undefined;
let launchBootstrapToken: string | undefined;
type LocalSessionResolution = {
  token: string | undefined;
  exchanged: boolean;
};

const exchangePromises = new Map<
  string,
  Promise<LocalSessionResolution>
>();
let lastCapturedFragment: string | undefined;

function captureLaunchBootstrap(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const rawFragment = window.location.hash;
  if (rawFragment === lastCapturedFragment) return launchBootstrapToken;
  lastCapturedFragment = rawFragment;
  const fragment = new URLSearchParams(rawFragment.slice(1));
  const bootstrap = fragment.get(LOCAL_SESSION_FRAGMENT) ?? undefined;
  if (bootstrap !== undefined) {
    fragment.delete(LOCAL_SESSION_FRAGMENT);
    const remainingFragment = fragment.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${
        remainingFragment ? `#${remainingFragment}` : ""
      }`,
    );
    if (LOCAL_SESSION_TOKEN.test(bootstrap)) {
      launchBootstrapToken = bootstrap;
    }
  }
  return launchBootstrapToken;
}

function storedLocalSessionToken(): string | undefined {
  if (inMemoryToken) return inMemoryToken;
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
    if (stored && LOCAL_SESSION_TOKEN.test(stored)) {
      inMemoryToken = stored;
    }
  } catch {
    // The server will return an authentication error if no launch token exists.
  }
  return inMemoryToken;
}

function exchangeLocalBootstrap(
  bootstrap: string,
  existing: string | undefined,
): Promise<LocalSessionResolution> {
  const active = exchangePromises.get(bootstrap);
  if (active) return active;

  const pending = (async (): Promise<LocalSessionResolution> => {
    try {
      const response = await fetch("/api/local-session", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "x-krater-bootstrap-token": bootstrap },
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          if (launchBootstrapToken === bootstrap) {
            launchBootstrapToken = undefined;
          }
        }
        return { token: existing, exchanged: false };
      }
      const value = (await response.json()) as { token?: unknown };
      if (
        typeof value.token !== "string" ||
        !LOCAL_SESSION_TOKEN.test(value.token)
      ) {
        if (launchBootstrapToken === bootstrap) {
          launchBootstrapToken = undefined;
        }
        return { token: existing, exchanged: false };
      }
      inMemoryToken = value.token;
      if (launchBootstrapToken === bootstrap) {
        launchBootstrapToken = undefined;
      }
      try {
        window.sessionStorage.setItem(
          LOCAL_SESSION_STORAGE_KEY,
          value.token,
        );
      } catch {
        // In-memory authorization still works when browser storage is disabled.
      }
      return { token: value.token, exchanged: true };
    } catch {
      return { token: existing, exchanged: false };
    }
  })();
  exchangePromises.set(bootstrap, pending);
  const cleanup = () => {
    if (exchangePromises.get(bootstrap) === pending) {
      exchangePromises.delete(bootstrap);
    }
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

async function resolveLocalSession(): Promise<LocalSessionResolution> {
  const bootstrap = captureLaunchBootstrap();
  const existing = storedLocalSessionToken();
  if (!bootstrap) return { token: existing, exchanged: false };
  return exchangeLocalBootstrap(bootstrap, existing);
}

async function localSessionToken(): Promise<string | undefined> {
  return (await resolveLocalSession()).token;
}

function sameOriginApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  const target =
    input instanceof Request
      ? new URL(input.url)
      : new URL(String(input), window.location.href);
  return (
    target.origin === window.location.origin &&
    (target.pathname === "/api" || target.pathname.startsWith("/api/"))
  );
}

if (typeof window !== "undefined") {
  window.addEventListener?.("hashchange", () => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const candidate = fragment.get(LOCAL_SESSION_FRAGMENT);
    if (!candidate || !LOCAL_SESSION_TOKEN.test(candidate)) return;
    const captured = captureLaunchBootstrap();
    if (captured !== candidate) return;
    void exchangeLocalBootstrap(candidate, storedLocalSessionToken()).then(
      ({ exchanged }) => {
        if (exchanged) window.location.reload();
      },
    );
  });
}

/**
 * The launch URL carries a one-use bootstrap secret in its fragment. Browsers
 * do not send fragments to HTTP servers; the UI removes it from the address
 * bar, exchanges it once, and keeps the returned bearer in origin-scoped
 * session state. Unlike a cookie, that bearer cannot leak to another loopback
 * port.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!sameOriginApiRequest(input)) return fetch(input, init);
  const token = await localSessionToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("x-krater-local-token", token);
  return fetch(input, { ...init, headers });
}
