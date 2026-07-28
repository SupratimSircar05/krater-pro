import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  SandboxSupervisor,
  createHostNativeSandboxAdapter,
  type NativeSandboxAdapter,
  type PlatformCapabilityReport,
  type SandboxExecutionReceipt,
} from "../sandbox/index.js";
import type {
  ProcessExecution,
  ProcessInvocation,
  ProcessRunContext,
  ProcessRunner,
  ProcessRunnerRequest,
} from "./types.js";

const MAX_LIVE_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_LIVE_OUTPUT_BYTES_PER_STREAM = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:authorization|credential|password|secret|token|api[_-]?key)/i;
const SENSITIVE_ARGUMENT_NAME =
  /^--?(?:api[-_]?key|authorization|credential|password|secret|token)(?:=|$)/i;
const CREDENTIAL_SHAPE =
  /\b(?:Bearer|Basic)\s+\S+|\b(?:sk|pk|kr|ghp|github_pat)[_-][A-Za-z0-9_-]{16,}\b/i;
const PRIVATE_RELATIVE_PATHS = [
  ".env",
  ".env.local",
  ".git",
  ".krater",
  ".npmrc",
  ".pypirc",
  ".netrc",
] as const;

export class LiveCausalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCausalValidationError";
  }
}

export class LiveCausalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCausalUnavailableError";
  }
}

export interface LiveCausalProcessRunnerOptions {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  pythonExecutable?: string;
  knownSecrets?: readonly string[];
  adapterFactory?: (
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
  ) => NativeSandboxAdapter | undefined;
}

export interface LiveCausalExecutionSummary {
  executionCount: number;
  containment: "secure";
  adapterId: string;
  platform: string;
  requestDigests: readonly `sha256:${string}`[];
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function exactRelativePath(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /[\u0000-\u001f\u007f\u2028\u2029*?[\]{}]/u.test(value)
  ) {
    throw new LiveCausalValidationError(
      `${label} must be an exact workspace-relative path.`,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw new LiveCausalValidationError(
      `${label} must not contain empty, current-directory, or traversal segments.`,
    );
  }
  return segments.join(sep);
}

async function resolveWorkspacePath(
  root: string,
  value: string,
  label: string,
  kind: "file" | "directory",
): Promise<string> {
  const relativePath =
    kind === "directory" && value === "."
      ? ""
      : exactRelativePath(value, label);
  const requested = resolve(root, relativePath);
  let physical: string;
  try {
    physical = await realpath(requested);
  } catch {
    throw new LiveCausalValidationError(
      `${label} was not found or is inaccessible.`,
    );
  }
  if (!within(root, physical)) {
    throw new LiveCausalValidationError(
      `${label} resolves outside the selected workspace.`,
    );
  }
  const details = await stat(physical);
  if (
    (kind === "file" && !details.isFile()) ||
    (kind === "directory" && !details.isDirectory())
  ) {
    throw new LiveCausalValidationError(
      `${label} must resolve to an existing ${kind}.`,
    );
  }
  if (kind === "file" && (await lstat(requested)).isSymbolicLink()) {
    throw new LiveCausalValidationError(
      `${label} must not be a symbolic link.`,
    );
  }
  return physical;
}

async function executablePath(
  requested: string | undefined,
  candidates: readonly string[],
  label: string,
): Promise<string> {
  for (const candidate of requested ? [requested] : candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const physical = await realpath(candidate);
      if (!(await stat(physical)).isFile()) continue;
      await access(physical, fsConstants.X_OK);
      return physical;
    } catch {
      // Try the next fixed host-owned candidate.
    }
  }
  throw new LiveCausalUnavailableError(
    `${label} executable is unavailable at the supported absolute locations.`,
  );
}

