import { verifyProofLease } from "./records.js";
import type {
  AutopilotProjection,
  ProofLease,
  ProofLeaseValidity,
  ProofLeaseValidityContext,
} from "./types.js";

function mismatch(
  reasons: string[],
  left: string,
  right: string,
  message: string,
): void {
  if (left !== right) reasons.push(message);
}

/**
 * Evaluates a lease only against exact, caller-supplied current digests.
 * Missing or stale context never degrades to a best-effort cache hit.
 */
export function evaluateProofLease(
  lease: ProofLease,
  projection: AutopilotProjection,
  context: ProofLeaseValidityContext,
): ProofLeaseValidity {
  const structural = verifyProofLease(lease);
  if (!structural.valid) {
    return {
      valid: false,
      status: "invalid",
      reasons: structural.errors,
    };
  }

  const invalidations = projection.proofLeaseInvalidations.filter(
    (invalidation) =>
      invalidation.leaseId === lease.id &&
      invalidation.leaseDigest === lease.digest,
  );
  if (invalidations.length > 0) {
    return {
      valid: false,
      status: "invalidated",
      reasons: invalidations.map(
        (invalidation) =>
          `${invalidation.reason}: ${invalidation.details}`,
      ),
    };
  }

  const now = Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) {
    return {
      valid: false,
      status: "invalid",
      reasons: ["Proof lease evaluation time is invalid."],
    };
  }
  if (now < Date.parse(lease.issuedAt)) {
    return {
      valid: false,
      status: "invalid",
      reasons: ["Proof lease is not valid yet."],
    };
  }
  if (now >= Date.parse(lease.expiresAt)) {
    return {
      valid: false,
      status: "expired",
      reasons: ["Proof lease has expired."],
    };
  }

  const reasons: string[] = [];
  mismatch(reasons, context.taskId, lease.taskId, "Task ID changed.");
  mismatch(
    reasons,
    context.planDigest,
    lease.planDigest,
    "Task plan digest changed.",
  );
  mismatch(
    reasons,
    context.subjectDigest,
    lease.subjectDigest,
    "Proof subject digest changed.",
  );
  mismatch(
    reasons,
    context.environmentDigest,
    lease.environmentDigest,
    "Execution environment digest changed.",
  );
  mismatch(
    reasons,
    context.policyDigest,
    lease.policyDigest,
    "Policy digest changed.",
  );
  mismatch(
    reasons,
    context.toolchainDigest,
    lease.toolchainDigest,
    "Toolchain digest changed.",
  );

  const currentPlan = projection.currentPlan;
  if (
    !currentPlan ||
    currentPlan.id !== lease.planId ||
    currentPlan.revision !== lease.planRevision ||
    currentPlan.digest !== lease.planDigest
  ) {
    reasons.push("Lease no longer references the current plan revision.");
  } else {
    const obligations = new Map(
      currentPlan.proofObligations.map((obligation) => [
        obligation.id,
        obligation,
      ]),
    );
    for (const obligationId of lease.proofObligationIds) {
      const obligation = obligations.get(obligationId);
      if (!obligation) {
        reasons.push(`Proof obligation disappeared: ${obligationId}.`);
        continue;
      }
      if (!["satisfied", "waived"].includes(obligation.status)) {
        reasons.push(`Proof obligation is no longer cleared: ${obligationId}.`);
        continue;
      }
      if (
        obligation.status === "satisfied" &&
        !obligation.evidenceIds.some((evidenceId) =>
          lease.evidenceIds.includes(evidenceId),
        )
      ) {
        reasons.push(`Lease omits current evidence for ${obligationId}.`);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    status: reasons.length === 0 ? "valid" : "mismatched",
    reasons,
  };
}
