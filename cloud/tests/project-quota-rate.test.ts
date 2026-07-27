import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/api/[[path]]";
import { CLOUD_MODEL } from "../lib/krater";
import {
  KEY_VALIDATION_RATE_LIMIT,
  KEY_VALIDATION_RATE_WINDOW_SECONDS,
  LOGIN_ACCOUNT_RATE_LIMIT,
  LOGIN_ACCOUNT_RATE_WINDOW_SECONDS,
  MAX_ACCOUNT_PROJECT_BYTES,
  MAX_PROJECTS,
  PROJECT_MUTATION_RATE_LIMIT,
  PROJECT_MUTATION_RATE_WINDOW_SECONDS,
  SESSION_COOKIE,
  hashPassword,
} from "../lib/security";
import type {
  CloudEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
  PagesFunctionContext,
} from "../lib/types";

const projectId = "2effd736-0cc7-46a7-a0bd-cbd28c47270c";
const timestamp = Math.floor(Date.now() / 1000);
const snapshot = {
  files: [{ path: "README.md", content: "# Project" }],
  messages: [],
  activePath: "README.md",
};

interface DatabaseOptions {
  userId?: string;
  sessionExpiresAt?: number;
  readiness?: "ready" | "empty" | "error";
  rateCounts?: Map<string, number>;
  userRow?: Record<string, unknown>;
  insertRow?: Record<string, unknown> | null;
  updateRow?: Record<string, unknown> | null;
  existingProject?: boolean;
  quota?: { project_count: number; snapshot_bytes: number };
}

class QuotaStatement implements D1PreparedStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly options: DatabaseOptions,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const userId = this.options.userId ?? "user-a";
    if (this.query === "SELECT 1 AS ready") {
      if (this.options.readiness === "error") {
        throw new Error("Synthetic D1 failure.");
      }
      return this.options.readiness === "empty" ? null : { ready: 1 } as T;
    }
    if (this.query.includes("RETURNING count")) {
      if (!this.options.rateCounts) return { count: 1 } as T;
      const key = `${String(this.values[0])}:${String(this.values[1])}:${String(this.values[2])}`;
      const count = (this.options.rateCounts.get(key) ?? 0) + 1;
      this.options.rateCounts.set(key, count);
      return { count } as T;
    }
    if (this.query.includes("FROM sessions s")) {
      return {
        token_hash: "token-hash",
        user_id: userId,
        issued_at: timestamp,
        expires_at: this.options.sessionExpiresAt ?? timestamp + 3600,
        user_email: `${userId}@example.com`,
        user_created_at: timestamp - 60,
      } as T;
    }
    if (this.query.includes("FROM users WHERE email")) {
      return (this.options.userRow ?? null) as T | null;
    }
    if (this.query.startsWith("INSERT INTO projects")) {
      return (this.options.insertRow ?? null) as T | null;
    }
    if (this.query.startsWith("UPDATE projects SET")) {
      return (this.options.updateRow ?? null) as T | null;
    }
    if (this.query.includes("AS project_count")) {
      return (this.options.quota ?? {
        project_count: 0,
        snapshot_bytes: 0,
      }) as T;
    }
    if (this.query.includes("FROM projects WHERE id")) {
      if (!this.options.existingProject) return null;
      return {
        id: projectId,
        user_id: userId,
        name: "Existing",
        snapshot_json: JSON.stringify(snapshot),
        created_at: timestamp - 30,
        updated_at: timestamp,
      } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }

  async run<T>(): Promise<D1Result<T>> {
    if (
      this.query === "DELETE FROM rate_limits WHERE scope = ? AND client_hash = ?"
      && this.options.rateCounts
    ) {
      const prefix = `${String(this.values[0])}:${String(this.values[1])}:`;
      for (const key of this.options.rateCounts.keys()) {
        if (key.startsWith(prefix)) this.options.rateCounts.delete(key);
      }
    }
    return { success: true, results: [] };
  }
}

class QuotaDatabase implements D1Database {
  readonly statements: QuotaStatement[] = [];

  constructor(private readonly options: DatabaseOptions = {}) {}

