import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type {
  PerCommandApproval,
  SandboxExecutionRequest,
  SandboxResourceLimits,
} from "./types.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function sandboxRequestDigest(
  request: SandboxExecutionRequest,
): `sha256:${string}` {
  const { approval: _approval, id: _id, ...proofObligations } = request;
  const serialized = JSON.stringify(canonicalize(proofObligations));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function validateApproval(
  approval: PerCommandApproval | undefined,
  requestDigest: `sha256:${string}`,
  now: Date,
): { valid: true } | { valid: false; reason: string } {
  if (!approval) {
    return { valid: false, reason: "An exact per-command user approval is required." };
  }
  if (approval.issuedBy !== "user") {
    return { valid: false, reason: "Only a user can approve uncontained execution." };
  }
  if (approval.requestDigest !== requestDigest) {
    return {
      valid: false,
      reason: "The approval does not match this exact command and capability request.",
    };
  }
  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "The approval has invalid timestamps." };
  }
  if (issuedAt > now.getTime()) {
    return { valid: false, reason: "The approval is not valid yet." };
  }
  if (expiresAt <= now.getTime() || expiresAt <= issuedAt) {
    return { valid: false, reason: "The approval has expired." };
  }
  if (expiresAt - issuedAt > 60 * 60 * 1_000) {
    return {
      valid: false,
      reason: "Per-command approval may not be valid for longer than one hour.",
    };
  }
  return { valid: true };
}

export function validateSandboxLimits(limits: SandboxResourceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Sandbox limit ${name} must be a positive safe integer.`);
    }
  }
}

export function validateSandboxRequest(request: SandboxExecutionRequest): void {
  validateSandboxLimits(request.limits);
  if (!request.command.executable.trim()) {
    throw new Error("Sandbox command executable must not be empty.");
  }
  if (!isExactAbsolutePath(request.command.executable)) {
    throw new Error(
      "Sandbox command executable must be an exact absolute path without wildcards.",
    );
  }
  if (!request.command.workingDirectory.trim()) {
    throw new Error("Sandbox command working directory must not be empty.");
  }
  if (!isExactAbsolutePath(request.command.workingDirectory)) {
    throw new Error(
      "Sandbox command working directory must be an exact absolute path without wildcards.",
    );
  }
  if (!request.command.reason.trim()) {
    throw new Error("Sandbox command capability requires a reason.");
  }
  if (
    request.command.sensitiveArgumentIndexes?.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= request.command.arguments.length,
    )
  ) {
    throw new Error("Sensitive command argument indexes must refer to exact arguments.");
  }
  if (
    request.command.environmentKeys?.some(
      (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    )
  ) {
    throw new Error("Sandbox environment capabilities require exact variable names.");
  }
  for (const resource of request.resources) {
    if (
      resource.paths.length === 0 ||
      resource.paths.some((path) => !isExactAbsolutePath(path))
    ) {
      throw new Error("Sandbox resource capabilities require exact non-empty paths.");
    }
    if (!resource.reason.trim()) {
      throw new Error("Sandbox resource capabilities require a reason.");
    }
  }
  if (
    request.network.policy === "allowlist" &&
    (request.network.destinations.length === 0 ||
      request.network.destinations.some(
        (destination) =>
          !isExactHost(destination.host) ||
          destination.ports?.some(
            (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
          ),
      ))
  ) {
    throw new Error("Network allowlist capabilities require exact destinations.");
  }
  if (!request.network.reason.trim()) {
    throw new Error("Sandbox network capability requires a reason.");
  }
}

function isExactAbsolutePath(value: string): boolean {
  const path = value.trim();
  return (
    path === value &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(path) &&
    !/[*?[\]{}]/.test(path) &&
    (posix.isAbsolute(path) || win32.isAbsolute(path))
  );
}

function isExactHost(value: string): boolean {
  const host = value.trim();
  return (
    host === value &&
    host.length > 0 &&
    !host.includes("\0") &&
    !/[\s*/?[\]{}]/.test(host) &&
    !host.includes("://") &&
    !host.includes("/")
  );
}
