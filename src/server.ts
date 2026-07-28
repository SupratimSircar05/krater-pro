import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { AgentSession } from "./agent.js";
import {
  calibrateReliabilityCandidate,
  replayRecordedCausalTwin,
  replayReliabilityEvaluation,
} from "./advanced-adapters.js";
import { browserAuthCapabilities } from "./browser-auth.js";
import type { KraterConfig } from "./config.js";
import {
  ROUTER_FALLBACK_MODEL,
  isAutomaticModel,
  selectCodingModel,
} from "./model-selection.js";
import { ProjectRegistry, type ProjectRecord } from "./projects.js";
import { KraterProvider } from "./provider.js";
import {
  EvidenceTask,
  cancelEvidenceTask,
  evidencePublicationReadiness,
  finalizeEvidencePublication,
  listEvidenceTasks,
  openEvidenceStore,
  readEvidenceTask,
  recordEvidenceRollback,
  renderPassportMarkdown,
} from "./evidence-runtime.js";
import {
  verifyChangePassport,
  verifyEvidenceCapsule,
} from "./proofgraph/index.js";
import type { AvailableModel } from "./router.js";
import { sanitizeTerminalText } from "./telemetry.js";
import type { AgentEvent, ApprovalRequest } from "./types.js";
import {
  explainPolicyDecision,
  simulatePolicy,
  type PolicySimulationRequest,
} from "./trust/index.js";
import { VerifiedWorkCache } from "./verified-cache/index.js";
import {
  StagedTaskWorkspace,
  discardStagedProofPatch,
  loadProofPatchBinding,
  publishBoundProofPatch,
  rollbackBoundProofPatch,
} from "./staging-workspace.js";
import {
  Workspace,
  WorkspaceRevisionConflictError,
} from "./workspace.js";

export interface ServerOptions {
  dev?: boolean;
  /**
   * Host-enforced Action/Abstention Gate. The Krater CLI enables it; direct
   * embedders may opt in during the compatibility release.
   */
  evidenceMode?: boolean;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

const LOCAL_SESSION_COOKIE = "krater_pro_local";
const MAX_BROWSER_SESSIONS = 64;
const SESSION_IDLE_MS = 60 * 60 * 1_000;
const MAX_IDE_COMMAND_BYTES = 8_192;
const MAX_IDE_COMMAND_TIMEOUT_MS = 120_000;
const MAX_IDE_TERMINALS = 4;

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
  private evidenceTask?: EvidenceTask;
  private stagedWorkspace?: StagedTaskWorkspace;

