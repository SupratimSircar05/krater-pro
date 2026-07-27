#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentSession } from "../src/agent.js";
import {
  loadConfig,
  requireApiKey,
  type KraterConfig,
} from "../src/config.js";
import {
  KraterProvider,
  type KraterProviderOptions,
} from "../src/provider.js";
import type { AgentEvent, ChatProvider, JsonObject, Usage } from "../src/types.js";
import {
  BENCHMARK_TASK_COUNT,
  type BenchmarkCatalog,
  type BenchmarkTask,
  validateBenchmarkCatalog,
} from "./schema.js";

const CATALOG_PATH = fileURLToPath(new URL("./tasks.json", import.meta.url));
const RUNNER_VERSION = "1.0.0";
const MAX_CHECKER_OUTPUT = 120_000;
const CHECKER_TIMEOUT_MS = 120_000;

export interface BenchmarkCliOptions {
  validate: boolean;
  list: boolean;
  task?: string;
  category?: string;
  model?: string;
  workspace?: string;
  live: boolean;
  output?: string;
  all: boolean;
  trustCheckers: boolean;
  help: boolean;
}

export interface BenchmarkExecutionPlan {
  live: boolean;
  selection: "default" | "task" | "category" | "all";
  selectedTasks: BenchmarkTask[];
}

export interface CapturedAgentEvent {
  atMs: number;
  event: AgentEvent;
}

export interface ExecutionScoreComponent {
  points: number;
  maximum: number;
  status: "passed" | "failed" | "partial" | "not-exercised";
  evidence: string;
}

export interface ExecutionScore {
  score: number;
  maximum: 100;
  completion: ExecutionScoreComponent;
  errorFree: ExecutionScoreComponent;
  toolReliability: ExecutionScoreComponent;
  warning: string;
}

