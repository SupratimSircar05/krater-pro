import {
  deleteProject,
  findSession,
  findUserByEmail,
  getProjectQuota,
  getProject,
  insertProject,
  listProjects,
  updateProject,
  type ProjectRow,
  type SessionRow,
  type UserRow,
} from "../../lib/db";
import {
  buildProjectChatMessages,
  isProjectId,
  loadOwnedProjectForChat,
  parseProjectSnapshot,
  validateCloudChatRequest,
} from "../../lib/chat";
import { chatWithKrater, CLOUD_MODEL, validateKraterKey } from "../../lib/krater";
import {
  SESSION_COOKIE,
  SESSION_ROTATE_AFTER_SECONDS,
  SESSION_TTL_SECONDS,
  HttpError,
  MAX_PROJECTS,
  MIN_RATE_LIMIT_SALT_BYTES,
  KEY_VALIDATION_RATE_LIMIT,
  KEY_VALIDATION_RATE_WINDOW_SECONDS,
  LOGIN_ACCOUNT_RATE_LIMIT,
  LOGIN_ACCOUNT_RATE_WINDOW_SECONDS,
  PROJECT_MUTATION_RATE_LIMIT,
  PROJECT_MUTATION_RATE_WINDOW_SECONDS,
  assertSameOrigin,
  boundedString,
  clearSessionCookie,
  hashPassword,
  jsonResponse,
  normalizeEmail,
  parseCookies,
  randomToken,
  readJson,
  readKraterKey,
  requirePasswordPepper,
  requireRateLimitSalt,
  safeErrorResponse,
  sessionCookie,
  sha256,
  validatePassword,
  validateSnapshot,
  verifyPassword,
  type RateLimitScope,
} from "../../lib/security";
import type {
  CloudEnv,
  PagesFunction,
  PagesFunctionContext,
} from "../../lib/types";

const EMPTY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";
const rotatedCookies = new WeakMap<Request, string>();
const textEncoder = new TextEncoder();