function safeString(
  value: string,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new LiveCausalValidationError(
      `${label} is invalid or exceeds ${maximumBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

function containsKnownSecret(
  value: string,
  knownSecrets: readonly string[],
): boolean {
  return knownSecrets.some(
    (secret) => secret.length >= 4 && value.includes(secret),
  );
}

function safeArguments(
  values: readonly string[],
  knownSecrets: readonly string[],
): string[] {
  let followsSensitiveName = false;
  return values.map((value, index) => {
    const argument = safeString(
      value,
      `argument ${index + 1}`,
      MAX_ARGUMENT_BYTES,
    );
    if (
      followsSensitiveName ||
      SENSITIVE_ARGUMENT_NAME.test(argument) ||
      CREDENTIAL_SHAPE.test(argument) ||
      containsKnownSecret(argument, knownSecrets)
    ) {
      throw new LiveCausalValidationError(
        "Live causal arguments must not contain credential material; use non-secret experiment inputs.",
      );
    }
    followsSensitiveName =
      /^--?(?:api[-_]?key|authorization|credential|password|secret|token)$/i.test(
        argument,
      );
    return argument;
  });
}

function safeEnvironment(
  values: Readonly<Record<string, string>>,
  runtime: ProcessRunnerRequest["runtime"],
  knownSecrets: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, rawValue] of Object.entries(values)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      SENSITIVE_ENVIRONMENT_NAME.test(name)
    ) {
      throw new LiveCausalValidationError(
        "Live causal environment names must be exact, non-sensitive identifiers.",
      );
    }
    const value = safeString(
      rawValue,
      `environment value for ${name}`,
      MAX_ENVIRONMENT_VALUE_BYTES,
    );
    if (
      CREDENTIAL_SHAPE.test(value) ||
      containsKnownSecret(value, knownSecrets)
    ) {
      throw new LiveCausalValidationError(
        "Live causal environment values must not contain credential material.",
      );
    }
    environment[name] = value;
  }
  if (runtime === "python") {
    environment.PYTHONDONTWRITEBYTECODE = "1";
    environment.PYTHONUNBUFFERED = "1";
  }
  return environment;
}

async function privateDenyPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const relativePath of PRIVATE_RELATIVE_PATHS) {
    const requested = join(root, relativePath);
    try {
      const physical = await realpath(requested);
      if (within(root, physical)) paths.push(physical);
    } catch {
      // A missing private path needs no sandbox rule.
    }
  }
  return [...new Set(paths)].sort();
}

function defaultAdapterFactory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): NativeSandboxAdapter | undefined {
  return createHostNativeSandboxAdapter(platform, { environment });
}

export class LiveCausalProcessRunner implements ProcessRunner {
  readonly #rootPromise: Promise<string>;
  readonly #platform: NodeJS.Platform;
  readonly #nodeExecutable?: string;
  readonly #pythonExecutable?: string;
  readonly #knownSecrets: readonly string[];
  readonly #environmentSource: NodeJS.ProcessEnv = {};
  readonly #adapter: NativeSandboxAdapter | undefined;
  readonly #supervisor: SandboxSupervisor;
  readonly #receipts: SandboxExecutionReceipt[] = [];
  #running = false;

  constructor(options: LiveCausalProcessRunnerOptions) {
    this.#rootPromise = realpath(resolve(options.workspaceRoot));
    this.#platform = options.platform ?? process.platform;
    this.#nodeExecutable = options.nodeExecutable;
    this.#pythonExecutable = options.pythonExecutable;
    this.#knownSecrets = (options.knownSecrets ?? []).filter(Boolean);
    this.#adapter = (
      options.adapterFactory ?? defaultAdapterFactory
    )(this.#platform, this.#environmentSource);
    this.#supervisor = new SandboxSupervisor({
      platform: this.#platform,
      adapter: this.#adapter,
    });
  }

  async assertAvailable(): Promise<PlatformCapabilityReport> {
    const report = await this.#supervisor.capabilities();
    if (
      !this.#adapter ||
      report.verification !== "verified" ||
      report.availability !== "available" ||
      !report.adapterId
    ) {
      throw new LiveCausalUnavailableError(
        `Live causal execution is fail-closed because verified native containment is unavailable: ${report.reason}`,
      );
    }
    return report;
  }

  /**
   * Resolves every caller-supplied invocation before the first process starts,
   * so a later invalid experiment cannot leave a partially executed run.
   */
  async validateInvocations(
    invocations: readonly ProcessInvocation[],
  ): Promise<void> {
    const root = await this.#rootPromise;
    for (const [index, invocation] of invocations.entries()) {
      const label = index === 0 ? "Baseline" : `Experiment ${index}`;
      const workingDirectory = await resolveWorkspacePath(
        root,
        invocation.cwd ?? ".",
        `${label} working directory`,
        "directory",
      );
      if (!within(root, workingDirectory)) {
        throw new LiveCausalValidationError(
          `${label} working directory resolves outside the selected workspace.`,
        );
      }
      const entrypoint = await resolveWorkspacePath(
        root,
        invocation.entrypoint,
        `${label} entrypoint`,
        "file",
      );
      const expectedExtensions =
        invocation.runtime === "node"
          ? [".js", ".cjs", ".mjs"]
          : [".py"];
      if (
        !expectedExtensions.some((extension) =>
          entrypoint.endsWith(extension),
        )
      ) {
        throw new LiveCausalValidationError(
          `${label} ${invocation.runtime} entrypoint has an unsupported file extension.`,
        );
      }
      if (
        invocation.timeoutMs !== undefined &&
        (!Number.isSafeInteger(invocation.timeoutMs) ||
          invocation.timeoutMs < 100 ||
          invocation.timeoutMs > MAX_LIVE_TIMEOUT_MS)
      ) {
        throw new LiveCausalValidationError(
          `${label} timeout must be from 100 to ${MAX_LIVE_TIMEOUT_MS} milliseconds.`,
        );
      }
      safeArguments(invocation.args ?? [], this.#knownSecrets);
      safeEnvironment(
        invocation.environment ?? {},
        invocation.runtime,
        this.#knownSecrets,
      );
      if (invocation.runtime === "node") {
        await executablePath(
          this.#nodeExecutable,
          [process.execPath],
          "Node.js",
        );
      } else {
        await executablePath(
          this.#pythonExecutable,
          [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
          ],
          "Python",
        );
      }
    }
  }

  summary(): LiveCausalExecutionSummary {
    const first = this.#receipts[0];
    if (
      !first ||
      first.containment !== "secure" ||
      !first.capabilityReport.adapterId
    ) {
      throw new LiveCausalUnavailableError(
        "No securely contained causal execution receipt is available.",
      );
    }
    return {
      executionCount: this.#receipts.length,
      containment: "secure",
      adapterId: first.capabilityReport.adapterId,
      platform: first.capabilityReport.platform,
      requestDigests: this.#receipts.map((receipt) => receipt.requestDigest),
    };
  }

  async run(
    request: ProcessRunnerRequest,
    context: ProcessRunContext,
  ): Promise<ProcessExecution> {
    if (this.#running) {
      throw new LiveCausalValidationError(
        "Live causal process execution must be sequential.",
      );
    }
    this.#running = true;
    try {
      if (context.signal?.aborted) {
        throw new LiveCausalValidationError(
          "Live causal execution was cancelled before process start.",
        );
      }
      if (
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs < 100 ||
        request.timeoutMs > MAX_LIVE_TIMEOUT_MS
      ) {
        throw new LiveCausalValidationError(
          `Live causal timeout must be from 100 to ${MAX_LIVE_TIMEOUT_MS} milliseconds.`,
        );
      }
      if (
        !Number.isSafeInteger(request.maxOutputBytesPerStream) ||
        request.maxOutputBytesPerStream < 1 ||
        request.maxOutputBytesPerStream >
          MAX_LIVE_OUTPUT_BYTES_PER_STREAM
      ) {
        throw new LiveCausalValidationError(
          `Live causal output must be bounded from 1 to ${MAX_LIVE_OUTPUT_BYTES_PER_STREAM} bytes per stream.`,
        );
      }

      const root = await this.#rootPromise;
      const workingDirectory = await resolveWorkspacePath(
        root,
        request.cwd ?? ".",
        "Process working directory",
        "directory",
      );
      const entrypoint = await resolveWorkspacePath(
        root,
        request.entrypoint,
        "Process entrypoint",
        "file",
      );
      const expectedExtensions =
        request.runtime === "node"
          ? [".js", ".cjs", ".mjs"]
          : [".py"];
      if (!expectedExtensions.some((extension) => entrypoint.endsWith(extension))) {
        throw new LiveCausalValidationError(
          `The ${request.runtime} entrypoint has an unsupported file extension.`,
        );
      }
      const executable =
        request.runtime === "node"
          ? await executablePath(
              this.#nodeExecutable,
              [process.execPath],
              "Node.js",
            )
          : await executablePath(
              this.#pythonExecutable,
              [
                "/usr/bin/python3",
                "/opt/homebrew/bin/python3",
                "/usr/local/bin/python3",
              ],
              "Python",
            );
      const arguments_ = [
        entrypoint,
        ...safeArguments(request.args, this.#knownSecrets),
      ];
      const environment = safeEnvironment(
        request.environment,
        request.runtime,
        this.#knownSecrets,
      );
      for (const key of Object.keys(this.#environmentSource)) {
        delete this.#environmentSource[key];
      }
      Object.assign(this.#environmentSource, environment);
      const denyPaths = await privateDenyPaths(root);
      const executionId = `causal-${context.planId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48)}-${context.sequence}`;
      const sandboxRequest = {
        id: executionId,
        mode: "unattended" as const,
        command: {
          kind: "command" as const,
          executable,
          arguments: arguments_,
          workingDirectory,
          environmentKeys: Object.keys(environment).sort(),
          reason: `Run the structured ${request.runtime} causal ${context.purpose} invocation.`,
        },
        resources: [
          {
            kind: "resource" as const,
            access: "read" as const,
            paths: [root],
            reason: "Read the immutable caller-selected causal workspace.",
          },
          ...(denyPaths.length
            ? [
                {
                  kind: "resource" as const,
                  access: "deny" as const,
                  paths: denyPaths,
                  reason:
                    "Deny private project state and credential-bearing files.",
                },
              ]
            : []),
        ],
        network: {
          kind: "network" as const,
          policy: "deny" as const,
          reason: "Live causal fixtures require no network access.",
        },
        limits: {
          cpuTimeMs: Math.max(1_000, request.timeoutMs),
          memoryBytes: 512 * 1024 * 1024,
          wallTimeMs: request.timeoutMs,
          processCount: 1,
          outputBytes: Math.min(
            MAX_LIVE_OUTPUT_BYTES_PER_STREAM * 2,
            request.maxOutputBytesPerStream * 2,
          ),
        },
      };

      const cancel = () => {
        void this.#adapter?.cancel(executionId, "supervisor_cancelled");
      };
      context.signal?.addEventListener("abort", cancel, { once: true });
      let receipt: SandboxExecutionReceipt;
      try {
        receipt = await this.#supervisor.execute(sandboxRequest);
      } finally {
        context.signal?.removeEventListener("abort", cancel);
      }
      this.#receipts.push(receipt);
      if (context.signal?.aborted) {
        throw new LiveCausalValidationError(
          "Live causal execution was cancelled.",
        );
      }
      if (
        receipt.status === "refused" ||
        receipt.status === "approval_required"
      ) {
        throw new LiveCausalUnavailableError(
          `Live causal execution is fail-closed: ${receipt.reason ?? "verified containment was unavailable."}`,
        );
      }
      if (receipt.status === "adapter_error") {
        throw new LiveCausalUnavailableError(
          `Verified native causal execution failed: ${receipt.reason ?? "native adapter error."}`,
        );
      }
      return {
        exitCode: receipt.exitCode,
        ...(receipt.signal ? { signal: receipt.signal } : {}),
        stdout: receipt.output.stdout,
        stderr: receipt.output.stderr,
        timedOut: receipt.status === "timed_out",
        durationMs: receipt.durationMs,
      };
    } finally {
      for (const key of Object.keys(this.#environmentSource)) {
        delete this.#environmentSource[key];
      }
      this.#running = false;
    }
  }
}