  constructor(
    private readonly config: KraterConfig,
    private readonly loadModels: (
      apiKey: string,
      signal?: AbortSignal,
    ) => Promise<AvailableModel[]>,
    readonly projectId: string,
    private readonly invalidateProjectCaches: (projectId: string) => void,
    private readonly evidenceMode: boolean,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastUsedAt(): number {
    return this.lastActivity;
  }

  invalidateWorkspaceCache(): void {
    this.agent?.invalidateToolCache();
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private emit(event: AgentEvent): void {
    this.evidenceTask?.accept(event);
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
      if (this.evidenceMode && !this.stagedWorkspace) {
        throw new Error("Evidence-native session has no isolated staging workspace.");
      }
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
        cwd: this.stagedWorkspace?.stageRoot ?? this.config.cwd,
        readOnlyDependencyRoots:
          this.stagedWorkspace?.readOnlyDependencyRoots,
        model,
        onEvent: (event) => this.emit(event),
        onWorkspaceMutation: () =>
          this.invalidateProjectCaches(this.projectId),
        requestApproval: this.requestApproval,
        contextCharBudget: this.config.contextChars,
        toolOutputCharBudget: this.config.toolOutputChars,
        responseStyle: this.config.responseStyle,
        maxSteps: this.config.maxSteps,
        sessionTokenBudget: this.config.sessionTokenBudget,
        evidenceMode: this.evidenceMode,
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
    assurance: "fast" | "standard" | "high" = "standard",
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
    let proofPatchPrepared = false;
    try {
      let resolvedModel = model;
      if (isAutomaticModel(model)) {
        if (this.agent && this.agentModel) {
          resolvedModel = this.agentModel;
        } else {
          const selection = await selectCodingModel({
            requestedModel: model,
            prompt: message,
            contextCharacters: message.length,
            expectedOutputTokens: this.config.maxOutputTokens,
            loadModels: (routeSignal) =>
              this.loadModels(apiKey, routeSignal),
            signal: controller.signal,
          });
          resolvedModel = selection.model;
          if (this.evidenceMode) {
            this.evidenceTask = await EvidenceTask.start({
              cwd: this.config.cwd,
              projectId: this.projectId,
              request: message,
              model: resolvedModel,
              assurance,
              maxTokens: this.config.sessionTokenBudget,
              maxToolSteps: this.config.maxSteps,
            });
            this.emit({
              type: "task",
              id: this.evidenceTask.taskId,
              state: this.evidenceTask.currentState,
            });
          }
          const decision = selection.decision!;
          this.emit({
            type: "route",
            model: decision.model,
            tier: decision.tier,
            confidence: decision.confidence,
            complexity: decision.assessment.complexity,
            risk: decision.assessment.risk,
            reasons: decision.reasons,
            catalog:
              selection.catalog === "fallback" ? "fallback" : "live",
          });
        }
      }
      if (this.evidenceMode && !this.evidenceTask) {
        this.evidenceTask = await EvidenceTask.start({
          cwd: this.config.cwd,
          projectId: this.projectId,
          request: message,
          model: resolvedModel,
          assurance,
          maxTokens: this.config.sessionTokenBudget,
          maxToolSteps: this.config.maxSteps,
        });
        this.emit({
          type: "task",
          id: this.evidenceTask.taskId,
          state: this.evidenceTask.currentState,
        });
      }
      if (this.evidenceMode && !this.stagedWorkspace) {
        this.stagedWorkspace = await StagedTaskWorkspace.create(
          this.config.cwd,
        );
      }
      await this.ensureAgent(apiKey, resolvedModel).run(
        message,
        controller.signal,
      );
      await this.evidenceTask?.flush();
      let projection;
      if (
        this.evidenceTask &&
        this.evidenceTask.actionGate?.shouldStageCode
      ) {
        if (!this.stagedWorkspace) {
          throw new Error("The isolated staging workspace was lost.");
        }
        const prepared = await this.stagedWorkspace.prepareProofPatch(
          this.evidenceTask.taskId,
        );
        proofPatchPrepared = true;
        this.stagedWorkspace = undefined;
        projection = await this.evidenceTask.finish({
          baseWorkspaceDigest: prepared.baseWorkspaceDigest,
          finalWorkspaceDigest: prepared.finalWorkspaceDigest,
          additionalGaps: prepared.unsupportedPaths.map(
            (path) =>
              `ProofPatch cannot publish ${path} because its parent directory does not exist in the base workspace.`,
          ),
        });
      } else if (this.evidenceTask && this.stagedWorkspace) {
        const digest = this.stagedWorkspace.initialWorkspaceDigest;
        await this.stagedWorkspace.discard();
        this.stagedWorkspace = undefined;
        projection = await this.evidenceTask.finish({
          baseWorkspaceDigest: digest,
          finalWorkspaceDigest: digest,
        });
      }
      if (projection) {
        this.sink?.({
          type: "task",
          id: projection.taskId,
          state: projection.state,
        });
        this.sink?.({
          type: "verdict",
          taskId: projection.taskId,
          state:
            projection.state === "complete" ||
            projection.state === "abstained" ||
            projection.state === "blocked" ||
            projection.state === "accepted_with_gaps"
              ? projection.state
              : "review",
          evidenceGrade:
            projection.passport?.weakestEvidenceGrade ?? "not_established",
          gaps: projection.capsule?.gaps ?? [],
        });
      }
    } catch (error) {
      if (this.evidenceTask && !controller.signal.aborted) {
        const projection = await this.evidenceTask.fail(
          (error as Error).message || "Agent execution failed.",
        );
        this.sink?.({
          type: "task",
          id: projection.taskId,
          state: projection.state,
        });
      } else if (this.evidenceTask && controller.signal.aborted) {
        await this.evidenceTask.cancel("Task execution was cancelled.");
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.running = false;
      this.sink = undefined;
      this.activeSignal = undefined;
      this.activeController = undefined;
      this.evidenceTask = undefined;
      if (this.evidenceMode) {
        if (this.stagedWorkspace && !proofPatchPrepared) {
          void this.stagedWorkspace.discard();
        }
        this.stagedWorkspace = undefined;
        this.agent = undefined;
        this.agentKey = "";
        this.agentModel = "";
      }
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
    if (this.evidenceTask) {
      void this.evidenceTask.cancel("Browser session was closed.");
    }
    if (this.stagedWorkspace) {
      void this.stagedWorkspace.discard();
      this.stagedWorkspace = undefined;
    }
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

function sendWorkspaceError(response: Response, error: unknown): void {
  if (error instanceof WorkspaceRevisionConflictError) {
    sendError(response, 409, error.message);
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    sendError(response, 404, "Workspace path was not found.");
    return;
  }
  sendError(response, 400, (error as Error).message || "Workspace request failed.");
}

function singleQuery(
  request: Request,
  name: string,
): string | undefined {
  const value = request.query[name];
  return typeof value === "string" ? value : undefined;
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
  let ideWorkspace = new Workspace(projects.current().path);
  const sessions = new Map<string, BrowserSession>();
  let projectChanging = false;
  let activeWorkspaceOperations = 0;
  let proofPatchMutationActive = false;
  const terminalControllers = new Set<AbortController>();
  const modelCache = new Map<
    string,
    { expiresAt: number; models: AvailableModel[] }
  >();
  const loadModels = async (
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<{ models: AvailableModel[]; cached: boolean }> => {
    const cacheKey = createHash("sha256")
      .update(config.baseURL)
      .update("\0")
      .update(apiKey)
      .digest("hex");
    const cached = modelCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { models: cached.models, cached: true };
    }
    const provider = new KraterProvider({
      apiKey,
      baseURL: config.baseURL,
      model: isAutomaticModel(config.model)
        ? ROUTER_FALLBACK_MODEL
        : config.model,
      maxOutputTokens: config.maxOutputTokens,
    });
    const models = await provider.listModels(signal);
    modelCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1_000,
      models,
    });
    return { models, cached: false };
  };

  const disposeSessions = (): void => {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  };
  const hasRunningSession = (): boolean =>
    [...sessions.values()].some((session) => session.isRunning);
  const invalidateWorkspaceSessions = (projectId: string): void => {
    for (const session of sessions.values()) {
      if (session.projectId === projectId) {
        session.invalidateWorkspaceCache();
      }
    }
  };
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
    if (activeWorkspaceOperations > 0) {
      sendError(
        response,
        409,
        "Wait for active editor, Git, or terminal work before changing projects.",
      );
      return false;
    }
    projectChanging = true;
    return true;
  };
  const beginWorkspaceOperation = (response: Response): boolean => {
    if (projectChanging) {
      sendError(response, 409, "Wait for the project change to finish.");
      return false;
    }
    if (proofPatchMutationActive) {
      sendError(
        response,
        409,
        "Wait for the active ProofPatch lifecycle mutation to finish.",
      );
      return false;
    }
    activeWorkspaceOperations += 1;
    return true;
  };
  const finishWorkspaceOperation = (): void => {
    activeWorkspaceOperations = Math.max(0, activeWorkspaceOperations - 1);
  };
  const beginProofPatchMutation = (response: Response): boolean => {
    if (projectChanging) {
      sendError(response, 409, "Wait for the project change to finish.");
      return false;
    }
    if (proofPatchMutationActive) {
      sendError(
        response,
        409,
        "Another ProofPatch publish, rollback, or cancellation is already in progress.",
      );
      return false;
    }
    if (activeWorkspaceOperations > 0) {
      sendError(
        response,
        409,
        "Wait for active editor, Git, or terminal work before changing a ProofPatch.",
      );
      return false;
    }
    if (hasRunningSession()) {
      sendError(
        response,
        409,
        "Stop the active agent response before changing a ProofPatch.",
      );
      return false;
    }
    proofPatchMutationActive = true;
    activeWorkspaceOperations += 1;
    return true;
  };
  const finishProofPatchMutation = (): void => {
    proofPatchMutationActive = false;
    finishWorkspaceOperation();
  };
  const requireCurrentProject = (
    request: Request,
    response: Response,
    operation: string,
  ): ProjectRecord | undefined => {
    if (
      request.query.projectId !== undefined &&
      typeof request.query.projectId !== "string"
    ) {
      sendError(response, 400, `${operation} "projectId" must be a single value.`);
      return undefined;
    }
    const projectId = singleQuery(request, "projectId")?.trim() ?? "";
    if (!projectId) {
      sendError(
        response,
        400,
        `${operation} "projectId" must be a non-empty string.`,
      );
      return undefined;
    }
    const current = projects.current();
    if (projectId !== current.id) {
      sendError(
        response,
        409,
        `This ${operation.toLowerCase()} request belongs to a different project. Reload the workspace.`,
      );
      return undefined;
    }
    return current;
  };
  const optionalCurrentProject = (
    request: Request,
    response: Response,
    operation: string,
  ): ProjectRecord | undefined => {
    if (
      request.query.projectId !== undefined &&
      typeof request.query.projectId !== "string"
    ) {
      sendError(response, 400, `${operation} "projectId" must be a single value.`);
      return undefined;
    }
    const requested = singleQuery(request, "projectId")?.trim();
    const current = projects.current();
    if (requested && requested !== current.id) {
      sendError(
        response,
        409,
        `This ${operation.toLowerCase()} request belongs to a different project. Reload the workspace.`,
      );
      return undefined;
    }
    return current;
  };

  app.locals.shutdown = () => {
    for (const controller of terminalControllers) controller.abort();
    terminalControllers.clear();
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

  app.use(express.json({ limit: "7mb" }));

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
      modelSource: config.modelSource,
      smartRouting: isAutomaticModel(config.model),
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

    const previous = projects.current();
    try {
      const current = projects.select(id);
      const nextWorkspace = new Workspace(current.path);
      ideWorkspace = nextWorkspace;
      disposeSessions();
      response.json(projectPayload(projects, current));
    } catch (error) {
      projects.select(previous.id);
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

    const previous = projects.current();
    try {
      const current = await projects.addLocal(path);
      const nextWorkspace = new Workspace(current.path);
      ideWorkspace = nextWorkspace;
      disposeSessions();
      response.status(201).json(projectPayload(projects, current));
    } catch (error) {
      projects.select(previous.id);
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

    const previous = projects.current();
    try {
      const current = await projects.createScratch(suppliedName?.trim() || undefined);
      const nextWorkspace = new Workspace(current.path);
      ideWorkspace = nextWorkspace;
      disposeSessions();
      response.status(201).json(projectPayload(projects, current));
    } catch (error) {
      projects.select(previous.id);
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

    const previous = projects.current();
    const abort = new AbortController();
    const cancelClone = () => abort.abort();
    request.once("aborted", cancelClone);
    response.once("close", cancelClone);
    try {
      const current = await projects.cloneGitHub(url, abort.signal);
      const nextWorkspace = new Workspace(current.path);
      ideWorkspace = nextWorkspace;
      disposeSessions();
      if (!response.writableEnded) {
        response.status(201).json(projectPayload(projects, current));
      }
    } catch (error) {
      projects.select(previous.id);
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

  app.get("/api/ide/tree", async (request, response) => {
    const project = requireCurrentProject(request, response, "Tree");
    if (!project) return;
    const rawPath = request.query.path;
    const rawDepth = request.query.depth;
    if (
      (rawPath !== undefined && typeof rawPath !== "string") ||
      (rawDepth !== undefined && typeof rawDepth !== "string")
    ) {
      sendError(response, 400, 'Tree "path" and "depth" must each be single values.');
      return;
    }
    const suppliedPath = singleQuery(request, "path");
    const path =
      suppliedPath === undefined || suppliedPath === "" ? "." : suppliedPath;
    const depthText = singleQuery(request, "depth");
    if (depthText !== undefined && !/^[0-6]$/.test(depthText)) {
      sendError(response, 400, 'Tree "depth" must be an integer from 0 to 6.');
      return;
    }
    if (!beginWorkspaceOperation(response)) return;
    try {
      const tree = await ideWorkspace.tree(
        path,
        depthText === undefined ? 3 : Number(depthText),
      );
      response.json({
        projectId: project.id,
        root: ideWorkspace.root,
        ...tree,
      });
    } catch (error) {
      sendWorkspaceError(response, error);
    } finally {
      finishWorkspaceOperation();
    }
  });

  app.get("/api/ide/file", async (request, response) => {
    const project = requireCurrentProject(request, response, "File");
    if (!project) return;
    if (
      request.query.path !== undefined &&
      typeof request.query.path !== "string"
    ) {
      sendError(response, 400, 'File "path" must be a single value.');
      return;
    }
    const path = singleQuery(request, "path") ?? "";
    if (!path) {
      sendError(response, 400, 'File "path" must be a non-empty string.');
      return;
    }
    if (!beginWorkspaceOperation(response)) return;
    try {
      response.json({
        projectId: project.id,
        ...(await ideWorkspace.readTextDocument(path)),
      });
    } catch (error) {
      sendWorkspaceError(response, error);
    } finally {
      finishWorkspaceOperation();
    }
  });

  app.put("/api/ide/file", async (request, response) => {
    const projectId =
      typeof request.body?.projectId === "string"
        ? request.body.projectId.trim()
        : "";
    const path =
      typeof request.body?.path === "string" ? request.body.path : "";
    const content = request.body?.content;
    const hasRevision = Object.prototype.hasOwnProperty.call(
      request.body ?? {},
      "revision",
    );
    const revision = request.body?.revision;
    if (!projectId) {
      sendError(response, 400, 'File "projectId" must be a non-empty string.');
      return;
    }
    if (projectId !== projects.current().id) {
      sendError(
        response,
        409,
        "This editor request belongs to a different project. Reload the workspace before saving.",
      );
      return;
    }
    if (!path) {
      sendError(response, 400, 'File "path" must be a non-empty string.');
      return;
    }
    if (typeof content !== "string") {
      sendError(response, 400, 'File "content" must be a string.');
      return;
    }
    if (!hasRevision || (revision !== null && typeof revision !== "string")) {
      sendError(
        response,
        400,
        'File "revision" must be null for a new file or the revision returned when it was opened.',
      );
      return;
    }
    if (!beginWorkspaceOperation(response)) return;
    const project = projects.current();
    try {
      response.json({
        projectId: project.id,
        saved: true,
        ...(await ideWorkspace.saveTextDocument(path, content, revision)),
      });
      invalidateWorkspaceSessions(project.id);
    } catch (error) {
      sendWorkspaceError(response, error);
    } finally {
      finishWorkspaceOperation();
    }
  });

  app.get("/api/ide/git/status", async (request, response) => {
    const project = requireCurrentProject(request, response, "Git");
    if (!project) return;
    if (!beginWorkspaceOperation(response)) return;
    try {
      const snapshot = await ideWorkspace.gitStatusSnapshot();
      response.json({
        projectId: project.id,
        ...snapshot,
        status: sanitizeTerminalText(snapshot.status),
      });
    } catch (error) {
      sendWorkspaceError(response, error);
    } finally {
      finishWorkspaceOperation();
    }
  });

  app.get("/api/ide/git/diff", async (request, response) => {
    const project = requireCurrentProject(request, response, "Git");
    if (!project) return;
    if (
      request.query.staged !== undefined &&
      typeof request.query.staged !== "string"
    ) {
      sendError(response, 400, 'Git "staged" must be a single boolean value.');
      return;
    }
    const stagedText = singleQuery(request, "staged");
    if (
      stagedText !== undefined &&
      stagedText !== "true" &&
      stagedText !== "false"
    ) {
      sendError(response, 400, 'Git "staged" must be "true" or "false".');
      return;
    }
    const staged = stagedText === "true";
    if (!beginWorkspaceOperation(response)) return;
    try {
      response.json({
        projectId: project.id,
        staged,
        diff: sanitizeTerminalText(await ideWorkspace.gitDiff(staged)),
      });
    } catch (error) {
      sendWorkspaceError(response, error);
    } finally {
      finishWorkspaceOperation();
    }
  });

  app.post("/api/ide/terminal", async (request, response) => {
    const projectId =
      typeof request.body?.projectId === "string"
        ? request.body.projectId.trim()
        : "";
    const command =
      typeof request.body?.command === "string" ? request.body.command : "";
    const timeoutValue = request.body?.timeoutMs;
    const timeoutMs = timeoutValue === undefined ? 30_000 : timeoutValue;
    if (!projectId) {
      sendError(response, 400, 'Terminal "projectId" must be a non-empty string.');
      return;
    }
    if (projectId !== projects.current().id) {
      sendError(
        response,
        409,
        "This terminal request belongs to a different project. Reload the workspace before running it.",
      );
      return;
    }
    if (!command.trim()) {
      sendError(response, 400, 'Terminal "command" must be a non-empty string.');
      return;
    }
    if (
      command.includes("\0") ||
      Buffer.byteLength(command, "utf8") > MAX_IDE_COMMAND_BYTES
    ) {
      sendError(
        response,
        400,
        `Terminal command must be at most ${MAX_IDE_COMMAND_BYTES} UTF-8 bytes and contain no null bytes.`,
      );
      return;
    }
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > MAX_IDE_COMMAND_TIMEOUT_MS
    ) {
      sendError(
        response,
        400,
        `Terminal "timeoutMs" must be an integer from 1000 to ${MAX_IDE_COMMAND_TIMEOUT_MS}.`,
      );
      return;
    }
    if (terminalControllers.size >= MAX_IDE_TERMINALS) {
      sendError(response, 429, "Too many terminal commands are already running.");
      return;
    }
    if (!beginWorkspaceOperation(response)) return;

    const project = projects.current();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    terminalControllers.add(controller);
    const startedAt = Date.now();
    try {
      const result = await ideWorkspace.runCommand(
        command,
        timeoutMs,
        controller.signal,
      );
      if (!controller.signal.aborted && !response.writableEnded) {
        response.json({
          projectId: project.id,
          exitCode: result.exitCode,
          stdout: sanitizeTerminalText(result.stdout),
          stderr: sanitizeTerminalText(result.stderr),
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted && !response.writableEnded) {
        sendWorkspaceError(response, error);
      }
    } finally {
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
      terminalControllers.delete(controller);
      // A command may mutate the workspace before it times out, is cancelled,
      // or loses its HTTP client. Never let an agent session retain a stale
      // tool-result cache after any terminal attempt.
      invalidateWorkspaceSessions(project.id);
      finishWorkspaceOperation();
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
      const result = await loadModels(apiKey);
      response.setHeader("X-Krater-Cache", result.cached ? "hit" : "miss");
      response.json({ models: result.models });
    } catch (error) {
      sendError(response, 502, (error as Error).message);
    }
  });

  app.get("/api/v2/tasks", async (request, response) => {
    const project = optionalCurrentProject(request, response, "Task");
    if (!project) return;
    try {
      response.json({
        tasks: await listEvidenceTasks(project.path, project.id),
      });
    } catch (error) {
      sendError(response, 500, (error as Error).message);
    }
  });

  app.get("/api/v2/tasks/:taskId/events", async (request, response) => {
    const project = optionalCurrentProject(request, response, "Task");
    if (!project) return;
    const rawAfter =
      request.header("last-event-id") ?? singleQuery(request, "after") ?? "0";
    if (!/^\d+$/.test(rawAfter)) {
      sendError(response, 400, 'Task event "after" must be a non-negative integer.');
      return;
    }
    try {
      const store = await openEvidenceStore(project.path);
      const replay = await store.replay();
      if (replay.tailCorruption) {
        sendError(
          response,
          409,
          `ProofGraph tail is corrupt at line ${replay.tailCorruption.lineNumber}.`,
        );
        return;
      }
      const taskEvents = replay.events.filter(
        (event) =>
          event.taskId === request.params.taskId &&
          event.sequence > Number(rawAfter),
      );
      if (
        !replay.events.some((event) => event.taskId === request.params.taskId)
      ) {
        sendError(response, 404, "Evidence task not found.");
        return;
      }
      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store, no-transform");
      response.setHeader("Connection", "close");
      for (const event of taskEvents) {
        response.write(`id: ${event.sequence}\n`);
        response.write(`event: ${event.kind}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        const code = (error as NodeJS.ErrnoException).code;
        sendError(
          response,
          code === "ENOENT" ? 404 : 500,
          code === "ENOENT" ? "Evidence task not found." : (error as Error).message,
        );
      } else {
        response.end();
      }
    }
  });

  app.get("/api/v2/tasks/:taskId/passport", async (request, response) => {
    const project = optionalCurrentProject(request, response, "Task");
    if (!project) return;
    const format = singleQuery(request, "format") ?? "json";
    if (format !== "json" && format !== "markdown") {
      sendError(response, 400, 'Passport "format" must be "json" or "markdown".');
      return;
    }
    try {
      const store = await openEvidenceStore(project.path);
      const projection = await store.task(request.params.taskId);
      if (!projection.passport || !projection.capsule) {
        sendError(response, 409, "This task does not have a generated passport yet.");
        return;
      }
      if (format === "markdown") {
        response.type("text/markdown; charset=utf-8");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="krater-passport-${projection.taskId}.md"`,
        );
        response.send(renderPassportMarkdown(projection));
        return;
      }
      response.json({
        passport: projection.passport,
        capsule: projection.capsule,
        verification: {
          passport: verifyChangePassport(
            projection.passport,
            projection.capsule,
          ),
          capsule: verifyEvidenceCapsule(projection.capsule),
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      sendError(
        response,
        code === "ENOENT" || /does not exist/i.test((error as Error).message)
          ? 404
          : 500,
        code === "ENOENT" ? "Evidence task not found." : (error as Error).message,
      );
    }
  });

  app.get("/api/v2/tasks/:taskId", async (request, response) => {
    const project = optionalCurrentProject(request, response, "Task");
    if (!project) return;
    try {
      const detail = await readEvidenceTask(
        project.path,
        project.id,
        request.params.taskId,
      );
      let proofPatch:
        | {
            transactionId: string;
            status: string;
            changedPaths: string[];
            unsupportedPaths: string[];
            publishedAt?: string;
            rolledBackAt?: string;
          }
        | undefined;
      try {
        const binding = await loadProofPatchBinding(
          project.path,
          request.params.taskId,
        );
        proofPatch = {
          transactionId: binding.transactionId,
          status: binding.status,
          changedPaths: binding.changedPaths,
          unsupportedPaths: binding.unsupportedPaths,
          ...(binding.publishedAt
            ? { publishedAt: binding.publishedAt }
            : {}),
          ...(binding.rolledBackAt
            ? { rolledBackAt: binding.rolledBackAt }
            : {}),
        };
      } catch (bindingError) {
        if ((bindingError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw bindingError;
        }
      }
      response.json({
        ...detail,
        ...(proofPatch ? { proofPatch } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      sendError(
        response,
        /does not exist|not found/i.test(message) ? 404 : 500,
        message,
      );
    }
  });

  app.post("/api/v2/tasks/:taskId/resume", async (request, response) => {
    const project = projects.current();
    try {
      const detail = await readEvidenceTask(
        project.path,
        project.id,
        request.params.taskId,
      );
      response.json({
        ...detail,
        resumable:
          detail.task.state === "review" ||
          detail.task.state === "blocked" ||
          detail.task.state === "accepted_with_gaps",
        note:
          "Durable evidence is resumable. Raw model transcripts remain local and opt-in, so a new agent turn starts with the contract and recorded evidence.",
      });
    } catch (error) {
      const message = (error as Error).message;
      sendError(
        response,
        /does not exist|not found/i.test(message) ? 404 : 500,
        message,
      );
    }
  });

  app.post("/api/v2/tasks/:taskId/cancel", async (request, response) => {
    const project = projects.current();
    if (!beginProofPatchMutation(response)) return;
    try {
      const taskId = request.params.taskId;
      const reason = request.body?.reason;
      if (reason !== undefined && typeof reason !== "string") {
        sendError(response, 400, '"reason" must be a string.');
        return;
      }
      const detail = await readEvidenceTask(project.path, project.id, taskId);
      let binding:
        | Awaited<ReturnType<typeof loadProofPatchBinding>>
        | undefined;
      try {
        binding = await loadProofPatchBinding(project.path, taskId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (binding?.status === "published" || binding?.publishedAt) {
        sendError(
          response,
          409,
          `Task ${taskId} has a published ProofPatch and cannot be cancelled. Use POST /api/v2/tasks/${taskId}/rollback to undo its workspace changes.`,
        );
        return;
      }
      if (
        detail.task.state !== "cancelled" &&
        [
          "complete",
          "abstained",
          "blocked",
          "accepted_with_gaps",
          "publication",
        ].includes(detail.task.state)
      ) {
        sendError(
          response,
          409,
          `Task is already ${detail.task.state} and cannot be cancelled.`,
        );
        return;
      }
      if (binding?.status === "staged") {
        binding = await discardStagedProofPatch(project.path, taskId);
      }
      const projection = await cancelEvidenceTask(project.path, taskId, {
        ...(reason?.trim() ? { reason } : {}),
        ...(binding
          ? {
              discardedProofPatch: {
                transactionId: binding.transactionId,
                baseWorkspaceDigest: binding.baseWorkspaceDigest,
                finalWorkspaceDigest: binding.finalWorkspaceDigest,
                changedPaths: binding.changedPaths,
              },
            }
          : {}),
      });
      invalidateWorkspaceSessions(project.id);
      response.json({
        task: await readEvidenceTask(project.path, project.id, taskId),
        verdict: projection.state,
        ...(binding
          ? {
              proofPatch: {
                transactionId: binding.transactionId,
                status: binding.status,
                changedPaths: binding.changedPaths,
                rolledBackAt: binding.rolledBackAt,
              },
            }
          : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      sendError(
        response,
        /does not exist|not found|ENOENT/i.test(message)
          ? 404
          : /published|publication|already|cannot be cancelled|not staged/i.test(
                message,
              )
            ? 409
            : 500,
        message,
      );
    } finally {
      finishProofPatchMutation();
    }
  });

  app.post("/api/v2/tasks/:taskId/publish", async (request, response) => {
    const project = projects.current();
    if (!beginProofPatchMutation(response)) return;
    try {
      const taskId = request.params.taskId;
      const acceptGaps = request.body?.acceptGaps ?? false;
      if (typeof acceptGaps !== "boolean") {
        sendError(response, 400, '"acceptGaps" must be a boolean.');
        return;
      }
      const readiness = await evidencePublicationReadiness(
        project.path,
        taskId,
      );
      if (!readiness.canPublish) {
        sendError(
          response,
          409,
          `Only reviewed tasks can be published; current state is ${readiness.state}.`,
        );
        return;
      }
      if (readiness.requiresGapAcceptance && !acceptGaps) {
        response.status(409).json({
          error: {
            message: `Publication is blocked by ${readiness.gaps.length} evidence gap(s).`,
            gaps: readiness.gaps,
          },
        });
        return;
      }
      let binding = await loadProofPatchBinding(project.path, taskId);
      if (binding.status === "staged") {
        binding = (await publishBoundProofPatch(project.path, taskId)).binding;
      } else if (binding.status !== "published") {
        sendError(
          response,
          409,
          `ProofPatch transaction is ${binding.status}, not publishable.`,
        );
        return;
      }
      const projection = await finalizeEvidencePublication(
        project.path,
        taskId,
        {
          acceptGaps,
          baseWorkspaceDigest: binding.baseWorkspaceDigest,
          finalWorkspaceDigest: binding.finalWorkspaceDigest,
          transactionId: binding.transactionId,
        },
      );
      invalidateWorkspaceSessions(project.id);
      response.json({
        task: await readEvidenceTask(project.path, project.id, taskId),
        proofPatch: {
          transactionId: binding.transactionId,
          status: binding.status,
          changedPaths: binding.changedPaths,
          publishedAt: binding.publishedAt,
        },
        verdict: projection.state,
      });
    } catch (error) {
      const message = (error as Error).message;
      sendError(
        response,
        /does not exist|not found|ENOENT/i.test(message)
          ? 404
          : /blocked|only reviewed|not publishable|conflict|cannot publish/i.test(
                message,
              )
            ? 409
            : 500,
        message,
      );
    } finally {
      finishProofPatchMutation();
    }
  });

  app.post("/api/v2/tasks/:taskId/rollback", async (request, response) => {
    const project = projects.current();
    if (!beginProofPatchMutation(response)) return;
    try {
      const taskId = request.params.taskId;
      await readEvidenceTask(project.path, project.id, taskId);
      const before = await loadProofPatchBinding(project.path, taskId);
      const binding = await rollbackBoundProofPatch(project.path, taskId);
      const projection = await recordEvidenceRollback(project.path, taskId, {
        transactionId: binding.transactionId,
        wasPublished: before.status === "published",
        baseWorkspaceDigest: binding.baseWorkspaceDigest,
        finalWorkspaceDigest: binding.finalWorkspaceDigest,
      });
      invalidateWorkspaceSessions(project.id);
      response.json({
        proofPatch: {
          transactionId: binding.transactionId,
          status: binding.status,
          changedPaths: binding.changedPaths,
          rolledBackAt: binding.rolledBackAt,
        },
        task: await readEvidenceTask(project.path, project.id, taskId),
        verdict: projection.state,
      });
    } catch (error) {
      const message = (error as Error).message;
      sendError(
        response,
        /does not exist|not found|ENOENT/i.test(message)
          ? 404
          : /conflict|cannot|not staged|not published/i.test(message)
            ? 409
            : 500,
        message,
      );
    } finally {
      finishProofPatchMutation();
    }
  });

  app.post("/api/v2/policy/simulate", (request, response) => {
    try {
      const decision = simulatePolicy(
        request.body as PolicySimulationRequest,
      );
      response.json({
        decision,
        explanation: explainPolicyDecision(decision),
      });
    } catch (error) {
      sendError(response, 400, (error as Error).message);
    }
  });

  app.post("/api/v2/debug/causal", async (request, response) => {
    try {
      response.json(await replayRecordedCausalTwin(request.body));
    } catch (error) {
      sendError(response, 400, (error as Error).message);
    }
  });

  app.post("/api/v2/lab/replay", (request, response) => {
    try {
      response.json(replayReliabilityEvaluation(request.body));
    } catch (error) {
      sendError(response, 400, (error as Error).message);
    }
  });

  app.post("/api/v2/lab/calibrate", (request, response) => {
    try {
      response.json(calibrateReliabilityCandidate(request.body));
    } catch (error) {
      sendError(response, 400, (error as Error).message);
    }
  });

  app.get("/api/v2/cache/stats", async (request, response) => {
    const project = optionalCurrentProject(request, response, "Cache");
    if (!project) return;
    try {
      const cache = new VerifiedWorkCache(
        join(project.path, ".krater", "cache"),
      );
      response.json(await cache.stats());
    } catch (error) {
      sendError(response, 500, (error as Error).message);
    }
  });

  app.post("/api/sessions", (request, response) => {
    if (projectChanging) {
      sendError(response, 409, "Wait for the project change to finish.");
      return;
    }
    const projectId =
      typeof request.body?.projectId === "string"
        ? request.body.projectId.trim()
        : "";
    const currentProject = projects.current();
    if (!projectId) {
      sendError(response, 400, 'Session "projectId" must be a non-empty string.');
      return;
    }
    if (projectId !== currentProject.id) {
      sendError(
        response,
        409,
        "This session request belongs to a different project. Reload the workspace.",
      );
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
    const session = new BrowserSession(
      {
        ...config,
        cwd: currentProject.path,
      },
      async (apiKey, signal) => (await loadModels(apiKey, signal)).models,
      currentProject.id,
      invalidateWorkspaceSessions,
      options.evidenceMode ?? false,
    );
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
    const projectId =
      typeof request.body?.projectId === "string"
        ? request.body.projectId.trim()
        : "";
    if (!projectId) {
      sendError(response, 400, 'Message "projectId" must be a non-empty string.');
      return;
    }
    if (
      projectId !== session.projectId ||
      projectId !== projects.current().id
    ) {
      sendError(
        response,
        409,
        "This agent session belongs to a different project. Start a new task in the current workspace.",
      );
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
    const assurance =
      request.body?.assurance === undefined
        ? "standard"
        : request.body.assurance;
    if (!message) {
      sendError(response, 400, "Message cannot be empty.");
      return;
    }
    if (!["fast", "standard", "high"].includes(assurance)) {
      sendError(
        response,
        400,
        'Message "assurance" must be "fast", "standard", or "high".',
      );
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
        assurance as "fast" | "standard" | "high",
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

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: (error: unknown) => void,
    ) => {
      if (!(request.path === "/api" || request.path.startsWith("/api/"))) {
        next(error);
        return;
      }
      const parseError = error as {
        status?: number;
        type?: string;
      };
      if (
        parseError.status === 413 ||
        parseError.type === "entity.too.large"
      ) {
        sendError(response, 413, "JSON request body exceeds the 7 MB limit.");
        return;
      }
      if (parseError.status === 400) {
        sendError(response, 400, "Request body must contain valid JSON.");
        return;
      }
      next(error);
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