interface AuthState {
  userId: string;
  email: string;
  createdAt: number;
  tokenHash: string;
  rotatedCookie?: string;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function publicUser(user: { id: string; email: string; created_at: number }) {
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

function publicProject(row: ProjectRow, includeSnapshot = true) {
  const base = {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!includeSnapshot) return base;
  return { ...base, snapshot: JSON.parse(row.snapshot_json) as unknown };
}

function routePath(request: Request): string[] {
  return new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

function clientAddress(request: Request): string {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  return value && value.length <= 64 ? value : "unknown";
}

interface RateLimitKey {
  scope: RateLimitScope;
  clientHash: string;
  windowStart: number;
  expiresAt: number;
}

async function rateLimitKey(
  context: PagesFunctionContext<CloudEnv>,
  scope: RateLimitScope,
  windowSeconds: number,
  identity = "",
  includeIp = true,
): Promise<RateLimitKey> {
  const now = unixNow();
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const cloudflareIp = context.request.headers.get("CF-Connecting-IP");
  const configuredSalt = context.env.RATE_LIMIT_SALT;
  if (cloudflareIp !== null) requireRateLimitSalt(configuredSalt);
  const salt = typeof configuredSalt === "string"
      && textEncoder.encode(configuredSalt).byteLength >= MIN_RATE_LIMIT_SALT_BYTES
    ? configuredSalt
    : "krater-pro-local-rate-limit-v1";
  return {
    scope,
    clientHash: await sha256(
      `${salt}:${scope}:${includeIp ? clientAddress(context.request) : "account"}:${identity}`,
    ),
    windowStart,
    expiresAt: windowStart + (windowSeconds * 2),
  };
}

function scheduleRateLimitCleanup(
  context: PagesFunctionContext<CloudEnv>,
): void {
  context.waitUntil(
    context.env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?")
      .bind(unixNow())
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );
}

async function enforceRateLimit(
  context: PagesFunctionContext<CloudEnv>,
  scope: RateLimitScope,
  limit: number,
  windowSeconds: number,
  identity = "",
  includeIp = true,
): Promise<void> {
  const key = await rateLimitKey(
    context,
    scope,
    windowSeconds,
    identity,
    includeIp,
  );
  const row = await context.env.DB.prepare(
    `INSERT INTO rate_limits (scope, client_hash, window_start, count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(scope, client_hash, window_start)
      DO UPDATE SET count = count + 1
      RETURNING count`,
  ).bind(key.scope, key.clientHash, key.windowStart, key.expiresAt)
    .first<{ count: number }>();
  scheduleRateLimitCleanup(context);
  if (!row || row.count > limit) {
    throw new HttpError(429, "rate_limited", "Too many requests. Try again later.");
  }
}

async function reserveLoginAccountAttempt(
  context: PagesFunctionContext<CloudEnv>,
  email: string,
): Promise<RateLimitKey> {
  const key = await rateLimitKey(
    context,
    "login_account",
    LOGIN_ACCOUNT_RATE_WINDOW_SECONDS,
    email,
    false,
  );
  const row = await context.env.DB.prepare(
    `INSERT INTO rate_limits (scope, client_hash, window_start, count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(scope, client_hash, window_start)
      DO UPDATE SET count = count + 1
      RETURNING count`,
  ).bind(key.scope, key.clientHash, key.windowStart, key.expiresAt)
    .first<{ count: number }>();
  if (!row || row.count > LOGIN_ACCOUNT_RATE_LIMIT) {
    throw new HttpError(429, "rate_limited", "Too many requests. Try again later.");
  }
  return key;
}

async function health(context: PagesFunctionContext<CloudEnv>): Promise<Response> {
  try {
    requirePasswordPepper(context.env.PASSWORD_PEPPER);
    requireRateLimitSalt(context.env.RATE_LIMIT_SALT);
  } catch {
    throw new HttpError(503, "configuration_error", "Service unavailable.");
  }
  try {
    const result = await context.env.DB.prepare("SELECT 1 AS ready")
      .first<{ ready: number }>();
    if (result?.ready !== 1) {
      throw new Error("D1 readiness query returned no row.");
    }
  } catch {
    throw new HttpError(503, "service_unavailable", "Service unavailable.");
  }
  return jsonResponse({ ok: true });
}

async function requireAuth(
  context: PagesFunctionContext<CloudEnv>,
): Promise<AuthState> {
  requirePasswordPepper(context.env.PASSWORD_PEPPER);
  const token = parseCookies(context.request.headers.get("Cookie")).get(SESSION_COOKIE);
  if (!token || token.length < 40 || token.length > 128) {
    throw new HttpError(401, "unauthorized", "Sign in to continue.");
  }
  const now = unixNow();
  context.waitUntil(
    context.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .bind(now)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );
  const tokenHash = await sha256(token);
  const session = await findSession(context.env.DB, tokenHash);
  if (!session || session.expires_at <= now) {
    if (session) {
      await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(tokenHash).run();
    }
    throw new HttpError(401, "unauthorized", "Sign in to continue.");
  }
  const auth: AuthState = {
    userId: session.user_id,
    email: session.user_email,
    createdAt: session.user_created_at,
    tokenHash,
  };
  if (now - session.issued_at >= SESSION_ROTATE_AFTER_SECONDS) {
    const nextToken = randomToken();
    const nextHash = await sha256(nextToken);
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO sessions (token_hash, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
      ).bind(nextHash, session.user_id, now, now + SESSION_TTL_SECONDS),
      // A short overlap prevents concurrent in-flight requests from being
      // rejected while the browser applies the rotated cookie.
      context.env.DB.prepare(
        "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
      ).bind(now + 60, tokenHash),
    ]);
    auth.tokenHash = nextHash;
    auth.rotatedCookie = sessionCookie(nextToken);
    rotatedCookies.set(context.request, auth.rotatedCookie);
  }
  return auth;
}

function authenticatedJson(
  auth: AuthState,
  body: unknown,
  status = 200,
): Response {
  const response = jsonResponse(body, status);
  if (auth.rotatedCookie) response.headers.set("Set-Cookie", auth.rotatedCookie);
  return response;
}

async function register(
  context: PagesFunctionContext<CloudEnv>,
): Promise<Response> {
  await enforceRateLimit(context, "register", 5, 60 * 60);
  const pepper = requirePasswordPepper(context.env.PASSWORD_PEPPER);
  const body = await readJson(context.request, 4 * 1024);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const passwordRecord = await hashPassword(password, pepper);
  const id = crypto.randomUUID();
  const now = unixNow();
  const token = randomToken();
  const tokenHash = await sha256(token);
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO users
          (id, email, password_hash, password_salt, password_iterations, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        email,
        passwordRecord.hash,
        passwordRecord.salt,
        passwordRecord.iterations,
        now,
        now,
      ),
      context.env.DB.prepare(
        "INSERT INTO sessions (token_hash, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
      ).bind(tokenHash, id, now, now + SESSION_TTL_SECONDS),
    ]);
  } catch {
    throw new HttpError(409, "account_unavailable", "Unable to create an account with that email.");
  }
  return jsonResponse(
    { user: publicUser({ id, email, created_at: now }) },
    201,
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function login(
  context: PagesFunctionContext<CloudEnv>,
): Promise<Response> {
  await enforceRateLimit(context, "login", 10, 15 * 60);
  const pepper = requirePasswordPepper(context.env.PASSWORD_PEPPER);
  const body = await readJson(context.request, 4 * 1024);
  const email = normalizeEmail(body.email);
  const accountRateKey = await reserveLoginAccountAttempt(context, email);
  const password = validatePassword(body.password);
  const user = await findUserByEmail(context.env.DB, email);
  const valid = await (user
    ? verifyPassword(
      password,
      pepper,
      user.password_hash,
      user.password_salt,
      user.password_iterations,
    )
    : hashPassword(password, pepper, EMPTY_SALT).then(() => false));
  if (!user || !valid) {
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  }
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = unixNow();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "DELETE FROM rate_limits WHERE scope = ? AND client_hash = ?",
    ).bind(accountRateKey.scope, accountRateKey.clientHash),
    context.env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(tokenHash, user.id, now, now + SESSION_TTL_SECONDS),
  ]);
  return jsonResponse(
    { user: publicUser(user) },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function logout(
  context: PagesFunctionContext<CloudEnv>,
): Promise<Response> {
  const token = parseCookies(context.request.headers.get("Cookie")).get(SESSION_COOKIE);
  if (token && token.length >= 40 && token.length <= 128) {
    const tokenHash = await sha256(token);
    await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(tokenHash).run();
  }
  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": clearSessionCookie() },
  );
}

