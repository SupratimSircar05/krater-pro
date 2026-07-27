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

async function enforceRateLimit(
  context: PagesFunctionContext<CloudEnv>,
  scope: RateLimitScope,
  limit: number,
  windowSeconds: number,
  identity = "",
): Promise<void> {
  const now = unixNow();
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const cloudflareIp = context.request.headers.get("CF-Connecting-IP");
  const configuredSalt = context.env.RATE_LIMIT_SALT;
  if (
    cloudflareIp !== null
    && (
      typeof configuredSalt !== "string"
      || textEncoder.encode(configuredSalt).byteLength < MIN_RATE_LIMIT_SALT_BYTES
    )
  ) {
    throw new HttpError(
      500,
      "configuration_error",
      "Service configuration error.",
    );
  }
  const salt = typeof configuredSalt === "string"
      && textEncoder.encode(configuredSalt).byteLength >= MIN_RATE_LIMIT_SALT_BYTES
    ? configuredSalt
    : "krater-pro-local-rate-limit-v1";
  const clientHash = await sha256(
    `${salt}:${clientAddress(context.request)}:${identity}`,
  );
  const row = await context.env.DB.prepare(
    `INSERT INTO rate_limits (scope, client_hash, window_start, count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(scope, client_hash, window_start)
      DO UPDATE SET count = count + 1
      RETURNING count`,
  ).bind(scope, clientHash, windowStart, windowStart + (windowSeconds * 2))
    .first<{ count: number }>();
  context.waitUntil(
    context.env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?")
      .bind(now)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );
  if (!row || row.count > limit) {
    throw new HttpError(429, "rate_limited", "Too many requests. Try again later.");
  }
}

async function issueSession(
  env: CloudEnv,
  userId: string,
  now = unixNow(),
): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, userId, now, now + SESSION_TTL_SECONDS).run();
  return token;
}

async function requireAuth(
  context: PagesFunctionContext<CloudEnv>,
): Promise<AuthState> {
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
  const body = await readJson(context.request, 4 * 1024);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const passwordRecord = await hashPassword(password);
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
  const body = await readJson(context.request, 4 * 1024);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const user = await findUserByEmail(context.env.DB, email);
  const valid = await (user
    ? verifyPassword(
      password,
      user.password_hash,
      user.password_salt,
      user.password_iterations,
    )
    : hashPassword(password, EMPTY_SALT).then(() => false));
  if (!user || !valid) {
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  }
  const token = await issueSession(context.env, user.id);
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
    return jsonResponse({ ok: true, service: "krater-pro-cloud" });
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
