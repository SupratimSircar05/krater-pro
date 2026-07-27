import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";

export type ProjectKind = "local" | "github" | "scratch";

export interface ProjectRecord {
  id: string;
  name: string;
  kind: ProjectKind;
  path: string;
  source?: string;
}

export interface ProjectRegistryOptions {
  cloneTimeoutMs?: number;
  maxCloneOutputBytes?: number;
  gitExecutable?: string;
}

interface GitHubRepository {
  owner: string;
  repository: string;
  source: string;
}

type CloneProcess = ChildProcessByStdio<null, Readable, Readable>;

const DEFAULT_CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CLONE_OUTPUT_BYTES = 64 * 1024;
const MIN_CLONE_TIMEOUT_MS = 10;
const MAX_CLONE_TIMEOUT_MS = 10 * 60_000;
const MIN_CLONE_OUTPUT_BYTES = 128;
const MAX_CLONE_OUTPUT_BYTES = 1024 * 1024;

function copyRecord(record: ProjectRecord): ProjectRecord {
  return { ...record };
}

function safeName(value: string, fallback: string): string {
  const normalized = value
    .slice(0, 512)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return normalized || fallback;
}

function stableLocalId(path: string): string {
  const name = safeName(basename(path), "local");
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
  return `local-${name}-${digest}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return resolved;
}

function ensureInitialDirectory(initialCwd: string): string {
  const physicalPath = realpathSync(initialCwd);
  if (!statSync(physicalPath).isDirectory()) {
    throw new Error("The initial project path must be an existing directory.");
  }
  return physicalPath;
}

function parseGitHubRepositoryUrl(value: string): GitHubRepository {
  if (
    value !== value.trim() ||
    !value.startsWith("https://github.com/") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "Only public https://github.com/<owner>/<repo>[.git] URLs are supported.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "Only public https://github.com/<owner>/<repo>[.git] URLs are supported.",
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Only public https://github.com/<owner>/<repo>[.git] URLs are supported.",
    );
  }

  const parts = parsed.pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "") {
    throw new Error(
      "Only public https://github.com/<owner>/<repo>[.git] URLs are supported.",
    );
  }

  const owner = parts[1] ?? "";
  let repository = parts[2] ?? "";
  if (repository.endsWith(".git")) {
    repository = repository.slice(0, -4);
  }

  const validOwner =
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
  const validRepository =
    repository.length <= 100 &&
    repository !== "." &&
    repository !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(repository);

  if (!validOwner || !validRepository) {
    throw new Error(
      "Only public https://github.com/<owner>/<repo>[.git] URLs are supported.",
    );
  }

  return {
    owner,
    repository,
    source: `https://github.com/${owner}/${repository}.git`,
  };
}

interface CapturedOutput {
  chunks: Buffer[];
  capturedBytes: number;
  truncated: boolean;
}

function captureOutput(
  output: CapturedOutput,
  chunk: Buffer | string,
  limit: number,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - output.capturedBytes);
  if (remaining > 0) {
    const accepted = buffer.subarray(0, remaining);
    output.chunks.push(accepted);
    output.capturedBytes += accepted.length;
  }
  if (buffer.length > remaining) {
    output.truncated = true;
  }
}

function safeDiagnostic(output: CapturedOutput): string {
  const text = Buffer.concat(output.chunks)
    .toString("utf8")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      "?",
    )
    .trim();
  if (!text) {
    return output.truncated ? "[output truncated]" : "";
  }
  return output.truncated ? `${text}\n[output truncated]` : text;
}

function abortError(): Error {
  const error = new Error("GitHub clone was cancelled.");
  error.name = "AbortError";
  return error;
}

function stopProcess(child: CloneProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  child.kill("SIGTERM");
}

function forceStopProcess(child: CloneProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  child.kill("SIGKILL");
}

export class ProjectRegistry {
  readonly initialCwd: string;

  readonly #cloneTimeoutMs: number;
  readonly #maxCloneOutputBytes: number;
  readonly #gitExecutable: string;
  readonly #records = new Map<string, ProjectRecord>();
  readonly #pathIndex = new Map<string, string>();
  #selectedId: string;