async function createProject(
  context: PagesFunctionContext<CloudEnv>,
  auth: AuthState,
): Promise<Response> {
  const body = await readJson(context.request);
  const name = boundedString(body.name, "name", 1, 80);
  const snapshot = validateSnapshot(body.snapshot);
  const id = crypto.randomUUID();
  const now = unixNow();
  const snapshotJson = JSON.stringify(snapshot);
  const row = await insertProject(
    context.env.DB,
    id,
    auth.userId,
    name,
    snapshotJson,
    now,
  );
  if (!row) {
    const quota = await getProjectQuota(context.env.DB, auth.userId);
    if (quota.project_count >= MAX_PROJECTS) {
      throw new HttpError(409, "project_limit", "Project limit reached.");
    }
    throw new HttpError(409, "storage_limit", "Project storage limit reached.");
  }
  return authenticatedJson(auth, { project: publicProject(row) }, 201);
}

async function dispatch(
  context: PagesFunctionContext<CloudEnv>,
): Promise<Response> {
  const { request } = context;
  const method = request.method.toUpperCase();
  const parts = routePath(request);
  if (parts[0] !== "api") {
    throw new HttpError(404, "not_found", "API route not found.");
  }
  const route = `/${parts.slice(1).join("/")}`;

  if (!["GET", "HEAD"].includes(method)) assertSameOrigin(request);

  if (method === "GET" && route === "/health") {
    return health(context);
  }
  if (method === "POST" && route === "/auth/register") return register(context);
  if (method === "POST" && route === "/auth/login") return login(context);
  if (method === "POST" && route === "/auth/logout") return logout(context);

  const auth = await requireAuth(context);
  if (method === "GET" && route === "/me") {
    return authenticatedJson(auth, {
      user: { id: auth.userId, email: auth.email, createdAt: auth.createdAt },
    });
  }
  if (method === "DELETE" && route === "/account") {
    await context.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(auth.userId).run();
    return jsonResponse(
      { ok: true },
      200,
      { "Set-Cookie": clearSessionCookie() },
    );
  }
  if (route === "/projects") {
    if (method === "GET") {
      const projects = await listProjects(context.env.DB, auth.userId);
      return authenticatedJson(auth, {
        projects: projects.map((project) => publicProject(project, false)),
      });
    }
    if (method === "POST") {
      await enforceRateLimit(
        context,
        "project_mutation",
        PROJECT_MUTATION_RATE_LIMIT,
        PROJECT_MUTATION_RATE_WINDOW_SECONDS,
        auth.userId,
      );
      return createProject(context, auth);
    }
  }

  if (parts.length === 3 && parts[1] === "projects" && isProjectId(parts[2] ?? "")) {
    const id = parts[2]!;
    if (method === "GET") {
      const project = await getProject(context.env.DB, id, auth.userId);
      if (!project) throw new HttpError(404, "not_found", "Project not found.");
      return authenticatedJson(auth, { project: publicProject(project) });
    }
    if (method === "PUT") {
      await enforceRateLimit(
        context,
        "project_mutation",
        PROJECT_MUTATION_RATE_LIMIT,
        PROJECT_MUTATION_RATE_WINDOW_SECONDS,
        auth.userId,
      );
      const body = await readJson(request);
      const name = boundedString(body.name, "name", 1, 80);
      const snapshot = validateSnapshot(body.snapshot);
      const project = await updateProject(
        context.env.DB,
        id,
        auth.userId,
        name,
        JSON.stringify(snapshot),
        unixNow(),
      );
      if (!project) {
        const existing = await getProject(context.env.DB, id, auth.userId);
        if (!existing) throw new HttpError(404, "not_found", "Project not found.");
        throw new HttpError(409, "storage_limit", "Project storage limit reached.");
      }
      return authenticatedJson(auth, { project: publicProject(project) });
    }
    if (method === "DELETE") {
      await enforceRateLimit(
        context,
        "project_mutation",
        PROJECT_MUTATION_RATE_LIMIT,
        PROJECT_MUTATION_RATE_WINDOW_SECONDS,
        auth.userId,
      );
      const existing = await getProject(context.env.DB, id, auth.userId);
      if (!existing) throw new HttpError(404, "not_found", "Project not found.");
      await deleteProject(context.env.DB, id, auth.userId);
      return authenticatedJson(auth, { ok: true });
    }
  }

  if (method === "POST" && route === "/key/validate") {
    await enforceRateLimit(
      context,
      "key_validate",
      KEY_VALIDATION_RATE_LIMIT,
      KEY_VALIDATION_RATE_WINDOW_SECONDS,
      auth.userId,
    );
    const key = readKraterKey(request);
    const valid = await validateKraterKey(key);
    return authenticatedJson(auth, { valid, model: CLOUD_MODEL });
  }
  if (method === "POST" && route === "/chat") {
    await enforceRateLimit(context, "chat", 30, 60, auth.userId);
    const key = readKraterKey(request);
    const body = await readJson(request, 80 * 1024);
    const chatRequest = validateCloudChatRequest(body);
    const project = await loadOwnedProjectForChat(
      context.env.DB,
      chatRequest.projectId,
      auth.userId,
    );
    if (!project) throw new HttpError(404, "not_found", "Project not found.");
    const snapshot = parseProjectSnapshot(project);
    const messages = buildProjectChatMessages(snapshot, chatRequest.message);
    const result = await chatWithKrater(key, messages);
    return authenticatedJson(auth, result);
  }

  throw new HttpError(404, "not_found", "API route not found.");
}

export const onRequest: PagesFunction<CloudEnv> = async (context) => {
  let response: Response;
  try {
    response = await dispatch(context);
  } catch (error) {
    response = safeErrorResponse(error);
  }
  const rotatedCookie = rotatedCookies.get(context.request);
  rotatedCookies.delete(context.request);
  if (rotatedCookie && !response.headers.has("Set-Cookie")) {
    response.headers.set("Set-Cookie", rotatedCookie);
  }
  return response;
};
