import { randomUUID } from "node:crypto";
import {
  AUTOPILOT_SCHEMA_VERSION,
  VerifiedAutopilotService,
  autopilotRecordDigest,
  type AutopilotDigest,
  type ExternalEffectPlan,
  type ExternalEffectReceipt,
  type ProofLease,
  type TaskPlan,
} from "../autopilot/index.js";
import {
  isSha256Digest,
  type ActionRecord,
  type EvidenceRecord,
  type JsonValue,
  type ProofGraphStore,
  type TaskProjection,
} from "../proofgraph/index.js";
import { ShippingStateError, ShippingValidationError } from "./errors.js";
import { StructuredShippingService } from "./service.js";
import {
  SHIPPING_SCHEMA_VERSION,
  type ExecuteShippingInput,
  type ShippingAuthorization,
  type ShippingConfirmation,
  type ShippingCredentialHandle,
  type ShippingEffect,
  type ShippingExecutionResult,
  type ShippingLeaseContext,
  type ShippingPreflight,
} from "./types.js";

const PREFLIGHT_ACTION = "shipping.preflight.persisted";
const CONFIRMATION_ACTION = "shipping.confirmation.persisted";
const EXECUTION_STARTED_ACTION = "shipping.execution.started";
const EXECUTION_COMPLETED_ACTION = "shipping.execution.completed";
const EXECUTION_INTERRUPTED_ACTION = "shipping.execution.interrupted";

export interface DurableShippingPreflightInput {
  taskId: string;
  expectedPlanDigest: AutopilotDigest;
  stepId: string;
  effect: ShippingEffect;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  expiresInMs?: number;
}

interface ExactShippingReference {
  taskId: string;
  effectPlanId: string;
  expectedPlanDigest: AutopilotDigest;
  expectedEffectPlanDigest: AutopilotDigest;
  expectedPreflightDigest: AutopilotDigest;
  expectedChallengeDigest: AutopilotDigest;
}

export interface DurableShippingConfirmationInput
  extends ExactShippingReference {
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
}

export interface DurableShippingExecutionInput extends ExactShippingReference {
  expectedAuthorizationDigest: AutopilotDigest;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  lease: ShippingLeaseContext;
}

export interface DurableShippingConfirmation {
  authorization: ShippingAuthorization;
  confirmationDigest: AutopilotDigest;
  effectPlanDigest: AutopilotDigest;
  preflightDigest: AutopilotDigest;
  idempotent: boolean;
}

export interface DurableShippingExecutionResult
  extends ShippingExecutionResult {
  idempotent: boolean;
  providerState: "recorded" | "unknown";
  reconciliationRequired: boolean;
}

export interface ShippingReconciliationGap {
  code:
    | "preflight_metadata_missing"
    | "provider_state_unknown"
    | "proof_lease_missing";
  effectPlanId: string;
  severity: "warning" | "critical";
  summary: string;
  blocksRetry: boolean;
}

export interface DurableShippingStatus {
  taskId: string;
  externalEffectPlans: ExternalEffectPlan[];
  externalEffectReceipts: ExternalEffectReceipt[];
  proofLeases: ProofLease[];
  phases: Array<{
    effectPlanId: string;
    effectPlanDigest: AutopilotDigest;
    state:
      | "preflight_incomplete"
      | "awaiting_confirmation"
      | "awaiting_execution"
      | "execution_unknown"
      | "recorded";
    preflightPersisted: boolean;
    confirmationPersisted: boolean;
    executionStarted: boolean;
    receiptDigest?: AutopilotDigest;
    proofLeaseDigest?: AutopilotDigest;
  }>;
  reconciliationGaps: ShippingReconciliationGap[];
  limitations: string[];
}

interface PersistedPreflight {
  projection: TaskProjection;
  effectPlan: ExternalEffectPlan;
  preflight: ShippingPreflight;
}

function objectValue(
  value: JsonValue | undefined,
  field: string,
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShippingStateError(`${field} is missing or malformed.`);
  }
  return value;
}

