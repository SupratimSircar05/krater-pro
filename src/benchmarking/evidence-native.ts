import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const EVIDENCE_BENCHMARK_FORMAT = "krater.evidence-benchmark/v1" as const;
export const CHECKER_REPORT_FORMAT = "krater.sealed-checker-report/v1" as const;
export const MAX_MANIFEST_BYTES = 1_048_576;
export const MAX_CHECKER_OUTPUT_BYTES = 65_536;

export type EvidenceBenchmarkRuntime = "node" | "python";

export interface EvidenceBenchmarkTask {
  id: string;
  sourceSpecId: string;
  title: string;
  runtime: EvidenceBenchmarkRuntime;
  prompt: string;
  acceptanceCriteria: string[];
  fixture: {
    root: string;
    files: string[];
  };
  checker: {
    entry: string;
    sha256: string;
    timeoutMs: number;
  };
}

export interface EvidenceBenchmarkManifest {
  format: typeof EVIDENCE_BENCHMARK_FORMAT;
  suite: {
    id: string;
    name: string;
    version: string;
    description: string;
  };
  tasks: EvidenceBenchmarkTask[];
}

export interface SealedCheckerReport {
  format: typeof CHECKER_REPORT_FORMAT;
  taskId: string;
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
  }>;
}

export interface CheckerExecution {
  report: SealedCheckerReport;
  exitCode: number;
  elapsedMs: number;
}

