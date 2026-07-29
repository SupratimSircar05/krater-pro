import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import type { Readable } from "node:stream";
import {
  assertTrustedGitExecutable,
  resolveTrustedGitExecutable,
  type TrustedGitExecutable,
} from "./trusted-git.js";

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
  /**
   * Host-selected roots from which local projects may be opened. When omitted,
   * the initial project is the only root; callers must expand this explicitly.
   */
  localProjectRoots?: readonly string[];
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

interface BoundDirectory {
  path: string;
  device: bigint;
  inode: bigint;
}

function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() ===
        win32.normalize(right).toLowerCase()
    : left === right;
}

function captureBoundDirectory(
  path: string,
  expectedParent?: BoundDirectory,
): BoundDirectory {
  if (process.platform === "win32") {
    const before = lstatSync(path, { bigint: true });
    const physical = realpathSync(path);
    const after = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (expectedParent &&
        !samePhysicalPath(dirname(physical), expectedParent.path))
    ) {
      throw new Error("A project directory identity could not be verified.");
    }
    return {
      path: physical,
      device: after.dev,
      inode: after.ino,
    };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const lexical = lstatSync(path, { bigint: true });
    const physical = realpathSync(path);
    const afterOpen = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !afterOpen.isDirectory() ||
      !afterPath.isDirectory() ||
      afterPath.isSymbolicLink() ||
      opened.dev !== lexical.dev ||
      opened.ino !== lexical.ino ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino ||
      opened.dev !== afterPath.dev ||
      opened.ino !== afterPath.ino ||
      (expectedParent &&
        !samePhysicalPath(dirname(physical), expectedParent.path))
    ) {
      throw new Error("A project directory identity could not be verified.");
    }
    return {
      path: physical,
      device: opened.dev,
      inode: opened.ino,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertBoundDirectory(identity: BoundDirectory): void {
  let current: BoundDirectory;
  try {
    current = captureBoundDirectory(identity.path);
  } catch (error) {
    throw new Error(
      "The launch workspace or its internal project directory changed; restart Krater before creating projects.",
      { cause: error },
    );
  }
  if (
    !samePhysicalPath(current.path, identity.path) ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw new Error(
      "The launch workspace or its internal project directory changed; restart Krater before creating projects.",
    );
  }
}

function createDirectoryIfMissing(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

function ensureBoundChildDirectory(
  parent: BoundDirectory,
  name: string,
): BoundDirectory {
  assertBoundDirectory(parent);
  const path = join(parent.path, name);
  createDirectoryIfMissing(path);
  const child = captureBoundDirectory(path, parent);
  assertBoundDirectory(parent);
  return child;
}

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

type CanonicalPathSemantics = Pick<
  typeof posix,
  | "basename"
  | "isAbsolute"
  | "normalize"
  | "parse"
  | "relative"
  | "resolve"
  | "sep"
>;

export function canonicalAbsolutePath(
  input: string,
  paths: CanonicalPathSemantics = process.platform === "win32" ? win32 : posix,
): string {
  if (
    !input ||
    input.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new Error(
      "A local project path must be a non-empty path without control characters.",
    );
  }
  if (!paths.isAbsolute(input)) {
    throw new Error("A local project path must be absolute.");
  }
  const windows = paths.sep === "\\";
  let normalizedPath = paths.normalize(input);
  if (!windows && process.platform === "darwin") {
    for (const alias of ["/var", "/tmp", "/etc"] as const) {
      if (
        normalizedPath === alias ||
        normalizedPath.startsWith(`${alias}/`)
      ) {
        normalizedPath = `/private${normalizedPath}`;
        break;
      }
    }
  }
  const parsedRoot = paths.parse(normalizedPath).root;
  const sanitizePiece = (piece: string, label: string): string => {
    const safePiece = windows ? win32.basename(piece) : posix.basename(piece);
    const windowsDeviceName = safePiece.split(".", 1)[0]?.toUpperCase() ?? "";
    if (
      !safePiece ||
      safePiece === "." ||
      safePiece === ".." ||
      safePiece !== piece ||
      (windows &&
        (/[<>:"/\\|?*\u0000-\u001f]/.test(safePiece) ||
          /[ .]$/.test(safePiece) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(
            windowsDeviceName,
          )))
    ) {
      throw new Error(`A local project path contains an unsafe ${label}.`);
    }
    return safePiece;
  };

  let trustedRoot: string;
  if (windows) {
    const extendedUncPrefix = "\\\\?\\UNC\\";
    if (
      normalizedPath
        .slice(0, extendedUncPrefix.length)
        .toUpperCase() === extendedUncPrefix
    ) {
      const rootParts = input
        .replace(/\//g, "\\")
        .slice(extendedUncPrefix.length)
        .split("\\");
      const server = sanitizePiece(rootParts[0] ?? "", "UNC server");
      const share = sanitizePiece(rootParts[1] ?? "", "UNC share");
      if (
        rootParts
          .slice(2)
          .some((segment) => segment === "." || segment === "..")
      ) {
        throw new Error(
          "A local project path cannot traverse an extended UNC share.",
        );
      }
      trustedRoot = `\\\\${server}\\${share}\\`;
      normalizedPath = paths.resolve(
        trustedRoot,
        rootParts.slice(2).join("\\"),
      );
    } else {
      const extendedDrive = /^\\\\\?\\([A-Za-z]):\\$/.exec(parsedRoot);
      const drive = /^([A-Za-z]):\\$/.exec(parsedRoot);
      const unc = /^\\\\([^\\]+)\\([^\\]+)\\$/.exec(parsedRoot);
      const volume =
        /^\\\\\?\\(Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\})\\$/.exec(
          parsedRoot,
        );
      if (extendedDrive || drive) {
        const driveLetter = (
          extendedDrive?.[1] ??
          drive?.[1] ??
          ""
        ).toUpperCase();
        if (!"ABCDEFGHIJKLMNOPQRSTUVWXYZ".includes(driveLetter)) {
          throw new Error("A local project path has an unsafe drive root.");
        }
        trustedRoot = `${driveLetter}:\\`;
        if (extendedDrive) {
          normalizedPath = paths.normalize(normalizedPath.slice(4));
        }
      } else if (volume) {
        const volumeName = sanitizePiece(
          volume[1] ?? "",
          "extended volume root",
        );
        trustedRoot = `\\\\?\\${volumeName}\\`;
      } else if (unc) {
        const server = sanitizePiece(unc[1] ?? "", "UNC server");
        const share = sanitizePiece(unc[2] ?? "", "UNC share");
        trustedRoot = `\\\\${server}\\${share}\\`;
      } else {
        throw new Error("A local project path has an unsupported Windows root.");
      }
    }
  } else {
    if (parsedRoot !== paths.sep) {
      throw new Error("A local project path must be absolute.");
    }
    trustedRoot = paths.sep;
  }

  const relativePath = paths.relative(trustedRoot, normalizedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relativePath)
  ) {
    throw new Error("A local project path cannot traverse its filesystem root.");
  }
  let reconstructed = trustedRoot;
  for (const segment of relativePath.split(paths.sep).filter(Boolean)) {
    const safeSegment = sanitizePiece(segment, "segment");
    reconstructed = paths.resolve(reconstructed, safeSegment);
  }
  return reconstructed;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
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
  readonly #gitExecutable?: TrustedGitExecutable;
  readonly #initialRoot: BoundDirectory;
  readonly #localProjectRoots: string[];
  readonly #records = new Map<string, ProjectRecord>();
  readonly #pathIndex = new Map<string, string>();
  #kraterRoot?: BoundDirectory;
  #projectsRoot?: BoundDirectory;
  #gitHomeRoot?: BoundDirectory;
  #scratchRoot?: BoundDirectory;
  #selectedId: string;

  constructor(initialCwd: string, options: ProjectRegistryOptions = {}) {
    this.initialCwd = ensureInitialDirectory(initialCwd);
    this.#initialRoot = captureBoundDirectory(this.initialCwd);
    this.#localProjectRoots = [
      ...new Set(
        (options.localProjectRoots ?? [initialCwd]).flatMap((root) => [
          canonicalAbsolutePath(resolve(root)),
          ensureInitialDirectory(root),
        ]),
      ),
    ];
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
    this.#gitExecutable = resolveTrustedGitExecutable(options.gitExecutable, [
      this.initialCwd,
    ]);

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

  #boundKraterRoot(): BoundDirectory {
    assertBoundDirectory(this.#initialRoot);
    if (!this.#kraterRoot) {
      this.#kraterRoot = ensureBoundChildDirectory(
        this.#initialRoot,
        ".krater",
      );
    } else {
      assertBoundDirectory(this.#kraterRoot);
    }
    assertBoundDirectory(this.#initialRoot);
    return this.#kraterRoot;
  }

  #boundScratchRoot(): BoundDirectory {
    const kraterRoot = this.#boundKraterRoot();
    if (!this.#scratchRoot) {
      this.#scratchRoot = ensureBoundChildDirectory(kraterRoot, "scratch");
    } else {
      assertBoundDirectory(this.#scratchRoot);
    }
    assertBoundDirectory(kraterRoot);
    return this.#scratchRoot;
  }

  #boundCloneRoots(): {
    kraterRoot: BoundDirectory;
    projectsRoot: BoundDirectory;
    gitHomeRoot: BoundDirectory;
  } {
    const kraterRoot = this.#boundKraterRoot();
    if (!this.#projectsRoot) {
      this.#projectsRoot = ensureBoundChildDirectory(
        kraterRoot,
        "projects",
      );
    } else {
      assertBoundDirectory(this.#projectsRoot);
    }
    if (!this.#gitHomeRoot) {
      this.#gitHomeRoot = ensureBoundChildDirectory(
        kraterRoot,
        "git-home",
      );
    } else {
      assertBoundDirectory(this.#gitHomeRoot);
    }
    this.#assertCloneRootsBound();
    return {
      kraterRoot,
      projectsRoot: this.#projectsRoot,
      gitHomeRoot: this.#gitHomeRoot,
    };
  }

  #assertScratchRootsBound(): void {
    assertBoundDirectory(this.#initialRoot);
    if (!this.#kraterRoot || !this.#scratchRoot) {
      throw new Error("Scratch project directories were not bound.");
    }
    assertBoundDirectory(this.#kraterRoot);
    assertBoundDirectory(this.#scratchRoot);
  }

  #assertCloneRootsBound(): void {
    assertBoundDirectory(this.#initialRoot);
    if (!this.#kraterRoot || !this.#projectsRoot || !this.#gitHomeRoot) {
      throw new Error("GitHub clone directories were not bound.");
    }
    assertBoundDirectory(this.#kraterRoot);
    assertBoundDirectory(this.#projectsRoot);
    assertBoundDirectory(this.#gitHomeRoot);
  }

  #cloneCleanupIsSafe(destination: BoundDirectory): boolean {
    try {
      this.#assertCloneRootsBound();
      assertBoundDirectory(destination);
      return true;
    } catch {
      return false;
    }
  }

  #scratchCleanupIsSafe(destination: BoundDirectory): boolean {
    try {
      this.#assertScratchRootsBound();
      assertBoundDirectory(destination);
      return true;
    } catch {
      return false;
    }
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
    if (
      !path ||
      path.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(path)
    ) {
      throw new Error(
        "A local project path must be a non-empty path without control characters.",
      );
    }
    if (!isAbsolute(path)) {
      throw new Error("A local project path must be absolute.");
    }

    const normalizedPath = canonicalAbsolutePath(path);
    let physicalPath: string | undefined;
    for (const root of this.#localProjectRoots) {
      let fromRoot = relative(root, normalizedPath);
      if (
        process.platform === "darwin" &&
        (fromRoot === ".." ||
          fromRoot.startsWith(`..${sep}`) ||
          isAbsolute(fromRoot))
      ) {
        fromRoot = relative(
          root.toLocaleLowerCase("en-US"),
          normalizedPath.toLocaleLowerCase("en-US"),
        );
      }
      if (
        fromRoot === ".." ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
      ) {
        continue;
      }
      const guardedPath = resolve(root, fromRoot);
      try {
        const candidate = await realpath(guardedPath);
        if (
          !this.#localProjectRoots.some((authorizedRoot) =>
            isWithinRoot(authorizedRoot, candidate),
          )
        ) {
          continue;
        }
        const details = await stat(candidate);
        if (!details.isDirectory()) continue;
        physicalPath = candidate;
        break;
      } catch {
        // Try another host-authorized root before returning one safe error.
      }
    }
    if (!physicalPath) {
      throw new Error(
        "The local project path must be an existing directory within an authorized local project root.",
      );
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
    const scratchRoot = this.#boundScratchRoot();
    const prefix = `${safeName(name, "scratch")}-`;
    const path = await mkdtemp(join(scratchRoot.path, prefix));
    const created = captureBoundDirectory(path, scratchRoot);
    try {
      this.#assertScratchRootsBound();
      return this.#register({
        id: `scratch-${basename(created.path)}`,
        name: basename(created.path),
        kind: "scratch",
        path: created.path,
      });
    } catch (error) {
      if (this.#scratchCleanupIsSafe(created)) {
        await rm(created.path, { recursive: true, force: true }).catch(
          () => {},
        );
      }
      throw error;
    }
  }

  async cloneGitHub(
    source: string,
    signal?: AbortSignal,
  ): Promise<ProjectRecord> {
    const repository = parseGitHubRepositoryUrl(source);
    if (signal?.aborted) {
      throw abortError();
    }
    this.#validatedGitExecutable();

    const { projectsRoot, gitHomeRoot } = this.#boundCloneRoots();

    if (signal?.aborted) {
      throw abortError();
    }

    const prefix = `${safeName(repository.repository, "project")}-`;
    const destinationPath = await mkdtemp(join(projectsRoot.path, prefix));
    const destination = captureBoundDirectory(
      destinationPath,
      projectsRoot,
    );
    this.#assertCloneRootsBound();

    try {
      await this.#runGitClone(
        repository.source,
        destination.path,
        projectsRoot.path,
        gitHomeRoot.path,
        signal,
      );
      this.#assertCloneRootsBound();
      assertBoundDirectory(destination);
      return this.#register({
        id: `github-${basename(destination.path)}`,
        name: basename(destination.path),
        kind: "github",
        path: destination.path,
        source: repository.source,
      });
    } catch (error) {
      // This path was created by this invocation and was never registered.
      if (this.#cloneCleanupIsSafe(destination)) {
        await rm(destination.path, { recursive: true, force: true }).catch(
          () => {},
        );
      }
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
    this.#assertCloneRootsBound();
    const gitExecutable = this.#validatedGitExecutable();
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
        this.#assertCloneRootsBound();
        child = spawn(gitExecutable, args, {
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

  #validatedGitExecutable(): string {
    const executable = this.#gitExecutable;
    if (!executable) {
      throw new Error(
        "Git is unavailable from Krater Pro's fixed system paths. Configure a trusted absolute Git executable.",
      );
    }
    return assertTrustedGitExecutable(executable);
  }
}
