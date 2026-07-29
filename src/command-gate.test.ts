import { spawn } from "node:child_process";
import {
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTrustedGitExecutable,
  serializeTrustedGitExecutable,
  type SerializedTrustedGitExecutable,
} from "./trusted-git.js";

type GateMode = "git" | "shell-posix" | "shell-windows";

interface GateConfig {
  mode: GateMode;
  expectedRoot: string;
  expectedDevice: string;
  expectedInode: string;
  trustedGit?: SerializedTrustedGitExecutable;
  gitArguments?: string[];
  macOsSandboxProfile?: string;
}

interface GateResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const temporaryPaths: string[] = [];
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const gatePath = join(moduleDirectory, "command-gate.ts");
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function rewriteOpenFileInPlace(handle: FileHandle) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size < 1n) {
    throw new Error("The rewrite fixture requires a non-empty regular file.");
  }
  const original = Buffer.alloc(1);
  const read = await handle.read(original, 0, original.length, 0);
  if (read.bytesRead !== original.length) {
    throw new Error("The rewrite fixture could not read the opened file.");
  }
  const replacement = Buffer.from([(original[0] ?? 0) ^ 0xff]);
  const written = await handle.write(replacement, 0, replacement.length, 0);
  if (written.bytesWritten !== replacement.length) {
    throw new Error("The rewrite fixture could not update the opened file.");
  }
  await handle.sync();
  return { before, after: await handle.stat({ bigint: true }) };
}

function configFor(root: string, mode: GateMode): GateConfig {
  const details = statSync(root, { bigint: true });
  const trustedGit =
    mode === "git" ? resolveTrustedGitExecutable() : undefined;
  return {
    mode,
    expectedRoot: realpathSync(root),
    expectedDevice: details.dev.toString(),
    expectedInode: details.ino.toString(),
    ...(trustedGit
      ? {
          trustedGit: serializeTrustedGitExecutable(trustedGit),
        }
      : {}),
    ...(process.platform === "darwin" && mode === "shell-posix"
      ? { macOsSandboxProfile: "(version 1) (allow default)" }
      : {}),
  };
}

