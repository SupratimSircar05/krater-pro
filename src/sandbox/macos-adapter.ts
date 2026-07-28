import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  generateMacOsSandboxProfile,
  type MacOsProfilePath,
} from "./macos-profile.js";
import { unverifiedPlatformCapabilities } from "./platform.js";
import type {
  NativeAdapterExecutionRequest,
  NativeAdapterExecutionResult,
  NativeOutputChunk,
  NativeSandboxAdapter,
  NativeTerminationReason,
  PlatformCapabilityReport,
  ResourceCapabilityRequest,
} from "./types.js";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const LIMIT_SHELL = "/bin/zsh";
const LIMIT_SETUP_MARKER = "KRATER_SANDBOX_LIMIT_SETUP_FAILED";
const LIMIT_SCRIPT = [
  'limit cputime "$1" || { print -u2 -- "' + LIMIT_SETUP_MARKER + '"; exit 125; }',
  'limit -h cputime "$1" || { print -u2 -- "' + LIMIT_SETUP_MARKER + '"; exit 125; }',
  'limit addressspace "$2" || { print -u2 -- "' + LIMIT_SETUP_MARKER + '"; exit 125; }',
  'limit -h addressspace "$2" || { print -u2 -- "' + LIMIT_SETUP_MARKER + '"; exit 125; }',
  "shift 2",
  'exec "$@"',
].join("; ");

const SAFE_DEFAULT_PATH = "/usr/bin:/bin";
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:authorization|credential|password|secret|token|api[_-]?key)/i;

interface PreparedExecution {
  executable: string;
  workingDirectory: string;
  readable: readonly MacOsProfilePath[];
  writable: readonly MacOsProfilePath[];
  denied: readonly MacOsProfilePath[];
}

interface ActiveExecution {
  child: ChildProcess;
  requestedTermination?: "wall_time" | "output_limit" | "cancelled";
  forceTimer?: NodeJS.Timeout;
}

export interface MacOsSandboxAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function unavailableReport(reason: string): PlatformCapabilityReport {
  return {
    ...unverifiedPlatformCapabilities("darwin"),
    adapterId: "macos-seatbelt-v1",
    reason,
  };
}

function verifiedReport(now: Date): PlatformCapabilityReport {
  return {
    platform: "darwin",
    verification: "verified",
    availability: "available",
    expectedPrimitives: ["macos_sandbox_profile", "macos_process_limits"],
    verifiedPrimitives: ["macos_sandbox_profile", "macos_process_limits"],
    controls: {
      filesystemBoundary: true,
      processIsolation: true,
      networkDeny: true,
      networkAllowlist: false,
      cpuLimit: true,
      memoryLimit: true,
      wallTimeLimit: true,
      processCountLimit: true,
      outputLimit: true,
    },
    adapterId: "macos-seatbelt-v1",
    supportsApprovedUncontainedExecution: false,
    reason:
      "Verified macOS Seatbelt file/network/no-fork policy, kernel CPU/address-space limits, and bounded wall-time/output supervision. Exact network allowlists are unavailable.",
    verifiedAt: now.toISOString(),
  };
}

async function pathKind(path: string): Promise<MacOsProfilePath["kind"]> {
  return (await stat(path)).isDirectory() ? "directory" : "file";
}

async function canonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\0\r\n\u2028\u2029]/u.test(path)) {
    throw new Error("Sandbox paths must be absolute and single-line.");
  }
  return realpath(path);
}

