import { randomUUID } from "node:crypto";
import {
  AUTOPILOT_SCHEMA_VERSION,
  autopilotRecordDigest,
  createProofLeaseInvalidation,
  type ProofLeaseInvalidation,
} from "../autopilot/index.js";
import { ShippingValidationError } from "./errors.js";
import type { LeaseDriftInput } from "./types.js";

/**
 * Produces one durable invalidation for the highest-priority exact mismatch.
 * No fuzzy comparison or model judgment is involved.
 */
export function invalidateLeaseForDrift(
  input: LeaseDriftInput,
  options: {
    createId?: () => string;
    invalidatedBy?: "system" | "user" | "verifier";
  } = {},
): ProofLeaseInvalidation | undefined {
  const createId = options.createId ?? randomUUID;
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new ShippingValidationError(
      "Proof Lease observation time is invalid.",
    );
  }

  let reason: ProofLeaseInvalidation["reason"] | undefined;
  let causedByDigest: `sha256:${string}` | undefined;
  let defaultDetails = "";
  if (input.currentPlanDigest !== input.lease.planDigest) {
    reason = "plan_revision";
    causedByDigest = input.currentPlanDigest;
    defaultDetails = "The accepted task plan changed after the release.";
  } else if (input.currentSubjectDigest !== input.lease.subjectDigest) {
    reason = "subject_changed";
    causedByDigest = input.currentSubjectDigest;
    defaultDetails = "The released source or artifact digest changed.";
  } else if (
    input.currentEnvironmentDigest !== input.lease.environmentDigest
  ) {
    reason = "environment_changed";
    causedByDigest = input.currentEnvironmentDigest;
    defaultDetails = "The verified release environment changed.";
  } else if (input.currentPolicyDigest !== input.lease.policyDigest) {
    reason = "policy_changed";
    causedByDigest = input.currentPolicyDigest;
    defaultDetails = "The policy governing the release changed.";
  } else if (input.currentToolchainDigest !== input.lease.toolchainDigest) {
    reason = "toolchain_changed";
    causedByDigest = input.currentToolchainDigest;
    defaultDetails = "The verified release toolchain changed.";
  }
  if (!reason) return undefined;

  const details = input.details?.trim() || defaultDetails;
  return createProofLeaseInvalidation({
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    id: createId(),
    taskId: input.lease.taskId,
    leaseId: input.lease.id,
    leaseDigest: input.lease.digest,
    reason,
    details,
    invalidatedBy: options.invalidatedBy ?? "system",
    causedByDigest:
      causedByDigest ??
      autopilotRecordDigest({
        reason,
        observedAt,
      }),
    invalidatedAt: observedAt,
  });
}