export interface ExternalCheckResult {
  status: "not-enabled" | "not-configured" | "passed" | "failed" | "error";
  checker?: string;
  sha256?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface RubricResult {
  criterion: string;
  status: "unverified" | "external-check-passed" | "external-check-failed";
  evidence: string;
}

export interface BenchmarkTaskResult {
  task: Pick<BenchmarkTask, "id" | "title" | "category" | "difficulty">;
  status: "completed" | "error";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workspace: {
    mode: "copied" | "dossier";
    source?: string;
    isolatedWorkspaceRemoved: true;
  };
  streamedText: {
    chunks: string[];
    combined: string;
  };
  events: CapturedAgentEvent[];
  tools: {
    calls: number;
    results: number;
    successful: number;
    failed: number;
  };
  usage: Usage & { reports: number };
  errors: string[];
  executionScore: ExecutionScore;
  rubric: RubricResult[];
  externalCheck: ExternalCheckResult;
  correctnessStatement: string;
}

export interface BenchmarkReport {
  schemaVersion: "1.0";
  runner: { product: "Krater Pro"; version: string };
  benchmark: {
    name: string;
    version: string;
    description: string;
    catalogTaskCount: number;
  };
  run: {
    model: string;
    apiKeySource: string;
    contextChars: number;
    toolOutputChars: number;
    responseStyle: KraterConfig["responseStyle"];
    maxSteps: number;
    maxOutputTokens: number;
    sessionTokenBudget: number;
    mutationPolicy: {
      fileEdits: "auto-approved-in-isolated-workspace";
      shellCommands: "denied";
    };
    trustCheckers: boolean;
    selection: BenchmarkExecutionPlan["selection"];
    selectedTaskIds: string[];
    sourceWorkspace?: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  summary: {
    attempted: number;
    completed: number;
    errored: number;
    averageExecutionScore: number;
    externalChecksPassed: number;
    externallyUnchecked: number;
    correctness: string;
  };
  results: BenchmarkTaskResult[];
  methodologyWarning: string;
  creditWarning: string;
}

interface IsolatedWorkspace {
  runRoot: string;
  workspaceRoot: string;
  checker?: {
    absolutePath: string;
    displayPath: string;
    sha256: string;
  };
}

export interface BenchmarkCliDependencies {
  catalog?: unknown;
  cwd?: string;
  stdout?: (text: string) => void;
  providerFactory?: (options: KraterProviderOptions) => ChatProvider;
  signal?: AbortSignal;
}

export type BenchmarkCliResult =
  | {
      mode: "offline";
      plan?: BenchmarkExecutionPlan;
      catalog: BenchmarkCatalog;
    }
  | {
      mode: "live";
      plan: BenchmarkExecutionPlan;
      report: BenchmarkReport;
      paths: { json: string; markdown: string };
    };

export function benchmarkToolApproval(tool: string): boolean {
  return tool === "write_file" || tool === "replace_in_file";
}

function cleanCliValue(value: string, flag: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${flag} requires a non-empty value`);
  return cleaned;
}

export function parseCliArguments(argv: readonly string[]): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    validate: false,
    list: false,
    live: false,
    all: false,
    trustCheckers: false,
    help: false,
  };
  const valueFlags = new Map<
    string,
    "task" | "category" | "model" | "workspace" | "output"
  >([
    ["--task", "task"],
    ["--category", "category"],
    ["--model", "model"],
    ["--workspace", "workspace"],
    ["--output", "output"],
  ] as const);

  const setValue = (flag: string, key: "task" | "category" | "model" | "workspace" | "output", value: string) => {
    if (options[key] !== undefined) throw new Error(`${flag} may only be provided once`);
    options[key] = cleanCliValue(value, flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate") options.validate = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--trust-checkers") options.trustCheckers = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else {
      const equals = argument.indexOf("=");
      const flag = equals === -1 ? argument : argument.slice(0, equals);
      const key = valueFlags.get(flag);
      if (!key) throw new Error(`Unknown benchmark option: ${argument}`);
      const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
      const value = inlineValue ?? argv[++index];
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
        throw new Error(`${flag} requires a value`);
      }
      setValue(flag, key, value);
    }
  }
  return options;
}

export function createExecutionPlan(
  options: BenchmarkCliOptions,
  catalog: BenchmarkCatalog,
): BenchmarkExecutionPlan {
  const selectors = [
    options.task !== undefined,
    options.category !== undefined,
    options.all,
  ].filter(Boolean).length;
  if (selectors > 1) {
    throw new Error("--task, --category, and --all are mutually exclusive");
  }

  let selection: BenchmarkExecutionPlan["selection"] = "default";
  let selectedTasks = catalog.tasks;
  if (options.task) {
    selection = "task";
    selectedTasks = catalog.tasks.filter((task) => task.id === options.task);
    if (!selectedTasks.length) throw new Error(`Unknown benchmark task: ${options.task}`);
  } else if (options.category) {
    selection = "category";
    if (!catalog.categories.some((category) => category.id === options.category)) {
      throw new Error(`Unknown benchmark category: ${options.category}`);
    }
    selectedTasks = catalog.tasks.filter((task) => task.category === options.category);
  } else if (options.all) {
    selection = "all";
  }

  if (options.live && selection === "default") {
    throw new Error(
      `Live execution requires --task <KC-###> or --category <id>. ` +
        `Running all ${BENCHMARK_TASK_COUNT} tasks requires an explicit --all flag.`,
    );
  }
  if (options.trustCheckers && (!options.live || !options.workspace)) {
    throw new Error("--trust-checkers requires both --live and --workspace <path>");
  }
  if (!options.live && options.output) {
    throw new Error("--output is only used with --live benchmark execution");
  }
  if (!options.live && options.workspace) {
    throw new Error("--workspace is only used with --live benchmark execution");
  }

  return { live: options.live, selection, selectedTasks };
}

export function benchmarkHelp(): string {
  return [
    "Krater Pro expert benchmark",
    "",
    "Usage:",
    "  npx tsx benchmarks/run.ts [options]",
    "",
    "Offline options (never contact Krater):",
    "  --validate                 validate the complete 100-task catalog",
    "  --list                     list tasks (optionally filtered)",
    "  --task KC-001              select one task",
    "  --category <id>            select one ten-task category",
    "  --all                      explicitly select all 100 tasks",
    "",
    "Live options:",
    "  --live                     allow Krater API execution",
    "  --model <id>               override KRATER_MODEL for this run",
    "  --workspace <path>         copy a fixture workspace into isolation",
    "  --trust-checkers           execute a reviewed fixture checker (requires --workspace)",
    "  --output <path>            report stem, directory, .json, or .md path",
    "",
    "Safety:",
    "  --live alone is refused. Use --task/--category, or add --all intentionally.",
    "  Fixture checkers are ignored unless --trust-checkers is also explicit.",
    "  API keys are loaded from the environment or invocation-directory .env only.",
    "",
  ].join("\n");
}

