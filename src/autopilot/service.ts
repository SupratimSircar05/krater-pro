import { randomUUID } from "node:crypto";
import type { ProofGraphStore } from "../proofgraph/store.js";
import {
  createAgentDelegation,
  createExternalEffectPlan,
  createExternalEffectReceipt,
  createProductionObservation,
  createProofLease,
  createProofLeaseInvalidation,
  createTaskPlan,
} from "./records.js";
import { evaluateProofLease } from "./lease.js";
import {
  AUTOPILOT_SCHEMA_VERSION,
  type AgentDelegation,
  type ExternalEffectPlan,
  type ExternalEffectReceipt,
  type PlanStep,
  type ProductionObservation,
  type ProofLease,
  type ProofLeaseInvalidation,
  type ProofLeaseValidity,
  type ProofLeaseValidityContext,
  type ProofObligation,
  type TaskPlan,
} from "./types.js";

export type PlanStepInput = Omit<PlanStep, "schemaVersion">;
export type ProofObligationInput = Omit<ProofObligation, "schemaVersion">;

export interface TaskPlanRevisionInput {
  id: string;
  taskId: string;
  /**
   * Optional optimistic-concurrency guard for host APIs. When supplied, the
   * revision is rejected unless it still extends this exact durable plan.
   */
  expectedPreviousPlanDigest?: TaskPlan["digest"];
  status: TaskPlan["status"];
  objective: string;
  contractDigest?: TaskPlan["contractDigest"];
  steps: PlanStepInput[];
  proofObligations: ProofObligationInput[];
  createdBy?: TaskPlan["createdBy"];
  revisedBy: TaskPlan["revisedBy"];
  createdAt?: string;
  revisedAt?: string;
  revisionReason: string;
}

export type AgentDelegationInput = Omit<
  AgentDelegation,
  "schemaVersion" | "digest"
>;
export type ExternalEffectPlanInput = Omit<
  ExternalEffectPlan,
  "schemaVersion" | "digest"
>;
export type ExternalEffectReceiptInput = Omit<
  ExternalEffectReceipt,
  "schemaVersion" | "digest"
>;
export type ProofLeaseInput = Omit<ProofLease, "schemaVersion" | "digest">;
export type ProofLeaseInvalidationInput = Omit<
  ProofLeaseInvalidation,
  "schemaVersion" | "digest"
>;
export type ProductionObservationInput = Omit<
  ProductionObservation,
  "schemaVersion" | "digest"
>;

export interface VerifiedAutopilotServiceOptions {
  now?: () => Date;
  createId?: () => string;
}

/**
 * Host-owned append-only domain service. It creates redacted, digested records;
 * ProofGraph remains the authority for reference and revision consistency.
 */