async function prepareResources(
  command: NativeAdapterExecutionRequest["command"],
  resources: readonly ResourceCapabilityRequest[],
): Promise<PreparedExecution> {
  const executable = await canonicalPath(command.executable);
  const workingDirectory = await canonicalPath(command.workingDirectory);
  if (!(await stat(workingDirectory)).isDirectory()) {
    throw new Error("Sandbox working directory must be an existing directory.");
  }

  const readable: MacOsProfilePath[] = [];
  const writable: MacOsProfilePath[] = [];
  const denied: MacOsProfilePath[] = [];
  for (const resource of resources) {
    for (const requestedPath of resource.paths) {
      const path = await canonicalPath(requestedPath);
      const prepared = { path, kind: await pathKind(path) };
      if (resource.access === "read" || resource.access === "read_write") {
        readable.push(prepared);
      }
      if (resource.access === "write" || resource.access === "read_write") {
        writable.push(prepared);
      }
      if (resource.access === "deny") {
        denied.push(prepared);
      }
    }
  }

  const workingDirectoryReadable = readable.some(({ path, kind }) =>
    kind === "directory"
      ? within(path, workingDirectory)
      : path === workingDirectory,
  );
  if (!workingDirectoryReadable) {
    throw new Error(
      "Sandbox working directory must be inside an explicitly readable resource.",
    );
  }

  return { executable, workingDirectory, readable, writable, denied };
}

function safeEnvironment(
  requestedKeys: readonly string[] | undefined,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: SAFE_DEFAULT_PATH };
  for (const key of requestedKeys ?? []) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(key)) {
      throw new Error(
        `Sensitive environment variable ${key} requires a host-side handle and cannot enter a sandboxed command.`,
      );
    }
    const value = source[key];
    if (value === undefined) continue;
    if (value.includes("\0")) {
      throw new Error(`Environment variable ${key} contains an invalid value.`);
    }
    environment[key] = value;
  }
  return environment;
}

function assertNoSensitiveProcessArguments(
  command: NativeAdapterExecutionRequest["command"],
): void {
  const marked = new Set(command.sensitiveArgumentIndexes ?? []);
  let followsSecretFlag = false;
  for (const [index, argument] of command.arguments.entries()) {
    const secretFlag =
      /^--?(?:api[-_]?key|authorization|credential|password|secret|token)$/i.test(
        argument,
      );
    const inlineSecret =
      /^--?(?:api[-_]?key|authorization|credential|password|secret|token)=/i.test(
        argument,
      ) || /\b(?:Bearer|Basic)\s+\S+/i.test(argument);
    if (marked.has(index) || followsSecretFlag || inlineSecret) {
      throw new Error(
        "Sensitive values cannot be placed in process arguments; use a host-side credential handle.",
      );
    }
    followsSecretFlag = secretFlag;
  }
}

function killProcessGroup(
  execution: ActiveExecution,
  signal: NodeJS.Signals,
): void {
  const pid = execution.child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      execution.child.kill(signal);
    } catch {
      // A concurrent exit is expected and does not weaken containment.
    }
  }
}

async function runProbeCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs = 2_000,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: { PATH: SAFE_DEFAULT_PATH },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("Native sandbox verification timed out."));
      }
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, signal });
    });
  });
}