async function readCatalog(): Promise<BenchmarkCatalog> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Could not read benchmark catalog ${CATALOG_PATH}: ${(error as Error).message}`);
  }
  return validateBenchmarkCatalog(parsed);
}

function renderTaskList(tasks: readonly BenchmarkTask[]): string {
  return tasks
    .map(
      (task) =>
        `${task.id}  [${task.category}]  ${task.title}  (${task.estimatedMinutes} min)`,
    )
    .join("\n");
}

function renderTaskDetails(task: BenchmarkTask): string {
  return [
    `${task.id}: ${task.title}`,
    `Category: ${task.category}`,
    `Difficulty: ${task.difficulty}`,
    `Estimate: ${task.estimatedMinutes} minutes`,
    `Capabilities: ${task.requiredCapabilities.join(", ")}`,
    "",
    task.prompt,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `${task.hiddenChecks.length} catalog hidden checks are intentionally withheld from live prompts.`,
    "",
  ].join("\n");
}

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".env",
  ".secrets",
  "secrets",
  ".ssh",
  ".aws",
  ".gnupg",
  ".krater-benchmark",
]);
const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
]);

/**
 * Returns true for paths which must never enter an auto-approved benchmark copy.
 * The function accepts slash styles from either platform so it is easy to test.
 */
export function shouldExcludeWorkspacePath(relativePath: string): boolean {
  const parts = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase());
  if (!parts.length) return false;
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) return true;
  const name = parts.at(-1)!;
  if (name.startsWith(".env.")) return true;
  if (EXCLUDED_FILE_NAMES.has(name)) return true;
  if (/^(?:credentials|secrets)\.[a-z0-9_-]+$/i.test(name)) return true;
  return /\.(?:pem|p12|pfx|key)$/i.test(name);
}

async function copyWorkspaceTree(
  sourceRoot: string,
  destinationRoot: string,
  currentRelative = "",
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(join(sourceRoot, currentRelative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const shown = currentRelative ? join(currentRelative, entry.name) : entry.name;
    if (shouldExcludeWorkspacePath(shown)) continue;
    const source = join(sourceRoot, shown);
    const destination = join(destinationRoot, shown);
    const details = await lstat(source);
    if (details.isSymbolicLink()) continue;
    if (details.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyWorkspaceTree(sourceRoot, destinationRoot, shown);
    } else if (details.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }
}

function dossierMarkdown(task: BenchmarkTask): string {
  return [
    `# ${task.id}: ${task.title}`,
    "",
    "This is an isolated Krater Pro benchmark dossier. No source fixture was supplied.",
    "Create the smallest coherent project needed to solve and verify the task.",
    "",
    "## Task",
    "",
    task.prompt,
    "",
    "## Setup",
    "",
    task.setup.summary,
    "",
    `Suggested stack: ${task.setup.stack.join(", ")}`,
    "",
    "Catalog seed-file paths (descriptive only; they were not materialized):",
    ...task.setup.seedFiles.map((path) => `- \`${path}\``),
    "",
    "## Acceptance criteria",
    "",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Known hazards",
    "",
    ...task.hazards.map((hazard) => `- ${hazard}`),
    "",
    "The catalog's hidden checks are intentionally absent from this workspace.",
    "",
  ].join("\n");
}

