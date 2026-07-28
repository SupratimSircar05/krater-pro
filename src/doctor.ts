import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ConfigOverrides,
  type KraterConfig,
  loadConfig,
} from "./config.js";
import {
  generateCompletion,
  SUPPORTED_COMPLETION_SHELLS,
} from "./completions.js";
import {
  createHostNativeSandboxAdapter,
  unverifiedPlatformCapabilities,
  type NativeSandboxAdapter,
  type SandboxControlCapabilities,
} from "./sandbox/index.js";
import {
  type CredentialValidator,
  validateKraterCredential,
} from "./setup.js";

export type DoctorCheckStatus = "pass" | "warning" | "fail";
export type DoctorStatus = "ready" | "setup_required" | "issues";

export interface DoctorReport {
  schemaVersion: 1;
  type: "doctor";
  scope: "offline_local_preflight" | "live_credential_verification";
  status: DoctorStatus;
  ok: boolean;
  product: {
    name: "Krater Pro";
    version: string;
  };
  system: {
    platform: NodeJS.Platform;
    architecture: string;
  };
  checks: {
    node: {
      status: DoctorCheckStatus;
      version: string;
      supported: boolean;
      requirement: "^20.19.0 || >=22.12.0";
    };
    workspace: {
      status: DoctorCheckStatus;
      path: string;
      readable: boolean;
      writable: boolean;
    };
    configuration: {
      status: DoctorCheckStatus;
      loaded: boolean;
      endpointOrigin?: string;
      model?: string;
      modelSource?: KraterConfig["modelSource"];
    };
    credential: {
      status: DoctorCheckStatus;
      configured: boolean;
      source: KraterConfig["apiKeySource"] | "unknown";
      verification: "not_attempted" | "verified" | "failed";
      modelCount?: number;
    };
    environmentFile: {
      status: DoctorCheckStatus;
      path: string;
      exists: boolean;
      permissions: "private" | "permissive" | "unknown" | "missing";
      mode?: string;
    };
    git: {
      status: DoctorCheckStatus;
      available: boolean;
      version?: string;
      repository: boolean;
    };
    sandbox: {
      status: DoctorCheckStatus;
      availability: "available" | "unavailable";
      verification: "verified" | "unverified";
      expectedPrimitives: readonly string[];
      controls: Readonly<SandboxControlCapabilities>;
      adapterId?: string;
      reason: string;
    };
    evidenceStorage: {
      status: DoctorCheckStatus;
      proofGraph: "initialized" | "not_initialized";
      proofPatch: "initialized" | "not_initialized";
      verification: "not_attempted";
    };
    completions: {
      status: DoctorCheckStatus;
      ready: boolean;
      shells: readonly ["bash", "zsh", "fish"];
    };
  };
  warnings: string[];
  actions: string[];
}

export interface CommandProbeResult {
  ok: boolean;
  stdout: string;
}

export type CommandProbe = (
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => Promise<CommandProbeResult>;

export interface RunDoctorOptions {
  version: string;
  overrides?: ConfigOverrides;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  probe?: CommandProbe;
  live?: boolean;
  validator?: CredentialValidator;
  nativeSandboxAdapter?: NativeSandboxAdapter | null;
}

function probeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    if (environment[name] !== undefined) safe[name] = environment[name];
  }
  return safe;
}

async function defaultCommandProbe(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandProbeResult> {
  return new Promise((resolveProbe) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: probeEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (result: CommandProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout: "" });
    }, 3_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 4_096) stdout += chunk.slice(0, 4_096 - stdout.length);
    });
    child.once("error", () => finish({ ok: false, stdout: "" }));
    child.once("close", (code) =>
      finish({ ok: code === 0, stdout: stdout.slice(0, 4_096) }),
    );
  });
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major > 22;
}

async function workspaceAccess(cwd: string): Promise<{
  readable: boolean;
  writable: boolean;
}> {
  const readable = await access(cwd, fsConstants.R_OK)
    .then(() => true)
    .catch(() => false);
  const writable = await access(cwd, fsConstants.W_OK)
    .then(() => true)
    .catch(() => false);
  return { readable, writable };
}