export class EvidenceBenchmarkValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(
      `Evidence benchmark validation failed with ${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "EvidenceBenchmarkValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectWithExactKeys(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: string[],
): UnknownRecord | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
  for (const key of keys) {
    if (!(key in value)) issues.push(`${path}.${key} is required`);
  }
  return value;
}

function nonBlankString(
  value: unknown,
  path: string,
  issues: string[],
  minimum = 1,
): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return undefined;
  }
  if (value.trim().length < minimum) {
    issues.push(`${path} must contain at least ${minimum} non-whitespace characters`);
    return undefined;
  }
  return value;
}

function safeRelativePath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
  minimumItems: number,
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length < minimumItems) {
    issues.push(`${path} must contain at least ${minimumItems} item(s)`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const checked = nonBlankString(item, `${path}[${index}]`, issues);
    if (checked === undefined) return;
    if (seen.has(checked)) issues.push(`${path}[${index}] is duplicated`);
    seen.add(checked);
    result.push(checked);
  });
  return result;
}

/**
 * Validates untrusted manifest JSON without coercing fields or ignoring additions.
 *
 * The manifest is intentionally declarative: it points to public fixture files and
 * a host-owned checker. It cannot embed commands, environment variables, expected
 * patches, or arbitrary checker arguments.
 */
export function validateEvidenceBenchmarkManifest(
  value: unknown,
): EvidenceBenchmarkManifest {
  const issues: string[] = [];
  const manifest = objectWithExactKeys(value, "manifest", ["format", "suite", "tasks"], issues);
  if (!manifest) throw new EvidenceBenchmarkValidationError(issues);

  if (manifest.format !== EVIDENCE_BENCHMARK_FORMAT) {
    issues.push(`manifest.format must be exactly "${EVIDENCE_BENCHMARK_FORMAT}"`);
  }

  const suite = objectWithExactKeys(
    manifest.suite,
    "manifest.suite",
    ["id", "name", "version", "description"],
    issues,
  );
  if (suite) {
    const id = nonBlankString(suite.id, "manifest.suite.id", issues, 3);
    if (id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      issues.push("manifest.suite.id must be lowercase kebab-case");
    }
    nonBlankString(suite.name, "manifest.suite.name", issues, 8);
    const version = nonBlankString(suite.version, "manifest.suite.version", issues);
    if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      issues.push("manifest.suite.version must be semantic versioning");
    }
    nonBlankString(suite.description, "manifest.suite.description", issues, 40);
  }

  if (!Array.isArray(manifest.tasks)) {
    issues.push("manifest.tasks must be an array");
  } else {
    if (manifest.tasks.length < 1 || manifest.tasks.length > 1_000) {
      issues.push("manifest.tasks must contain between 1 and 1000 tasks");
    }
    const taskIds = new Set<string>();
    manifest.tasks.forEach((candidate, index) => {
      const path = `manifest.tasks[${index}]`;
      const task = objectWithExactKeys(
        candidate,
        path,
        [
          "id",
          "sourceSpecId",
          "title",
          "runtime",
          "prompt",
          "acceptanceCriteria",
          "fixture",
          "checker",
        ],
        issues,
      );
      if (!task) return;

      const id = nonBlankString(task.id, `${path}.id`, issues, 6);
      if (id) {
        if (!/^EB-\d{3}$/.test(id)) issues.push(`${path}.id must match EB-NNN`);
        if (taskIds.has(id)) issues.push(`${path}.id must be unique`);
        taskIds.add(id);
      }
      const sourceSpecId = nonBlankString(task.sourceSpecId, `${path}.sourceSpecId`, issues);
      if (sourceSpecId && !/^KC-\d{3}$/.test(sourceSpecId)) {
        issues.push(`${path}.sourceSpecId must match KC-NNN`);
      }
      nonBlankString(task.title, `${path}.title`, issues, 8);
      if (task.runtime !== "node" && task.runtime !== "python") {
        issues.push(`${path}.runtime must be "node" or "python"`);
      }
      nonBlankString(task.prompt, `${path}.prompt`, issues, 40);
      stringArray(task.acceptanceCriteria, `${path}.acceptanceCriteria`, issues, 2);

      const fixture = objectWithExactKeys(
        task.fixture,
        `${path}.fixture`,
        ["root", "files"],
        issues,
      );
      if (fixture) {
        const root = nonBlankString(fixture.root, `${path}.fixture.root`, issues);
        if (root && (!safeRelativePath(root) || !root.startsWith("fixtures/"))) {
          issues.push(`${path}.fixture.root must be a safe path under fixtures/`);
        }
        const files = stringArray(fixture.files, `${path}.fixture.files`, issues, 1);
        files?.forEach((file, fileIndex) => {
          if (!safeRelativePath(file)) {
            issues.push(`${path}.fixture.files[${fileIndex}] must be a safe relative path`);
          }
        });
      }

      const checker = objectWithExactKeys(
        task.checker,
        `${path}.checker`,
        ["entry", "sha256", "timeoutMs"],
        issues,
      );
      if (checker) {
        const entry = nonBlankString(checker.entry, `${path}.checker.entry`, issues);
        if (entry && (!safeRelativePath(entry) || !entry.startsWith("checkers/"))) {
          issues.push(`${path}.checker.entry must be a safe path under checkers/`);
        }
        if (typeof checker.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checker.sha256)) {
          issues.push(`${path}.checker.sha256 must be a lowercase SHA-256 digest`);
        }
        if (
          !Number.isInteger(checker.timeoutMs) ||
          (checker.timeoutMs as number) < 100 ||
          (checker.timeoutMs as number) > 30_000
        ) {
          issues.push(`${path}.checker.timeoutMs must be an integer from 100 to 30000`);
        }
      }
    });
  }

  if (issues.length) throw new EvidenceBenchmarkValidationError(issues);
  return value as EvidenceBenchmarkManifest;
}

export async function readEvidenceBenchmarkManifest(
  benchmarkRoot: string,
): Promise<EvidenceBenchmarkManifest> {
  const path = resolve(benchmarkRoot, "manifest.json");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new EvidenceBenchmarkValidationError([
      `manifest.json exceeds ${MAX_MANIFEST_BYTES} bytes`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new EvidenceBenchmarkValidationError([
      `manifest.json is not valid JSON: ${(error as Error).message}`,
    ]);
  }
  return validateEvidenceBenchmarkManifest(parsed);
}

function pathIsInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function regularFileInside(root: string, relativePath: string): Promise<string> {
  if (!safeRelativePath(relativePath)) {
    throw new EvidenceBenchmarkValidationError([
      `${relativePath} is not a safe relative asset path`,
    ]);
  }
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, relativePath);
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new EvidenceBenchmarkValidationError([
      `${relativePath} must be a regular file, not a link or special file`,
    ]);
  }
  const candidateReal = await realpath(candidate);
  if (!pathIsInside(rootReal, candidateReal)) {
    throw new EvidenceBenchmarkValidationError([
      `${relativePath} resolves outside the benchmark root`,
    ]);
  }
  return candidateReal;
}

async function listFixtureFiles(
  benchmarkRoot: string,
  fixtureRoot: string,
): Promise<string[]> {
  const rootReal = await realpath(benchmarkRoot);
  const start = resolve(rootReal, fixtureRoot);
  const startStats = await lstat(start);
  if (startStats.isSymbolicLink() || !startStats.isDirectory()) {
    throw new EvidenceBenchmarkValidationError([
      `${fixtureRoot} must be a regular directory`,
    ]);
  }
  const startReal = await realpath(start);
  if (!pathIsInside(rootReal, startReal)) {
    throw new EvidenceBenchmarkValidationError([
      `${fixtureRoot} resolves outside the benchmark root`,
    ]);
  }

  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(relativePath) || entry.isSymbolicLink()) {
        throw new EvidenceBenchmarkValidationError([
          `${fixtureRoot}/${relativePath} is an unsafe fixture entry`,
        ]);
      }
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new EvidenceBenchmarkValidationError([
          `${fixtureRoot}/${relativePath} is not a regular file`,
        ]);
      }
    }
  };
  await visit(startReal, "");
  return files;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Verifies that every declared asset is regular, confined, complete, and sealed.
 */
export async function validateEvidenceBenchmarkAssets(
  benchmarkRoot: string,
  manifest: EvidenceBenchmarkManifest,
): Promise<void> {
  const issues: string[] = [];
  for (const task of manifest.tasks) {
    try {
      const actualFiles = await listFixtureFiles(benchmarkRoot, task.fixture.root);
      const expectedFiles = [...task.fixture.files].sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        issues.push(
          `${task.id} fixture inventory differs: declared ${expectedFiles.join(", ")}, ` +
            `found ${actualFiles.join(", ")}`,
        );
      }
      for (const file of task.fixture.files) {
        await regularFileInside(benchmarkRoot, `${task.fixture.root}/${file}`);
      }
      const checkerPath = await regularFileInside(benchmarkRoot, task.checker.entry);
      const actualDigest = await sha256File(checkerPath);
      if (actualDigest !== task.checker.sha256) {
        issues.push(
          `${task.id} checker digest mismatch: expected ${task.checker.sha256}, got ${actualDigest}`,
        );
      }
    } catch (error) {
      if (error instanceof EvidenceBenchmarkValidationError) {
        issues.push(...error.issues.map((issue) => `${task.id}: ${issue}`));
      } else {
        issues.push(`${task.id}: ${(error as Error).message}`);
      }
    }
  }
  if (issues.length) throw new EvidenceBenchmarkValidationError(issues);
}

export async function materializeEvidenceFixture(
  benchmarkRoot: string,
  task: EvidenceBenchmarkTask,
  workspaceRoot: string,
): Promise<void> {
  const workspaceStats = await lstat(workspaceRoot).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (workspaceStats?.isSymbolicLink() || (workspaceStats && !workspaceStats.isDirectory())) {
    throw new Error("Evidence benchmark workspace must be a regular directory");
  }
  if (!workspaceStats) await mkdir(workspaceRoot, { recursive: true });
  const workspaceReal = await realpath(workspaceRoot);
  const existing = await readdir(workspaceReal);
  if (existing.length > 0) {
    throw new Error("Evidence benchmark workspace must be empty before materialization");
  }
  for (const file of task.fixture.files) {
    const source = await regularFileInside(
      benchmarkRoot,
      `${task.fixture.root}/${file}`,
    );
    const destination = resolve(workspaceReal, file);
    if (!pathIsInside(workspaceReal, destination)) {
      throw new Error(`Fixture destination escaped workspace: ${file}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

export function validateSealedCheckerReport(
  value: unknown,
  expectedTaskId: string,
): SealedCheckerReport {
  const issues: string[] = [];
  const report = objectWithExactKeys(
    value,
    "report",
    ["format", "taskId", "passed", "checks"],
    issues,
  );
  if (!report) throw new EvidenceBenchmarkValidationError(issues);
  if (report.format !== CHECKER_REPORT_FORMAT) {
    issues.push(`report.format must be exactly "${CHECKER_REPORT_FORMAT}"`);
  }
  if (report.taskId !== expectedTaskId) {
    issues.push(`report.taskId must equal ${expectedTaskId}`);
  }
  if (typeof report.passed !== "boolean") issues.push("report.passed must be boolean");
  if (!Array.isArray(report.checks) || report.checks.length < 1) {
    issues.push("report.checks must be a non-empty array");
  } else {
    const ids = new Set<string>();
    report.checks.forEach((candidate, index) => {
      const check = objectWithExactKeys(
        candidate,
        `report.checks[${index}]`,
        ["id", "passed"],
        issues,
      );
      if (!check) return;
      if (typeof check.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(check.id)) {
        issues.push(`report.checks[${index}].id must be a bounded kebab-case identifier`);
      } else if (ids.has(check.id)) {
        issues.push(`report.checks[${index}].id must be unique`);
      } else {
        ids.add(check.id);
      }
      if (typeof check.passed !== "boolean") {
        issues.push(`report.checks[${index}].passed must be boolean`);
      }
    });
    if (
      typeof report.passed === "boolean" &&
      report.passed !== report.checks.every(
        (check) => isRecord(check) && check.passed === true,
      )
    ) {
      issues.push("report.passed must equal the conjunction of all check results");
    }
  }
  if (issues.length) throw new EvidenceBenchmarkValidationError(issues);
  return value as SealedCheckerReport;
}

function appendBounded(buffer: Buffer, chunk: Buffer): Buffer {
  if (buffer.byteLength + chunk.byteLength > MAX_CHECKER_OUTPUT_BYTES) {
    throw new Error(`Sealed checker output exceeded ${MAX_CHECKER_OUTPUT_BYTES} bytes`);
  }
  return Buffer.concat([buffer, chunk]);
}

/**
 * Runs the sealed host checker. Only its typed, non-diagnostic summary is returned;
 * checker source and expected values are never copied into the task workspace.
 */
export async function runSealedChecker(
  benchmarkRoot: string,
  task: EvidenceBenchmarkTask,
  workspaceRoot: string,
): Promise<CheckerExecution> {
  const checkerPath = await regularFileInside(benchmarkRoot, task.checker.entry);
  const actualDigest = await sha256File(checkerPath);
  if (actualDigest !== task.checker.sha256) {
    throw new Error(`Refusing to run ${task.id}: sealed checker digest mismatch`);
  }
  const workspaceReal = await realpath(workspaceRoot);
  const start = Date.now();

  return await new Promise<CheckerExecution>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [checkerPath, "--task", task.id, "--workspace", workspaceReal],
      {
        cwd: benchmarkRoot,
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH ?? "",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          KRATER_BENCHMARK_SEALED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;

    const stop = (): void => {
      if (child.killed) return;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to direct termination.
        }
      }
      child.kill("SIGKILL");
    };
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const timer = setTimeout(() => {
      finishError(new Error(`Sealed checker timed out after ${task.checker.timeoutMs}ms`));
    }, task.checker.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        finishError(error as Error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        finishError(error as Error);
      }
    });
    child.on("error", finishError);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.toString("utf8")) as unknown;
      } catch {
        reject(
          new Error(
            `Sealed checker returned invalid JSON${
              stderr.length ? ` (${stderr.toString("utf8").slice(0, 200)})` : ""
            }`,
          ),
        );
        return;
      }
      try {
        const report = validateSealedCheckerReport(parsed, task.id);
        if ((exitCode === 0) !== report.passed) {
          throw new Error(
            `Sealed checker exit ${exitCode} contradicts passed=${report.passed}`,
          );
        }
        resolvePromise({ report, exitCode, elapsedMs: Date.now() - start });
      } catch (error) {
        reject(error);
      }
    });
  });
}