async function findAndCopyChecker(
  sourceWorkspace: string,
  taskId: string,
  runRoot: string,
): Promise<IsolatedWorkspace["checker"]> {
  for (const extension of [".mjs", ".js", ".sh"]) {
    const displayPath = join(".krater-benchmark", "checks", `${taskId}${extension}`);
    const source = join(sourceWorkspace, displayPath);
    try {
      const details = await lstat(source);
      if (!details.isFile() || details.isSymbolicLink()) continue;
      const physicalSource = await realpath(source);
      const shownPhysical = relative(sourceWorkspace, physicalSource);
      if (
        shownPhysical === ".." ||
        shownPhysical.startsWith(`..${sep}`)
      ) {
        continue;
      }
      const checkerDirectory = join(runRoot, "checker");
      await mkdir(checkerDirectory, { recursive: true });
      const destination = join(checkerDirectory, basename(source));
      await copyFile(physicalSource, destination);
      const sha256 = createHash("sha256")
        .update(await readFile(destination))
        .digest("hex");
      return { absolutePath: destination, displayPath, sha256 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

export async function createIsolatedWorkspace(
  task: BenchmarkTask,
  sourceWorkspace?: string,
  trustCheckers = false,
): Promise<IsolatedWorkspace> {
  const runRoot = await mkdtemp(join(tmpdir(), `krater-pro-${task.id.toLocaleLowerCase()}-`));
  const workspaceRoot = join(runRoot, "workspace");
  try {
    await mkdir(workspaceRoot, { recursive: true });
    let checker: IsolatedWorkspace["checker"];
    if (sourceWorkspace) {
      const physicalSource = await realpath(resolve(sourceWorkspace));
      const details = await stat(physicalSource);
      if (!details.isDirectory()) {
        throw new Error(`Benchmark workspace is not a directory: ${sourceWorkspace}`);
      }
      checker = trustCheckers
        ? await findAndCopyChecker(physicalSource, task.id, runRoot)
        : undefined;
      await copyWorkspaceTree(physicalSource, workspaceRoot);
    } else {
      await writeFile(
        join(workspaceRoot, "BENCHMARK_TASK.md"),
        dossierMarkdown(task),
        "utf8",
      );
    }
    return { runRoot, workspaceRoot, checker };
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}

function taskPrompt(task: BenchmarkTask): string {
  return [
    `Run benchmark task ${task.id}: ${task.title}.`,
    "",
    task.prompt,
    "",
    "Setup:",
    task.setup.summary,
    `Stack: ${task.setup.stack.join(", ")}`,
    `Expected seed paths: ${task.setup.seedFiles.join(", ")}`,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "Hazards to handle:",
    ...task.hazards.map((hazard) => `- ${hazard}`),
    "",
    "Work only in the current isolated workspace. Inspect before editing, implement the",
    "solution, and run relevant checks. Report evidence and genuine limitations. Do not",
    "claim correctness merely because you wrote code; the runner scores execution evidence",
    "separately from external correctness checks.",
  ].join("\n");
}

function redactText(value: string, apiKey: string): string {
  let redacted = apiKey ? value.split(apiKey).join("[REDACTED_KRATER_API_KEY]") : value;
  redacted = redacted.replace(
    /((?:KRATER_API_KEY|authorization)\s*(?:=|:)\s*(?:Bearer\s+)?)[^\s"'`]+/gi,
    "$1[REDACTED]",
  );
  return redacted;
}

function redactUnknown(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") return redactText(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, apiKey));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactUnknown(item, apiKey);
    }
    return output;
  }
  return value;
}

function aggregateUsage(events: readonly CapturedAgentEvent[]): Usage & { reports: number } {
  const aggregate: Usage & { reports: number } = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reports: 0,
  };
  for (const captured of events) {
    if (captured.event.type !== "usage") continue;
    aggregate.reports += 1;
    aggregate.promptTokens! += captured.event.promptTokens ?? 0;
    aggregate.completionTokens! += captured.event.completionTokens ?? 0;
    aggregate.totalTokens! += captured.event.totalTokens ?? 0;
  }
  return aggregate;
}

export function calculateExecutionScore(
  events: readonly CapturedAgentEvent[],
  errors: readonly string[],
): ExecutionScore {
  const completed = events.some(({ event }) => event.type === "done");
  const toolResults = events
    .map(({ event }) => event)
    .filter((event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result",
    );
  const successfulTools = toolResults.filter((event) => event.ok).length;
  const completionPoints = completed ? 40 : 0;
  const errorPoints = errors.length === 0 ? 30 : 0;
  const toolPoints = toolResults.length
    ? Math.round((successfulTools / toolResults.length) * 3_000) / 100
    : 0;
  const toolStatus =
    toolResults.length === 0
      ? "not-exercised"
      : successfulTools === toolResults.length
        ? "passed"
        : successfulTools === 0
          ? "failed"
          : "partial";

  return {
    score: completionPoints + errorPoints + toolPoints,
    maximum: 100,
    completion: {
      points: completionPoints,
      maximum: 40,
      status: completed ? "passed" : "failed",
      evidence: completed
        ? "AgentSession emitted a done event."
        : "AgentSession did not emit a done event.",
    },
    errorFree: {
      points: errorPoints,
      maximum: 30,
      status: errors.length ? "failed" : "passed",
      evidence: errors.length
        ? `${errors.length} runtime error(s) were captured.`
        : "No runtime error event or thrown run error was captured.",
    },
    toolReliability: {
      points: toolPoints,
      maximum: 30,
      status: toolStatus,
      evidence: toolResults.length
        ? `${successfulTools}/${toolResults.length} tool results reported success.`
        : "No tool result was produced, so tool reliability was not exercised.",
    },
    warning:
      "Execution score measures run completion and tool behavior only; it is not a correctness score.",
  };
}

function safeCheckerEnvironment(
  runRoot: string,
  taskId: string,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "LANG",
    "TERM",
    "CI",
    "NO_COLOR",
    "NODE_ENV",
    "JAVA_HOME",
    "GOPATH",
    "GOROOT",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "SDKROOT",
    "DEVELOPER_DIR",
  ]);
  const environment: NodeJS.ProcessEnv = {
    HOME: join(runRoot, "checker-home"),
    KRATER_BENCHMARK_TASK_ID: taskId,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowed.has(name) || name.startsWith("LC_"))) {
      environment[name] = value;
    }
  }
  return environment;
}