function stringValue(
  value: JsonValue | undefined,
  field: string,
): string {
  if (typeof value !== "string" || !value) {
    throw new ShippingStateError(`${field} is missing or malformed.`);
  }
  return value;
}

function digestValue(
  value: JsonValue | undefined,
  field: string,
): AutopilotDigest {
  const result = stringValue(value, field);
  if (!isSha256Digest(result)) {
    throw new ShippingStateError(`${field} is not a valid digest.`);
  }
  return result as AutopilotDigest;
}

function withoutRecordEnvelope<T extends { schemaVersion: 1; digest: string }>(
  value: T,
): Omit<T, "schemaVersion" | "digest"> {
  const {
    schemaVersion: _schemaVersion,
    digest: _digest,
    ...body
  } = value;
  return body;
}

function assertExactReference(
  input: ExactShippingReference,
  persisted: PersistedPreflight,
): void {
  if (
    input.expectedPlanDigest !== persisted.preflight.taskPlan.digest ||
    input.expectedPlanDigest !== persisted.projection.autopilot.currentPlan?.digest
  ) {
    throw new ShippingValidationError(
      "The task plan changed after shipping preflight. Create a new preflight.",
    );
  }
  if (
    input.expectedEffectPlanDigest !== persisted.effectPlan.digest ||
    input.expectedEffectPlanDigest !== persisted.preflight.effectPlan.digest ||
    input.expectedPreflightDigest !== persisted.preflight.digest ||
    input.expectedChallengeDigest !== persisted.preflight.challenge.digest
  ) {
    throw new ShippingValidationError(
      "Shipping confirmation does not match the exact durable preflight.",
    );
  }
}

function actionOutput(
  action: ActionRecord | undefined,
): Record<string, JsonValue> | undefined {
  if (!action?.output) return undefined;
  try {
    return objectValue(action.output, `${action.name} output`);
  } catch {
    return undefined;
  }
}

function actionForEffect(
  projection: TaskProjection,
  name: string,
  effectPlanDigest: AutopilotDigest,
): ActionRecord | undefined {
  return [...projection.actions]
    .reverse()
    .find(
      (action) =>
        action.name === name &&
        actionOutput(action)?.effectPlanDigest === effectPlanDigest,
  );
}

function receiptProviderState(
  receipt: ExternalEffectReceipt,
): "recorded" | "unknown" {
  return receipt.status === "failed" &&
    receipt.providerReceiptDigests.length === 0
    ? "unknown"
    : "recorded";
}

