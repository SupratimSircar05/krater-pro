import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

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
const MAX_COMMAND_OUTPUT = 120_000;
const MAX_LIST_OUTPUT_CHARS = 120_000;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function displayPath(root: string, absolute: string): string {
  const value = relative(root, absolute);
  return value || ".";
}

function truncate(value: string, max = MAX_COMMAND_OUTPUT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… output truncated (${value.length - max} characters omitted)`;
}

function isProtectedPath(root: string, absolute: string): boolean {
  const shown = relative(root, absolute);
  const parts = shown.split(sep).map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  if (parts.includes(".git")) return true;
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
  const secretName =
    String.raw`(?:\.env(?:\.(?!example\b|sample\b|template\b)[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials|[\w.-]+\.(?:pem|p12|pfx|key))`;
  const readers = String.raw`(?:cat|tac|sed|awk|grep|rg|head|tail|less|more|strings|xxd)`;
  return new RegExp(String.raw`\b${readers}\b[^\n;&|]*${secretName}`, "i").test(command);
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

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
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

  private async atomicWrite(path: string, content: string): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const temporary = resolve(
      parent,
      `.${basename(path)}.krater-${randomUUID()}.tmp`,
    );
    let mode: number | undefined;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const handle = await open(temporary, "wx", mode ?? 0o666);
      try {
        await handle.writeFile(content, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
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
      await unlink(temporary).catch(() => undefined);
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
      const entries = await readdir(directory, { withFileTypes: true });
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
    };

    await visit(start, 0);
    if (!lines.length) return truncated ? "(listing truncated)" : "(empty directory)";
    return `${lines.join("\n")}${
      truncated
        ? `\n… listing truncated at ${entriesVisited} entries or ${MAX_LIST_OUTPUT_CHARS.toLocaleString("en-US")} characters`
        : ""
    }`;
  }

  async readFile(input: string, startLine = 1, endLine?: number): Promise<string> {
    const path = await this.safePath(input);
    this.protect(path, input);
    const details = await stat(path);
    if (!details.isFile()) throw new Error(`Not a file: ${input}`);
    if (details.size > MAX_READ_BYTES) {
      throw new Error(
        `File is too large (${details.size} bytes). Maximum readable size is ${MAX_READ_BYTES}.`,
      );
    }
    const buffer = await readFile(path);
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

    const inspect = async (path: string): Promise<void> => {
      if (visited >= MAX_SEARCH_FILES || matches.length >= 200) return;
      visited += 1;
      const details = await lstat(path);
      if (!details.isFile() || details.size > MAX_READ_BYTES) return;
      if (isProtectedPath(this.root, path)) return;
      const buffer = await readFile(path);
      if (buffer.includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
        if (haystack.includes(needle)) {
          matches.push(
            `${displayPath(this.root, path)}:${index + 1}: ${lines[index].trimEnd()}`,
          );
          if (matches.length >= 200) return;
        }
      }
    };

    const walk = async (path: string): Promise<void> => {
      if (visited >= MAX_SEARCH_FILES || matches.length >= 200) return;
      const details = await lstat(path);
      if (details.isSymbolicLink()) return;
      if (details.isFile()) {
        await inspect(path);
        return;
      }
      if (!details.isDirectory()) return;
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) continue;
        await walk(resolve(path, entry.name));
      }
    };

    await walk(start);
    const footer =
      visited >= MAX_SEARCH_FILES
        ? `\n(Search stopped after ${MAX_SEARCH_FILES} files.)`
        : "";
    return matches.length ? `${matches.join("\n")}${footer}` : "No matches found.";
  }

  async projectMap(): Promise<string> {
    const extensions = new Map<string, number>();
    const manifests: string[] = [];
    const topLevel: string[] = [];
    let files = 0;
    let directories = 0;
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
      if (files >= MAX_SEARCH_FILES) return;
      const entries = await readdir(directory, { withFileTypes: true });
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
      `Indexed: ${files} files, ${directories} directories${files >= MAX_SEARCH_FILES ? ` (limit ${MAX_SEARCH_FILES} reached)` : ""}`,
      `Primary file types: ${fileTypes || "none"}`,
      `Key project files:\n${manifests.length ? manifests.join("\n") : "(none found)"}`,
      `Top level:\n${topLevel.slice(0, 80).join("\n") || "(empty)"}`,
    ].join("\n\n");
  }

  async writeTextFile(input: string, content: string): Promise<string> {
    const path = await this.safePath(input);
    this.protect(path, input);
    await this.atomicWrite(path, content);
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
    const details = await stat(path);
    if (!details.isFile()) throw new Error(`Not a file: ${input}`);
    if (details.size > MAX_EDIT_BYTES) {
      throw new Error(
        `File is too large to edit safely (${details.size} bytes). Maximum is ${MAX_EDIT_BYTES}.`,
      );
    }
    const buffer = await readFile(path);
    if (buffer.includes(0)) {
      throw new Error(`Binary file cannot be edited as text: ${input}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`File is not valid UTF-8 text: ${input}`);
    }
    const occurrences = content.split(search).length - 1;
    if (occurrences === 0) throw new Error(`Search text was not found in ${input}.`);
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `Search text occurs ${occurrences} times. Provide more context or set replaceAll=true.`,
      );
    }
    const updated = replaceAll
      ? content.split(search).join(replacement)
      : content.replace(search, replacement);
    await this.atomicWrite(path, updated);
    return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${displayPath(this.root, path)}.`;
  }

  async runCommand(
    command: string,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (containsDestructiveCommand(command)) {
      throw new Error("This command is blocked because it can irreversibly destroy data.");
    }
    if (containsSecretReadCommand(command)) {
      throw new Error("This command is blocked because it attempts to read a protected secret file.");
    }
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1_000), 600_000);
    if (signal?.aborted) throw new Error("Request cancelled.");

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, {
        cwd: this.root,
        env: safeCommandEnvironment(),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_COMMAND_OUTPUT * 2) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_COMMAND_OUTPUT * 2) stderr += chunk.toString();
      });
      const terminate = () => {
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
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, boundedTimeout);
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          reject(new Error("Request cancelled."));
          return;
        }
        resolvePromise({
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut,
        });
      });
    });
  }

  async gitStatus(): Promise<string> {
    const result = await this.runFixedCommand(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.pager=cat",
        "status",
        "--short",
        "--branch",
      ],
      30_000,
      this.safeGitEnvironment(),
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || "git status failed.");
    return result.stdout.trim() || "Working tree clean.";
  }

  async gitDiff(staged = false): Promise<string> {
    const safePrefix = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
    ];
    const listArgs = [
      ...safePrefix,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
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
    const safePaths = listed.stdout
      .split("\0")
      .filter(Boolean)
      .filter((path) => {
        const absolute = resolve(this.root, path);
        return within(this.root, absolute) && !isProtectedPath(this.root, absolute);
      });
    if (!safePaths.length) return "No diff.";

    let output = "";
    for (let index = 0; index < safePaths.length; index += 100) {
      const args = [
        ...safePrefix,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
      ];
      if (staged) args.push("--cached");
      args.push(
        "--",
        ...safePaths
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
      output += result.stdout;
      if (output.length >= MAX_COMMAND_OUTPUT) break;
    }
    return truncate(output.trim() || "No diff.");
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
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut: false,
        });
      });
    });
  }
}