async function runCheckerProcess(
  checker: NonNullable<IsolatedWorkspace["checker"]>,
  isolated: IsolatedWorkspace,
  taskId: string,
  apiKey: string,
): Promise<ExternalCheckResult> {
  const started = Date.now();
  const extension = extname(checker.absolutePath);
  const command = extension === ".sh" ? "/bin/sh" : process.execPath;
  const args = [checker.absolutePath];
  await mkdir(join(isolated.runRoot, "checker-home"), { recursive: true });

  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: isolated.workspaceRoot,
      env: safeCheckerEnvironment(isolated.runRoot, taskId),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const finish = (result: ExternalCheckResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise({
        ...result,
        checker: checker.displayPath,
        sha256: checker.sha256,
        durationMs: Date.now() - started,
        stdout: redactText(stdout.slice(0, MAX_CHECKER_OUTPUT), apiKey),
        stderr: redactText(stderr.slice(0, MAX_CHECKER_OUTPUT), apiKey),
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CHECKER_OUTPUT * 2) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CHECKER_OUTPUT * 2) stderr += chunk.toString();
    });
    child.on("error", (error) =>
      finish({ status: "error", error: redactText(error.message, apiKey) }),
    );
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        forceTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 2_000);
      } else {
        child.kill("SIGTERM");
      }
    }, CHECKER_TIMEOUT_MS);
    child.on("close", (exitCode) => {
      finish({
        status: !timedOut && exitCode === 0 ? "passed" : "failed",
        exitCode,
        timedOut,
      });
    });
  });
}

async function runExternalCheck(
  isolated: IsolatedWorkspace,
  task: BenchmarkTask,
  apiKey: string,
  trustCheckers: boolean,
): Promise<ExternalCheckResult> {
  if (!trustCheckers) return { status: "not-enabled" };
  if (!isolated.checker) return { status: "not-configured" };
  return runCheckerProcess(isolated.checker, isolated, task.id, apiKey);
}

function rubricForTask(
  task: BenchmarkTask,
  externalCheck: ExternalCheckResult,
): RubricResult[] {
  return task.acceptanceCriteria.map((criterion) => {
    if (externalCheck.status === "passed") {
      return {
        criterion,
        status: "external-check-passed",
        evidence:
          `${externalCheck.checker} (SHA-256 ${externalCheck.sha256}) ` +
          "exited successfully after the run.",
      };
    }
    if (externalCheck.status === "failed" || externalCheck.status === "error") {
      return {
        criterion,
        status: "external-check-failed",
        evidence:
          externalCheck.error ??
          `${externalCheck.checker} did not exit successfully after the run.`,
      };
    }
    if (externalCheck.status === "not-enabled") {
      return {
        criterion,
        status: "unverified",
        evidence:
          "Checker trust was not explicitly enabled; no fixture checker was discovered or executed.",
      };
    }
    return {
      criterion,
      status: "unverified",
      evidence:
        "Checker trust was enabled, but no independent executable checker was found; model statements are not verification.",
    };
  });
}