async function verifyNativeControls(): Promise<void> {
  await Promise.all([
    access(SANDBOX_EXECUTABLE, fsConstants.X_OK),
    access(LIMIT_SHELL, fsConstants.X_OK),
    access(process.execPath, fsConstants.X_OK),
  ]);

  const profile = generateMacOsSandboxProfile({
    executable: process.execPath,
    shellExecutable: LIMIT_SHELL,
    workingDirectory: process.cwd(),
    readable: [
      { path: process.cwd(), kind: "directory" },
      { path: process.execPath, kind: "file" },
    ],
    writable: [],
  });
  const deniedReadProgram = [
    'const fs = require("node:fs");',
    'try { fs.readFileSync("/etc/hosts"); process.exit(9); }',
    'catch (error) { process.exit(error && error.code === "EPERM" ? 0 : 8); }',
  ].join(" ");
  const deniedNetworkProgram = [
    'const socket = require("node:net").connect(9, "127.0.0.1");',
    'socket.once("connect", () => process.exit(9));',
    'socket.once("error", error => process.exit(error.code === "EPERM" ? 0 : 8));',
  ].join(" ");

  const readProbe = await runProbeCommand(SANDBOX_EXECUTABLE, [
    "-p",
    profile,
    process.execPath,
    "-e",
    deniedReadProgram,
  ]);
  if (readProbe.exitCode !== 0) {
    throw new Error("Seatbelt did not prove undeclared-file denial.");
  }

  const networkProbe = await runProbeCommand(SANDBOX_EXECUTABLE, [
    "-p",
    profile,
    process.execPath,
    "-e",
    deniedNetworkProgram,
  ]);
  if (networkProbe.exitCode !== 0) {
    throw new Error("Seatbelt did not prove outbound-network denial.");
  }

  const forkProbe = await runProbeCommand(SANDBOX_EXECUTABLE, [
    "-p",
    profile,
    LIMIT_SHELL,
    "-f",
    "-c",
    "/bin/zsh -f -c 'exit 0' & wait",
  ]);
  if (forkProbe.exitCode === 0) {
    throw new Error("Seatbelt did not prove child-process denial.");
  }

  const limitProbe = await runProbeCommand(SANDBOX_EXECUTABLE, [
    "-p",
    profile,
    LIMIT_SHELL,
    "-f",
    "-c",
    "limit cputime 1 && limit -h cputime 1 && " +
      "limit addressspace 262144k && limit -h addressspace 262144k && exit 0",
  ]);
  if (limitProbe.exitCode !== 0) {
    throw new Error("Kernel CPU/address-space limits could not be installed.");
  }
}

/**
 * A deliberately narrow native adapter for macOS. It has no uncontained
 * fallback and never claims hostname allowlisting. Linux and Windows remain
 * unavailable until their native primitives have equivalent executable
 * verification.
 */
export class MacOsSandboxAdapter implements NativeSandboxAdapter {
  readonly id = "macos-seatbelt-v1";
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveExecution>();
  #probePromise?: Promise<PlatformCapabilityReport>;

  constructor(options: MacOsSandboxAdapterOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? (() => new Date());
  }

