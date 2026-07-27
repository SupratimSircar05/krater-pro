import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { AgentSession } from "./agent.js";
import { browserAuthCapabilities } from "./browser-auth.js";
import type { KraterConfig } from "./config.js";
import { ProjectRegistry, type ProjectRecord } from "./projects.js";
import { KraterProvider } from "./provider.js";
import type { AgentEvent, ApprovalRequest } from "./types.js";

export interface ServerOptions {
  dev?: boolean;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

const LOCAL_SESSION_COOKIE = "krater_pro_local";
const MAX_BROWSER_SESSIONS = 64;
const SESSION_IDLE_MS = 60 * 60 * 1_000;

class BrowserSession {
  readonly id = randomUUID();
  private agent?: AgentSession;
  private agentKey = "";
  private agentModel = "";
  private sink?: (event: AgentEvent) => void;
  private activeSignal?: AbortSignal;
  private activeController?: AbortController;
  private readonly pending = new Map<string, PendingApproval>();
  private running = false;
  private lastActivity = Date.now();

  constructor(private readonly config: KraterConfig) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastUsedAt(): number {
    return this.lastActivity;
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private emit(event: AgentEvent): void {
    this.sink?.(event);
  }

  private requestApproval = (request: ApprovalRequest): Promise<boolean> =>
    new Promise((resolveApproval) => {
      const signal = this.activeSignal;
      if (signal?.aborted) {
        resolveApproval(false);
        return;
      }
      const settle = (approved: boolean) => {
        const pending = this.pending.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        this.pending.delete(request.id);
        resolveApproval(approved);
      };
      const timer = setTimeout(() => {
        settle(false);
      }, 10 * 60 * 1_000);
      const onAbort = () => settle(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: resolveApproval,
        timer,
        removeAbortListener: signal
          ? () => signal.removeEventListener("abort", onAbort)
          : undefined,
      });
    });

  private ensureAgent(apiKey: string, model: string): AgentSession {
    const signature = createHash("sha256")
      .update(this.config.baseURL)
      .update("\0")
      .update(apiKey)
      .digest("hex");
    if (this.agent && (this.agentKey !== signature || this.agentModel !== model)) {
      throw new Error(
        "The API key or model changed during this task. Start a new task before continuing.",
      );
    }
    if (!this.agent) {
      this.denyAll();
      this.agentKey = signature;
      this.agentModel = model;
      this.agent = new AgentSession({
        provider: new KraterProvider({
          apiKey,
          baseURL: this.config.baseURL,
          model,
          maxOutputTokens: this.config.maxOutputTokens,
        }),
        cwd: this.config.cwd,
        model,
        onEvent: (event) => this.emit(event),
        requestApproval: this.requestApproval,
        contextCharBudget: this.config.contextChars,
        toolOutputCharBudget: this.config.toolOutputChars,
        responseStyle: this.config.responseStyle,
        maxSteps: this.config.maxSteps,
        sessionTokenBudget: this.config.sessionTokenBudget,
      });
    }
    return this.agent;
  }

  async run(
    message: string,
    apiKey: string,
    model: string,
    sink: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.running) throw new Error("This session is already processing a message.");
    this.touch();
    this.running = true;
    this.sink = sink;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    this.activeController = controller;
    this.activeSignal = controller.signal;
    try {
      await this.ensureAgent(apiKey, model).run(message, controller.signal);
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.running = false;
      this.sink = undefined;
      this.activeSignal = undefined;
      this.activeController = undefined;
      this.denyAll();
    }
  }

  approve(id: string, approved: boolean): boolean {
    this.touch();
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.pending.delete(id);
    pending.resolve(approved);
    return true;
  }

  dispose(): void {
    this.activeController?.abort();
    this.denyAll();
    this.sink = undefined;
  }

  private denyAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.resolve(false);
    }
    this.pending.clear();
  }
}

function loopbackHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "[::1]"].includes(hostname)
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
}