async function runOneTask(
  task: BenchmarkTask,
  provider: ChatProvider,
  model: string,
  apiKey: string,
  agentRuntime: Pick<
    KraterConfig,
    | "contextChars"
    | "toolOutputChars"
    | "responseStyle"
    | "maxSteps"
    | "sessionTokenBudget"
  >,
  sourceWorkspace: string | undefined,
  trustCheckers: boolean,
  announce: (text: string) => void,
  signal: AbortSignal | undefined,
): Promise<BenchmarkTaskResult> {
  const isolated = await createIsolatedWorkspace(
    task,
    sourceWorkspace,
    trustCheckers,
  );
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const events: CapturedAgentEvent[] = [];
  const streamedChunks: string[] = [];
  const errors: string[] = [];

  try {
    const agent = new AgentSession({
      provider,
      cwd: isolated.workspaceRoot,
      model,
      autoApprove: false,
      requestApproval: async (request) => benchmarkToolApproval(request.tool),
      contextCharBudget: agentRuntime.contextChars,
      toolOutputCharBudget: agentRuntime.toolOutputChars,
      responseStyle: agentRuntime.responseStyle,
      maxSteps: agentRuntime.maxSteps,
      sessionTokenBudget: agentRuntime.sessionTokenBudget,
      onEvent: (rawEvent) => {
        const event = redactUnknown(rawEvent, apiKey) as AgentEvent;
        events.push({ atMs: Date.now() - startedAtMs, event });
        if (event.type === "text") streamedChunks.push(event.text);
        if (event.type === "error" && !errors.includes(event.message)) {
          errors.push(event.message);
        }
      },
    });
    try {
      await agent.run(taskPrompt(task), signal);
    } catch (error) {
      const message = redactText((error as Error).message, apiKey);
      if (!errors.includes(message)) errors.push(message);
    }

    if (isolated.checker) {
      announce(
        `Trusted checker: ${isolated.checker.displayPath}\n` +
          `SHA-256: ${isolated.checker.sha256}\n`,
      );
    }
    const externalCheck = await runExternalCheck(
      isolated,
      task,
      apiKey,
      trustCheckers,
    );
    const finishedAtMs = Date.now();
    const toolEvents = events.map(({ event }) => event);
    const toolCalls = toolEvents.filter((event) => event.type === "tool").length;
    const toolResults = toolEvents.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    const successful = toolResults.filter((event) => event.ok).length;
    const rubric = rubricForTask(task, externalCheck);

    return {
      task: {
        id: task.id,
        title: task.title,
        category: task.category,
        difficulty: task.difficulty,
      },
      status:
        errors.length === 0 && events.some(({ event }) => event.type === "done")
          ? "completed"
          : "error",
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      workspace: {
        mode: sourceWorkspace ? "copied" : "dossier",
        ...(sourceWorkspace ? { source: sourceWorkspace } : {}),
        isolatedWorkspaceRemoved: true,
      },
      streamedText: {
        chunks: streamedChunks,
        combined: streamedChunks.join(""),
      },
      events,
      tools: {
        calls: toolCalls,
        results: toolResults.length,
        successful,
        failed: toolResults.length - successful,
      },
      usage: aggregateUsage(events),
      errors,
      executionScore: calculateExecutionScore(events, errors),
      rubric,
      externalCheck,
      correctnessStatement:
        externalCheck.status === "passed"
          ? "The independent workspace checker passed; this is external evidence, not a model self-assessment."
          : "Task correctness is not established. Execution evidence and model self-report are insufficient.",
    };
  } finally {
    await rm(isolated.runRoot, { recursive: true, force: true });
  }
}

function safeReportComponent(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "benchmark"
  );
}