async function environmentFileCheck(
  path: string,
  platform: NodeJS.Platform,
): Promise<DoctorReport["checks"]["environmentFile"]> {
  try {
    const stats = await lstat(path);
    if (platform === "win32") {
      return {
        status: "pass",
        path,
        exists: true,
        permissions: "unknown",
      };
    }
    const mode = stats.mode & 0o777;
    const privateToOwner = (mode & 0o077) === 0;
    return {
      status: privateToOwner ? "pass" : "warning",
      path,
      exists: true,
      permissions: privateToOwner ? "private" : "permissive",
      mode: mode.toString(8).padStart(3, "0"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "warning",
        path,
        exists: false,
        permissions: "missing",
      };
    }
    return {
      status: "warning",
      path,
      exists: false,
      permissions: "unknown",
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

function safeGitVersion(output: string): string | undefined {
  const match = /^git version ([A-Za-z0-9._+-]+)(?:\s.*)?$/m.exec(output);
  return match?.[1];
}

export async function runDoctor(
  options: RunDoctorOptions,
): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const cwd = resolve(options.overrides?.cwd ?? process.cwd());
  const probe = options.probe ?? defaultCommandProbe;
  const safeEnvironment = probeEnvironment(environment);
  const nodeSupported = isSupportedNodeVersion(nodeVersion);
  const workspace = await workspaceAccess(cwd);
  const environmentFile = await environmentFileCheck(
    join(cwd, ".env"),
    platform,
  );

  let config: KraterConfig | undefined;
  try {
    config = loadConfig(options.overrides, environment);
  } catch {
    // Doctor intentionally avoids echoing configuration parser errors because a
    // malformed endpoint or environment value may itself contain sensitive data.
  }

  let credentialVerification:
    | { verification: "not_attempted" }
    | { verification: "verified" | "failed"; modelCount: number } = {
    verification: "not_attempted",
  };
  if (options.live && config?.apiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const result = await (
          options.validator ?? validateKraterCredential
        )({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          signal: controller.signal,
        });
        const verified = result.verified === true && result.modelCount > 0;
        credentialVerification = {
          verification: verified ? "verified" : "failed",
          modelCount:
            Number.isSafeInteger(result.modelCount) && result.modelCount >= 0
              ? result.modelCount
              : 0,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      credentialVerification = {
        verification: "failed",
        modelCount: 0,
      };
    }
  }

  const gitVersionProbe = await probe(
    "git",
    ["--version"],
    cwd,
    safeEnvironment,
  );
  const gitVersion = gitVersionProbe.ok
    ? safeGitVersion(gitVersionProbe.stdout)
    : undefined;
  const gitAvailable = gitVersionProbe.ok && Boolean(gitVersion);
  const gitRepositoryProbe = gitAvailable
    ? await probe(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        cwd,
        safeEnvironment,
      )
    : undefined;
  const gitRepository =
    gitRepositoryProbe?.ok === true &&
    gitRepositoryProbe.stdout.trim() === "true";
  const nativeSandboxAdapter =
    options.nativeSandboxAdapter === undefined
      ? createHostNativeSandboxAdapter(platform)
      : options.nativeSandboxAdapter ?? undefined;
  const sandbox = nativeSandboxAdapter
    ? await nativeSandboxAdapter.probe(platform)
    : unverifiedPlatformCapabilities(platform);
  const proofGraphInitialized = await pathExists(
    join(cwd, ".krater", "proofgraph", "events.ndjson"),
  );
  const proofPatchInitialized = await pathExists(
    join(cwd, ".krater", "proofpatch"),
  );
  let completionsReady = true;
  try {
    completionsReady = SUPPORTED_COMPLETION_SHELLS.every((shell) => {
      const generated = generateCompletion(shell);
      return generated.endsWith("\n") && generated.includes("doctor");
    });
  } catch {
    completionsReady = false;
  }

  const warnings: string[] = [];
  const actions: string[] = [];
  if (!nodeSupported) {
    actions.push("Install Node.js 20.19+ or 22.12+ before running Krater Pro.");
  }
  if (!workspace.readable || !workspace.writable) {
    actions.push("Choose a readable and writable workspace.");
  }
  if (!config) {
    actions.push(
      "Review the workspace .env and KRATER_* settings; configuration could not be loaded safely.",
    );
  } else if (!config.apiKey) {
    actions.push("Run `krater setup` to configure a Krater API key.");
  } else if (credentialVerification.verification === "failed") {
    actions.push(
      "Krater model discovery failed. Check API access, network connectivity, and account credits.",
    );
  }
  if (environmentFile.permissions === "permissive") {
    warnings.push(
      "The workspace .env can be read by users other than its owner.",
    );
    actions.push("Restrict the workspace .env permissions to its owner.");
  }
  if (!gitAvailable) {
    warnings.push(
      "Git is unavailable; scratch work still works, but repository workflows do not.",
    );
  }
  if (sandbox.verification !== "verified") {
    warnings.push(
      "Secure native command containment is unverified; unattended commands remain fail-closed.",
    );
  } else if (!sandbox.controls.networkAllowlist) {
    warnings.push(
      "Strict unattended commands use deny-all networking and a one-process ceiling; commands needing network access or subprocesses require an explicit attended approval.",
    );
  }
  if (!completionsReady) {
    actions.push("Reinstall Krater Pro; shell completion generation is unavailable.");
  }

  const hardIssue =
    !nodeSupported ||
    !workspace.readable ||
    !workspace.writable ||
    !config ||
    credentialVerification.verification === "failed" ||
    !completionsReady;
  const status: DoctorStatus = hardIssue
    ? "issues"
    : config?.apiKey
      ? "ready"
      : "setup_required";

  return {
    schemaVersion: 1,
    type: "doctor",
    scope: options.live
      ? "live_credential_verification"
      : "offline_local_preflight",
    status,
    ok: status === "ready",
    product: {
      name: "Krater Pro",
      version: options.version,
    },
    system: {
      platform,
      architecture,
    },
    checks: {
      node: {
        status: nodeSupported ? "pass" : "fail",
        version: nodeVersion,
        supported: nodeSupported,
        requirement: "^20.19.0 || >=22.12.0",
      },
      workspace: {
        status:
          workspace.readable && workspace.writable ? "pass" : "fail",
        path: cwd,
        readable: workspace.readable,
        writable: workspace.writable,
      },
      configuration: {
        status: config ? "pass" : "fail",
        loaded: Boolean(config),
        ...(config
          ? {
              endpointOrigin: new URL(config.baseURL).origin,
              model: config.model,
              modelSource: config.modelSource,
            }
          : {}),
      },
      credential: {
        status:
          credentialVerification.verification === "failed"
            ? "fail"
            : config?.apiKey
              ? "pass"
              : "warning",
        configured: Boolean(config?.apiKey),
        source: config?.apiKeySource ?? "unknown",
        ...credentialVerification,
      },
      environmentFile,
      git: {
        status: gitAvailable ? "pass" : "warning",
        available: gitAvailable,
        ...(gitVersion ? { version: gitVersion } : {}),
        repository: gitRepository,
      },
      sandbox: {
        status:
          sandbox.verification === "verified" &&
          sandbox.availability === "available"
            ? "pass"
            : "warning",
        availability: sandbox.availability,
        verification: sandbox.verification,
        expectedPrimitives: sandbox.expectedPrimitives,
        controls: sandbox.controls,
        ...(sandbox.adapterId ? { adapterId: sandbox.adapterId } : {}),
        reason: sandbox.reason,
      },
      evidenceStorage: {
        status: workspace.readable && workspace.writable ? "pass" : "fail",
        proofGraph: proofGraphInitialized
          ? "initialized"
          : "not_initialized",
        proofPatch: proofPatchInitialized
          ? "initialized"
          : "not_initialized",
        verification: "not_attempted",
      },
      completions: {
        status: completionsReady ? "pass" : "fail",
        ready: completionsReady,
        shells: SUPPORTED_COMPLETION_SHELLS,
      },
    },
    warnings,
    actions: [...new Set(actions)],
  };
}

export function doctorExitCode(report: DoctorReport): number {
  if (report.status === "ready") return 0;
  if (report.status === "setup_required") return 4;
  return 1;
}

export function renderDoctorReport(
  report: DoctorReport,
  json = false,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    `Krater Pro doctor v${report.product.version}`,
    report.scope === "live_credential_verification"
      ? "Scope: local preflight plus explicit authenticated model discovery"
      : "Scope: offline local preflight (no API or evidence-artifact validation)",
    `[${report.checks.node.status}] Node ${report.checks.node.version} (${report.checks.node.requirement})`,
    `[${report.checks.workspace.status}] Workspace ${report.checks.workspace.path}`,
    report.checks.credential.configured
      ? `[${report.checks.credential.status}] Credential configured, ${
          report.checks.credential.verification === "verified"
            ? `live-verified (${report.checks.credential.modelCount ?? 0} model(s))`
            : report.checks.credential.verification === "failed"
              ? "live verification failed"
              : "unverified"
        } (${report.checks.credential.source})`
      : `[${report.checks.credential.status}] Credential not configured`,
    `[${report.checks.environmentFile.status}] .env ${report.checks.environmentFile.permissions}`,
    report.checks.git.available
      ? `[${report.checks.git.status}] Git ${report.checks.git.version}${report.checks.git.repository ? " (repository)" : ""}`
      : `[${report.checks.git.status}] Git unavailable`,
    `[${report.checks.sandbox.status}] Sandbox ${report.checks.sandbox.verification}: ${report.checks.sandbox.reason}`,
    `[${report.checks.evidenceStorage.status}] Evidence storage ProofGraph=${report.checks.evidenceStorage.proofGraph}, ProofPatch=${report.checks.evidenceStorage.proofPatch} (not verified)`,
    `[${report.checks.completions.status}] Shell completions ${report.checks.completions.ready ? "ready" : "unavailable"}`,
    `Status: ${report.status}`,
  ];
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  for (const action of report.actions) lines.push(`Next: ${action}`);
  lines.push("");
  return lines.join("\n");
}