export class ProofGraphShippingCoordinator {
  readonly #store: ProofGraphStore;
  readonly #shipping: StructuredShippingService;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    store: ProofGraphStore;
    shipping: StructuredShippingService;
    now?: () => Date;
    createId?: () => string;
  }) {
    this.#store = options.store;
    this.#shipping = options.shipping;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async #appendAction(input: {
    taskId: string;
    name: string;
    capability: string;
    input: JsonValue;
    output: JsonValue;
    status: ActionRecord["status"];
    startedAt?: string;
    completedAt?: string;
    sideEffects?: ActionRecord["sideEffects"];
  }): Promise<ActionRecord> {
    const now = this.#now().toISOString();
    const action: ActionRecord = {
      id: this.#createId(),
      taskId: input.taskId,
      name: input.name,
      capability: input.capability,
      provenance: {
        source: "local_tool",
        trust: "authoritative",
        sensitivity: "proprietary",
      },
      input: input.input,
      output: input.output,
      sideEffects: input.sideEffects ?? [],
      status: input.status,
      startedAt: input.startedAt ?? now,
      ...(input.completedAt || input.status !== "running"
        ? { completedAt: input.completedAt ?? now }
        : {}),
    };
    await this.#store.append({
      taskId: action.taskId,
      kind: "action.recorded",
      payload: { action },
      occurredAt: action.completedAt ?? action.startedAt,
    });
    return action;
  }

  async #ensureEvidence(input: {
    taskId: string;
    evidenceIds: string[];
    summary: string;
    artifactDigests: string[];
    observedAt: string;
  }): Promise<void> {
    let projection = await this.#store.task(input.taskId);
    const existing = new Set(projection.evidence.map((record) => record.id));
    for (const evidenceId of input.evidenceIds) {
      if (existing.has(evidenceId)) continue;
      const evidence: EvidenceRecord = {
        id: evidenceId,
        taskId: input.taskId,
        kind: "runtime_trace",
        grade: "observed",
        origin: "tool",
        summary: input.summary,
        supportsClaimIds: [],
        contradictsClaimIds: [],
        tool: "structured-shipping-adapter",
        artifactDigests: input.artifactDigests,
        stale: false,
        observedAt: input.observedAt,
      };
      await this.#store.append({
        taskId: input.taskId,
        kind: "evidence.recorded",
        payload: { evidence },
        occurredAt: evidence.observedAt,
      });
      existing.add(evidenceId);
    }
    projection = await this.#store.task(input.taskId);
    const missing = input.evidenceIds.find(
      (evidenceId) =>
        !projection.evidence.some(
          (record) => record.id === evidenceId && !record.stale,
        ),
    );
    if (missing) {
      throw new ShippingStateError(
        `Structured shipping evidence could not be made durable: ${missing}`,
      );
    }
  }

  async #loadPreflight(
    taskId: string,
    effectPlanId: string,
  ): Promise<PersistedPreflight> {
    const projection = await this.#store.task(taskId);
    const effectPlan = projection.autopilot.externalEffectPlans.find(
      (candidate) => candidate.id === effectPlanId,
    );
    if (!effectPlan) {
      throw new ShippingStateError(
        `Durable external effect plan does not exist: ${effectPlanId}`,
      );
    }
    const action = actionForEffect(
      projection,
      PREFLIGHT_ACTION,
      effectPlan.digest,
    );
    const output = actionOutput(action);
    const artifactDigest = digestValue(
      output?.preflightArtifactDigest,
      "Shipping preflight artifact",
    );
    const preflight = await this.#store.cas.getJson<ShippingPreflight>(
      artifactDigest,
    );
    if (
      preflight.digest !==
        digestValue(output?.preflightDigest, "Shipping preflight") ||
      preflight.effectPlan.id !== effectPlan.id ||
      preflight.effectPlan.digest !== effectPlan.digest ||
      preflight.taskPlan.taskId !== taskId
    ) {
      throw new ShippingStateError(
        "Durable shipping preflight does not match its ProofGraph record.",
      );
    }
    return { projection, effectPlan, preflight };
  }

  async prepare(
    input: DurableShippingPreflightInput,
  ): Promise<ShippingPreflight> {
    const projection = await this.#store.task(input.taskId);
    const taskPlan = projection.autopilot.currentPlan;
    if (!taskPlan || taskPlan.digest !== input.expectedPlanDigest) {
      throw new ShippingValidationError(
        "Shipping preflight requires the exact current task plan digest.",
      );
    }
    const preflight = await this.#shipping.prepare({
      taskPlan,
      stepId: input.stepId,
      effect: input.effect,
      credentialHandle: input.credentialHandle,
      idempotencyKey: input.idempotencyKey,
      ...(input.expiresInMs === undefined
        ? {}
        : { expiresInMs: input.expiresInMs }),
    });
    const current = await this.#store.task(input.taskId);
    if (current.autopilot.currentPlan?.digest !== taskPlan.digest) {
      throw new ShippingValidationError(
        "The task plan changed while the external target was inspected.",
      );
    }
    const artifact = await this.#store.cas.putJson(preflight);
    if (artifact.redacted) {
      throw new ShippingValidationError(
        "The shipping preflight contained secret-like material and was refused.",
      );
    }
    await this.#ensureEvidence({
      taskId: input.taskId,
      evidenceIds: preflight.inspection.evidenceIds,
      summary:
        "The structured adapter inspected the exact external target before confirmation.",
      artifactDigests: [preflight.inspection.currentStateDigest],
      observedAt: preflight.effectPlan.createdAt,
    });
    const service = new VerifiedAutopilotService(this.#store, {
      now: this.#now,
      createId: this.#createId,
    });
    const persistedPlan = await service.planExternalEffect(
      withoutRecordEnvelope(preflight.effectPlan),
    );
    if (persistedPlan.digest !== preflight.effectPlan.digest) {
      throw new ShippingStateError(
        "Persisted external effect plan digest does not match preflight.",
      );
    }
    await this.#appendAction({
      taskId: input.taskId,
      name: PREFLIGHT_ACTION,
      capability: persistedPlan.requiredCapability,
      input: {
        taskPlanDigest: taskPlan.digest,
        effectDigest: preflight.effectDigest,
        inspectionDigest: preflight.inspectionDigest,
      },
      output: {
        effectPlanId: persistedPlan.id,
        effectPlanDigest: persistedPlan.digest,
        preflightDigest: preflight.digest,
        preflightArtifactDigest: artifact.digest,
        challengeDigest: preflight.challenge.digest,
        operationDigest: preflight.challenge.operationDigest,
        externalMutationOccurred: false,
        crashReconciliation:
          "If a future execution starts without a durable receipt, inspect the provider before retrying.",
      },
      status: "succeeded",
    });
    return preflight;
  }

  async confirm(
    input: DurableShippingConfirmationInput,
  ): Promise<DurableShippingConfirmation> {
    const persisted = await this.#loadPreflight(
      input.taskId,
      input.effectPlanId,
    );
    assertExactReference(input, persisted);
    const existing = actionForEffect(
      persisted.projection,
      CONFIRMATION_ACTION,
      persisted.effectPlan.digest,
    );
    const existingOutput = actionOutput(existing);
    if (existingOutput) {
      const confirmation = await this.#store.cas.getJson<ShippingConfirmation>(
        digestValue(
          existingOutput.confirmationArtifactDigest,
          "Shipping confirmation artifact",
        ),
      );
      const authorization = this.#shipping.verifyAuthorization({
        preflight: persisted.preflight,
        credentialHandle: input.credentialHandle,
        idempotencyKey: input.idempotencyKey,
        confirmation,
      });
      if (
        authorization.digest !==
        digestValue(
          existingOutput.authorizationDigest,
          "Shipping authorization",
        )
      ) {
        throw new ShippingStateError(
          "Durable shipping authorization failed digest verification.",
        );
      }
      return {
        authorization,
        confirmationDigest: autopilotRecordDigest(confirmation),
        effectPlanDigest: persisted.effectPlan.digest,
        preflightDigest: persisted.preflight.digest,
        idempotent: true,
      };
    }

    const confirmation: ShippingConfirmation = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      challengeDigest: persisted.preflight.challenge.digest,
      decision: "confirmed",
      confirmedBy: "user",
      confirmedAt: this.#now().toISOString(),
    };
    const authorization = this.#shipping.verifyAuthorization({
      preflight: persisted.preflight,
      credentialHandle: input.credentialHandle,
      idempotencyKey: input.idempotencyKey,
      confirmation,
    });
    const artifact = await this.#store.cas.putJson(confirmation);
    if (artifact.redacted) {
      throw new ShippingStateError(
        "Shipping confirmation could not be persisted safely.",
      );
    }
    await this.#appendAction({
      taskId: input.taskId,
      name: CONFIRMATION_ACTION,
      capability: persisted.effectPlan.requiredCapability,
      input: {
        taskPlanDigest: input.expectedPlanDigest,
        effectPlanDigest: input.expectedEffectPlanDigest,
        preflightDigest: input.expectedPreflightDigest,
        challengeDigest: input.expectedChallengeDigest,
      },
      output: {
        effectPlanDigest: persisted.effectPlan.digest,
        authorizationDigest: authorization.digest,
        approvalReceiptDigest: authorization.approvalReceiptDigest,
        confirmationArtifactDigest: artifact.digest,
        confirmedAt: confirmation.confirmedAt,
        externalMutationOccurred: false,
      },
      status: "succeeded",
    });
    return {
      authorization,
      confirmationDigest: autopilotRecordDigest(confirmation),
      effectPlanDigest: persisted.effectPlan.digest,
      preflightDigest: persisted.preflight.digest,
      idempotent: false,
    };
  }

  async execute(
    input: DurableShippingExecutionInput,
  ): Promise<DurableShippingExecutionResult> {
    const persisted = await this.#loadPreflight(
      input.taskId,
      input.effectPlanId,
    );
    assertExactReference(input, persisted);
    const confirmationAction = actionForEffect(
      persisted.projection,
      CONFIRMATION_ACTION,
      persisted.effectPlan.digest,
    );
    const confirmationOutput = actionOutput(confirmationAction);
    if (
      digestValue(
        confirmationOutput?.authorizationDigest,
        "Shipping authorization",
      ) !== input.expectedAuthorizationDigest
    ) {
      throw new ShippingValidationError(
        "Execution does not match the exact durable user authorization.",
      );
    }
    const confirmation = await this.#store.cas.getJson<ShippingConfirmation>(
      digestValue(
        confirmationOutput?.confirmationArtifactDigest,
        "Shipping confirmation artifact",
      ),
    );
    const authorization = this.#shipping.verifyAuthorization({
      preflight: persisted.preflight,
      credentialHandle: input.credentialHandle,
      idempotencyKey: input.idempotencyKey,
      confirmation,
    });
    if (authorization.digest !== input.expectedAuthorizationDigest) {
      throw new ShippingValidationError(
        "Execution authorization changed after confirmation.",
      );
    }
    const priorReceipt =
      persisted.projection.autopilot.externalEffectReceipts.find(
        (receipt) => receipt.effectPlanId === persisted.effectPlan.id,
      );
    if (priorReceipt) {
      const completion = actionForEffect(
        persisted.projection,
        EXECUTION_COMPLETED_ACTION,
        persisted.effectPlan.digest,
      );
      const completionOutput = actionOutput(completion);
      const leaseDigest =
        typeof completionOutput?.proofLeaseDigest === "string"
          ? completionOutput.proofLeaseDigest
          : undefined;
      return {
        receipt: priorReceipt,
        ...(leaseDigest
          ? {
              proofLease: persisted.projection.autopilot.proofLeases.find(
                (lease) => lease.digest === leaseDigest,
              ),
            }
          : {}),
        compensationAvailable:
          priorReceipt.status === "succeeded" &&
          persisted.effectPlan.recovery.mode !== "none",
        idempotent: true,
        providerState: receiptProviderState(priorReceipt),
        reconciliationRequired:
          receiptProviderState(priorReceipt) === "unknown",
      };
    }
    if (
      actionForEffect(
        persisted.projection,
        EXECUTION_STARTED_ACTION,
        persisted.effectPlan.digest,
      )
    ) {
      throw new ShippingStateError(
        "A prior execution started without a durable receipt. Inspect the provider and reconcile its state before retry.",
      );
    }
    const startedAt = this.#now().toISOString();
    await this.#appendAction({
      taskId: input.taskId,
      name: EXECUTION_STARTED_ACTION,
      capability: persisted.effectPlan.requiredCapability,
      input: {
        effectPlanDigest: persisted.effectPlan.digest,
        preflightDigest: persisted.preflight.digest,
        authorizationDigest: authorization.digest,
        operationDigest: authorization.operationDigest,
      },
      output: {
        effectPlanDigest: persisted.effectPlan.digest,
        providerState: "unknown_until_receipt_is_durable",
        reconciliationRequiredIfInterrupted: true,
      },
      status: "running",
      startedAt,
      sideEffects: [
        {
          kind: persisted.effectPlan.kind,
          target: persisted.effectPlan.target.displayName,
          reversible: persisted.effectPlan.recovery.mode !== "none",
          recovery: persisted.effectPlan.recovery.description,
        },
      ],
    });

    let durableReceipt = false;
    try {
      const result = await this.#shipping.execute({
        preflight: persisted.preflight,
        credentialHandle: input.credentialHandle,
        idempotencyKey: input.idempotencyKey,
        confirmation,
        lease: input.lease,
      } satisfies ExecuteShippingInput);
      await this.#ensureEvidence({
        taskId: input.taskId,
        evidenceIds: result.receipt.resultEvidenceIds,
        summary:
          "The structured provider adapter returned evidence for the external effect result.",
        artifactDigests: result.receipt.providerReceiptDigests,
        observedAt: result.receipt.completedAt,
      });
      const receiptEvidenceId = `external-effect-receipt:${result.receipt.digest}`;
      await this.#ensureEvidence({
        taskId: input.taskId,
        evidenceIds: [receiptEvidenceId],
        summary: `Durable external effect receipt: ${result.receipt.summary}`,
        artifactDigests: [result.receipt.digest],
        observedAt: result.receipt.completedAt,
      });
      const service = new VerifiedAutopilotService(this.#store, {
        now: this.#now,
        createId: this.#createId,
      });
      const receipt = await service.recordExternalEffectReceipt(
        withoutRecordEnvelope(result.receipt),
      );
      durableReceipt = true;
      const providerState = receiptProviderState(receipt);
      let proofLease: ProofLease | undefined;
      if (result.proofLease) {
        proofLease = await service.issueProofLease(
          withoutRecordEnvelope(result.proofLease),
        );
      }
      await this.#appendAction({
        taskId: input.taskId,
        name: EXECUTION_COMPLETED_ACTION,
        capability: persisted.effectPlan.requiredCapability,
        input: {
          effectPlanDigest: persisted.effectPlan.digest,
          authorizationDigest: authorization.digest,
          operationDigest: authorization.operationDigest,
        },
        output: {
          effectPlanDigest: persisted.effectPlan.digest,
          receiptDigest: receipt.digest,
          receiptStatus: receipt.status,
          ...(proofLease ? { proofLeaseDigest: proofLease.digest } : {}),
          providerState,
          reconciliationRequired: providerState === "unknown",
        },
        status:
          receipt.status === "succeeded"
            ? "succeeded"
            : receipt.status === "refused"
              ? "denied"
              : "failed",
        startedAt,
        completedAt: receipt.completedAt,
        sideEffects: [
          {
            kind: persisted.effectPlan.kind,
            target: persisted.effectPlan.target.displayName,
            reversible: persisted.effectPlan.recovery.mode !== "none",
            recovery: persisted.effectPlan.recovery.description,
          },
        ],
      });
      return {
        receipt,
        ...(proofLease ? { proofLease } : {}),
        compensationAvailable: result.compensationAvailable,
        idempotent: false,
        providerState,
        reconciliationRequired: providerState === "unknown",
      };
    } catch {
      await this.#appendAction({
        taskId: input.taskId,
        name: EXECUTION_INTERRUPTED_ACTION,
        capability: persisted.effectPlan.requiredCapability,
        input: {
          effectPlanDigest: persisted.effectPlan.digest,
          authorizationDigest: authorization.digest,
          operationDigest: authorization.operationDigest,
        },
        output: {
          effectPlanDigest: persisted.effectPlan.digest,
          durableReceipt,
          providerState: durableReceipt ? "recorded" : "unknown",
          reconciliationRequired: !durableReceipt,
          gap: durableReceipt
            ? "The provider receipt is durable, but Proof Lease persistence did not complete."
            : "Execution started without a durable receipt. Inspect the provider before retrying.",
        },
        status: "failed",
        startedAt,
        sideEffects: [
          {
            kind: persisted.effectPlan.kind,
            target: persisted.effectPlan.target.displayName,
            reversible: persisted.effectPlan.recovery.mode !== "none",
            recovery: persisted.effectPlan.recovery.description,
          },
        ],
      }).catch(() => undefined);
      throw new ShippingStateError(
        durableReceipt
          ? "The external effect receipt is durable, but its Proof Lease could not be persisted."
          : "Execution may have reached the provider without a durable receipt. Provider reconciliation is required before retry.",
      );
    }
  }
}