  prepare(query: string): D1PreparedStatement {
    const statement = new QuotaStatement(query, this.options);
    this.statements.push(statement);
    return statement;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>> {
    const results: Array<D1Result<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

function context(
  db: D1Database,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: HeadersInit,
  envOverrides?: Partial<CloudEnv>,
): PagesFunctionContext<CloudEnv> {
  return {
    request: new Request(`https://krater-pro.pages.dev${path}`, {
      method,
      headers: {
        Origin: "https://krater-pro.pages.dev",
        Cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env: {
      DB: db,
      RATE_LIMIT_SALT: "test-rate-limit-salt-value",
      PASSWORD_PEPPER: "test-password-pepper-value-32-bytes",
      ...envOverrides,
    },
    params: {},
    waitUntil: () => undefined,
  };
}

function rateScope(db: QuotaDatabase): unknown {
  return db.statements.find((statement) =>
    statement.query.includes("INSERT INTO rate_limits"))?.values[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("project quotas and mutation limits", () => {
  it("reports minimal readiness only when secrets and D1 are ready", async () => {
    const response = await onRequest(context(
      new QuotaDatabase({ readiness: "ready" }),
      "GET",
      "/api/health",
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns generic 503 readiness errors for missing or short secrets", async () => {
    const cases: Array<Partial<CloudEnv>> = [
      { PASSWORD_PEPPER: undefined },
      { PASSWORD_PEPPER: "too-short" },
      { RATE_LIMIT_SALT: undefined },
      { RATE_LIMIT_SALT: "short" },
    ];
    for (const overrides of cases) {
      const db = new QuotaDatabase({ readiness: "ready" });
      const response = await onRequest(context(
        db,
        "GET",
        "/api/health",
        undefined,
        undefined,
        overrides,
      ));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "configuration_error",
          message: "Service unavailable.",
        },
      });
      expect(db.statements).toHaveLength(0);
    }
  });

  it("returns generic 503 readiness errors when D1 fails", async () => {
    for (const readiness of ["empty", "error"] as const) {
      const response = await onRequest(context(
        new QuotaDatabase({ readiness }),
        "GET",
        "/api/health",
      ));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "service_unavailable",
          message: "Service unavailable.",
        },
      });
    }
  });

  it("publishes the sharply bounded quota and rate configuration", () => {
    expect(MAX_PROJECTS).toBe(10);
    expect(MAX_ACCOUNT_PROJECT_BYTES).toBe(524_288);
    expect(PROJECT_MUTATION_RATE_LIMIT).toBe(300);
    expect(PROJECT_MUTATION_RATE_WINDOW_SECONDS).toBe(3600);
    expect(KEY_VALIDATION_RATE_LIMIT).toBe(20);
    expect(KEY_VALIDATION_RATE_WINDOW_SECONDS).toBe(900);
    expect(LOGIN_ACCOUNT_RATE_LIMIT).toBe(12);
    expect(LOGIN_ACCOUNT_RATE_WINDOW_SECONDS).toBe(900);
  });

  it("returns project_limit when the atomic create reaches ten projects", async () => {
    const db = new QuotaDatabase({
      insertRow: null,
      quota: { project_count: 10, snapshot_bytes: 1_000 },
    });
    const response = await onRequest(context(db, "POST", "/api/projects", {
      name: "Eleventh",
      snapshot,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "project_limit" },
    });
    expect(rateScope(db)).toBe("project_mutation");
  });

  it("returns storage_limit when aggregate create bytes exceed 512 KiB", async () => {
    const db = new QuotaDatabase({
      insertRow: null,
      quota: {
        project_count: 2,
        snapshot_bytes: MAX_ACCOUNT_PROJECT_BYTES - 1,
      },
    });
    const response = await onRequest(context(db, "POST", "/api/projects", {
      name: "Too much",
      snapshot,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "storage_limit" },
    });
    const insert = db.statements.find((statement) =>
      statement.query.startsWith("INSERT INTO projects"));
    expect(insert?.query).toMatch(/LENGTH\(CAST\(\? AS BLOB\)\) <= \?/u);
    expect(insert?.values.at(-1)).toBe(MAX_ACCOUNT_PROJECT_BYTES);
  });

  it("returns storage_limit when an owned update exceeds aggregate bytes", async () => {
    const db = new QuotaDatabase({ updateRow: null, existingProject: true });
    const response = await onRequest(context(
      db,
      "PUT",
      `/api/projects/${projectId}`,
      { name: "Larger", snapshot },
    ));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "storage_limit" },
    });
    const update = db.statements.find((statement) =>
      statement.query.startsWith("UPDATE projects SET"));
    expect(update?.query).toMatch(
      /id = \? AND user_id = \?[\s\S]+user_id = \? AND id <> \?/u,
    );
    expect(update?.values.slice(3, 7)).toEqual([
      projectId,
      "user-a",
      "user-a",
      projectId,
    ]);
    expect(rateScope(db)).toBe("project_mutation");
  });

  it("routes DELETE through the same project mutation bucket", async () => {
    const db = new QuotaDatabase({ existingProject: true });
    const response = await onRequest(
      context(db, "DELETE", `/api/projects/${projectId}`),
    );
    expect(response.status).toBe(200);
    expect(rateScope(db)).toBe("project_mutation");
  });

  it("isolates project mutation limits by authenticated user on a shared IP", async () => {
    const firstDb = new QuotaDatabase({
      userId: "user-a",
      quota: { project_count: MAX_PROJECTS, snapshot_bytes: 1 },
    });
    const secondDb = new QuotaDatabase({
      userId: "user-b",
      quota: { project_count: MAX_PROJECTS, snapshot_bytes: 1 },
    });
    const headers = { "CF-Connecting-IP": "203.0.113.8" };
    await onRequest(context(firstDb, "POST", "/api/projects", {
      name: "A",
      snapshot,
    }, headers));
    await onRequest(context(secondDb, "POST", "/api/projects", {
      name: "B",
      snapshot,
    }, headers));
    const firstRate = firstDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    const secondRate = secondDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    expect(firstRate?.values[0]).toBe("project_mutation");
    expect(secondRate?.values[0]).toBe("project_mutation");
    expect(firstRate?.values[1]).not.toBe(secondRate?.values[1]);
  });

  it("isolates chat limits by authenticated user on a shared IP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Reply" } }],
      usage: {},
    }), { status: 200 })));
    const firstDb = new QuotaDatabase({ userId: "user-a", existingProject: true });
    const secondDb = new QuotaDatabase({ userId: "user-b", existingProject: true });
    const headers = {
      "CF-Connecting-IP": "203.0.113.9",
      "X-Krater-API-Key": "private-test-key",
    };
    const body = {
      projectId,
      message: "Help",
      model: CLOUD_MODEL,
    };
    const first = await onRequest(
      context(firstDb, "POST", "/api/chat", body, headers),
    );
    const second = await onRequest(
      context(secondDb, "POST", "/api/chat", body, headers),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstRate = firstDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    const secondRate = secondDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    expect(firstRate?.values[0]).toBe("chat");
    expect(secondRate?.values[0]).toBe("chat");
    expect(firstRate?.values[1]).not.toBe(secondRate?.values[1]);
  });

  it("rate-limits key validation by the combined authenticated user and IP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: CLOUD_MODEL }],
    }), { status: 200 })));
    const firstDb = new QuotaDatabase({ userId: "user-a" });
    const secondDb = new QuotaDatabase({ userId: "user-b" });
    const headers = {
      "X-Krater-API-Key": "private-test-key",
      "CF-Connecting-IP": "203.0.113.4",
    };
    const first = await onRequest(context(
      firstDb,
      "POST",
      "/api/key/validate",
      undefined,
      headers,
    ));
    const second = await onRequest(context(
      secondDb,
      "POST",
      "/api/key/validate",
      undefined,
      headers,
    ));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstRate = firstDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    const secondRate = secondDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO rate_limits"));
    expect(firstRate?.values[0]).toBe("key_validate");
    expect(secondRate?.values[0]).toBe("key_validate");
    expect(firstRate?.values[1]).not.toBe(secondRate?.values[1]);
  });

  it("fails closed in production when the rate-limit salt is absent", async () => {
    const db = new QuotaDatabase();
    const response = await onRequest(context(
      db,
      "POST",
      "/api/auth/register",
      { email: "new@example.com", password: "a secure password" },
      { "CF-Connecting-IP": "203.0.113.5" },
      { RATE_LIMIT_SALT: undefined },
    ));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "configuration_error",
        message: "Service configuration error.",
      },
    });
    expect(db.statements).toHaveLength(0);
  });

  it("fails registration closed when the password pepper is missing or short", async () => {
    for (const passwordPepper of [undefined, "too-short"]) {
      const db = new QuotaDatabase();
      const response = await onRequest(context(
        db,
        "POST",
        "/api/auth/register",
        { email: "new@example.com", password: "a secure password" },
        undefined,
        { PASSWORD_PEPPER: passwordPepper },
      ));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "configuration_error" },
      });
      expect(db.statements.some((statement) =>
        statement.query.includes("INSERT INTO users"))).toBe(false);
    }
  });

  it("enforces the 15-character boundary in a production-style register flow", async () => {
    const productionHeaders = { "CF-Connecting-IP": "203.0.113.20" };
    const rejectedDb = new QuotaDatabase();
    const rejected = await onRequest(context(
      rejectedDb,
      "POST",
      "/api/auth/register",
      { email: "boundary@example.com", password: "x".repeat(14) },
      productionHeaders,
    ));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "invalid_password" },
    });
    expect(rejectedDb.statements.some((statement) =>
      statement.query.includes("INSERT INTO users"))).toBe(false);

    const acceptedDb = new QuotaDatabase();
    const acceptedPassword = "x".repeat(15);
    const accepted = await onRequest(context(
      acceptedDb,
      "POST",
      "/api/auth/register",
      { email: "boundary@example.com", password: acceptedPassword },
      productionHeaders,
    ));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      user: { email: "boundary@example.com" },
    });
    const userInsert = acceptedDb.statements.find((statement) =>
      statement.query.includes("INSERT INTO users"));
    expect(userInsert?.values[2]).not.toBe(acceptedPassword);
    expect(userInsert?.values[4]).toBe(100_000);
  });

  it("fails login closed when the password pepper is missing or short", async () => {
    for (const passwordPepper of [undefined, "too-short"]) {
      const db = new QuotaDatabase();
      const response = await onRequest(context(
        db,
        "POST",
        "/api/auth/login",
        { email: "new@example.com", password: "a secure password" },
        undefined,
        { PASSWORD_PEPPER: passwordPepper },
      ));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "configuration_error",
          message: "Service configuration error.",
        },
      });
      expect(db.statements.some((statement) =>
        statement.query.includes("FROM users WHERE email"))).toBe(false);
    }
  });

  it("fails protected session authentication closed without the pepper", async () => {
    const db = new QuotaDatabase();
    const response = await onRequest(context(
      db,
      "GET",
      "/api/me",
      undefined,
      undefined,
      { PASSWORD_PEPPER: undefined },
    ));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "configuration_error" },
    });
    expect(db.statements).toHaveLength(0);
  });

  it("performs keyed PBKDF2 work for a nonexistent-user login", async () => {
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
    const sign = vi.spyOn(globalThis.crypto.subtle, "sign");
    const db = new QuotaDatabase();
    const response = await onRequest(context(
      db,
      "POST",
      "/api/auth/login",
      { email: "missing@example.com", password: "a secure password" },
    ));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_credentials" },
    });
    expect(sign).toHaveBeenCalledOnce();
    expect(deriveBits).toHaveBeenCalledOnce();
  });

  it("shares a secret-hashed email bucket across distributed login IPs", async () => {
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
    const rateCounts = new Map<string, number>();
    const db = new QuotaDatabase({ rateCounts });
    const rawEmails = [
      " Distributed@Example.COM ",
      "distributed@example.com",
    ];

    for (let attempt = 0; attempt <= LOGIN_ACCOUNT_RATE_LIMIT; attempt += 1) {
      const response = await onRequest(context(
        db,
        "POST",
        "/api/auth/login",
        {
          email: rawEmails[attempt % rawEmails.length],
          password: "a secure password",
        },
        { "CF-Connecting-IP": `203.0.113.${40 + (attempt % 2)}` },
      ));
      expect(response.status).toBe(
        attempt < LOGIN_ACCOUNT_RATE_LIMIT ? 401 : 429,
      );
    }

    const accountReservations = db.statements.filter((statement) =>
      statement.query.includes("INSERT INTO rate_limits")
      && statement.values[0] === "login_account");
    expect(accountReservations).toHaveLength(LOGIN_ACCOUNT_RATE_LIMIT + 1);
    expect(new Set(accountReservations.map((statement) => statement.values[1])).size)
      .toBe(1);
    for (const statement of accountReservations) {
      expect(statement.values).not.toContain("distributed@example.com");
      expect(statement.values).not.toContain(" Distributed@Example.COM ");
    }
    expect(deriveBits).toHaveBeenCalledTimes(LOGIN_ACCOUNT_RATE_LIMIT);
  });

  it("does not retain successful reservations and atomically clears prior failures", async () => {
    const password = "correct password value";
    const pepper = "test-password-pepper-value-32-bytes";
    const passwordRecord = await hashPassword(password, pepper);
    const rateCounts = new Map<string, number>();
    const db = new QuotaDatabase({
      rateCounts,
      userRow: {
        id: "user-a",
        email: "person@example.com",
        password_hash: passwordRecord.hash,
        password_salt: passwordRecord.salt,
        password_iterations: passwordRecord.iterations,
        created_at: timestamp - 60,
        updated_at: timestamp - 60,
      },
    });
    const login = (candidate: string) => onRequest(context(
      db,
      "POST",
      "/api/auth/login",
      { email: "Person@Example.COM", password: candidate },
      { "CF-Connecting-IP": "203.0.113.70" },
    ));

    expect((await login("wrong password value")).status).toBe(401);
    expect((await login("another wrong value")).status).toBe(401);
    expect(
      [...rateCounts.keys()].some((key) => key.startsWith("login_account:")),
    ).toBe(true);

    const success = await login(password);
    expect(success.status).toBe(200);
    expect(
      [...rateCounts.keys()].some((key) => key.startsWith("login_account:")),
    ).toBe(false);

    const secondSuccess = await login(password);
    expect(secondSuccess.status).toBe(200);
    const accountReservations = db.statements.filter((statement) =>
      statement.query.includes("INSERT INTO rate_limits")
      && statement.values[0] === "login_account");
    expect(accountReservations).toHaveLength(4);
  });

  it("atomically caps concurrent cross-IP reservations before password crypto", async () => {
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
    const rateCounts = new Map<string, number>();
    const db = new QuotaDatabase({ rateCounts });
    const attempts = Array.from(
      { length: LOGIN_ACCOUNT_RATE_LIMIT + 1 },
      (_, index) => onRequest(context(
        db,
        "POST",
        "/api/auth/login",
        {
          email: index % 2 === 0
            ? "Concurrent@Example.COM"
            : " concurrent@example.com ",
          password: "a secure password",
        },
        { "CF-Connecting-IP": `198.51.100.${index + 1}` },
      )),
    );
    const responses = await Promise.all(attempts);
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(
      LOGIN_ACCOUNT_RATE_LIMIT,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    expect(deriveBits).toHaveBeenCalledTimes(LOGIN_ACCOUNT_RATE_LIMIT);

    const accountReservations = db.statements.filter((statement) =>
      statement.query.includes("INSERT INTO rate_limits")
      && statement.values[0] === "login_account");
    expect(accountReservations).toHaveLength(LOGIN_ACCOUNT_RATE_LIMIT + 1);
    expect(new Set(accountReservations.map((statement) => statement.values[1])).size)
      .toBe(1);
  });

  it("opportunistically removes expired session rows even for a stale token", async () => {
    const db = new QuotaDatabase({ sessionExpiresAt: timestamp - 1 });
    const response = await onRequest(context(db, "GET", "/api/me"));
    expect(response.status).toBe(401);
    const cleanup = db.statements.find((statement) =>
      statement.query === "DELETE FROM sessions WHERE expires_at <= ?");
    expect(cleanup?.values[0]).toEqual(expect.any(Number));
    expect(db.statements.some((statement) =>
      statement.query === "DELETE FROM sessions WHERE token_hash = ?")).toBe(true);
  });
});
