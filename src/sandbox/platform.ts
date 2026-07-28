import type {
  PlatformCapabilityReport,
  PlatformContainmentPrimitive,
  SandboxControlCapabilities,
  SandboxExecutionRequest,
} from "./types.js";

const NO_CONTROLS: Readonly<SandboxControlCapabilities> = Object.freeze({
  filesystemBoundary: false,
  processIsolation: false,
  networkDeny: false,
  networkAllowlist: false,
  cpuLimit: false,
  memoryLimit: false,
  wallTimeLimit: false,
  processCountLimit: false,
  outputLimit: false,
});

export function platformContainmentPrimitives(
  platform: NodeJS.Platform,
): readonly PlatformContainmentPrimitive[] {
  switch (platform) {
    case "darwin":
      return ["macos_sandbox_profile", "macos_process_limits"];
    case "linux":
      return ["linux_namespaces", "linux_seccomp", "linux_cgroups"];
    case "win32":
      return ["windows_restricted_token", "windows_job_object"];
    default:
      return [];
  }
}

/**
 * Describes what a platform adapter would need to prove. Detection in plain
 * Node is intentionally never treated as verified secure containment.
 */
export function unverifiedPlatformCapabilities(
  platform: NodeJS.Platform = process.platform,
): PlatformCapabilityReport {
  const supported =
    platform === "darwin" || platform === "linux" || platform === "win32";
  return {
    platform: supported ? platform : "unsupported",
    verification: "unverified",
    availability: "unavailable",
    expectedPrimitives: platformContainmentPrimitives(platform),
    verifiedPrimitives: [],
    controls: NO_CONTROLS,
    supportsApprovedUncontainedExecution: false,
    reason: supported
      ? "No native adapter has verified and configured this platform's containment primitives."
      : `Platform ${platform} has no Krater sandbox contract.`,
  };
}

export interface CapabilityValidation {
  secure: boolean;
  missingControls: readonly (keyof SandboxControlCapabilities)[];
  reason: string;
}

export function validateSecureContainment(
  report: PlatformCapabilityReport,
  request: SandboxExecutionRequest,
): CapabilityValidation {
  const required: (keyof SandboxControlCapabilities)[] = [
    "filesystemBoundary",
    "processIsolation",
    "cpuLimit",
    "memoryLimit",
    "wallTimeLimit",
    "processCountLimit",
    "outputLimit",
    request.network.policy === "deny" ? "networkDeny" : "networkAllowlist",
  ];
  const missingControls = required.filter((control) => !report.controls[control]);
  const canonicalPrimitives =
    report.platform === "unsupported"
      ? []
      : platformContainmentPrimitives(report.platform);
  const primitivesVerified =
    canonicalPrimitives.length > 0 &&
    canonicalPrimitives.every((primitive) =>
      report.verifiedPrimitives.includes(primitive),
    );
  const verificationTimestamp = report.verifiedAt
    ? Date.parse(report.verifiedAt)
    : Number.NaN;
  const secure =
    report.platform !== "unsupported" &&
    report.verification === "verified" &&
    report.availability === "available" &&
    Boolean(report.adapterId) &&
    Number.isFinite(verificationTimestamp) &&
    primitivesVerified &&
    missingControls.length === 0;

  let reason = "Native containment is verified for this request.";
  if (report.platform === "unsupported") {
    reason = report.reason;
  } else if (report.verification !== "verified") {
    reason = "Containment has not been verified by a native adapter.";
  } else if (report.availability !== "available") {
    reason = report.reason;
  } else if (!report.adapterId || !Number.isFinite(verificationTimestamp)) {
    reason = "The adapter did not provide verifiable probe identity and time.";
  } else if (!primitivesVerified) {
    reason = "The adapter did not verify every required platform primitive.";
  } else if (missingControls.length > 0) {
    reason = `The adapter cannot enforce: ${missingControls.join(", ")}.`;
  }

  return { secure, missingControls, reason };
}