  constructor(initialCwd: string, options: ProjectRegistryOptions = {}) {
    this.initialCwd = ensureInitialDirectory(initialCwd);
    this.#cloneTimeoutMs = boundedInteger(
      options.cloneTimeoutMs,
      DEFAULT_CLONE_TIMEOUT_MS,
      MIN_CLONE_TIMEOUT_MS,
      MAX_CLONE_TIMEOUT_MS,
      "cloneTimeoutMs",
    );
    this.#maxCloneOutputBytes = boundedInteger(
      options.maxCloneOutputBytes,
      DEFAULT_MAX_CLONE_OUTPUT_BYTES,
      MIN_CLONE_OUTPUT_BYTES,
      MAX_CLONE_OUTPUT_BYTES,
      "maxCloneOutputBytes",
    );
    this.#gitExecutable = options.gitExecutable ?? "git";
    if (!this.#gitExecutable || this.#gitExecutable.includes("\0")) {
      throw new Error("gitExecutable must be a non-empty executable name.");
    }

    const initial: ProjectRecord = {
      id: stableLocalId(this.initialCwd),
      name: safeName(basename(this.initialCwd), "local"),
      kind: "local",
      path: this.initialCwd,
    };
    this.#records.set(initial.id, initial);
    this.#pathIndex.set(initial.path, initial.id);
    this.#selectedId = initial.id;
  }

  list(): ProjectRecord[] {
    return [...this.#records.values()].map(copyRecord);
  }

  current(): ProjectRecord {
    const record = this.#records.get(this.#selectedId);
    if (!record) {
      throw new Error("No project is currently selected.");
    }
    return copyRecord(record);
  }

  select(id: string): ProjectRecord {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error("That project is not registered.");
    }
    this.#selectedId = record.id;
    return copyRecord(record);
  }

  async addLocal(path: string): Promise<ProjectRecord> {
    if (!isAbsolute(path)) {
      throw new Error("A local project path must be absolute.");
    }

    let physicalPath: string;
    try {
      physicalPath = await realpath(path);
      const details = await stat(physicalPath);
      if (!details.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error("The local project path must be an existing directory.");
    }

    const existingId = this.#pathIndex.get(physicalPath);
    if (existingId) {
      return this.select(existingId);
    }

    return this.#register({
      id: stableLocalId(physicalPath),
      name: safeName(basename(physicalPath), "local"),
      kind: "local",
      path: physicalPath,
    });
  }

  async createScratch(name = "scratch"): Promise<ProjectRecord> {
    const scratchRoot = join(this.initialCwd, ".krater", "scratch");
    await mkdir(scratchRoot, { recursive: true });

    const prefix = `${safeName(name, "scratch")}-`;
    const path = await mkdtemp(join(scratchRoot, prefix));
    const physicalPath = await realpath(path);

    return this.#register({
      id: `scratch-${basename(physicalPath)}`,
      name: basename(physicalPath),
      kind: "scratch",
      path: physicalPath,
    });
  }

  async cloneGitHub(
    source: string,
    signal?: AbortSignal,
  ): Promise<ProjectRecord> {
    const repository = parseGitHubRepositoryUrl(source);
    if (signal?.aborted) {
      throw abortError();
    }

    const kraterRoot = join(this.initialCwd, ".krater");
    const projectsRoot = join(kraterRoot, "projects");
    const isolatedGitHome = join(kraterRoot, "git-home");
    await Promise.all([
      mkdir(projectsRoot, { recursive: true }),
      mkdir(isolatedGitHome, { recursive: true }),
    ]);

    if (signal?.aborted) {
      throw abortError();
    }

    const prefix = `${safeName(repository.repository, "project")}-`;
    const destination = await mkdtemp(join(projectsRoot, prefix));

    try {
      await this.#runGitClone(
        repository.source,
        destination,
        projectsRoot,
        isolatedGitHome,
        signal,
      );
      const physicalPath = await realpath(destination);
      return this.#register({
        id: `github-${basename(physicalPath)}`,
        name: basename(physicalPath),
        kind: "github",
        path: physicalPath,
        source: repository.source,
      });
    } catch (error) {
      // This path was created by this invocation and was never registered.
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  #register(record: ProjectRecord): ProjectRecord {
    const existingId = this.#pathIndex.get(record.path);
    if (existingId) {
      return this.select(existingId);
    }
    if (this.#records.has(record.id)) {
      throw new Error("A project with this identifier is already registered.");
    }

    const stored = { ...record };
    this.#records.set(stored.id, stored);
    this.#pathIndex.set(stored.path, stored.id);
    this.#selectedId = stored.id;
    return copyRecord(stored);
  }

  #runGitClone(
    source: string,
    destination: string,
    projectsRoot: string,
    isolatedGitHome: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const args = [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "http.followRedirects=initial",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--",
      source,
      destination,
    ];

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      HOME: isolatedGitHome,
      USERPROFILE: isolatedGitHome,
      XDG_CONFIG_HOME: isolatedGitHome,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CEILING_DIRECTORIES: projectsRoot,
      GCM_INTERACTIVE: "Never",
    };

    return new Promise((resolve, reject) => {
      let child: CloneProcess;
      try {
        child = spawn(this.#gitExecutable, args, {
          cwd: projectsRoot,
          detached: process.platform !== "win32",
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new Error("Unable to start Git for the GitHub clone.", {
            cause: error,
          }),
        );
        return;
      }

      const output: CapturedOutput = {
        chunks: [],
        capturedBytes: 0,
        truncated: false,
      };
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let forceStopTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (forceStopTimer) {
          clearTimeout(forceStopTimer);
        }
        abortSignal?.removeEventListener("abort", onAbort);
      };

      const requestStop = (): void => {
        stopProcess(child);
        forceStopTimer = setTimeout(() => forceStopProcess(child), 2_000);
        forceStopTimer.unref();
      };

      const onAbort = (): void => {
        aborted = true;
        requestStop();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        captureOutput(output, chunk, this.#maxCloneOutputBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        captureOutput(output, chunk, this.#maxCloneOutputBytes);
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        requestStop();
      }, this.#cloneTimeoutMs);
      timeout.unref();

      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
      }

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error("Unable to start Git for the GitHub clone.", {
            cause: error,
          }),
        );
      });

      child.once("close", (code, terminationSignal) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (aborted) {
          reject(abortError());
          return;
        }
        if (timedOut) {
          reject(
            new Error(
              `GitHub clone timed out after ${this.#cloneTimeoutMs} ms.`,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }

        const diagnostic = safeDiagnostic(output);
        const status =
          code === null
            ? `signal ${terminationSignal ?? "unknown"}`
            : `exit ${code}`;
        reject(
          new Error(
            `GitHub clone failed (${status})${
              diagnostic ? `: ${diagnostic}` : "."
            }`,
          ),
        );
      });
    });
  }
}