function startGate(
  root: string,
  config: GateConfig,
  command = "",
  environment: NodeJS.ProcessEnv = process.env,
): {
  control: Writable;
  completed: Promise<GateResult>;
} {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, gatePath],
    {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const descriptors = child.stdio as unknown as Array<
    NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined
  >;
  const configInput = descriptors[3] as Writable | null | undefined;
  const commandInput = descriptors[4] as Writable | null | undefined;
  const control = descriptors[5] as Writable | null | undefined;
  if (!child.stdout || !child.stderr || !configInput || !commandInput || !control) {
    child.kill("SIGKILL");
    throw new Error("Command-gate test descriptors were unavailable.");
  }
  for (const input of [configInput, commandInput, control]) {
    input.on("error", () => {
      // The child may close a descriptor before the parent-side stream settles.
    });
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  configInput.end(JSON.stringify(config));
  commandInput.end(command);
  const completed = new Promise<GateResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      control.destroy();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  return { control, completed };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${milliseconds}ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function expectNoKraterCommandDirectory(path: string): Promise<void> {
  const leftovers = (await readdir(path)).filter((entry) =>
    entry.startsWith("krater-pro-terminal-"),
  );
  expect(leftovers).toEqual([]);
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("command gate runtime", () => {
  it("exits promptly after a normal shell command while fd 5 remains open", async () => {
    const root = await temporaryDirectory("krater-gate-normal-");
    const mode =
      process.platform === "win32" ? "shell-windows" : "shell-posix";
    const command =
      process.platform === "win32" ? "echo GATE_OK" : "printf GATE_OK";
    const started = Date.now();
    const gate = startGate(root, configFor(root, mode), command);

    const result = await within(gate.completed, 3_000);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.replaceAll("\r\n", "\n")).toContain("GATE_OK");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("exits promptly after a normal fixed Git command while fd 5 remains open", async () => {
    const root = await temporaryDirectory("krater-gate-git-");
    const config = configFor(root, "git");
    config.gitArguments = ["--version"];
    const gate = startGate(root, config);

    const result = await within(gate.completed, 3_000);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toMatch(/^git version /);
  });

  it("rejects a trusted Git executable rewritten in place after approval", async () => {
    const root = await temporaryDirectory("krater-gate-git-root-");
    const tools = await temporaryDirectory("krater-gate-git-tools-");
    const executable = join(
      tools,
      process.platform === "win32" ? "git.exe" : "git",
    );
    await copyFile(process.execPath, executable);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    const trusted = resolveTrustedGitExecutable(executable, [root]);
    if (!trusted) throw new Error("The copied test executable was not trusted.");
    const config = configFor(root, "git");
    config.trustedGit = serializeTrustedGitExecutable(trusted);
    config.gitArguments = ["--version"];

    const handle = await open(
      executable,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    let mutation: Awaited<ReturnType<typeof rewriteOpenFileInPlace>>;
    try {
      const opened = await handle.stat({ bigint: true });
      expect(opened.dev).toBe(trusted.device);
      expect(opened.ino).toBe(trusted.inode);
      mutation = await rewriteOpenFileInPlace(handle);
    } finally {
      await handle.close();
    }
    const { before, after } = mutation;
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);

    const result = await within(startGate(root, config).completed, 3_000);

    expect(result.code).toBe(126);
    expect(result.stderr).toMatch(/trusted Git executable identity changed/i);
  });

  it.runIf(process.platform !== "win32")(
    "keeps the approved script separate while commands receive EOF on stdin",
    async () => {
      const root = await temporaryDirectory("krater-gate-stdin-");
      const gate = startGate(
        root,
        configFor(root, "shell-posix"),
        "read value\ncat\necho SHOULD_RUN",
      );

      const result = await within(gate.completed, 5_000);

      expect(result).toMatchObject({
        code: 0,
        signal: null,
        stdout: "SHOULD_RUN\n",
        stderr: "",
      });
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "terminates ordinary background descendants before reporting success",
    async () => {
      const root = await temporaryDirectory("krater-gate-background-");
      const pidPath = join(root, "background.pid");
      const gate = startGate(
        root,
        configFor(root, "shell-posix"),
        "sleep 15 >/dev/null 2>&1 & echo \"$!\" > background.pid",
      );
      await waitForFile(pidPath);
      const backgroundPid = Number(readFileSync(pidPath, "utf8").trim());

      try {
        await within(gate.completed, 5_000);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(backgroundPid, 0);
          } catch {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          `Successful command left background descendant ${backgroundPid} alive.`,
        );
      } finally {
        try {
          process.kill(backgroundPid, "SIGKILL");
        } catch {
          // The expected process-group cleanup already removed it.
        }
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "force-kills a TERM-ignoring descendant before cancellation completes",
    async () => {
      const root = await temporaryDirectory("krater-gate-cancel-");
      const pidPath = join(root, "survivor.pid");
      const command = [
        "(trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done) &",
        'echo "$!" > survivor.pid',
        "trap 'exit 0' TERM",
        "while :; do sleep 1; done",
      ].join("\n");
      const gate = startGate(
        root,
        configFor(root, "shell-posix"),
        command,
      );
      await waitForFile(pidPath);
      const survivorPid = Number(readFileSync(pidPath, "utf8").trim());

      try {
        gate.control.end("cancel");
        await within(gate.completed, 5_000);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(survivorPid, 0);
          } catch {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Cancelled descendant ${survivorPid} survived.`);
      } finally {
        try {
          process.kill(survivorPid, "SIGKILL");
        } catch {
          // The expected path already reaped the descendant.
        }
      }
    },
    10_000,
  );

  it.runIf(process.platform === "win32")(
    "keeps the command script separate from stdin and removes it after exit",
    async () => {
      const root = await temporaryDirectory("krater-gate-windows-");
      const privateTemp = await temporaryDirectory(
        "krater-gate-windows-temp-",
      );
      const unicodeProof = "Krater_ಕನ್ನಡ_Résumé";
      const gate = startGate(
        root,
        configFor(root, "shell-windows"),
        [
          'set /p "KRATER_READ="',
          "echo SHOULD_RUN",
          `echo ${unicodeProof}`,
        ].join("\r\n"),
        {
          ...process.env,
          TEMP: privateTemp,
          TMP: privateTemp,
        },
      );

      const result = await within(gate.completed, 5_000);
      const stdout = result.stdout.replaceAll("\r\n", "\n");

      expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(stdout).toContain("SHOULD_RUN");
      expect(stdout).toContain(unicodeProof);
      // The TypeScript test loader may own a sibling `tsx-*` cache here.
      // Assert only the command gate's private script directory is gone.
      await expectNoKraterCommandDirectory(privateTemp);
    },
    10_000,
  );

  it.runIf(process.platform === "win32")(
    "removes the private command script after cancelling the process tree",
    async () => {
      const root = await temporaryDirectory(
        "krater-gate-windows-cancel-",
      );
      const privateTemp = await temporaryDirectory(
        "krater-gate-windows-cancel-temp-",
      );
      const readyPath = join(root, "ready.txt");
      const gate = startGate(
        root,
        configFor(root, "shell-windows"),
        [
          "echo READY>ready.txt",
          `"${process.execPath}" -e "setInterval(function () {}, 1000)"`,
        ].join("\r\n"),
        {
          ...process.env,
          TEMP: privateTemp,
          TMP: privateTemp,
        },
      );
      await waitForFile(readyPath);

      gate.control.end("cancel");
      await within(gate.completed, 8_000);

      await expectNoKraterCommandDirectory(privateTemp);
    },
    15_000,
  );
});
