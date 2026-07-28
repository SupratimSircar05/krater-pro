export const SANDBOX_PLATFORMS = ["darwin", "linux", "win32"] as const;

export type SandboxPlatform = (typeof SANDBOX_PLATFORMS)[number];

export type PlatformContainmentPrimitive =
  | "macos_sandbox_profile"
  | "macos_process_limits"
  | "linux_namespaces"
  | "linux_seccomp"
  | "linux_cgroups"
  | "windows_restricted_token"
  | "windows_job_object";

export interface SandboxControlCapabilities {
  filesystemBoundary: boolean;
  processIsolation: boolean;
  networkDeny: boolean;
  networkAllowlist: boolean;
  cpuLimit: boolean;
  memoryLimit: boolean;
  wallTimeLimit: boolean;
  processCountLimit: boolean;
  outputLimit: boolean;
}

export interface PlatformCapabilityReport {
  platform: SandboxPlatform | "unsupported";
  verification: "unverified" | "verified";
  availability: "available" | "unavailable";
  expectedPrimitives: readonly PlatformContainmentPrimitive[];
  verifiedPrimitives: readonly PlatformContainmentPrimitive[];
  controls: Readonly<SandboxControlCapabilities>;
  adapterId?: string;
  supportsApprovedUncontainedExecution: boolean;
  reason: string;
  verifiedAt?: string;
}

export interface CommandCapabilityRequest {
  kind: "command";
  executable: string;
  arguments: readonly string[];
  /** Argument indexes that must never be copied into receipts or diagnostics. */
  sensitiveArgumentIndexes?: readonly number[];
  workingDirectory: string;
  environmentKeys?: readonly string[];
  reason: string;
}

export interface ResourceCapabilityRequest {
  kind: "resource";
  access: "read" | "write" | "read_write" | "deny";
  paths: readonly string[];
  reason: string;
}

export interface NetworkDestination {
  host: string;
  ports?: readonly number[];
  protocol?: "tcp" | "udp";
}

export type NetworkCapabilityRequest =
  | {
      kind: "network";
      policy: "deny";
      destinations?: never;
      reason: string;
    }
  | {
      kind: "network";
      policy: "allowlist";
      destinations: readonly NetworkDestination[];
      reason: string;
    };

export interface SandboxResourceLimits {
  cpuTimeMs: number;
  memoryBytes: number;
  wallTimeMs: number;
  processCount: number;
  outputBytes: number;
}

export interface SandboxExecutionRequest {
  id?: string;
  mode: "attended" | "unattended";
  command: CommandCapabilityRequest;
  resources: readonly ResourceCapabilityRequest[];
  network: NetworkCapabilityRequest;
  limits: SandboxResourceLimits;
  approval?: PerCommandApproval;
}

export interface PerCommandApproval {
  requestDigest: `sha256:${string}`;
  issuedBy: "user";
  issuedAt: string;
  expiresAt: string;
}

export type SandboxPlan =
  | {
      decision: "ready";
      executionId: string;
      containment: "secure" | "approved_uncontained";
      requestDigest: `sha256:${string}`;
      capabilityReport: PlatformCapabilityReport;
    }
  | {
      decision: "approval_required";
      executionId: string;
      requestDigest: `sha256:${string}`;
      capabilityReport: PlatformCapabilityReport;
      reason: string;
    }
  | {
      decision: "refused";
      executionId: string;
      requestDigest: `sha256:${string}`;
      capabilityReport: PlatformCapabilityReport;
      reason: string;
    };

export interface NativeOutputChunk {
  stream: "stdout" | "stderr";
  data: Uint8Array | string;
}

export type NativeTerminationReason =
  | "exit"
  | "cpu_limit"
  | "memory_limit"
  | "wall_time"
  | "process_limit"
  | "output_limit"
  | "cancelled";

export interface NativeResourceUsage {
  cpuTimeMs?: number;
  peakMemoryBytes?: number;
  peakProcessCount?: number;
}

export interface NativeAdapterExecutionRequest {
  executionId: string;
  containment: "secure" | "approved_uncontained";
  command: CommandCapabilityRequest;
  resources: readonly ResourceCapabilityRequest[];
  network: NetworkCapabilityRequest;
  limits: SandboxResourceLimits;
}

export interface NativeAdapterExecutionResult {
  exitCode: number | null;
  signal?: string;
  terminationReason: NativeTerminationReason;
  output: readonly NativeOutputChunk[];
  outputBytesObserved?: number;
  resourceUsage?: NativeResourceUsage;
}

/**
 * A native adapter is the only component allowed to claim OS containment.
 * Implementations must configure the named platform primitives before starting
 * the child and enforce every advertised control inside the native boundary.
 */
export interface NativeSandboxAdapter {
  readonly id: string;
  probe(platform: NodeJS.Platform): Promise<PlatformCapabilityReport>;
  run(
    request: NativeAdapterExecutionRequest,
  ): Promise<NativeAdapterExecutionResult>;
  cancel(
    executionId: string,
    reason: "wall_time" | "supervisor_cancelled",
  ): Promise<void>;
}

export interface BoundedProcessOutput {
  stdout: string;
  stderr: string;
  capturedBytes: number;
  observedBytes: number;
  truncated: boolean;
  sha256: `sha256:${string}`;
}

export type SandboxExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "resource_limited"
  | "approval_required"
  | "refused"
  | "adapter_error";

export interface SandboxExecutionReceipt {
  schemaVersion: 1;
  executionId: string;
  requestDigest: `sha256:${string}`;
  status: SandboxExecutionStatus;
  containment: "secure" | "approved_uncontained" | "none";
  capabilityReport: PlatformCapabilityReport;
  command: {
    executable: string;
    /** Sensitive arguments are replaced with `[REDACTED]`. */
    arguments: readonly string[];
    workingDirectory: string;
  };
  networkPolicy: NetworkCapabilityRequest["policy"];
  limits: SandboxResourceLimits;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal?: string;
  terminationReason?: NativeTerminationReason;
  output: BoundedProcessOutput;
  resourceUsage?: NativeResourceUsage;
  reason?: string;
}

export interface SandboxSupervisorOptions {
  adapter?: NativeSandboxAdapter;
  platform?: NodeJS.Platform;
  now?: () => Date;
  createExecutionId?: () => string;
}