export async function resolveReportPaths(
  output: string | undefined,
  cwd: string,
  stem: string,
): Promise<{ json: string; markdown: string }> {
  let base: string;
  if (!output) {
    base = join(cwd, "benchmarks", "results", stem);
  } else {
    const requested = resolve(cwd, output);
    let isDirectory = output.endsWith("/") || output.endsWith(sep);
    try {
      isDirectory = (await stat(requested)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (isDirectory) base = join(requested, stem);
    else if ([".json", ".md"].includes(extname(requested).toLocaleLowerCase())) {
      base = requested.slice(0, -extname(requested).length);
    } else {
      base = requested;
    }
  }
  return { json: `${base}.json`, markdown: `${base}.md` };
}

function average(values: readonly number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function buildReport(
  catalog: BenchmarkCatalog,
  plan: BenchmarkExecutionPlan,
  model: string,
  apiKeySource: string,
  agentRuntime: Pick<
    KraterConfig,
    | "contextChars"
    | "toolOutputChars"
    | "responseStyle"
    | "maxSteps"
    | "maxOutputTokens"
    | "sessionTokenBudget"
  >,
  sourceWorkspace: string | undefined,
  trustCheckers: boolean,
  results: BenchmarkTaskResult[],
  startedAtMs: number,
  finishedAtMs: number,
): BenchmarkReport {
  const externalChecksPassed = results.filter(
    (result) => result.externalCheck.status === "passed",
  ).length;
  return {
    schemaVersion: "1.0",
    runner: { product: "Krater Pro", version: RUNNER_VERSION },
    benchmark: {
      name: catalog.name,
      version: catalog.version,
      description: catalog.description,
      catalogTaskCount: catalog.tasks.length,
    },
    run: {
      model,
      apiKeySource,
      contextChars: agentRuntime.contextChars,
      toolOutputChars: agentRuntime.toolOutputChars,
      responseStyle: agentRuntime.responseStyle,
      maxSteps: agentRuntime.maxSteps,
      maxOutputTokens: agentRuntime.maxOutputTokens,
      sessionTokenBudget: agentRuntime.sessionTokenBudget,
      mutationPolicy: {
        fileEdits: "auto-approved-in-isolated-workspace",
        shellCommands: "denied",
      },
      trustCheckers,
      selection: plan.selection,
      selectedTaskIds: results.map((result) => result.task.id),
      ...(sourceWorkspace ? { sourceWorkspace } : {}),
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
    },
    summary: {
      attempted: results.length,
      completed: results.filter((result) => result.status === "completed").length,
      errored: results.filter((result) => result.status === "error").length,
      averageExecutionScore: average(
        results.map((result) => result.executionScore.score),
      ),
      externalChecksPassed,
      externallyUnchecked: results.filter(
        (result) =>
          result.externalCheck.status === "not-enabled" ||
          result.externalCheck.status === "not-configured",
      ).length,
      correctness:
        externalChecksPassed === results.length && results.length > 0
          ? "Every selected task's independent checker passed."
          : "Correctness is not established for tasks without a passing independent checker.",
    },
    results,
    methodologyWarning:
      "Execution scores cover completion, runtime errors, and tool-result reliability only. They never treat model self-report as proof of task correctness.",
    creditWarning:
      "Live benchmarks call a paid Krater model and may use substantial tokens. Category runs execute ten tasks; --all executes one hundred.",
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdownReport(report: BenchmarkReport): string {
  const lines = [
    "# Krater Pro Benchmark Report",
    "",
    `- Benchmark: ${report.benchmark.name} v${report.benchmark.version}`,
    `- Model: \`${report.run.model}\``,
    `- Agent runtime: ${report.run.responseStyle} responses, ${report.run.contextChars} context chars, ${report.run.toolOutputChars} tool-output chars, ${report.run.maxSteps} max steps, ${report.run.maxOutputTokens} max output tokens, ${report.run.sessionTokenBudget} session-token budget`,
    "- Mutation policy: file edits auto-approved inside the copied workspace; model-requested shell commands denied",
    `- Trusted checker execution: ${report.run.trustCheckers ? "enabled by explicit opt-in" : "disabled"}`,
    `- Selection: ${report.run.selection} (${report.summary.attempted} task(s))`,
    `- Started: ${report.run.startedAt}`,
    `- Duration: ${report.run.durationMs} ms`,
    `- Average execution score: ${report.summary.averageExecutionScore}/100`,
    `- Correctness: ${report.summary.correctness}`,
    "",
    `> ${report.methodologyWarning}`,
    "",
    `> Credit warning: ${report.creditWarning}`,
    "",
    "## Results",
    "",
    "| Task | Runtime | Execution | Tools | External check |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.results.map(
      (result) =>
        `| ${result.task.id} — ${tableCell(result.task.title)} | ${result.durationMs} ms | ` +
        `${result.executionScore.score}/100 | ${result.tools.successful}/${result.tools.results} | ` +
        `${result.externalCheck.status} |`,
    ),
    "",
  ];

  for (const result of report.results) {
    lines.push(
      `## ${result.task.id}: ${result.task.title}`,
      "",
      `Status: **${result.status}** · execution score **${result.executionScore.score}/100**`,
      "",
      result.correctnessStatement,
      "",
      "### Execution evidence",
      "",
      `- Completion: ${result.executionScore.completion.points}/${result.executionScore.completion.maximum} — ${result.executionScore.completion.evidence}`,
      `- Error-free run: ${result.executionScore.errorFree.points}/${result.executionScore.errorFree.maximum} — ${result.executionScore.errorFree.evidence}`,
      `- Tool reliability: ${result.executionScore.toolReliability.points}/${result.executionScore.toolReliability.maximum} — ${result.executionScore.toolReliability.evidence}`,
      `- Usage reported: ${result.usage.totalTokens ?? 0} total tokens across ${result.usage.reports} usage event(s)`,
      "",
      "### Acceptance rubric",
      "",
      "| Criterion | Status | Evidence |",
      "| --- | --- | --- |",
      ...result.rubric.map(
        (rubric) =>
          `| ${tableCell(rubric.criterion)} | ${rubric.status} | ${tableCell(rubric.evidence)} |`,
      ),
      "",
    );
    if (result.errors.length) {
      lines.push(
        "### Errors",
        "",
        ...result.errors.map((error) => `- ${tableCell(error)}`),
        "",
      );
    }
    lines.push(
      "<details>",
      "<summary>Streamed model text</summary>",
      "",
      `<pre>${escapeHtml(result.streamedText.combined || "(no text streamed)")}</pre>`,
      "",
      "</details>",
      "",
      "<details>",
      "<summary>External checker output</summary>",
      "",
      `<pre>${escapeHtml(
        [
          `status: ${result.externalCheck.status}`,
          result.externalCheck.checker
            ? `checker: ${result.externalCheck.checker}`
            : "",
          result.externalCheck.sha256
            ? `sha256: ${result.externalCheck.sha256}`
            : "",
          result.externalCheck.stdout ?? "",
          result.externalCheck.stderr ?? "",
          result.externalCheck.error ?? "",
        ]
          .filter(Boolean)
          .join("\n") || "(not configured)",
      )}</pre>`,
      "",
      "</details>",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeReport(
  report: BenchmarkReport,
  paths: { json: string; markdown: string },
): Promise<void> {
  await Promise.all([
    mkdir(dirname(paths.json), { recursive: true }),
    mkdir(dirname(paths.markdown), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(paths.markdown, renderMarkdownReport(report), "utf8"),
  ]);
}

export async function runBenchmarkCli(
  argv: readonly string[],
  dependencies: BenchmarkCliDependencies = {},
): Promise<BenchmarkCliResult> {
  const options = parseCliArguments(argv);
  const output = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const catalog = validateBenchmarkCatalog(
    dependencies.catalog ?? (await readCatalog()),
  );

  if (options.help) {
    output(benchmarkHelp());
    return { mode: "offline", catalog };
  }

  const plan = createExecutionPlan(options, catalog);
  if (!options.live) {
    output(
      `Catalog valid: ${catalog.tasks.length} tasks across ${catalog.categories.length} categories.\n`,
    );
    if (options.task && !options.list) {
      output(`\n${renderTaskDetails(plan.selectedTasks[0])}`);
    } else if (
      options.list ||
      options.category ||
      options.all ||
      (!options.validate && !options.task)
    ) {
      output(`\n${renderTaskList(plan.selectedTasks)}\n`);
    }
    return { mode: "offline", plan, catalog };
  }

  const invocationCwd = await realpath(resolve(dependencies.cwd ?? process.cwd()));
  const sourceWorkspace = options.workspace
    ? await realpath(resolve(invocationCwd, options.workspace))
    : undefined;
  if (sourceWorkspace && !(await stat(sourceWorkspace)).isDirectory()) {
    throw new Error(`Benchmark workspace is not a directory: ${sourceWorkspace}`);
  }
  const config = loadConfig({ cwd: invocationCwd, model: options.model });
  const apiKey = requireApiKey(config);
  const provider = (dependencies.providerFactory ?? ((providerOptions) =>
    new KraterProvider(providerOptions)))({
    apiKey,
    baseURL: config.baseURL,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
  });

  output(
    `Live Krater Pro benchmark: ${plan.selectedTasks.length} task(s), model ${config.model}.\n` +
      "This may consume substantial Krater credits. API key contents will not be logged.\n",
  );
  const startedAtMs = Date.now();
  const results: BenchmarkTaskResult[] = [];
  for (const task of plan.selectedTasks) {
    if (dependencies.signal?.aborted) throw new Error("Benchmark cancelled.");
    output(`Running ${task.id}: ${task.title}...\n`);
    const result = await runOneTask(
      task,
      provider,
      config.model,
      apiKey,
      {
        contextChars: config.contextChars,
        toolOutputChars: config.toolOutputChars,
        responseStyle: config.responseStyle,
        maxSteps: config.maxSteps,
        sessionTokenBudget: config.sessionTokenBudget,
      },
      sourceWorkspace,
      options.trustCheckers,
      output,
      dependencies.signal,
    );
    results.push(result);
    output(
      `Finished ${task.id}: ${result.status}, execution ${result.executionScore.score}/100, ` +
        `external check ${result.externalCheck.status}.\n`,
    );
  }
  const finishedAtMs = Date.now();
  const report = buildReport(
    catalog,
    plan,
    config.model,
    config.apiKeySource,
    {
      contextChars: config.contextChars,
      toolOutputChars: config.toolOutputChars,
      responseStyle: config.responseStyle,
      maxSteps: config.maxSteps,
      maxOutputTokens: config.maxOutputTokens,
      sessionTokenBudget: config.sessionTokenBudget,
    },
    sourceWorkspace,
    options.trustCheckers,
    results,
    startedAtMs,
    finishedAtMs,
  );
  const timestamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, "-");
  const selectionLabel =
    plan.selection === "task"
      ? plan.selectedTasks[0].id
      : plan.selection === "category"
        ? plan.selectedTasks[0].category
        : "all";
  const stem = `${timestamp}-${safeReportComponent(config.model)}-${safeReportComponent(selectionLabel)}`;
  const paths = await resolveReportPaths(options.output, invocationCwd, stem);
  await writeReport(report, paths);
  output(`JSON report: ${paths.json}\nMarkdown report: ${paths.markdown}\n`);
  return { mode: "live", plan, report, paths };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runBenchmarkCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Krater Pro benchmark error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
