import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("apiFetch", () => {
  it("captures the launch fragment, removes it from the URL, and authenticates the local API", async () => {
    const bootstrapToken = "a".repeat(43);
    const sessionToken = "c".repeat(43);
    const storage = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: `#__krater_session=${bootstrapToken}&view=evidence`,
        href: `http://127.0.0.1:4317/#__krater_session=${bootstrapToken}&view=evidence`,
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const exchange = new Response(JSON.stringify({ token: sessionToken }), {
      status: 200,
    });
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(exchange)
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    await expect(apiFetch("/api/status")).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/local-session");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-krater-bootstrap-token",
      ),
    ).toBe(bootstrapToken);
    const requestInit = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(requestInit?.headers).get("x-krater-local-token")).toBe(
      sessionToken,
    );
    expect(storage.get("krater_pro_local_session")).toBe(sessionToken);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#view=evidence");
  });

  it("does not send the loopback token to a different origin", async () => {
    const token = "b".repeat(43);
    vi.stubGlobal("window", {
      location: {
        hash: "",
        href: "http://127.0.0.1:4317/",
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => token,
        setItem: vi.fn(),
      },
    });
    const denied = new Response(
      JSON.stringify({ error: { message: "Krater rejected the API key." } }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(denied);
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    await expect(
      apiFetch("https://attacker.example/api/models"),
    ).resolves.toBe(denied);
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(
      new Headers(requestInit?.headers).has("x-krater-local-token"),
    ).toBe(false);
  });

  it("shares one bootstrap exchange across concurrent startup requests", async () => {
    const bootstrapToken = "d".repeat(43);
    const sessionToken = "e".repeat(43);
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      location: {
        hash: `#__krater_session=${bootstrapToken}`,
        href: `http://127.0.0.1:4317/#__krater_session=${bootstrapToken}`,
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
        if (String(input) === "/api/local-session") {
          await Promise.resolve();
          return new Response(JSON.stringify({ token: sessionToken }), {
            status: 200,
          });
        }
        expect(
          new Headers(init?.headers).get("x-krater-local-token"),
        ).toBe(sessionToken);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    const [status, projects] = await Promise.all([
      apiFetch("/api/status"),
      apiFetch("/api/projects"),
    ]);

    expect(status.status).toBe(200);
    expect(projects.status).toBe(200);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/local-session",
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves headers carried by a same-origin Request object", async () => {
    const sessionToken = "f".repeat(43);
    vi.stubGlobal("window", {
      location: {
        hash: "",
        href: "http://127.0.0.1:4317/",
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => sessionToken,
        setItem: vi.fn(),
      },
    });
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");
    const request = new Request("http://127.0.0.1:4317/api/ide/file", {
      headers: { "if-match": "revision-a" },
    });

    await expect(apiFetch(request)).resolves.toBe(response);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("if-match")).toBe("revision-a");
    expect(headers.get("x-krater-local-token")).toBe(sessionToken);
  });

  it("does not repeat a definitively rejected bootstrap exchange", async () => {
    const bootstrapToken = "g".repeat(43);
    vi.stubGlobal("window", {
      location: {
        hash: `#__krater_session=${bootstrapToken}`,
        href: `http://127.0.0.1:4317/#__krater_session=${bootstrapToken}`,
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/local-session"
        ? new Response(null, { status: 401 })
        : new Response(null, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    await apiFetch("/api/status");
    await apiFetch("/api/projects");

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/local-session",
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers when a fresh launch fragment is opened in an existing bare tab", async () => {
    const bootstrapToken = "h".repeat(43);
    const sessionToken = "i".repeat(43);
    const storage = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    const location = {
      hash: "",
      href: "http://127.0.0.1:4317/",
      origin: "http://127.0.0.1:4317",
      pathname: "/",
      search: "",
      reload,
    };
    vi.stubGlobal("window", {
      location,
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/local-session"
        ? new Response(JSON.stringify({ token: sessionToken }), { status: 200 })
        : new Response(null, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");
    await apiFetch("/api/status");

    location.hash = `#__krater_session=${bootstrapToken}`;
    listeners.get("hashchange")?.();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storage.get("krater_pro_local_session")).toBe(sessionToken);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/local-session",
      ),
    ).toHaveLength(1);
  });

  it("keeps a fresh bootstrap retryable and does not reload for a stale stored token", async () => {
    const staleSessionToken = "j".repeat(43);
    const bootstrapToken = "k".repeat(43);
    const freshSessionToken = "l".repeat(43);
    const storage = new Map<string, string>([
      ["krater_pro_local_session", staleSessionToken],
    ]);
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    const location = {
      hash: "",
      href: "http://127.0.0.1:4317/",
      origin: "http://127.0.0.1:4317",
      pathname: "/",
      search: "",
      reload,
    };
    vi.stubGlobal("window", {
      location,
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
    });
    let exchangeCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "/api/local-session") {
        exchangeCount += 1;
        expect(
          new Headers(init?.headers).get("x-krater-bootstrap-token"),
        ).toBe(bootstrapToken);
        if (exchangeCount === 1) {
          return new Response(null, { status: 500 });
        }
        return new Response(JSON.stringify({ token: freshSessionToken }), {
          status: 200,
        });
      }
      expect(
        new Headers(init?.headers).get("x-krater-local-token"),
      ).toBe(freshSessionToken);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    location.hash = `#__krater_session=${bootstrapToken}`;
    listeners.get("hashchange")?.();
    await vi.waitFor(() => expect(exchangeCount).toBe(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(reload).not.toHaveBeenCalled();
    await expect(apiFetch("/api/status")).resolves.toMatchObject({
      status: 204,
    });
    expect(exchangeCount).toBe(2);
    expect(storage.get("krater_pro_local_session")).toBe(freshSessionToken);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keys concurrent exchanges so a fresh fragment survives an older rejection", async () => {
    const firstBootstrap = "m".repeat(43);
    const secondBootstrap = "n".repeat(43);
    const sessionToken = "o".repeat(43);
    const storage = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    const location = {
      hash: `#__krater_session=${firstBootstrap}`,
      href: `http://127.0.0.1:4317/#__krater_session=${firstBootstrap}`,
      origin: "http://127.0.0.1:4317",
      pathname: "/",
      search: "",
      reload,
    };
    vi.stubGlobal("window", {
      location,
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
    });
    let resolveFirstExchange!: (response: Response) => void;
    const firstExchange = new Promise<Response>((resolve) => {
      resolveFirstExchange = resolve;
    });
    let exchangeCount = 0;
    const seenBootstrapTokens: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "/api/local-session") {
        exchangeCount += 1;
        seenBootstrapTokens.push(
          new Headers(init?.headers).get("x-krater-bootstrap-token") ?? "",
        );
        if (exchangeCount === 1) return firstExchange;
        return new Response(JSON.stringify({ token: sessionToken }), {
          status: 200,
        });
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    const firstRequest = apiFetch("/api/status");
    await vi.waitFor(() => expect(exchangeCount).toBe(1));

    location.hash = `#__krater_session=${secondBootstrap}`;
    listeners.get("hashchange")?.();
    await vi.waitFor(() => expect(exchangeCount).toBe(2));
    resolveFirstExchange(new Response(null, { status: 401 }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await expect(firstRequest).resolves.toMatchObject({ status: 401 });
    expect(seenBootstrapTokens).toEqual([
      firstBootstrap,
      secondBootstrap,
    ]);
    expect(storage.get("krater_pro_local_session")).toBe(sessionToken);
  });

  it("does not retry an authorization failure or mint new local state", async () => {
    vi.stubGlobal("window", {
      location: {
        hash: "",
        href: "http://127.0.0.1:4317/",
        origin: "http://127.0.0.1:4317",
        pathname: "/",
        search: "",
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => null,
        setItem: vi.fn(),
      },
    });
    const denied = new Response(null, { status: 401 });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(denied);
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/api");

    await expect(apiFetch("/api/status")).resolves.toBe(denied);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
