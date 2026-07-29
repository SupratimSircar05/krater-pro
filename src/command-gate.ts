import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, win32 } from "node:path";
import type { Writable } from "node:stream";
import {
  assertSerializedTrustedGitExecutable,
  isSerializedTrustedGitExecutable,
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

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_COMMAND_BYTES = 128_000;
const POSIX_SHELL_BOOTSTRAP = [
  "KRATER_COMMAND=$(/bin/cat <&3)",
  "KRATER_READ_STATUS=$?",
  "exec 3<&-",
  '[ "$KRATER_READ_STATUS" -eq 0 ] || exit "$KRATER_READ_STATUS"',
  'eval "$KRATER_COMMAND"',
].join("; ");

function fail(message: string): never {
  throw new Error(message);
}

function readDescriptor(descriptor: number, maximum: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
  let total = 0;
  try {
    while (total <= maximum) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > maximum) fail("an input exceeded its safe size bound");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseConfig(): GateConfig {
  let value: unknown;
  try {
    value = JSON.parse(readDescriptor(3, MAX_CONFIG_BYTES));
  } catch {
    fail("its host configuration was invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("its host configuration was not an object");
  }
  const config = value as Partial<GateConfig>;
  if (
    !["git", "shell-posix", "shell-windows"].includes(config.mode ?? "") ||
    typeof config.expectedRoot !== "string" ||
    !isAbsolute(config.expectedRoot) ||
    config.expectedRoot.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(config.expectedRoot) ||
    typeof config.expectedDevice !== "string" ||
    !/^\d{1,40}$/.test(config.expectedDevice) ||
    typeof config.expectedInode !== "string" ||
    !/^\d{1,40}$/.test(config.expectedInode)
  ) {
    fail("its root identity contract was invalid");
  }
  return config as GateConfig;
}

function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() ===
        win32.normalize(right).toLowerCase()
    : left === right;
}

function verifyInheritedRoot(config: GateConfig): void {
  const details = statSync(".", { bigint: true });
  const physical = realpathSync(".");
  if (
    !details.isDirectory() ||
    details.dev !== BigInt(config.expectedDevice) ||
    details.ino !== BigInt(config.expectedInode) ||
    !samePhysicalPath(physical, config.expectedRoot)
  ) {
    fail("the inherited working directory did not match the selected project");
  }
}

function windowsSystemExecutable(name: "cmd.exe" | "taskkill.exe"): string {
  return String.raw`\\?\GLOBALROOT\SystemRoot\System32\${name}`;
}

interface CancellationChannel {
  requested: Promise<void>;
  close(): void;
}

function cancellationChannel(): CancellationChannel {
  const stream = new Socket({
    fd: 5,
    readable: true,
    writable: false,
  });
  let resolveCancellation!: () => void;
  let resolved = false;
  const finish = () => {
    if (resolved) return;
    resolved = true;
    resolveCancellation();
  };
  const requested = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  stream.once("data", finish);
  stream.once("end", finish);
  stream.once("error", finish);
  return {
    requested,
    close: () => stream.destroy(),
  };
}

async function terminateChildTree(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let killer: ReturnType<typeof spawn>;
      try {
        killer = spawn(
          windowsSystemExecutable("taskkill.exe"),
          ["/pid", String(child.pid), "/T", "/F"],
          {
            env: process.env,
            shell: false,
            stdio: "ignore",
            windowsHide: true,
          },
        );
      } catch {
        child.kill("SIGKILL");
        resolve();
        return;
      }
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
      killer.once("close", (code) => {
        if (code !== 0) child.kill("SIGKILL");
        resolve();
      });
    });
    return;
  }
  const processGroup = -child.pid;
  try {
    process.kill(processGroup, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processGroup, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  try {
    process.kill(processGroup, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function runChild(
  executable: string,
  args: readonly string[],
  cancellation: Promise<void>,
  scriptInput?: string,
): Promise<number> {
  const child = spawn(executable, [...args], {
    detached: process.platform !== "win32",
    env: process.env,
    shell: false,
    stdio: [
      "ignore",
      "inherit",
      "inherit",
      ...(scriptInput === undefined ? [] : (["pipe"] as const)),
    ],
    windowsHide: true,
  });
  if (scriptInput !== undefined) {
    const input = child.stdio[3] as Writable | null | undefined;
    if (!input) {
      child.kill("SIGKILL");
      fail("the command input was unavailable");
    }
    input.on("error", () => {
      // A short-lived command may close its script input early.
    });
    input.end(scriptInput);
  }
  let active = true;
  let termination: Promise<void> | undefined;
  const requestTermination = () => {
    if (!active || termination) return;
    termination = terminateChildTree(child);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, requestTermination);
  }
  void cancellation.then(requestTermination);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve(code ?? (signal ? 128 : 1));
      });
    });
  } finally {
    active = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.removeListener(signal, requestTermination);
    }
    // A shell may exit successfully after starting ordinary background
    // descendants. Drain the original POSIX process group before reporting
    // completion so those descendants do not outlive the task.
    if (!termination && process.platform !== "win32") {
      termination = terminateChildTree(child);
    }
    if (termination) await termination;
  }
}