function allowedOrigin(origin: string | undefined, hostHeader: string): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      loopbackHostname(parsed.host) !== undefined &&
      parsed.host.toLowerCase() === hostHeader.toLowerCase()
    );
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const item of (request.header("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secureEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function apiKeyFrom(request: Request, fallback?: string): string | undefined {
  const header = request.header("x-krater-api-key")?.trim();
  return header || fallback;
}

function sendError(response: Response, status: number, message: string): void {
  response.status(status).json({ error: { message } });
}

function writeEvent(response: Response, event: AgentEvent): void {
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function projectPayload(
  projects: ProjectRegistry,
  current: ProjectRecord = projects.current(),
): {
  current: ProjectRecord;
  currentId: string;
  projects: ProjectRecord[];
} {
  return {
    current,
    currentId: current.id,
    projects: projects.list(),
  };
}

export async function createApp(
  config: KraterConfig,
  options: ServerOptions = {},
): Promise<Express> {
  const app = express();
  const localToken = randomBytes(32).toString("base64url");
  app.locals.localToken = localToken;
  const projects = new ProjectRegistry(config.cwd);
  const sessions = new Map<string, BrowserSession>();
  let projectChanging = false;
  const modelCache = new Map<
    string,
    { expiresAt: number; models: Array<{ id: string; ownedBy?: string }> }
  >();

  const disposeSessions = (): void => {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  };
  const hasRunningSession = (): boolean =>
    [...sessions.values()].some((session) => session.isRunning);
  const beginProjectChange = (response: Response): boolean => {
    if (projectChanging) {
      sendError(response, 409, "Another project change is already in progress.");
      return false;
    }
    if (hasRunningSession()) {
      sendError(
        response,
        409,
        "Stop the active response before changing projects.",
      );
      return false;
    }
    projectChanging = true;
    return true;
  };

  app.locals.shutdown = () => {
    disposeSessions();
    modelCache.clear();
  };
  app.disable("x-powered-by");

  app.use((request, response, next) => {
    const host = request.header("host");
    if (!host || !loopbackHostname(host)) {
      sendError(response, 403, "Krater Pro accepts only loopback Host headers.");
      return;
    }
    if (!allowedOrigin(request.header("origin"), host)) {
      sendError(response, 403, "Cross-origin requests are not allowed.");
      return;
    }

    response.setHeader(
      "Set-Cookie",
      `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(localToken)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );

    if (request.path === "/api" || request.path.startsWith("/api/")) {
      const supplied =
        request.header("x-krater-local-token") ??
        cookieValue(request, LOCAL_SESSION_COOKIE);
      if (!secureEqual(supplied, localToken)) {
        sendError(
          response,
          401,
          "Local session token missing or expired. Reload the Krater Pro page.",
        );
        return;
      }
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/api/status", (_request, response) => {
    const currentProject = projects.current();
    response.json({
      configured: Boolean(config.apiKey),
      model: config.model,
      cwd: currentProject.path,
      projectId: currentProject.id,
      projectKind: currentProject.kind,
      version: "0.1.0",
      baseURL: config.baseURL,
      contextChars: config.contextChars,
      toolOutputChars: config.toolOutputChars,
      responseStyle: config.responseStyle,
      maxSteps: config.maxSteps,
      maxOutputTokens: config.maxOutputTokens,
      sessionTokenBudget: config.sessionTokenBudget,
    });
  });

  app.get("/api/projects", (_request, response) => {
    response.json(projectPayload(projects));
  });

  app.post("/api/projects/select", (request, response) => {
    const id =
      typeof request.body?.id === "string" ? request.body.id.trim() : "";
    if (!id) {
      sendError(response, 400, 'Project "id" must be a non-empty string.');
      return;
    }
    if (id === projects.current().id) {
      response.json(projectPayload(projects));
      return;
    }
    if (!beginProjectChange(response)) return;

    try {
      const current = projects.select(id);
      disposeSessions();
      response.json(projectPayload(projects, current));
    } catch (error) {
      sendError(response, 404, (error as Error).message);
    } finally {
      projectChanging = false;
    }
  });

  app.post("/api/projects/local", async (request, response) => {
    const path =
      typeof request.body?.path === "string" ? request.body.path.trim() : "";
    if (!path) {
      sendError(response, 400, 'Local project "path" must be a non-empty string.');
      return;
    }
    if (!beginProjectChange(response)) return;

    try {
      const current = await projects.addLocal(path);
      disposeSessions();
      response.status(201).json(projectPayload(projects, current));
    } catch (error) {
      sendError(response, 400, (error as Error).message);
    } finally {
      projectChanging = false;
    }
  });

  app.post("/api/projects/scratch", async (request, response) => {
    const suppliedName = request.body?.name;
    if (
      suppliedName !== undefined &&
      (typeof suppliedName !== "string" || suppliedName.length > 80)
    ) {
      sendError(response, 400, 'Scratch "name" must be a string of 80 characters or fewer.');
      return;
    }
    if (!beginProjectChange(response)) return;

    try {
      const current = await projects.createScratch(suppliedName?.trim() || undefined);
      disposeSessions();
      response.status(201).json(projectPayload(projects, current));
    } catch (error) {
      sendError(response, 500, (error as Error).message);
    } finally {
      projectChanging = false;
    }
  });

  app.post("/api/projects/github", async (request, response) => {
    const url = typeof request.body?.url === "string" ? request.body.url : "";
    if (!url) {
      sendError(response, 400, 'GitHub project "url" must be a non-empty string.');
      return;
    }
    if (!beginProjectChange(response)) return;

    const abort = new AbortController();
    const cancelClone = () => abort.abort();
    request.once("aborted", cancelClone);
    response.once("close", cancelClone);
    try {
      const current = await projects.cloneGitHub(url, abort.signal);
      disposeSessions();
      if (!response.writableEnded) {
        response.status(201).json(projectPayload(projects, current));
      }
    } catch (error) {
      if (!abort.signal.aborted && !response.writableEnded) {
        const message = (error as Error).message;
        const status = message.startsWith("Only public ") ? 400 : 502;
        sendError(response, status, message);
      }
    } finally {
      request.removeListener("aborted", cancelClone);
      response.removeListener("close", cancelClone);
      projectChanging = false;
    }
  });

  app.get("/api/auth/capabilities", (_request, response) => {
    response.json(browserAuthCapabilities());
  });

  app.get("/api/models", async (request, response) => {
    const apiKey = apiKeyFrom(request, config.apiKey);
    if (!apiKey) {
      sendError(
        response,
        401,
        "Add a Krater API key in Settings or configure KRATER_API_KEY.",
      );
      return;
    }
    try {
      const cacheKey = createHash("sha256")
        .update(config.baseURL)
        .update("\0")
        .update(apiKey)
        .digest("hex");
      const cached = modelCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        response.setHeader("X-Krater-Cache", "hit");
        response.json({ models: cached.models });
        return;
      }
      const provider = new KraterProvider({
        apiKey,
        baseURL: config.baseURL,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
      });
      const models = await provider.listModels();
      modelCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1_000,
        models,
      });
      response.setHeader("X-Krater-Cache", "miss");
      response.json({ models });
    } catch (error) {
      sendError(response, 502, (error as Error).message);
    }
  });

  app.post("/api/sessions", (_request, response) => {
    if (projectChanging) {
      sendError(response, 409, "Wait for the project change to finish.");
      return;
    }
    const now = Date.now();
    for (const [id, existing] of sessions) {
      if (!existing.isRunning && now - existing.lastUsedAt > SESSION_IDLE_MS) {
        existing.dispose();
        sessions.delete(id);
      }
    }
    if (sessions.size >= MAX_BROWSER_SESSIONS) {
      const oldest = [...sessions.entries()]
        .filter(([, existing]) => !existing.isRunning)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) {
        sendError(response, 503, "Too many active browser sessions.");
        return;
      }
      oldest[1].dispose();
      sessions.delete(oldest[0]);
    }
    const session = new BrowserSession({
      ...config,
      cwd: projects.current().path,
    });
    sessions.set(session.id, session);
    response.status(201).json({ id: session.id });
  });

  app.delete("/api/sessions/:sessionId", (request, response) => {
    const session = sessions.get(request.params.sessionId);
    if (session) session.dispose();
    sessions.delete(request.params.sessionId);
    response.status(204).end();
  });

  app.post("/api/sessions/:sessionId/messages", async (request, response) => {
    if (projectChanging) {
      sendError(response, 409, "Wait for the project change to finish.");
      return;
    }
    const session = sessions.get(request.params.sessionId);
    if (!session) {
      sendError(response, 404, "Session not found.");
      return;
    }
    if (session.isRunning) {
      sendError(response, 409, "This session is already processing a message.");
      return;
    }

    const message =
      typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const bodyKey =
      typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
    const apiKey = bodyKey || apiKeyFrom(request, config.apiKey);
    const model =
      typeof request.body?.model === "string" && request.body.model.trim()
        ? request.body.model.trim()
        : config.model;
    if (!message) {
      sendError(response, 400, "Message cannot be empty.");
      return;
    }
    if (!apiKey) {
      sendError(
        response,
        401,
        "Krater API key not found. Add one in Settings or configure KRATER_API_KEY.",
      );
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abort.abort();
    });

    let emittedError = false;
    try {
      await session.run(
        message,
        apiKey,
        model,
        (event) => {
          if (event.type === "error") emittedError = true;
          writeEvent(response, event);
        },
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted && !emittedError) {
        writeEvent(response, { type: "error", message: (error as Error).message });
      }
    } finally {
      response.end();
    }
  });

  app.post(
    "/api/sessions/:sessionId/approvals/:approvalId",
    (request, response) => {
      const session = sessions.get(request.params.sessionId);
      if (!session) {
        sendError(response, 404, "Session not found.");
        return;
      }
      if (typeof request.body?.approved !== "boolean") {
        sendError(response, 400, '"approved" must be a boolean.');
        return;
      }
      if (!session.approve(request.params.approvalId, request.body.approved)) {
        sendError(response, 404, "Approval request not found or already resolved.");
        return;
      }
      response.json({ ok: true });
    },
  );

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const webRoot = resolve(currentDirectory, "../web");
  if (options.dev) {
    if (!existsSync(resolve(webRoot, "vite.config.ts"))) {
      throw new Error(
        "Web development mode is available only from a source checkout. Use the packaged production GUI without --dev.",
      );
    }
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: webRoot,
      configFile: resolve(webRoot, "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const staticRoot = resolve(webRoot, "dist");
    if (!existsSync(staticRoot)) {
      app.get("/", (_request, response) => {
        response
          .status(503)
          .type("text")
          .send("Krater Pro GUI has not been built. Run `npm run build` first.");
      });
    } else {
      app.use(express.static(staticRoot, { index: false }));
      app.use((request, response, next) => {
        if (request.path.startsWith("/api/")) {
          next();
          return;
        }
        response.sendFile(resolve(staticRoot, "index.html"));
      });
    }
  }

  return app;
}

export async function startServer(
  config: KraterConfig,
  options: ServerOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = config.host.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `Refusing to bind workspace tools to non-loopback host "${config.host}". ` +
        "Use 127.0.0.1, localhost, or ::1.",
    );
  }
  const app = await createApp(config, options);
  const server = await new Promise<ReturnType<Express["listen"]>>(
    (resolveServer, reject) => {
      const instance = app.listen(config.port, config.host, () => resolveServer(instance));
      instance.once("error", reject);
    },
  );
  const displayHost = config.host === "::1" ? "[::1]" : config.host;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${displayHost}:${config.port}`,
    close: () => {
      if (closePromise) return closePromise;
      app.locals.shutdown?.();
      closePromise = new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
        server.closeIdleConnections?.();
        // Agent shutdown already aborts in-flight work and denies approvals.
        // Close the associated HTTP streams now so keep-alive clients cannot
        // hold process shutdown open until Node's connection timeout expires.
        server.closeAllConnections?.();
      });
      return closePromise;
    },
  };
}