export class VerifiedAutopilotService {
  readonly #store: ProofGraphStore;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(
    store: ProofGraphStore,
    options: VerifiedAutopilotServiceOptions = {},
  ) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async revisePlan(input: TaskPlanRevisionInput): Promise<TaskPlan> {
    const projection = await this.#store.task(input.taskId);
    const previous = projection.autopilot.currentPlan;
    if (
      input.expectedPreviousPlanDigest !== undefined &&
      previous?.digest !== input.expectedPreviousPlanDigest
    ) {
      throw new Error(
        "The task plan changed after it was opened. Reload before revising it.",
      );
    }
    const revisedAt = input.revisedAt ?? this.#now().toISOString();
    const plan = createTaskPlan({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: input.id,
      taskId: input.taskId,
      revision: (previous?.revision ?? 0) + 1,
      ...(previous ? { previousPlanDigest: previous.digest } : {}),
      status: input.status,
      objective: input.objective,
      ...(input.contractDigest ? { contractDigest: input.contractDigest } : {}),
      steps: input.steps.map((step) => ({
        ...step,
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      })),
      proofObligations: input.proofObligations.map((obligation) => ({
        ...obligation,
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      })),
      createdBy: previous?.createdBy ?? input.createdBy ?? input.revisedBy,
      revisedBy: input.revisedBy,
      createdAt: previous?.createdAt ?? input.createdAt ?? revisedAt,
      revisedAt,
      revisionReason: input.revisionReason,
    });
    await this.#store.append({
      taskId: input.taskId,
      kind: "autopilot.plan.revised",
      payload: { plan },
      occurredAt: revisedAt,
    });

    if (previous) {
      const alreadyInvalidated = new Set(
        projection.autopilot.proofLeaseInvalidations.map(
          (invalidation) => invalidation.leaseId,
        ),
      );
      for (const lease of projection.autopilot.proofLeases) {
        if (alreadyInvalidated.has(lease.id)) continue;
        const invalidation = createProofLeaseInvalidation({
          schemaVersion: AUTOPILOT_SCHEMA_VERSION,
          id: this.#createId(),
          taskId: input.taskId,
          leaseId: lease.id,
          leaseDigest: lease.digest,
          reason: "plan_revision",
          details: `Task plan advanced from revision ${previous.revision} to ${plan.revision}.`,
          invalidatedBy: "system",
          causedByDigest: plan.digest,
          invalidatedAt: revisedAt,
        });
        await this.#store.append({
          taskId: input.taskId,
          kind: "autopilot.proof_lease.invalidated",
          payload: { invalidation },
          occurredAt: revisedAt,
        });
      }
    }
    return plan;
  }

  async recordDelegation(
    input: AgentDelegationInput,
  ): Promise<AgentDelegation> {
    const delegation = createAgentDelegation({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: delegation.taskId,
      kind: "autopilot.delegation.recorded",
      payload: { delegation },
      occurredAt: delegation.issuedAt,
    });
    return delegation;
  }

  async planExternalEffect(
    input: ExternalEffectPlanInput,
  ): Promise<ExternalEffectPlan> {
    const effectPlan = createExternalEffectPlan({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: effectPlan.taskId,
      kind: "autopilot.external_effect.planned",
      payload: { effectPlan },
      occurredAt: effectPlan.createdAt,
    });
    return effectPlan;
  }

  async recordExternalEffectReceipt(
    input: ExternalEffectReceiptInput,
  ): Promise<ExternalEffectReceipt> {
    const receipt = createExternalEffectReceipt({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: receipt.taskId,
      kind: "autopilot.external_effect.receipt.recorded",
      payload: { receipt },
      occurredAt: receipt.completedAt,
    });
    return receipt;
  }

  async issueProofLease(input: ProofLeaseInput): Promise<ProofLease> {
    const lease = createProofLease({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: lease.taskId,
      kind: "autopilot.proof_lease.issued",
      payload: { lease },
      occurredAt: lease.issuedAt,
    });
    return lease;
  }

  async invalidateProofLease(
    input: ProofLeaseInvalidationInput,
  ): Promise<ProofLeaseInvalidation> {
    const invalidation = createProofLeaseInvalidation({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: invalidation.taskId,
      kind: "autopilot.proof_lease.invalidated",
      payload: { invalidation },
      occurredAt: invalidation.invalidatedAt,
    });
    return invalidation;
  }

  async recordProductionObservation(
    input: ProductionObservationInput,
  ): Promise<ProductionObservation> {
    const observation = createProductionObservation({
      ...input,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    });
    await this.#store.append({
      taskId: observation.taskId,
      kind: "autopilot.production.observed",
      payload: { observation },
      occurredAt: observation.observedAt,
    });
    return observation;
  }

  async evaluateLease(
    taskId: string,
    leaseId: string,
    context: ProofLeaseValidityContext,
  ): Promise<ProofLeaseValidity> {
    const projection = await this.#store.task(taskId);
    const lease = projection.autopilot.proofLeases.find(
      (candidate) => candidate.id === leaseId,
    );
    if (!lease) {
      return {
        valid: false,
        status: "invalid",
        reasons: [`Proof lease does not exist: ${leaseId}.`],
      };
    }
    return evaluateProofLease(lease, projection.autopilot, context);
  }
}
