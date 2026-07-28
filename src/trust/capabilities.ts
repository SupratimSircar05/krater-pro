import { createHash } from "node:crypto";
import type {
  CapabilityGrant,
  CapabilityGrantInput,
  PolicySimulationRequest,
} from "./types.js";

/**
 * Capability grants are process-local authority objects, not self-authenticating
 * JSON. Keeping the issued object identities private prevents repository data,
 * model output, or an API caller from manufacturing an exceptional grant by
 * copying the public fields (including the deterministic receipt ID).
 *
 * Persistent authority must be re-issued by a host-owned policy loader after it
 * authenticates the user-authored policy. Deserializing JSON is deliberately
 * insufficient.
 */
const ISSUED_GRANTS = new WeakSet<object>();

function exactPart(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.includes("*")) {
    throw new Error(`${label} must be exact; wildcard capabilities are not supported.`);
  }
  return normalized;
}

function capabilityId(input: Omit<CapabilityGrant, "id">): string {
  const canonical = JSON.stringify({
    durationMs: input.durationMs,
    exceptions: {
      licenseRestrictedEgress: input.exceptions.licenseRestrictedEgress === true,
      secretToModel: input.exceptions.secretToModel === true,
      secretToNetwork: input.exceptions.secretToNetwork === true,
      untrustedDataToCommand: input.exceptions.untrustedDataToCommand === true,
    },
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
    issuedBy: input.issuedBy,
    operation: input.operation,
    resource: input.resource,
    scope: input.scope,
  });
  return `cap:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function createCapabilityGrant(input: CapabilityGrantInput): CapabilityGrant {
  if (input.issuedBy !== "user" && input.issuedBy !== "approved_policy") {
    throw new Error("Capability issuer must be the user or an approved policy.");
  }
  const operation = exactPart(input.operation, "Capability operation");
  const resource = exactPart(input.resource, "Capability resource");
  const scope = exactPart(input.scope, "Capability scope");
  const issuedAt = input.issuedAt ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("Capability issue time must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new Error("Capability duration must be a positive safe integer.");
  }
  const expiresAt = issuedAt + input.durationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Capability expiry exceeds the supported timestamp range.");
  }
  const exceptions = input.exceptions ?? {};
  for (const [name, enabled] of Object.entries(exceptions)) {
    if (
      ![
        "untrustedDataToCommand",
        "secretToModel",
        "secretToNetwork",
        "licenseRestrictedEgress",
      ].includes(name) ||
      typeof enabled !== "boolean"
    ) {
      throw new Error(`Capability exception is invalid: ${name}.`);
    }
  }
  const withoutId: Omit<CapabilityGrant, "id"> = {
    operation,
    resource,
    scope,
    issuedBy: input.issuedBy,
    issuedAt,
    durationMs: input.durationMs,
    expiresAt,
    exceptions: Object.freeze({ ...exceptions }),
  };
  const grant = Object.freeze({
    id: capabilityId(withoutId),
    ...withoutId,
  });
  ISSUED_GRANTS.add(grant);
  return grant;
}

export type CapabilityMatch =
  | { matches: true }
  | {
      matches: false;
      reason: "expired" | "not_yet_valid" | "mismatch" | "untrusted";
    };

export function matchCapability(
  capability: CapabilityGrant,
  request: Pick<PolicySimulationRequest, "operation" | "resource" | "scope">,
  now = Date.now(),
): CapabilityMatch {
  if (
    !capability ||
    typeof capability !== "object" ||
    !ISSUED_GRANTS.has(capability)
  ) {
    return { matches: false, reason: "untrusted" };
  }
  if (now < capability.issuedAt) return { matches: false, reason: "not_yet_valid" };
  if (now >= capability.expiresAt) return { matches: false, reason: "expired" };
  if (
    capability.operation !== request.operation.trim() ||
    capability.resource !== request.resource.trim() ||
    capability.scope !== request.scope.trim()
  ) {
    return { matches: false, reason: "mismatch" };
  }
  return { matches: true };
}
