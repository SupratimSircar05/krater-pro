import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import {
  constants,
  existsSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  MacOsSandboxAdapter,
  SandboxSupervisor,
  createHostNativeSandboxAdapter,
  type NativeSandboxAdapter,
  type ResourceCapabilityRequest,
} from "./sandbox/index.js";

const DEFAULT_IGNORES = new Set([
  ".git",
  ".krater",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const MAX_READ_BYTES = 250_000;
const MAX_EDIT_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_OUTPUT_CHARS = 120_000;
const MAX_SEARCH_MATCH_LINE_CHARS = 4_000;
const MAX_COMMAND_OUTPUT = 120_000;
const MAX_LIST_OUTPUT_CHARS = 120_000;
const MAX_IDE_FILE_BYTES = 1_000_000;
const MAX_IDE_TREE_ENTRIES = 2_000;
const MAX_IDE_TREE_OUTPUT_CHARS = 400_000;
const MAX_WORKSPACE_WALK_ENTRIES = 20_000;

export interface WorkspaceTreeEntry {
  path: string;
  name: string;
  type: "directory" | "file";
  depth: number;
  size?: number;
  modifiedAt: string;
  ignored?: boolean;
}

export interface WorkspaceTree {
  path: string;
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
}

export interface WorkspaceOptions {
  /**
   * Host-selected dependency/toolchain roots that sandboxed commands may read
   * but never mutate. These paths are not exposed through file tools.
   */
  readOnlyDependencyRoots?: readonly string[];
  /**
   * Native adapter used only for unattended model commands. `undefined`
   * selects the verified host adapter; `null` forces fail-closed unavailability
   * for deterministic tests and hosts that disable unattended execution.
   */
  nativeSandboxAdapter?: NativeSandboxAdapter | null;
}

export interface WorkspaceDocument {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  revision: string;
}

export interface GitStatusEntry {
  index: string;
  workingTree: string;
  path: string;
  originalPath?: string;
}

export interface GitStatusSnapshot {
  branch: string;
  clean: boolean;
  entries: GitStatusEntry[];
  status: string;
}

export class WorkspaceRevisionConflictError extends Error {
  readonly code = "WORKSPACE_REVISION_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRevisionConflictError";
  }
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated?: boolean;
  execution: {
    authorization:
      | "host_direct"
      | "approved_attended"
      | "verified_unattended";
    containment:
      | "verified_native"
      | "macos_seatbelt_best_effort"
      | "approved_uncontained"
      | "host_process";
    adapterId?: string;
    effectiveProcessLimit?: number;
    summary: string;
  };
}

export interface CommandExecutionOptions {
  authorization?:
    | "host_direct"
    | "approved_attended"
    | "verified_unattended";
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function displayPath(root: string, absolute: string): string {
  const value = relative(root, absolute);
  return value || ".";
}

function portableDisplayPath(root: string, absolute: string): string {
  return displayPath(root, absolute).split(sep).join("/");
}

function documentRevision(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function truncate(value: string, max = MAX_COMMAND_OUTPUT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… output truncated (${value.length - max} characters omitted)`;
}

function redactGitRemoteCredentials(value: string): string {
  return value.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`\u0000-\u001f]+/gi,
    (url) =>
      url
        .replace(
          /^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i,
          "$1[REDACTED]@",
        )
        .replace(
          /([?&#;](?:token|access_?token|auth_?token|oauth_?token|private_?token|api_?key|password|passwd|credential|secret|client_?secret)=)[^&#;\s<>"'`]+/gi,
          "$1[REDACTED]",
        ),
  );
}

function isProtectedPath(root: string, absolute: string): boolean {
  const shown = relative(root, absolute);
  const parts = shown.split(sep).map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  if (parts.includes(".git") || parts.includes(".krater")) return true;
  if (
    name === ".env" ||
    (name.startsWith(".env.") &&
      ![".env.example", ".env.sample", ".env.template"].includes(name))
  ) {
    return true;
  }
  if (
    [".npmrc", ".pypirc", ".netrc", "credentials", "id_rsa", "id_ed25519"].includes(
      name,
    )
  ) {
    return true;
  }
  return /\.(?:pem|p12|pfx|key)$/i.test(name);
}

function isSafeGitPath(root: string, path: string): boolean {
  if (!path || path.includes("\0")) return false;
  const absolute = resolve(root, path);
  return within(root, absolute) && !isProtectedPath(root, absolute);
}

async function isSafeGitStatusPath(root: string, path: string): Promise<boolean> {
  if (!isSafeGitPath(root, path)) return false;
  try {
    const details = await lstat(resolve(root, path));
    return (
      !details.isSymbolicLink() &&
      !(details.isFile() && details.nlink > 1)
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function rejectHardLinkedFile(
  details: { isFile(): boolean; nlink: number },
  input: string,
): void {
  if (details.isFile() && details.nlink > 1) {
    throw new Error(
      `Hard-linked files are not supported because their content identity cannot be confined safely: ${input}`,
    );
  }
}

const documentLocks = new Map<string, Promise<void>>();

async function withDocumentLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = documentLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.then(() => gate);
  documentLocks.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (documentLocks.get(path) === queued) documentLocks.delete(path);
  }
}

function formatGitPath(path: string): string {
  return /[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path;
}

function containsDestructiveCommand(command: string): boolean {
  const segments = command.split(/[;&|]/).map((segment) => segment.trim());
  for (const segment of segments) {
    const rmCommands = segment.matchAll(
      /(?:^|[\s'"`])(?:\/(?:usr\/)?bin\/)?rm\b([^;&|]*)/gi,
    );
    for (const match of rmCommands) {
      const args = match[1];
      if (
        (/(?:^|\s)--recursive(?:\s|$)/i.test(args) ||
          /(?:^|\s)-[a-z]*r[a-z]*(?:\s|$)/i.test(args)) &&
        (/(?:^|\s)--force(?:\s|$)/i.test(args) ||
          /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(args))
      ) {
        return true;
      }
    }
    if (
      /\bgit\b.*\breset\b.*(?:^|\s)--hard(?:\s|$)/i.test(segment) ||
      (/\bgit\b.*\bclean\b/i.test(segment) &&
        (/(?:^|\s)--force(?:\s|$)/i.test(segment) ||
          /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(segment)))
    ) {
      return true;
    }
    if (
      /(?:^|[\s/])mkfs(?:\.[a-z0-9]+)?(?:\s|$)/i.test(segment) ||
      /(?:^|[\s/])diskutil\s+erase/i.test(segment) ||
      /\b(?:shutdown|reboot)\b/i.test(segment)
    ) {
      return true;
    }
  }
  return false;
}

function containsSecretReadCommand(command: string): boolean {
  const gitMetadata =
    String.raw`(?:(?<![\w.-])\.git(?=[\\/]|(?![\w.-]))|\.gitconfig|\.git-credentials)(?![\w.-])`;
  if (new RegExp(gitMetadata, "i").test(command)) return true;
  const secretName =
    String.raw`(?:\.env(?:\.(?!(?:example|sample|template)(?![\w.-]))[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials|[\w.-]+\.(?:pem|p12|pfx|key))(?![\w.-])`;
  const readers =
    String.raw`(?:cat|tac|sed|awk|grep|rg|head|tail|less|more|strings|xxd|od|hexdump|base64|jq|yq|dd|cp)`;
  return new RegExp(String.raw`\b${readers}\b[^\n;&|]*${secretName}`, "i").test(
    command,
  );
}

function safeCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const exact = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "CI",
    "NODE_ENV",
    "JAVA_HOME",
    "GOPATH",
    "GOROOT",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PYENV_ROOT",
    "VIRTUAL_ENV",
    "SDKROOT",
    "DEVELOPER_DIR",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
  ]);
  const safe: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(name) || name.startsWith("LC_"))) {
      safe[name] = value;
    }
  }
  return safe;
}

function sandboxLiteral(value: string): string {
  return JSON.stringify(value);
}

function sandboxRegex(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Sandbox regular expressions cannot contain control lines.");
  }
  // Seatbelt's regex literals preserve regex backslashes. JSON
  // encoding would double them and turn `\.` into a literal backslash match.
  return `#"${value.replace(/"/g, '\\"')}"`;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function caseInsensitiveRegularExpressionLiteral(value: string): string {
  return escapeRegularExpression(value).replace(
    /[a-z]/gi,
    (character) => `[${character.toLowerCase()}${character.toUpperCase()}]`,
  );
}

export class Workspace {
  readonly root: string;
  private readonly readOnlyDependencyRoots: string[];
  private readonly nativeSandboxAdapter?: NativeSandboxAdapter;

  constructor(root: string, options: WorkspaceOptions = {}) {
    this.root = realpathSync(resolve(root));
    this.readOnlyDependencyRoots = [
      ...new Set(
        (options.readOnlyDependencyRoots ?? []).map((path) =>
          realpathSync(resolve(path)),
        ),
      ),
    ].filter((path) => path !== this.root && !within(this.root, path));
    this.nativeSandboxAdapter =
      options.nativeSandboxAdapter === undefined
        ? createHostNativeSandboxAdapter()
        : options.nativeSandboxAdapter ?? undefined;
  }

  private lexicalPath(input = "."): string {
    if (input.includes("\0")) throw new Error("Path contains a null byte.");
    const candidate = resolve(this.root, input);
    if (!within(this.root, candidate)) {
      throw new Error(`Path is outside the workspace: ${input}`);
    }
    return candidate;
  }

  private async safePath(input = "."): Promise<string> {
    const candidate = this.lexicalPath(input);
    let ancestor = candidate;

    while (true) {
      try {
        const physical = await realpath(ancestor);
        if (!within(this.root, physical)) {
          throw new Error(`Path resolves outside the workspace: ${input}`);
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }

    let current = this.root;
    for (const part of relative(this.root, candidate).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Symbolic-link paths are not supported: ${input}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }

    return candidate;
  }

  private protect(path: string, input: string): void {
    if (isProtectedPath(this.root, path)) {
      throw new Error(`Access to secret or internal file is blocked: ${input}`);
    }
  }

  private async readVerifiedFile(
    path: string,
    input: string,
    maximumBytes: number,
  ): Promise<{ buffer: Buffer; details: Awaited<ReturnType<typeof lstat>> }> {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Error(`Not a file: ${input}`);
      rejectHardLinkedFile(details, input);
      if (details.size > maximumBytes) {
        throw new Error(
          `File is too large (${details.size} bytes). Maximum is ${maximumBytes}.`,
        );
      }
      const physical = await realpath(path);
      if (!within(this.root, physical) || isProtectedPath(this.root, physical)) {
        throw new Error(`Path resolves outside the safe workspace: ${input}`);
      }
      const current = await lstat(path);
      if (
        current.isSymbolicLink() ||
        current.dev !== details.dev ||
        current.ino !== details.ino
      ) {
        throw new Error(`File changed while it was being opened: ${input}`);
      }
      const buffer = await handle.readFile();
      if (buffer.byteLength > maximumBytes) {
        throw new Error(
          `File is too large (${buffer.byteLength} bytes). Maximum is ${maximumBytes}.`,
        );
      }
      return { buffer, details };
    } finally {
      await handle.close();
    }
  }

  private async readDirectoryEntries(
    directory: string,
    limit: number,
  ): Promise<{ entries: Dirent[]; truncated: boolean }> {
    const before = await this.verifiedDirectoryIdentity(directory);

    const handle = await opendir(directory);
    try {
      const current = await this.verifiedDirectoryIdentity(directory);
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.physical !== before.physical
      ) {
        throw new Error(
          `Directory changed while it was being opened: ${displayPath(this.root, directory)}`,
        );
      }

      const entries: Dirent[] = [];
      while (entries.length < Math.max(0, limit)) {
        const entry = await handle.read();
        if (!entry) return { entries, truncated: false };
        entries.push(entry);
      }
      return {
        entries,
        truncated: Boolean(await handle.read()),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async verifiedDirectoryIdentity(
    directory: string,
  ): Promise<{ dev: number; ino: number; physical: string }> {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(
        `Directory changed while it was being opened: ${displayPath(this.root, directory)}`,
      );
    }
    const physical = await realpath(directory);
    if (
      !within(this.root, physical) ||
      (directory !== this.root && isProtectedPath(this.root, physical))
    ) {
      throw new Error(
        `Directory resolves outside the safe workspace: ${displayPath(this.root, directory)}`,
      );
    }
    return { dev: details.dev, ino: details.ino, physical };
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    await this.safePath(parent);
    const parentBefore = await this.verifiedDirectoryIdentity(parent);
    const temporary = resolve(
      parent,
      `.${basename(path)}.krater-${randomUUID()}.tmp`,
    );
    let mode: number | undefined;
    let targetBefore:
      | { exists: false }
      | { exists: true; dev: number; ino: number };
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`File changed while it was being saved: ${displayPath(this.root, path)}`);
      }
      rejectHardLinkedFile(existing, displayPath(this.root, path));
      const physical = await realpath(path);
      if (!within(this.root, physical) || isProtectedPath(this.root, physical)) {
        throw new Error(`Path resolves outside the safe workspace: ${displayPath(this.root, path)}`);
      }
      mode = existing.mode & 0o777;
      targetBefore = { exists: true, dev: existing.dev, ino: existing.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targetBefore = { exists: false };
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdIdentity: { dev: number; ino: number } | undefined;
    const removeCreatedTemporary = async (): Promise<void> => {
      if (!createdIdentity) return;
      try {
        const details = await lstat(temporary);
        const physical = await realpath(temporary);
        if (
          details.dev === createdIdentity.dev &&
          details.ino === createdIdentity.ino &&
          within(this.root, physical)
        ) {
          await unlink(temporary);
        }
      } catch {
        // The temp file may already have been renamed or removed.
      }
    };

    try {
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        mode ?? 0o666,
      );
      const created = await handle.stat();
      createdIdentity = { dev: created.dev, ino: created.ino };
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();

      const parentCurrent = await this.verifiedDirectoryIdentity(parent);
      if (
        parentCurrent.dev !== parentBefore.dev ||
        parentCurrent.ino !== parentBefore.ino ||
        parentCurrent.physical !== parentBefore.physical
      ) {
        throw new Error(
          `Parent directory changed while saving ${displayPath(this.root, path)}.`,
        );
      }

      const temporaryCurrent = await lstat(temporary);
      const temporaryPhysical = await realpath(temporary);
      if (
        temporaryCurrent.isSymbolicLink() ||
        temporaryCurrent.dev !== created.dev ||
        temporaryCurrent.ino !== created.ino ||
        !within(this.root, temporaryPhysical)
      ) {
        throw new Error(
          `Temporary file changed while saving ${displayPath(this.root, path)}.`,
        );
      }

      try {
        const targetCurrent = await lstat(path);
        if (
          !targetBefore.exists ||
          targetCurrent.isSymbolicLink() ||
          targetCurrent.dev !== targetBefore.dev ||
          targetCurrent.ino !== targetBefore.ino
        ) {
          throw new Error(
            `File changed while it was being saved: ${displayPath(this.root, path)}`,
          );
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          targetBefore.exists
        ) {
          throw error;
        }
      }

      await rename(temporary, path);
      const saved = await lstat(path);
      const savedPhysical = await realpath(path);
      if (
        saved.isSymbolicLink() ||
        saved.dev !== created.dev ||
        saved.ino !== created.ino ||
        !within(this.root, savedPhysical) ||
        isProtectedPath(this.root, savedPhysical)
      ) {
        throw new Error(
          `Saved file resolved outside the safe workspace: ${displayPath(this.root, path)}`,
        );
      }
      await handle.close();
      handle = undefined;

      const parentAfter = await this.verifiedDirectoryIdentity(parent);
      if (
        parentAfter.dev !== parentBefore.dev ||
        parentAfter.ino !== parentBefore.ino ||
        parentAfter.physical !== parentBefore.physical
      ) {
        throw new Error(
          `Parent directory changed after saving ${displayPath(this.root, path)}.`,
        );
      }

      try {
        const directory = await open(parent, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Directory fsync is unsupported on some platforms; the file itself is synced.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await removeCreatedTemporary();
      throw error;
    }
  }

  async listFiles(input = ".", maxDepth = 3): Promise<string> {
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 6) {
      throw new Error("maxDepth must be an integer from 0 to 6.");
    }
    const start = await this.safePath(input);
    const details = await stat(start);
    if (!details.isDirectory()) return displayPath(this.root, start);
    const lines: string[] = [];
    let entriesVisited = 0;
    let outputChars = 0;
    let truncated = false;

    const addLine = (line: string): boolean => {
      if (
        entriesVisited >= MAX_SEARCH_FILES ||
        outputChars + line.length + 1 > MAX_LIST_OUTPUT_CHARS
      ) {
        truncated = true;
        return false;
      }
      entriesVisited += 1;
      outputChars += line.length + 1;
      lines.push(line);
      return true;
    };

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (truncated) return;
      const listing = await this.readDirectoryEntries(
        directory,
        MAX_SEARCH_FILES - entriesVisited,
      );
      const entries = listing.entries;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (truncated) break;
        const absolute = resolve(directory, entry.name);
        const shown = displayPath(this.root, absolute);
        if (isProtectedPath(this.root, absolute)) {
          addLine(`${shown} [protected]`);
          continue;
        }
        if (entry.isSymbolicLink()) {
          addLine(`${shown} -> [symlink]`);
          continue;
        }
        if (entry.isDirectory()) {
          if (!addLine(`${shown}/`)) break;
          if (depth < maxDepth && !DEFAULT_IGNORES.has(entry.name)) {
            await visit(absolute, depth + 1);
          }
        } else {
          addLine(shown);
        }
      }
      if (listing.truncated) truncated = true;
    };

    await visit(start, 0);
    if (!lines.length) return truncated ? "(listing truncated)" : "(empty directory)";
    return `${lines.join("\n")}${
      truncated
        ? `\n… listing truncated at ${entriesVisited} entries or ${MAX_LIST_OUTPUT_CHARS.toLocaleString("en-US")} characters`
        : ""
    }`;
  }

  async tree(input = ".", maxDepth = 3): Promise<WorkspaceTree> {
    if (input.length > 4_096) {
      throw new Error("Path is too long.");
    }
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 6) {
      throw new Error("maxDepth must be an integer from 0 to 6.");
    }
    const start = await this.safePath(input);
    this.protect(start, input);
    const startDetails = await stat(start);
    if (!startDetails.isDirectory()) {
      throw new Error(`Not a directory: ${input}`);
    }

    const entries: WorkspaceTreeEntry[] = [];
    let outputChars = 0;
    let scannedEntries = 0;
    let truncated = false;
    const addEntry = (entry: WorkspaceTreeEntry): boolean => {
      const estimatedChars =
        entry.path.length +
        entry.name.length +
        entry.modifiedAt.length +
        96;
      if (
        entries.length >= MAX_IDE_TREE_ENTRIES ||
        outputChars + estimatedChars > MAX_IDE_TREE_OUTPUT_CHARS
      ) {
        truncated = true;
        return false;
      }
      entries.push(entry);
      outputChars += estimatedChars;
      return true;
    };

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (truncated) return;
      const listing = await this.readDirectoryEntries(
        directory,
        MAX_WORKSPACE_WALK_ENTRIES - scannedEntries,
      );
      const children = listing.entries;
      scannedEntries += children.length;
      children.sort((left, right) => {
        const leftRank = left.isDirectory() ? 0 : 1;
        const rightRank = right.isDirectory() ? 0 : 1;
        return leftRank - rightRank || left.name.localeCompare(right.name);
      });

      for (const child of children) {
        if (truncated) break;
        const absolute = resolve(directory, child.name);
        if (
          child.isSymbolicLink() ||
          isProtectedPath(this.root, absolute)
        ) {
          continue;
        }
        const details = await lstat(absolute);
        if (
          details.isSymbolicLink() ||
          (details.isFile() && details.nlink > 1) ||
          (!details.isDirectory() && !details.isFile())
        ) {
          continue;
        }
        const ignored = details.isDirectory() && DEFAULT_IGNORES.has(child.name);
        const entry: WorkspaceTreeEntry = {
          path: portableDisplayPath(this.root, absolute),
          name: child.name,
          type: details.isDirectory() ? "directory" : "file",
          depth,
          modifiedAt: details.mtime.toISOString(),
          ...(details.isFile() ? { size: details.size } : {}),
          ...(ignored ? { ignored: true } : {}),
        };
        if (!addEntry(entry)) break;
        if (details.isDirectory() && !ignored && depth < maxDepth) {
          await visit(absolute, depth + 1);
        }
      }
      if (listing.truncated) truncated = true;
    };

    await visit(start, 0);
    return {
      path: portableDisplayPath(this.root, start),
      entries,
      truncated,
    };
  }

  async readTextDocument(input: string): Promise<WorkspaceDocument> {
    if (!input || input.length > 4_096) {
      throw new Error(input ? "Path is too long." : "Path cannot be empty.");
    }
    const path = await this.safePath(input);
    this.protect(path, input);
    const details = await lstat(path);
    if (!details.isFile()) throw new Error(`Not a file: ${input}`);
    rejectHardLinkedFile(details, input);
    if (details.size > MAX_IDE_FILE_BYTES) {
      throw new Error(
        `File is too large (${details.size} bytes). Maximum editor size is ${MAX_IDE_FILE_BYTES}.`,
      );
    }
    const { buffer } = await this.readVerifiedFile(
      path,
      input,
      MAX_IDE_FILE_BYTES,
    );
    if (buffer.byteLength > MAX_IDE_FILE_BYTES) {
      throw new Error(
        `File is too large (${buffer.byteLength} bytes). Maximum editor size is ${MAX_IDE_FILE_BYTES}.`,
      );
    }
    if (buffer.includes(0)) {
      throw new Error(`Binary file cannot be opened in the editor: ${input}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`File is not valid UTF-8 text: ${input}`);
    }
    return {
      path: portableDisplayPath(this.root, path),
      content,
      size: buffer.byteLength,
      modifiedAt: details.mtime.toISOString(),
      revision: documentRevision(buffer),
    };
  }

  async saveTextDocument(
    input: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WorkspaceDocument> {
    if (!input || input.length > 4_096) {
      throw new Error(input ? "Path is too long." : "Path cannot be empty.");
    }
    if (
      expectedRevision !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(expectedRevision)
    ) {
      throw new Error(
        'Revision must be null for a new file or a "sha256:<digest>" value returned by the editor API.',
      );
    }
    const contentBuffer = Buffer.from(content, "utf8");
    if (contentBuffer.byteLength > MAX_IDE_FILE_BYTES) {
      throw new Error(
        `File is too large (${contentBuffer.byteLength} bytes). Maximum editor size is ${MAX_IDE_FILE_BYTES}.`,
      );
    }
    if (contentBuffer.includes(0)) {
      throw new Error("Editor saves cannot contain null bytes.");
    }

    const path = await this.safePath(input);
    this.protect(path, input);
    return withDocumentLock(path, async () => {
    let existing: Buffer | undefined;
    try {
      const details = await lstat(path);
      if (!details.isFile()) throw new Error(`Not a file: ${input}`);
      rejectHardLinkedFile(details, input);
      if (details.size > MAX_IDE_FILE_BYTES) {
        throw new Error(
          `File is too large (${details.size} bytes). Maximum editor size is ${MAX_IDE_FILE_BYTES}.`,
        );
      }
      existing = (
        await this.readVerifiedFile(path, input, MAX_IDE_FILE_BYTES)
      ).buffer;
      if (existing.byteLength > MAX_IDE_FILE_BYTES) {
        throw new Error(
          `File is too large (${existing.byteLength} bytes). Maximum editor size is ${MAX_IDE_FILE_BYTES}.`,
        );
      }
      if (existing.includes(0)) {
        throw new Error(`Binary file cannot be saved from the editor: ${input}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (existing === undefined) {
      if (expectedRevision !== null) {
        throw new WorkspaceRevisionConflictError(
          `${input} was removed after it was opened. Reload before saving.`,
        );
      }
    } else {
      if (expectedRevision === null) {
        throw new WorkspaceRevisionConflictError(
          `${input} was created after this editor tab opened. Reload before saving.`,
        );
      }
      if (documentRevision(existing) !== expectedRevision) {
        throw new WorkspaceRevisionConflictError(
          `${input} changed on disk. Reload or merge the latest version before saving.`,
        );
      }
    }

    await this.atomicWrite(path, content);
    return this.readTextDocument(input);
    });
  }

  async readFile(input: string, startLine = 1, endLine?: number): Promise<string> {
    const path = await this.safePath(input);
    this.protect(path, input);
    const details = await lstat(path);
    if (!details.isFile()) throw new Error(`Not a file: ${input}`);
    rejectHardLinkedFile(details, input);
    if (details.size > MAX_READ_BYTES) {
      throw new Error(
        `File is too large (${details.size} bytes). Maximum readable size is ${MAX_READ_BYTES}.`,
      );
    }
    const { buffer } = await this.readVerifiedFile(
      path,
      input,
      MAX_READ_BYTES,
    );
    if (buffer.byteLength > MAX_READ_BYTES) {
      throw new Error(
        `File is too large (${buffer.byteLength} bytes). Maximum readable size is ${MAX_READ_BYTES}.`,
      );
    }
    if (buffer.includes(0)) throw new Error(`Binary file cannot be read as text: ${input}`);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, endLine ?? Math.min(lines.length, start + 399));
    if (end < start) throw new Error("endLine must be greater than or equal to startLine.");
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(5)} | ${line}`)
      .join("\n");
  }

  async searchFiles(
    query: string,
    input = ".",
    caseSensitive = false,
  ): Promise<string> {
    if (!query) throw new Error("Search query cannot be empty.");
    const start = await this.safePath(input);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: string[] = [];
    let visited = 0;
    let scannedEntries = 0;
    let walkTruncated = false;
    let outputChars = 0;
    let outputTruncated = false;
    let matchLimitReached = false;
    const markerReserve = 512;

    const addMatch = (match: string): boolean => {
      const truncationMarker = " … [matching line truncated]";
      const bounded =
        match.length > MAX_SEARCH_MATCH_LINE_CHARS
          ? `${match.slice(
              0,
              MAX_SEARCH_MATCH_LINE_CHARS - truncationMarker.length,
            )}${truncationMarker}`
          : match;
      const separatorChars = matches.length ? 1 : 0;
      if (
        outputChars + separatorChars + bounded.length >
        MAX_SEARCH_OUTPUT_CHARS - markerReserve
      ) {
        outputTruncated = true;
        return false;
      }
      matches.push(bounded);
      outputChars += separatorChars + bounded.length;
      if (matches.length >= 200) {
        matchLimitReached = true;
        return false;
      }
      return true;
    };

    const inspect = async (path: string): Promise<void> => {
      if (
        visited >= MAX_SEARCH_FILES ||
        matchLimitReached ||
        outputTruncated
      ) return;
      visited += 1;
      const details = await lstat(path);
      if (
        !details.isFile() ||
        details.nlink > 1 ||
        details.size > MAX_READ_BYTES
      ) return;
      if (isProtectedPath(this.root, path)) return;
      let buffer: Buffer;
      try {
        buffer = (
          await this.readVerifiedFile(
            path,
            displayPath(this.root, path),
            MAX_READ_BYTES,
          )
        ).buffer;
      } catch {
        return;
      }
      if (buffer.byteLength > MAX_READ_BYTES) return;
      if (buffer.includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
        if (haystack.includes(needle)) {
          if (
            !addMatch(
              `${displayPath(this.root, path)}:${index + 1}: ${lines[index].trimEnd()}`,
            )
          ) return;
        }
      }
    };

    const walk = async (path: string): Promise<void> => {
      if (
        visited >= MAX_SEARCH_FILES ||
        scannedEntries >= MAX_WORKSPACE_WALK_ENTRIES ||
        matchLimitReached ||
        outputTruncated
      ) {
        if (scannedEntries >= MAX_WORKSPACE_WALK_ENTRIES) walkTruncated = true;
        return;
      }
      const details = await lstat(path);
      if (details.isSymbolicLink()) return;
      if (details.isFile()) {
        await inspect(path);
        return;
      }
      if (!details.isDirectory()) return;
      const listing = await this.readDirectoryEntries(
        path,
        MAX_WORKSPACE_WALK_ENTRIES - scannedEntries,
      );
      const entries = listing.entries;
      scannedEntries += entries.length;
      if (listing.truncated) walkTruncated = true;
      for (const entry of entries) {
        if (entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) continue;
        await walk(resolve(path, entry.name));
      }
    };

    await walk(start);
    const markers: string[] = [];
    if (outputTruncated) {
      markers.push(
        `(Search output truncated at its ${MAX_SEARCH_OUTPUT_CHARS}-character limit.)`,
      );
    }
    if (matchLimitReached) {
      markers.push("(Search stopped after 200 matches.)");
    }
    if (visited >= MAX_SEARCH_FILES || walkTruncated) {
      markers.push("(Search stopped at its bounded workspace traversal limit.)");
    }
    return matches.length
      ? [...matches, ...markers].join("\n")
      : "No matches found.";
  }

  async projectMap(): Promise<string> {
    const extensions = new Map<string, number>();
    const manifests: string[] = [];
    const topLevel: string[] = [];
    let files = 0;
    let directories = 0;
    let scannedEntries = 0;
    let walkTruncated = false;
    const notable = new Set([
      "package.json",
      "pyproject.toml",
      "requirements.txt",
      "cargo.toml",
      "go.mod",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "gemfile",
      "composer.json",
      "mix.exs",
      "pubspec.yaml",
      "package.swift",
      "cmakelists.txt",
      "makefile",
      "dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "readme.md",
      "agents.md",
      "claude.md",
    ]);

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (
        files >= MAX_SEARCH_FILES ||
        scannedEntries >= MAX_WORKSPACE_WALK_ENTRIES
      ) {
        if (scannedEntries >= MAX_WORKSPACE_WALK_ENTRIES) walkTruncated = true;
        return;
      }
      const listing = await this.readDirectoryEntries(
        directory,
        MAX_WORKSPACE_WALK_ENTRIES - scannedEntries,
      );
      const entries = listing.entries;
      scannedEntries += entries.length;
      if (listing.truncated) walkTruncated = true;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files >= MAX_SEARCH_FILES) break;
        const absolute = resolve(directory, entry.name);
        if (isProtectedPath(this.root, absolute) || entry.isSymbolicLink()) continue;
        const shown = displayPath(this.root, absolute);
        if (depth === 0) topLevel.push(`${shown}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) {
          directories += 1;
          if (!DEFAULT_IGNORES.has(entry.name)) await walk(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        files += 1;
        const lower = entry.name.toLowerCase();
        if (notable.has(lower) && manifests.length < 80) manifests.push(shown);
        const extension = extname(lower) || `[${lower}]`;
        extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
      }
    };

    await walk(this.root, 0);
    const fileTypes = [...extensions.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 16)
      .map(([extension, count]) => `${extension}: ${count}`)
      .join(", ");
    return [
      `Workspace: ${basename(this.root)}`,
      `Indexed: ${files} files, ${directories} directories${
        files >= MAX_SEARCH_FILES || walkTruncated
          ? " (bounded traversal limit reached)"
          : ""
      }`,
      `Primary file types: ${fileTypes || "none"}`,
      `Key project files:\n${manifests.length ? manifests.join("\n") : "(none found)"}`,
      `Top level:\n${topLevel.slice(0, 80).join("\n") || "(empty)"}`,
    ].join("\n\n");
  }

  async writeTextFile(input: string, content: string): Promise<string> {
    const path = await this.safePath(input);
    this.protect(path, input);
    await withDocumentLock(path, async () => {
      try {
        const details = await lstat(path);
        rejectHardLinkedFile(details, input);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.atomicWrite(path, content);
    });
    return `Wrote ${Buffer.byteLength(content)} bytes to ${displayPath(this.root, path)}.`;
  }

  async replaceInFile(
    input: string,
    search: string,
    replacement: string,
    replaceAll = false,
  ): Promise<string> {
    if (!search) throw new Error("Search text cannot be empty.");
    const path = await this.safePath(input);
    this.protect(path, input);
    const details = await lstat(path);
    if (!details.isFile()) throw new Error(`Not a file: ${input}`);
    rejectHardLinkedFile(details, input);
    if (details.size > MAX_EDIT_BYTES) {
      throw new Error(
        `File is too large to edit safely (${details.size} bytes). Maximum is ${MAX_EDIT_BYTES}.`,
      );
    }
    const { buffer } = await this.readVerifiedFile(
      path,
      input,
      MAX_EDIT_BYTES,
    );
    if (buffer.byteLength > MAX_EDIT_BYTES) {
      throw new Error(
        `File is too large to edit safely (${buffer.byteLength} bytes). Maximum is ${MAX_EDIT_BYTES}.`,
      );
    }
    if (buffer.includes(0)) {
      throw new Error(`Binary file cannot be edited as text: ${input}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`File is not valid UTF-8 text: ${input}`);
    }
    let occurrences = 0;
    let searchOffset = 0;
    while (searchOffset <= content.length - search.length) {
      const matchOffset = content.indexOf(search, searchOffset);
      if (matchOffset === -1) break;
      occurrences += 1;
      searchOffset = matchOffset + search.length;
    }
    if (occurrences === 0) throw new Error(`Search text was not found in ${input}.`);
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `Search text occurs ${occurrences} times. Provide more context or set replaceAll=true.`,
      );
    }
    const replacements = BigInt(replaceAll ? occurrences : 1);
    const projectedBytes =
      BigInt(buffer.byteLength) -
      BigInt(Buffer.byteLength(search)) * replacements +
      BigInt(Buffer.byteLength(replacement)) * replacements;
    if (
      projectedBytes < 0n ||
      projectedBytes > BigInt(MAX_EDIT_BYTES)
    ) {
      throw new Error(
        `Replacement would make ${input} too large (${projectedBytes.toString()} bytes). Maximum is ${MAX_EDIT_BYTES}.`,
      );
    }
    const updated = replaceAll
      ? content.replaceAll(search, () => replacement)
      : content.replace(search, replacement);
    const updatedBytes = Buffer.byteLength(updated);
    if (updatedBytes > MAX_EDIT_BYTES) {
      throw new Error(
        `Replacement made ${input} too large (${updatedBytes} bytes). Maximum is ${MAX_EDIT_BYTES}.`,
      );
    }
    await withDocumentLock(path, async () => {
      const current = (
        await this.readVerifiedFile(path, input, MAX_EDIT_BYTES)
      ).buffer;
      if (!current.equals(buffer)) {
        throw new WorkspaceRevisionConflictError(
          `${input} changed while it was being edited. Retry against the latest content.`,
        );
      }
      await this.atomicWrite(path, updated);
    });
    return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${displayPath(this.root, path)}.`;
  }

  async runCommand(
    command: string,
    timeoutMs = 120_000,
    signal?: AbortSignal,
    options: CommandExecutionOptions = {},
  ): Promise<CommandResult> {
    if (containsDestructiveCommand(command)) {
      throw new Error("This command is blocked because it can irreversibly destroy data.");
    }
    if (containsSecretReadCommand(command)) {
      throw new Error("This command is blocked because it attempts to read a protected secret file.");
    }
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1_000), 600_000);
    if (signal?.aborted) throw new Error("Request cancelled.");
    const authorization = options.authorization ?? "host_direct";
    if (authorization === "verified_unattended") {
      return this.runVerifiedUnattendedCommand(
        command,
        boundedTimeout,
        signal,
      );
    }
    let sandboxDirectory: string | undefined;
    let executable = command;
    let executableArguments: string[] | undefined;
    let environment = safeCommandEnvironment();
    let useShell = true;
    let usedMacOsProfile = false;
    if (
      process.platform === "darwin" &&
      existsSync("/usr/bin/sandbox-exec")
    ) {
      usedMacOsProfile = true;
      sandboxDirectory = await mkdtemp(
        join(tmpdir(), "krater-pro-terminal-"),
      );
      const profile = this.commandSandboxProfile(sandboxDirectory);
      executable = "/usr/bin/sandbox-exec";
      executableArguments = [
        "-p",
        profile,
        "/bin/sh",
        "-c",
        command,
      ];
      environment = {
        ...environment,
        HOME: sandboxDirectory,
        TMPDIR: sandboxDirectory,
        TMP: sandboxDirectory,
        TEMP: sandboxDirectory,
        ...(existsSync("/Library/Developer/CommandLineTools/usr/bin")
          ? {
              PATH:
                `/Library/Developer/CommandLineTools/usr/bin${delimiter}` +
                (environment.PATH ?? ""),
            }
          : {}),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      };
      useShell = false;
    }
    if (signal?.aborted) {
      if (sandboxDirectory) {
        await rm(sandboxDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      throw new Error("Request cancelled.");
    }

    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, executableArguments ?? [], {
        cwd: this.root,
        env: environment,
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      child.stdout.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        if (stdout.length < MAX_COMMAND_OUTPUT * 2) {
          stdout += text.slice(0, MAX_COMMAND_OUTPUT * 2 - stdout.length);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        if (stderr.length < MAX_COMMAND_OUTPUT * 2) {
          stderr += text.slice(0, MAX_COMMAND_OUTPUT * 2 - stderr.length);
        }
      });
      const forceKill = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      };
      const terminate = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          forceTimer = setTimeout(forceKill, 2_000);
        } else {
          child.kill("SIGTERM");
        }
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.on("error", async (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceKill();
        }
        signal?.removeEventListener("abort", onAbort);
        if (sandboxDirectory) {
          await rm(sandboxDirectory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        reject(error);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, boundedTimeout);
      child.on("close", async (exitCode, terminationSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceKill();
        }
        signal?.removeEventListener("abort", onAbort);
        if (sandboxDirectory) {
          await rm(sandboxDirectory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        if (aborted) {
          reject(new Error("Request cancelled."));
          return;
        }
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (exitCode === null && !timedOut) {
          reject(
            new Error(
              `Command terminated unexpectedly${
                terminationSignal ? ` (${terminationSignal})` : ""
              }.`,
            ),
          );
          return;
        }
        resolvePromise({
          exitCode,
          stdout: truncate(redactGitRemoteCredentials(stdout)),
          stderr: truncate(redactGitRemoteCredentials(stderr)),
          timedOut,
          execution: {
            authorization,
            containment: usedMacOsProfile
              ? "macos_seatbelt_best_effort"
              : authorization === "approved_attended"
                ? "approved_uncontained"
                : "host_process",
            summary: usedMacOsProfile
              ? "Attended/host command used the compatibility macOS Seatbelt profile; this is not the strict unattended native adapter."
              : authorization === "approved_attended"
                ? "The user explicitly approved this attended command without verified native OS containment."
                : "This host-selected command used process, environment, output, and wall-time bounds without verified native OS containment.",
          },
        });
      });
    });
  }

  private async protectedCommandResources(): Promise<
    ResourceCapabilityRequest[]
  > {
    const directories = [this.root];
    const denied = new Set<string>();
    const fileIdentities = new Map<
      string,
      { paths: string[]; protected: boolean }
    >();
    let visited = 0;

    while (directories.length) {
      const directory = directories.pop()!;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        visited += 1;
        if (visited > MAX_WORKSPACE_WALK_ENTRIES) {
          throw new Error(
            `Unattended containment refused: protected-path discovery exceeded ${MAX_WORKSPACE_WALK_ENTRIES.toLocaleString("en-US")} workspace entries.`,
          );
        }
        const absolute = join(directory, entry.name);
        const details = await lstat(absolute);
        const protectedPath = isProtectedPath(this.root, absolute);
        if (protectedPath) {
          denied.add(absolute);
          if (details.isDirectory()) continue;
        }
        if (details.isDirectory()) {
          directories.push(absolute);
          continue;
        }
        if (details.isFile()) {
          const identity = `${details.dev}:${details.ino}`;
          const record = fileIdentities.get(identity) ?? {
            paths: [],
            protected: false,
          };
          record.paths.push(absolute);
          record.protected ||= protectedPath;
          fileIdentities.set(identity, record);
        }
      }
    }

    for (const record of fileIdentities.values()) {
      if (!record.protected) continue;
      for (const path of record.paths) denied.add(path);
    }
    return denied.size
      ? [
          {
            kind: "resource",
            access: "deny",
            paths: [...denied].sort(),
            reason:
              "Keep project secrets, Git internals, and Krater private state host-side.",
          },
        ]
      : [];
  }

  private async runVerifiedUnattendedCommand(
    command: string,
    boundedTimeout: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (
      /\b(?:Bearer|Basic)\s+\S+/i.test(command) ||
      /--?(?:api[-_]?key|authorization|credential|password|secret|token)(?:=|\s+)/i.test(
        command,
      )
    ) {
      throw new Error(
        "Unattended command refused: credential material cannot enter a process argument.",
      );
    }

    const adapter = this.nativeSandboxAdapter;
    const supervisor = new SandboxSupervisor({
      ...(adapter ? { adapter } : {}),
      platform: process.platform,
    });
    const executionId = randomUUID();
    const environmentKeys = Object.keys(safeCommandEnvironment()).filter(
      (name) =>
        !["HOME", "TMPDIR", "TMP", "TEMP"].includes(name) &&
        !/(?:authorization|credential|password|secret|token|api[_-]?key)/i.test(
          name,
        ),
    );
    const resources: ResourceCapabilityRequest[] = [
      {
        kind: "resource",
        access: "read_write",
        paths: [this.root],
        reason: "Execute only against the isolated staged workspace.",
      },
      ...this.readOnlyDependencyRoots.map(
        (path): ResourceCapabilityRequest => ({
          kind: "resource",
          access: "read",
          paths: [path],
          reason: "Read a host-selected dependency/toolchain root.",
        }),
      ),
      ...(await this.protectedCommandResources()),
    ];
    const shellExecutable =
      process.platform === "darwin"
        ? "/bin/zsh"
        : process.platform === "win32"
          ? process.execPath
          : "/bin/sh";
    const execution = supervisor.execute({
      id: executionId,
      mode: "unattended",
      command: {
        kind: "command",
        executable: shellExecutable,
        arguments:
          process.platform === "darwin"
            ? ["-f", "-c", command]
            : ["-c", command],
        workingDirectory: this.root,
        environmentKeys,
        reason: "Run a model-generated command under verified containment.",
      },
      resources,
      network: {
        kind: "network",
        policy: "deny",
        reason: "Unattended model commands have no network capability.",
      },
      limits: {
        cpuTimeMs: boundedTimeout,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        wallTimeMs: boundedTimeout,
        processCount: 1,
        outputBytes: MAX_COMMAND_OUTPUT,
      },
    });
    const onAbort = () => {
      void adapter?.cancel(executionId, "supervisor_cancelled");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const receipt = await execution;
      if (signal?.aborted) throw new Error("Request cancelled.");
      if (
        receipt.status === "refused" ||
        receipt.status === "approval_required" ||
        receipt.status === "adapter_error"
      ) {
        throw new Error(
          `Unattended command refused by native containment: ${receipt.reason ?? receipt.status}`,
        );
      }
      return {
        exitCode: receipt.exitCode,
        stdout: redactGitRemoteCredentials(receipt.output.stdout),
        stderr: redactGitRemoteCredentials(receipt.output.stderr),
        timedOut: receipt.status === "timed_out",
        truncated: receipt.output.truncated,
        execution: {
          authorization: "verified_unattended",
          containment: "verified_native",
          ...(receipt.capabilityReport.adapterId
            ? { adapterId: receipt.capabilityReport.adapterId }
            : {}),
          effectiveProcessLimit: 1,
          summary:
            "Unattended command ran with verified native containment: staged paths only, deny-all networking, one process, hard CPU/address-space limits, and bounded output/wall time.",
        },
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private commandSandboxProfile(temporaryDirectory: string): string {
    const insensitive = caseInsensitiveRegularExpressionLiteral;
    const protectedPattern =
      `^${escapeRegularExpression(this.root)}/(.*/)?` +
      `(${[
        ".npmrc",
        ".pypirc",
        ".netrc",
        "credentials",
        "id_rsa",
        "id_ed25519",
      ].map(insensitive).join("|")}|` +
      `[^/]+\\.(${["pem", "p12", "pfx", "key"].map(insensitive).join("|")}))$`;
    const environmentPattern =
      `^${escapeRegularExpression(this.root)}/(.*/)?` +
      `${insensitive(".env")}(\\..*)?$`;
    const environmentExamplesPattern =
      `^${escapeRegularExpression(this.root)}/(.*/)?` +
      `${insensitive(".env")}\\.(` +
      `${["example", "sample", "template"].map(insensitive).join("|")})$`;
    const internalPattern =
      `^${escapeRegularExpression(this.root)}/(.*/)?` +
      `${insensitive(".krater")}(/.*)?$`;
    const sourceHome = process.env.HOME;
    const executableSearchRoots = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((path) => isAbsolute(path));
    const versionedNodeRoots = executableSearchRoots
      .filter((path) => /\/\.nvm\/versions\/node\/[^/]+\/bin$/.test(path))
      .map(dirname);
    const userToolchainReadRoots = sourceHome
      ? [
          join(sourceHome, ".cargo", "bin"),
          join(sourceHome, ".cargo", "registry"),
          join(sourceHome, ".cargo", "git"),
          join(sourceHome, ".rustup", "toolchains"),
          join(sourceHome, ".volta", "tools", "image"),
        ]
      : [];
    const allowedReadRoots = [
      this.root,
      ...this.readOnlyDependencyRoots,
      temporaryDirectory,
      realpathSync(temporaryDirectory),
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/Library",
      "/private/etc",
      "/private/var/db",
      "/private/var/select",
      "/dev",
      "/opt/homebrew",
      "/usr/local",
      dirname(process.execPath),
      ...executableSearchRoots,
      ...versionedNodeRoots,
      ...userToolchainReadRoots,
    ].filter((path, index, paths) => paths.indexOf(path) === index);
    const readableParentDirectories = [
      this.root,
      temporaryDirectory,
      realpathSync(temporaryDirectory),
    ].flatMap((path) => {
      const parents: string[] = [];
      let current = dirname(resolve(path));
      while (current !== dirname(current)) {
        parents.push(current);
        current = dirname(current);
      }
      return parents;
    }).filter((path, index, paths) => paths.indexOf(path) === index);
    const deniedHomePaths = sourceHome
      ? [
          ".ssh",
          ".aws",
          ".kube",
          ".docker",
          ".codex",
          join(".config", "gh"),
          join(".config", "gcloud"),
        ].map((path) => `(subpath ${sandboxLiteral(join(sourceHome, path))})`)
      : [];
    const deniedHomeFiles = sourceHome
      ? [".netrc", ".npmrc", ".pypirc"].map(
          (path) => `(literal ${sandboxLiteral(join(sourceHome, path))})`,
        )
      : [];
    const deniedFilters = [
      `(regex ${sandboxRegex(internalPattern)})`,
      `(require-all (regex ${sandboxRegex(environmentPattern)}) ` +
        `(require-not (regex ${sandboxRegex(environmentExamplesPattern)})))`,
      `(regex ${sandboxRegex(protectedPattern)})`,
      ...deniedHomePaths,
      ...deniedHomeFiles,
    ];
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix*)",
      `(allow file-read* (literal "/") (literal "/private") ` +
        `(literal "/private/var") ${readableParentDirectories
          .map((path) => `(literal ${sandboxLiteral(path)})`)
          .join(" ")} ${allowedReadRoots
          .map((path) => `(subpath ${sandboxLiteral(path)})`)
          .join(" ")})`,
      `(allow file-write* (subpath ${sandboxLiteral(this.root)}) ` +
        `(subpath ${sandboxLiteral(temporaryDirectory)}) ` +
        '(literal "/dev/null"))',
      "(deny network*)",
      ...deniedFilters.map((filter) => `(deny file-read* ${filter})`),
      ...deniedFilters.map((filter) => `(deny file-write* ${filter})`),
    ].join(" ");
  }

  async gitStatus(): Promise<string> {
    return (await this.gitStatusSnapshot()).status;
  }

  async gitStatusSnapshot(): Promise<GitStatusSnapshot> {
    await this.assertSafeGitRepository();
    const result = await this.runFixedCommand(
      "git",
      [
        ...this.safeGitPrefix(),
        "-c",
        "status.renames=true",
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
      ],
      30_000,
      this.safeGitEnvironment(),
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || "git status failed.");
    if (result.truncated) {
      throw new Error(
        "Git status exceeds the safe output limit; narrow or clean the working tree before inspecting it.",
      );
    }

    const fields = result.stdout.split("\0").filter(Boolean);
    let branch = "";
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (field.startsWith("## ")) {
        branch = field.slice(3);
        continue;
      }
      if (field.length < 4 || field[2] !== " ") continue;
      const status = field.slice(0, 2);
      const path = field.slice(3);
      let originalPath: string | undefined;
      if (status.includes("R") || status.includes("C")) {
        originalPath = fields[index + 1];
        index += 1;
      }
      if (
        !(await isSafeGitStatusPath(this.root, path)) ||
        (originalPath !== undefined &&
          !(await isSafeGitStatusPath(this.root, originalPath)))
      ) {
        continue;
      }
      entries.push({
        index: status[0],
        workingTree: status[1],
        path: path.split(sep).join("/"),
        ...(originalPath
          ? { originalPath: originalPath.split(sep).join("/") }
          : {}),
      });
    }
    const statusLines = [
      ...(branch ? [`## ${branch}`] : []),
      ...entries.map((entry) => {
        const target = formatGitPath(entry.path);
        const rename = entry.originalPath
          ? `${formatGitPath(entry.originalPath)} -> ${target}`
          : target;
        return `${entry.index}${entry.workingTree} ${rename}`;
      }),
    ];
    return {
      branch,
      clean: entries.length === 0,
      entries,
      status: statusLines.join("\n") || "Working tree clean.",
    };
  }

  async gitDiff(staged = false): Promise<string> {
    await this.assertSafeGitRepository();
    const safePrefix = this.safeGitPrefix();
    const listArgs = [
      ...safePrefix,
      "diff",
      "--name-status",
      "-z",
      "-M",
      "-C",
      "--find-copies-harder",
      "--no-textconv",
      "--no-ext-diff",
    ];
    if (staged) listArgs.push("--cached");
    const listed = await this.runFixedCommand(
      "git",
      listArgs,
      30_000,
      this.safeGitEnvironment(),
    );
    if (listed.exitCode !== 0) {
      throw new Error(listed.stderr || "git diff failed.");
    }
    if (listed.truncated) {
      throw new Error(
        "Git diff path metadata exceeds the safe output limit; narrow or clean the working tree before inspecting it.",
      );
    }
    const fields = listed.stdout.split("\0").filter(Boolean);
    const safePaths = new Set<string>();
    for (let index = 0; index < fields.length; ) {
      const status = fields[index++];
      const paired = status.startsWith("R") || status.startsWith("C");
      const paths = paired
        ? [fields[index++], fields[index++]]
        : [fields[index++]];
      if (
        paths.some((path) => !path) ||
        !(await Promise.all(
          paths.map((path) => isSafeGitStatusPath(this.root, path)),
        )).every(Boolean)
      ) {
        continue;
      }
      for (const path of paths) safePaths.add(path);
    }
    if (!safePaths.size) return "No diff.";

    let output = "";
    let previewTruncated = false;
    const pathList = [...safePaths];
    for (let index = 0; index < pathList.length; index += 100) {
      const args = [
        ...safePrefix,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "-C",
        "--find-copies-harder",
      ];
      if (staged) args.push("--cached");
      args.push(
        "--",
        ...pathList
          .slice(index, index + 100)
          .map((path) => `:(literal)${path}`),
      );
      const result = await this.runFixedCommand(
        "git",
        args,
        30_000,
        this.safeGitEnvironment(),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "git diff failed.");
      }
      if (result.truncated) {
        const marker = `\n… diff preview truncated at ${MAX_COMMAND_OUTPUT.toLocaleString("en-US")} characters.`;
        output += result.stdout.slice(
          0,
          Math.max(0, MAX_COMMAND_OUTPUT - output.length - marker.length),
        );
        output += marker;
        previewTruncated = true;
        break;
      }
      output += result.stdout;
      if (output.length >= MAX_COMMAND_OUTPUT) break;
    }
    return previewTruncated
      ? output.trim()
      : truncate(output.trim() || "No diff.");
  }

  private safeGitPrefix(): string[] {
    return [
      `--work-tree=${this.root}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
    ];
  }

  private async assertSafeGitRepository(): Promise<void> {
    const marker = resolve(this.root, ".git");
    let markerDetails;
    try {
      markerDetails = await lstat(marker);
    } catch {
      throw new Error("Git is unavailable because this workspace is not a repository.");
    }
    if (!markerDetails.isDirectory() || markerDetails.isSymbolicLink()) {
      throw new Error(
        "Git inspection requires a repository whose .git directory is contained in the workspace.",
      );
    }
    const physicalMarker = await realpath(marker);
    if (!within(this.root, physicalMarker)) {
      throw new Error("Git metadata resolves outside the workspace.");
    }

    const inspected = await this.runFixedCommand(
      "git",
      [
        ...this.safeGitPrefix(),
        "rev-parse",
        "--show-toplevel",
        "--absolute-git-dir",
      ],
      30_000,
      this.safeGitEnvironment(),
    );
    if (inspected.exitCode !== 0 || inspected.truncated) {
      throw new Error(
        inspected.stderr || "Git repository boundaries could not be verified.",
      );
    }
    const [topLevelText, gitDirectoryText] = inspected.stdout
      .trim()
      .split(/\r?\n/);
    if (!topLevelText || !gitDirectoryText) {
      throw new Error("Git repository boundaries could not be verified.");
    }
    const [topLevel, gitDirectory] = await Promise.all([
      realpath(topLevelText),
      realpath(gitDirectoryText),
    ]);
    if (topLevel !== this.root || !within(this.root, gitDirectory)) {
      throw new Error(
        "Git inspection was blocked because the repository resolves outside the selected workspace.",
      );
    }
  }

  private safeGitEnvironment(): NodeJS.ProcessEnv {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    return {
      ...safeCommandEnvironment(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
    };
  }

  private async runFixedCommand(
    executable: string,
    args: string[],
    timeoutMs: number,
    environment: NodeJS.ProcessEnv = safeCommandEnvironment(),
  ): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, {
        cwd: this.root,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = MAX_COMMAND_OUTPUT + 1 - stdoutBytes;
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          stdoutChunks.push(accepted);
          stdoutBytes += accepted.length;
        }
        if (chunk.length > remaining || stdoutBytes > MAX_COMMAND_OUTPUT) {
          truncated = true;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_COMMAND_OUTPUT + 1 - stderrBytes;
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          stderrChunks.push(accepted);
          stderrBytes += accepted.length;
        }
        if (chunk.length > remaining || stderrBytes > MAX_COMMAND_OUTPUT) {
          truncated = true;
        }
      });
      child.on("error", reject);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode,
          stdout: Buffer.concat(stdoutChunks)
            .subarray(0, MAX_COMMAND_OUTPUT)
            .toString("utf8"),
          stderr: Buffer.concat(stderrChunks)
            .subarray(0, MAX_COMMAND_OUTPUT)
            .toString("utf8"),
          timedOut: false,
          truncated,
          execution: {
            authorization: "host_direct",
            containment: "host_process",
            summary:
              "Host-selected fixed command used direct process, environment, output, and wall-time bounds.",
          },
        });
      });
    });
  }
}