function leaseDigestForCompletion(
  projection: TaskProjection,
  effectPlan: ExternalEffectPlan,
): AutopilotDigest | undefined {
  const output = actionOutput(
    actionForEffect(
      projection,
      EXECUTION_COMPLETED_ACTION,
      effectPlan.digest,
    ),
  );
  return typeof output?.proofLeaseDigest === "string" &&
    isSha256Digest(output.proofLeaseDigest)
    ? (output.proofLeaseDigest as AutopilotDigest)
    : undefined;
}

export async function durableShippingStatus(
  store: ProofGraphStore,
  taskId: string,
): Promise<DurableShippingStatus> {
  const projection = await store.task(taskId);
  const gaps: ShippingReconciliationGap[] = [];
  const phases = projection.autopilot.externalEffectPlans.map((effectPlan) => {
    const preflight = actionForEffect(
      projection,
      PREFLIGHT_ACTION,
      effectPlan.digest,
    );
    const confirmation = actionForEffect(
      projection,
      CONFIRMATION_ACTION,
      effectPlan.digest,
    );
    const execution = actionForEffect(
      projection,
      EXECUTION_STARTED_ACTION,
      effectPlan.digest,
    );
    const receipt = projection.autopilot.externalEffectReceipts.find(
      (candidate) => candidate.effectPlanId === effectPlan.id,
    );
    const executionUnknown =
      Boolean(execution) &&
      (!receipt || receiptProviderState(receipt) === "unknown");
    const proofLeaseDigest = leaseDigestForCompletion(projection, effectPlan);
    if (!preflight) {
      gaps.push({
        code: "preflight_metadata_missing",
        effectPlanId: effectPlan.id,
        severity: "warning",
        summary:
          "The effect plan is durable, but its exact preflight artifact is missing.",
        blocksRetry: true,
      });
    }
    if (executionUnknown) {
      gaps.push({
        code: "provider_state_unknown",
        effectPlanId: effectPlan.id,
        severity: "critical",
        summary:
          receipt
            ? "The provider adapter failed without a verifiable provider receipt. Inspect the provider before any retry."
            : "Execution started without a durable receipt. Inspect the provider before any retry.",
        blocksRetry: true,
      });
    }
    if (receipt?.status === "succeeded" && !proofLeaseDigest) {
      gaps.push({
        code: "proof_lease_missing",
        effectPlanId: effectPlan.id,
        severity: "warning",
        summary:
          "The external effect receipt is durable, but no Proof Lease was issued.",
        blocksRetry: false,
      });
    }
    const state: DurableShippingStatus["phases"][number]["state"] = !preflight
      ? "preflight_incomplete"
      : !confirmation
        ? "awaiting_confirmation"
        : !execution
          ? "awaiting_execution"
          : executionUnknown
            ? "execution_unknown"
            : "recorded";
    return {
      effectPlanId: effectPlan.id,
      effectPlanDigest: effectPlan.digest,
      state,
      preflightPersisted: Boolean(preflight),
      confirmationPersisted: Boolean(confirmation),
      executionStarted: Boolean(execution),
      ...(receipt ? { receiptDigest: receipt.digest } : {}),
      ...(proofLeaseDigest ? { proofLeaseDigest } : {}),
    };
  });
  return {
    taskId,
    externalEffectPlans: projection.autopilot.externalEffectPlans,
    externalEffectReceipts: projection.autopilot.externalEffectReceipts,
    proofLeases: projection.autopilot.proofLeases,
    phases,
    reconciliationGaps: gaps,
    limitations: [
      "External mutations remain disabled unless the local host explicitly injects a structured provider adapter.",
      "A crash after provider acceptance but before receipt persistence cannot be inferred locally; retry remains blocked until provider reconciliation.",
    ],
  };
}