  async probe(platform: NodeJS.Platform): Promise<PlatformCapabilityReport> {
    if (platform !== "darwin" || process.platform !== "darwin") {
      return {
        ...unverifiedPlatformCapabilities(platform),
        adapterId: this.id,
        reason:
          platform === "darwin"
            ? "The macOS adapter cannot be verified from a non-macOS host."
            : `The macOS adapter does not implement ${platform} containment.`,
      };
    }
    this.#probePromise ??= verifyNativeControls()
      .then(() => verifiedReport(this.#now()))
      .catch((error: unknown) =>
        unavailableReport(
          `macOS native containment verification failed: ${
            error instanceof Error ? error.message : "unknown failure"
          }`,
        ),
      );
    return this.#probePromise;
  }

  async run(
    request: NativeAdapterExecutionRequest,
  ): Promise<NativeAdapterExecutionResult> {
    if (request.containment !== "secure") {
      throw new Error("The macOS adapter never executes uncontained commands.");
    }
    if (request.network.policy !== "deny") {
      throw new Error(
        "Exact network allowlists are unavailable on the macOS Seatbelt adapter.",
      );
    }
    const capabilityReport = await this.probe("darwin");
    if (
      capabilityReport.verification !== "verified" ||
      capabilityReport.availability !== "available"
    ) {
      throw new Error(capabilityReport.reason);
    }

    assertNoSensitiveProcessArguments(request.command);
    const prepared = await prepareResources(request.command, request.resources);
    const profile = generateMacOsSandboxProfile({
      executable: prepared.executable,
      shellExecutable: LIMIT_SHELL,
      workingDirectory: prepared.workingDirectory,
      readable: prepared.readable,
      writable: prepared.writable,
      denied: prepared.denied,
    });
    const cpuSeconds = Math.floor(request.limits.cpuTimeMs / 1_000);
    const memoryKibibytes = Math.floor(request.limits.memoryBytes / 1_024);
    const environment = safeEnvironment(
      request.command.environmentKeys,
      this.#environment,
    );

    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        SANDBOX_EXECUTABLE,
        [
          "-p",
          profile,
          LIMIT_SHELL,
          "-f",
          "-c",
          LIMIT_SCRIPT,
          "krater-sandbox",
          String(cpuSeconds),
          `${memoryKibibytes}k`,
          prepared.executable,
          ...request.command.arguments,
        ],
        {
          cwd: prepared.workingDirectory,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      const active: ActiveExecution = { child };
      this.#active.set(request.executionId, active);
      const output: NativeOutputChunk[] = [];
      let observedBytes = 0;
      let capturedBytes = 0;
      let diagnosticStderrTail = "";
      let settled = false;

      const terminate = (
        reason: NonNullable<ActiveExecution["requestedTermination"]>,
      ) => {
        if (active.requestedTermination) return;
        active.requestedTermination = reason;
        killProcessGroup(active, "SIGTERM");
        active.forceTimer = setTimeout(() => {
          killProcessGroup(active, "SIGKILL");
        }, 250);
        active.forceTimer.unref?.();
      };

      const capture = (stream: NativeOutputChunk["stream"], data: Buffer) => {
        observedBytes += data.byteLength;
        if (stream === "stderr") {
          diagnosticStderrTail = (
            diagnosticStderrTail + data.toString("utf8")
          ).slice(-(LIMIT_SETUP_MARKER.length * 2));
        }
        const remaining = request.limits.outputBytes - capturedBytes;
        if (remaining > 0) {
          const captured = data.subarray(0, remaining);
          capturedBytes += captured.byteLength;
          output.push({ stream, data: captured });
        }
        if (observedBytes > request.limits.outputBytes) {
          terminate("output_limit");
        }
      };
      child.stdout.on("data", (data: Buffer) => capture("stdout", data));
      child.stderr.on("data", (data: Buffer) => capture("stderr", data));

      const wallTimer = setTimeout(
        () => terminate("wall_time"),
        request.limits.wallTimeMs,
      );
      wallTimer.unref?.();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        if (active.forceTimer) clearTimeout(active.forceTimer);
        this.#active.delete(request.executionId);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        if (active.forceTimer) clearTimeout(active.forceTimer);
        this.#active.delete(request.executionId);

        if (
          exitCode === 125 &&
          diagnosticStderrTail.includes(LIMIT_SETUP_MARKER)
        ) {
          reject(
            new Error(
              "macOS kernel CPU/address-space limits could not be installed.",
            ),
          );
          return;
        }

        let terminationReason: NativeTerminationReason = "exit";
        if (active.requestedTermination === "wall_time") {
          terminationReason = "wall_time";
        } else if (active.requestedTermination === "output_limit") {
          terminationReason = "output_limit";
        } else if (active.requestedTermination === "cancelled") {
          terminationReason = "cancelled";
        } else if (signal === "SIGXCPU") {
          terminationReason = "cpu_limit";
        }

        resolvePromise({
          exitCode,
          ...(signal ? { signal } : {}),
          terminationReason,
          output,
          outputBytesObserved: observedBytes,
          resourceUsage: { peakProcessCount: 1 },
        });
      });
    });
  }

  async cancel(
    executionId: string,
    reason: "wall_time" | "supervisor_cancelled",
  ): Promise<void> {
    const active = this.#active.get(executionId);
    if (!active) return;
    if (active.requestedTermination) return;
    active.requestedTermination =
      reason === "wall_time" ? "wall_time" : "cancelled";
    killProcessGroup(active, "SIGTERM");
    active.forceTimer = setTimeout(() => {
      killProcessGroup(active, "SIGKILL");
    }, 250);
    active.forceTimer.unref?.();
  }
}

export function createHostNativeSandboxAdapter(
  platform: NodeJS.Platform = process.platform,
  options: MacOsSandboxAdapterOptions = {},
): NativeSandboxAdapter | undefined {
  return platform === "darwin" && process.platform === "darwin"
    ? new MacOsSandboxAdapter(options)
    : undefined;
}