async function main(): Promise<void> {
  const config = parseConfig();
  verifyInheritedRoot(config);
  const cancellation = cancellationChannel();

  try {
    if (config.mode === "git") {
      const args = config.gitArguments;
      if (
        !isSerializedTrustedGitExecutable(config.trustedGit) ||
        !Array.isArray(args) ||
        args.length > 512 ||
        args.some(
          (argument) =>
            typeof argument !== "string" ||
            argument.length > 8_192 ||
            /[\u0000\r\n]/.test(argument),
        )
      ) {
        fail("Git arguments were invalid");
      }
      let executable: string;
      try {
        executable = assertSerializedTrustedGitExecutable(config.trustedGit);
      } catch {
        fail("the trusted Git executable identity changed");
      }
      process.exitCode = await runChild(
        executable,
        args,
        cancellation.requested,
      );
      return;
    }

    const command = readDescriptor(4, MAX_COMMAND_BYTES);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
      fail("the command contained unsafe control characters");
    }
    if (config.mode === "shell-posix") {
      if (process.platform === "darwin") {
        const profile = config.macOsSandboxProfile;
        if (
          typeof profile !== "string" ||
          profile.length > MAX_CONFIG_BYTES ||
          !existsSync("/usr/bin/sandbox-exec")
        ) {
          fail("the macOS sandbox contract was unavailable");
        }
        process.exitCode = await runChild(
          "/usr/bin/sandbox-exec",
          ["-p", profile, "/bin/sh", "-c", POSIX_SHELL_BOOTSTRAP],
          cancellation.requested,
          `${command}\n`,
        );
        return;
      }
      process.exitCode = await runChild(
        "/bin/sh",
        ["-c", POSIX_SHELL_BOOTSTRAP],
        cancellation.requested,
        `${command}\n`,
      );
      return;
    }

    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(tmpdir(), "krater-pro-terminal-"));
      const scriptPath = join(directory, "command.cmd");
      const descriptor = openSync(
        scriptPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeFileSync(
          descriptor,
          `@chcp 65001 >nul\r\n${command}\r\n`,
          { encoding: "utf8" },
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const details = lstatSync(scriptPath);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        basename(scriptPath).toLowerCase() !== "command.cmd"
      ) {
        fail("the Windows command script was unsafe");
      }
      process.exitCode = await runChild(
        windowsSystemExecutable("cmd.exe"),
        ["/d", "/q", "/c", scriptPath],
        cancellation.requested,
      );
    } finally {
      if (directory) {
        try {
          rmSync(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        } catch {
          fail("its private Windows command directory could not be removed");
        }
      }
    }
  } finally {
    cancellation.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  writeSync(
    2,
    `Krater command gate refused execution: ${message}\n`,
  );
  process.exitCode = 126;
}
