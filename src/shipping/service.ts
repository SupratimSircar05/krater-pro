import { randomUUID } from "node:crypto";
import {
  AUTOPILOT_SCHEMA_VERSION,
  MAX_PROOF_LEASE_MS,
  autopilotRecordDigest,
  createExternalEffectPlan,
  createExternalEffectReceipt,
  createProofLease,
  createProofLeaseInvalidation,
  verifyExternalEffectPlan,
  verifyExternalEffectReceipt,
  verifyProofLease,
  type AutopilotDigest,
  type ExternalEffectReceipt,
  type ProofLease,
} from "../autopilot/index.js";
import { redactText } from "../proofgraph/index.js";
import {
  ShippingConfirmationError,
  ShippingStateError,
  ShippingUnsupportedError,
  ShippingValidationError,
} from "./errors.js";
import type {
  CloudflarePagesEffect,
  CloudflareWorkersEffect,
  CompensationPreflight,
  ExecuteCompensationInput,
  ExecuteShippingInput,
  GitHubPullRequestEffect,
  GitHubPushEffect,
  PrepareCompensationInput,
  PrepareShippingInput,
  ProviderCompensationResult,
  ProviderMutationResult,
  ShippingConfirmation,
  ShippingConfirmationChallenge,
  ShippingAuthorization,
  ShippingEffect,
  ShippingExecutionResult,
  ShippingInspection,
  ShippingPreflight,
  ShippingCompensationRequest,
  ShippingCompensationResult,
  StructuredShippingServiceOptions,
  VerifyShippingAuthorizationInput,
} from "./types.js";
import { SHIPPING_SCHEMA_VERSION } from "./types.js";
import {
  credentialBindingDigest,
  effectAllowedDomains,
  effectCapability,
  effectPlanKind,
  effectProvider,
  effectRecovery,
  effectSubjectDigest,
  effectSummary,
  effectTargetDisplayName,
  effectTargetKind,
  targetLocatorDigest,
  validateCompensationResult,
  validateCredentialHandle,
  validateIdempotencyKey,
  validateInspection,
  validateMutationResult,
  validateShippingEffect,
  validateTaskPlanForShipping,
} from "./validation.js";

const DEFAULT_CONFIRMATION_MS = 10 * 60 * 1_000;
const MAX_CONFIRMATION_MS = 30 * 60 * 1_000;
const MAX_CONFIRMATION_CLOCK_SKEW_MS = 30_000;

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function idempotencyDigest(value: string): AutopilotDigest {
  return autopilotRecordDigest({ idempotencyKey: value });
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const duration = value ?? fallback;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > maximum
  ) {
    throw new ShippingValidationError(
      `${field} must be a positive bounded duration.`,
    );
  }
  return duration;
}

function confirmationDigest(value: ShippingConfirmation): AutopilotDigest {
  return autopilotRecordDigest(value);
}

function challengeBody(
  challenge: ShippingConfirmationChallenge,
): Omit<ShippingConfirmationChallenge, "digest"> {
  const { digest: _digest, ...body } = challenge;
  return body;
}

function preflightBody(
  preflight: ShippingPreflight,
): Omit<ShippingPreflight, "digest"> {
  const { digest: _digest, ...body } = preflight;
  return body;
}

function compensationBody(
  preflight: CompensationPreflight,
): Omit<CompensationPreflight, "digest"> {
  const { digest: _digest, ...body } = preflight;
  return body;
}

function resultReceiptStatus(
  result: ProviderMutationResult,
): ExternalEffectReceipt["status"] {
  return result.status;
}

function proofEvidenceIds(
  preflight: ShippingPreflight,
  receipt: ExternalEffectReceipt,
): string[] {
  const obligationEvidence = preflight.taskPlan.proofObligations
    .filter((obligation) =>
      preflight.effectPlan.preconditionProofObligationIds.includes(
        obligation.id,
      ),
    )
    .flatMap((obligation) => obligation.evidenceIds);
  return unique([
    ...obligationEvidence,
    ...preflight.inspection.evidenceIds,
    ...receipt.resultEvidenceIds,
    `external-effect-receipt:${receipt.digest}`,
  ]);
}

function hasExactKeys(
  value: object,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export class StructuredShippingService {
  readonly #executor: StructuredShippingServiceOptions["executor"];
  readonly #ledger: StructuredShippingServiceOptions["ledger"];
  readonly #vault: StructuredShippingServiceOptions["vault"];
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: StructuredShippingServiceOptions) {
    this.#executor = options.executor;
    this.#ledger = options.ledger;
    this.#vault = options.vault;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    if (
      !options.allowVolatileState &&
      (options.ledger.durability !== "persistent" ||
        options.vault.durability !== "persistent")
    ) {
      throw new ShippingStateError(
        "External mutations require persistent shipping state; volatile state must be explicitly enabled for tests.",
      );
    }
  }

  #assertSupport(effect: ShippingEffect): void {
    const executor = this.#executor;
    const supported =
      effect.kind === "github_push"
        ? executor.inspectGitHubPush &&
          executor.pushGitHub &&
          executor.compensateGitHubPush
        : effect.kind === "github_pull_request"
          ? executor.inspectGitHubPullRequest &&
            executor.createGitHubPullRequest &&
            executor.compensateGitHubPullRequest
          : effect.kind === "cloudflare_pages_deploy"
            ? executor.inspectCloudflarePages &&
              executor.deployCloudflarePages &&
              executor.compensateCloudflarePages
            : executor.inspectCloudflareWorkers &&
              executor.deployCloudflareWorkers &&
              executor.compensateCloudflareWorkers;
    if (!supported) {
      throw new ShippingUnsupportedError(
        "The exact mutation, inspection, and compensation adapters are required.",
      );
    }
  }

  async #inspect(
    effect: ShippingEffect,
    credentialHandle: ReturnType<typeof validateCredentialHandle>,
  ): Promise<ShippingInspection> {
    switch (effect.kind) {
      case "github_push":
        return validateInspection(
          await this.#executor.inspectGitHubPush!(effect, credentialHandle),
          effect,
        );
      case "github_pull_request":
        return validateInspection(
          await this.#executor.inspectGitHubPullRequest!(
            effect,
            credentialHandle,
          ),
          effect,
        );
      case "cloudflare_pages_deploy":
        return validateInspection(
          await this.#executor.inspectCloudflarePages!(
            effect,
            credentialHandle,
          ),
          effect,
        );
      case "cloudflare_workers_deploy":
        return validateInspection(
          await this.#executor.inspectCloudflareWorkers!(
            effect,
            credentialHandle,
          ),
          effect,
        );
    }
  }

  async #mutate(
    effect: ShippingEffect,
    credentialHandle: ReturnType<typeof validateCredentialHandle>,
    idempotencyKey: string,
  ): Promise<ProviderMutationResult> {
    switch (effect.kind) {
      case "github_push":
        return validateMutationResult(
          await this.#executor.pushGitHub!({
            effect,
            credentialHandle,
            idempotencyKey,
          }),
        );
      case "github_pull_request":
        return validateMutationResult(
          await this.#executor.createGitHubPullRequest!({
            effect,
            credentialHandle,
            idempotencyKey,
          }),
        );
      case "cloudflare_pages_deploy":
        return validateMutationResult(
          await this.#executor.deployCloudflarePages!({
            effect,
            credentialHandle,
            idempotencyKey,
          }),
        );
      case "cloudflare_workers_deploy":
        return validateMutationResult(
          await this.#executor.deployCloudflareWorkers!({
            effect,
            credentialHandle,
            idempotencyKey,
          }),
        );
    }
  }

  async #compensate(
    effect: ShippingEffect,
    request: Omit<ShippingCompensationRequest, "effect">,
  ): Promise<ProviderCompensationResult> {
    switch (effect.kind) {
      case "github_push":
        return validateCompensationResult(
          await this.#executor.compensateGitHubPush!({
            ...request,
            effect,
          } as ShippingCompensationRequest<GitHubPushEffect>),
        );
      case "github_pull_request":
        return validateCompensationResult(
          await this.#executor.compensateGitHubPullRequest!({
            ...request,
            effect,
          } as ShippingCompensationRequest<GitHubPullRequestEffect>),
        );
      case "cloudflare_pages_deploy":
        return validateCompensationResult(
          await this.#executor.compensateCloudflarePages!({
            ...request,
            effect,
          } as ShippingCompensationRequest<CloudflarePagesEffect>),
        );
      case "cloudflare_workers_deploy":
        return validateCompensationResult(
          await this.#executor.compensateCloudflareWorkers!({
            ...request,
            effect,
          } as ShippingCompensationRequest<CloudflareWorkersEffect>),
        );
    }
  }

  #createChallenge(input: {
    operation: "execute" | "compensate";
    effectPlanDigest: AutopilotDigest;
    operationDigest: AutopilotDigest;
    credentialBindingDigest: AutopilotDigest;
    summary: string;
    expiresInMs?: number;
  }): ShippingConfirmationChallenge {
    const createdAt = this.#now();
    const expiresInMs = boundedDuration(
      input.expiresInMs,
      DEFAULT_CONFIRMATION_MS,
      MAX_CONFIRMATION_MS,
      "Confirmation window",
    );
    const body: Omit<ShippingConfirmationChallenge, "digest"> = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      id: this.#createId(),
      operation: input.operation,
      effectPlanDigest: input.effectPlanDigest,
      operationDigest: input.operationDigest,
      credentialBindingDigest: input.credentialBindingDigest,
      summary: input.summary,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + expiresInMs).toISOString(),
    };
    return { ...body, digest: autopilotRecordDigest(body) };
  }

  #verifyConfirmation(
    challenge: ShippingConfirmationChallenge,
    confirmation: ShippingConfirmation,
  ): void {
    if (
      !hasExactKeys(challenge, [
        "schemaVersion",
        "id",
        "operation",
        "effectPlanDigest",
        "operationDigest",
        "credentialBindingDigest",
        "summary",
        "createdAt",
        "expiresAt",
        "digest",
      ]) ||
      challenge.schemaVersion !== SHIPPING_SCHEMA_VERSION ||
      challenge.digest !== autopilotRecordDigest(challengeBody(challenge))
    ) {
      throw new ShippingConfirmationError(
        "Shipping confirmation challenge failed digest verification.",
      );
    }
    if (
      !hasExactKeys(confirmation, [
        "schemaVersion",
        "challengeDigest",
        "decision",
        "confirmedBy",
        "confirmedAt",
      ]) ||
      confirmation.schemaVersion !== SHIPPING_SCHEMA_VERSION ||
      confirmation.decision !== "confirmed" ||
      confirmation.confirmedBy !== "user" ||
      confirmation.challengeDigest !== challenge.digest
    ) {
      throw new ShippingConfirmationError(
        "Shipping confirmation does not authorize this exact operation.",
      );
    }
    const confirmedAt = Date.parse(confirmation.confirmedAt);
    const createdAt = Date.parse(challenge.createdAt);
    const expiresAt = Date.parse(challenge.expiresAt);
    const now = this.#now().getTime();
    if (
      !Number.isFinite(confirmedAt) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      confirmedAt < createdAt ||
      confirmedAt >= expiresAt ||
      confirmedAt > now + MAX_CONFIRMATION_CLOCK_SKEW_MS ||
      now >= expiresAt
    ) {
      throw new ShippingConfirmationError(
        "Shipping confirmation is expired or has an invalid timestamp.",
      );
    }
  }

  #verifyPreflight(preflight: ShippingPreflight): ShippingEffect {
    if (
      !hasExactKeys(preflight, [
        "schemaVersion",
        "taskPlan",
        "effect",
        "effectDigest",
        "effectPlan",
        "inspection",
        "inspectionDigest",
        "credentialBindingDigest",
        "challenge",
        "digest",
      ]) ||
      preflight.schemaVersion !== SHIPPING_SCHEMA_VERSION ||
      preflight.digest !== autopilotRecordDigest(preflightBody(preflight))
    ) {
      throw new ShippingValidationError(
        "Shipping preflight failed digest verification.",
      );
    }
    const effect = validateShippingEffect(preflight.effect);
    this.#assertSupport(effect);
    if (preflight.effectDigest !== autopilotRecordDigest(effect)) {
      throw new ShippingValidationError("Shipping effect digest changed.");
    }
    const capability = effectCapability(effect);
    const proof = validateTaskPlanForShipping(
      preflight.taskPlan,
      preflight.effectPlan.stepId,
      capability,
    );
    const effectPlanVerification = verifyExternalEffectPlan(
      preflight.effectPlan,
    );
    if (
      !effectPlanVerification.valid ||
      preflight.effectPlan.kind !== effectPlanKind(effect) ||
      preflight.effectPlan.summary !== effectSummary(effect) ||
      preflight.effectPlan.requiredCapability !== capability ||
      preflight.effectPlan.target.kind !== effectTargetKind(effect) ||
      preflight.effectPlan.target.displayName !==
        effectTargetDisplayName(effect) ||
      preflight.effectPlan.target.locatorDigest !==
        targetLocatorDigest(effect) ||
      autopilotRecordDigest(preflight.effectPlan.target.allowedDomains) !==
        autopilotRecordDigest(effectAllowedDomains(effect)) ||
      autopilotRecordDigest(preflight.effectPlan.recovery) !==
        autopilotRecordDigest(effectRecovery(effect)) ||
      autopilotRecordDigest(
        preflight.effectPlan.preconditionProofObligationIds,
      ) !== autopilotRecordDigest(proof.preconditionIds) ||
      preflight.effectPlan.digest !==
        preflight.challenge.effectPlanDigest ||
      preflight.effectPlan.planDigest !== preflight.taskPlan.digest ||
      preflight.effectPlan.taskId !== preflight.taskPlan.taskId ||
      preflight.effectPlan.idempotencyKeyDigest === undefined
    ) {
      throw new ShippingValidationError(
        "External effect plan does not match this preflight.",
      );
    }
    if (this.#now().getTime() >= Date.parse(preflight.effectPlan.expiresAt)) {
      throw new ShippingValidationError("External effect plan has expired.");
    }
    const normalizedInspection = validateInspection(
      preflight.inspection,
      effect,
    );
    if (
      preflight.inspectionDigest !==
      autopilotRecordDigest(normalizedInspection)
    ) {
      throw new ShippingValidationError("Shipping inspection digest changed.");
    }
    const expectedOperationDigest = autopilotRecordDigest({
      operation: "execute",
      effectPlanDigest: preflight.effectPlan.digest,
      effectDigest: preflight.effectDigest,
      inspectionDigest: preflight.inspectionDigest,
    });
    if (
      !hasExactKeys(preflight.challenge, [
        "schemaVersion",
        "id",
        "operation",
        "effectPlanDigest",
        "operationDigest",
        "credentialBindingDigest",
        "summary",
        "createdAt",
        "expiresAt",
        "digest",
      ]) ||
      preflight.challenge.digest !==
        autopilotRecordDigest(challengeBody(preflight.challenge)) ||
      preflight.challenge.operation !== "execute" ||
      preflight.challenge.operationDigest !== expectedOperationDigest ||
      preflight.challenge.credentialBindingDigest !==
        preflight.credentialBindingDigest ||
      preflight.challenge.summary !== preflight.effectPlan.summary
    ) {
      throw new ShippingValidationError(
        "Shipping confirmation challenge does not match the exact effect.",
      );
    }
    return effect;
  }

  async prepare(input: PrepareShippingInput): Promise<ShippingPreflight> {
    const effect = validateShippingEffect(input.effect);
    this.#assertSupport(effect);
    const provider = effectProvider(effect);
    const credentialHandle = validateCredentialHandle(
      input.credentialHandle,
      provider,
    );
    const key = validateIdempotencyKey(input.idempotencyKey);
    const capability = effectCapability(effect);
    const proof = validateTaskPlanForShipping(
      input.taskPlan,
      input.stepId,
      capability,
    );
    let inspection: ShippingInspection;
    try {
      inspection = await this.#inspect(effect, credentialHandle);
    } catch (error) {
      if (error instanceof ShippingValidationError) throw error;
      throw new ShippingStateError(
        "The provider target could not be inspected safely.",
      );
    }
    const createdAt = this.#now();
    const expiresInMs = boundedDuration(
      input.expiresInMs,
      DEFAULT_CONFIRMATION_MS,
      MAX_CONFIRMATION_MS,
      "Preflight window",
    );
    const effectPlan = createExternalEffectPlan({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: this.#createId(),
      taskId: input.taskPlan.taskId,
      planId: input.taskPlan.id,
      planDigest: input.taskPlan.digest,
      stepId: input.stepId,
      kind: effectPlanKind(effect),
      summary: effectSummary(effect),
      target: {
        kind: effectTargetKind(effect),
        displayName: effectTargetDisplayName(effect),
        locatorDigest: targetLocatorDigest(effect),
        allowedDomains: effectAllowedDomains(effect),
      },
      preconditionProofObligationIds: proof.preconditionIds,
      requiredCapability: capability,
      idempotencyKeyDigest: idempotencyDigest(key),
      approvalRequired: true,
      recovery: effectRecovery(effect),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + expiresInMs).toISOString(),
    });
    const effectDigest = autopilotRecordDigest(effect);
    const inspectionDigest = autopilotRecordDigest(inspection);
    const credentialDigest = credentialBindingDigest(credentialHandle);
    const operationDigest = autopilotRecordDigest({
      operation: "execute",
      effectPlanDigest: effectPlan.digest,
      effectDigest,
      inspectionDigest,
    });
    const challenge = this.#createChallenge({
      operation: "execute",
      effectPlanDigest: effectPlan.digest,
      operationDigest,
      credentialBindingDigest: credentialDigest,
      summary: effectPlan.summary,
      expiresInMs,
    });
    const body: Omit<ShippingPreflight, "digest"> = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      taskPlan: input.taskPlan,
      effect,
      effectDigest,
      effectPlan,
      inspection,
      inspectionDigest,
      credentialBindingDigest: credentialDigest,
      challenge,
    };
    return { ...body, digest: autopilotRecordDigest(body) };
  }

  verifyAuthorization(
    input: VerifyShippingAuthorizationInput,
  ): ShippingAuthorization {
    const effect = this.#verifyPreflight(input.preflight);
    this.#assertSupport(effect);
    const credentialHandle = validateCredentialHandle(
      input.credentialHandle,
      effectProvider(effect),
    );
    const credentialDigest = credentialBindingDigest(credentialHandle);
    if (
      credentialDigest !== input.preflight.credentialBindingDigest ||
      credentialDigest !==
        input.preflight.challenge.credentialBindingDigest
    ) {
      throw new ShippingConfirmationError(
        "Credential handle changed after shipping preflight.",
      );
    }
    const keyDigest = idempotencyDigest(
      validateIdempotencyKey(input.idempotencyKey),
    );
    if (keyDigest !== input.preflight.effectPlan.idempotencyKeyDigest) {
      throw new ShippingConfirmationError(
        "Idempotency value changed after shipping preflight.",
      );
    }
    this.#verifyConfirmation(input.preflight.challenge, input.confirmation);
    const body: Omit<ShippingAuthorization, "digest"> = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectPlanDigest: input.preflight.effectPlan.digest,
      operationDigest: input.preflight.challenge.operationDigest,
      challengeDigest: input.preflight.challenge.digest,
      credentialBindingDigest: credentialDigest,
      idempotencyKeyDigest: keyDigest,
      approvalReceiptDigest: confirmationDigest(input.confirmation),
      confirmedAt: input.confirmation.confirmedAt,
    };
    return { ...body, digest: autopilotRecordDigest(body) };
  }

  async execute(input: ExecuteShippingInput): Promise<ShippingExecutionResult> {
    const effect = this.#verifyPreflight(input.preflight);
    this.#assertSupport(effect);
    const credentialHandle = validateCredentialHandle(
      input.credentialHandle,
      effectProvider(effect),
    );
    if (
      credentialBindingDigest(credentialHandle) !==
        input.preflight.credentialBindingDigest ||
      credentialBindingDigest(credentialHandle) !==
        input.preflight.challenge.credentialBindingDigest
    ) {
      throw new ShippingConfirmationError(
        "Credential handle changed after shipping preflight.",
      );
    }
    const key = validateIdempotencyKey(input.idempotencyKey);
    const keyDigest = idempotencyDigest(key);
    if (keyDigest !== input.preflight.effectPlan.idempotencyKeyDigest) {
      throw new ShippingConfirmationError(
        "Idempotency value changed after shipping preflight.",
      );
    }
    this.#verifyConfirmation(input.preflight.challenge, input.confirmation);
    const startedAt = this.#now().toISOString();
    const approvalReceiptDigest = confirmationDigest(input.confirmation);
    await this.#ledger.reserve({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      idempotencyKeyDigest: keyDigest,
      operationDigest: input.preflight.challenge.operationDigest,
      effectPlanDigest: input.preflight.effectPlan.digest,
      confirmationDigest: approvalReceiptDigest,
      operation: "execute",
      state: "reserved",
      reservedAt: startedAt,
    });

    let latest: ShippingInspection;
    try {
      latest = await this.#inspect(effect, credentialHandle);
    } catch {
      const completedAt = this.#now().toISOString();
      const receipt = createExternalEffectReceipt({
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: this.#createId(),
        taskId: input.preflight.effectPlan.taskId,
        effectPlanId: input.preflight.effectPlan.id,
        effectPlanDigest: input.preflight.effectPlan.digest,
        status: "refused",
        approvalReceiptDigest,
        preflightEvidenceIds: input.preflight.inspection.evidenceIds,
        resultEvidenceIds: [],
        providerReceiptDigests: [],
        summary:
          "Shipping was refused because the provider target could not be revalidated after confirmation.",
        startedAt,
        completedAt,
      });
      await this.#ledger.complete(
        keyDigest,
        input.preflight.challenge.operationDigest,
        receipt.digest,
        completedAt,
      );
      return { receipt, compensationAvailable: false };
    }
    if (autopilotRecordDigest(latest) !== input.preflight.inspectionDigest) {
      const completedAt = this.#now().toISOString();
      const receipt = createExternalEffectReceipt({
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: this.#createId(),
        taskId: input.preflight.effectPlan.taskId,
        effectPlanId: input.preflight.effectPlan.id,
        effectPlanDigest: input.preflight.effectPlan.digest,
        status: "refused",
        approvalReceiptDigest,
        preflightEvidenceIds: unique([
          ...input.preflight.inspection.evidenceIds,
          ...latest.evidenceIds,
        ]),
        resultEvidenceIds: [],
        providerReceiptDigests: [],
        summary:
          "Shipping was refused because the exact target state changed after confirmation.",
        startedAt,
        completedAt,
      });
      await this.#ledger.complete(
        keyDigest,
        input.preflight.challenge.operationDigest,
        receipt.digest,
        completedAt,
      );
      return { receipt, compensationAvailable: false };
    }

    let result: ProviderMutationResult;
    let providerAdapterFailed = false;
    try {
      result = await this.#mutate(effect, credentialHandle, key);
    } catch {
      providerAdapterFailed = true;
      result = {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "failed",
        summary:
          "The structured provider adapter failed before a verified effect could be established.",
        targetStateDigest: input.preflight.inspection.currentStateDigest,
        evidenceIds: ["shipping:provider-adapter-failure"],
        providerReceiptHandle: `failure:${this.#createId()}`,
      };
    }

    const completedAt = this.#now().toISOString();
    const providerReceiptDigest = autopilotRecordDigest({
      providerReceiptHandle: result.providerReceiptHandle,
    });
    let compensationAvailable =
      result.status !== "failed" && Boolean(result.compensationHandle);
    const receipt = createExternalEffectReceipt({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: this.#createId(),
      taskId: input.preflight.effectPlan.taskId,
      effectPlanId: input.preflight.effectPlan.id,
      effectPlanDigest: input.preflight.effectPlan.digest,
      status: resultReceiptStatus(result),
      approvalReceiptDigest,
      preflightEvidenceIds: input.preflight.inspection.evidenceIds,
      resultEvidenceIds: result.evidenceIds,
      providerReceiptDigests: providerAdapterFailed
        ? []
        : [providerReceiptDigest],
      summary: result.summary,
      startedAt,
      completedAt,
    });

    if (compensationAvailable && result.compensationHandle) {
      try {
        await this.#vault.putCompensationHandle(
          input.preflight.effectPlan.digest,
          receipt.digest,
          result.compensationHandle,
        );
      } catch {
        compensationAvailable = false;
      }
    }
    await this.#ledger.complete(
      keyDigest,
      input.preflight.challenge.operationDigest,
      receipt.digest,
      completedAt,
    );

    if (receipt.status !== "succeeded" || !compensationAvailable) {
      return { receipt, compensationAvailable: false };
    }
    const leaseTtl = boundedDuration(
      input.lease.ttlMs,
      MAX_PROOF_LEASE_MS,
      MAX_PROOF_LEASE_MS,
      "Proof Lease duration",
    );
    const evidenceIds = proofEvidenceIds(input.preflight, receipt);
    const proofLease = createProofLease({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: this.#createId(),
      taskId: input.preflight.taskPlan.taskId,
      planId: input.preflight.taskPlan.id,
      planRevision: input.preflight.taskPlan.revision,
      planDigest: input.preflight.taskPlan.digest,
      proofObligationIds:
        input.preflight.effectPlan.preconditionProofObligationIds,
      evidenceIds,
      subjectDigest: effectSubjectDigest(effect),
      environmentDigest: input.lease.environmentDigest,
      policyDigest: input.lease.policyDigest,
      toolchainDigest: input.lease.toolchainDigest,
      issuedBy: input.lease.issuedBy,
      issuedAt: completedAt,
      expiresAt: new Date(Date.parse(completedAt) + leaseTtl).toISOString(),
    });
    return { receipt, proofLease, compensationAvailable };
  }

  async prepareCompensation(
    input: PrepareCompensationInput,
  ): Promise<CompensationPreflight> {
    const effect = this.#verifyPreflight(input.preflight);
    this.#assertSupport(effect);
    if (
      !verifyExternalEffectReceipt(input.receipt).valid ||
      input.receipt.effectPlanId !== input.preflight.effectPlan.id ||
      input.receipt.effectPlanDigest !== input.preflight.effectPlan.digest ||
      !["succeeded", "partially_succeeded"].includes(input.receipt.status)
    ) {
      throw new ShippingValidationError(
        "Only a matching successful shipping receipt can be compensated.",
      );
    }
    const credentialHandle = validateCredentialHandle(
      input.credentialHandle,
      effectProvider(effect),
    );
    const credentialDigest = credentialBindingDigest(credentialHandle);
    if (credentialDigest !== input.preflight.credentialBindingDigest) {
      throw new ShippingConfirmationError(
        "Compensation credential handle does not match the shipped effect.",
      );
    }
    const key = validateIdempotencyKey(input.idempotencyKey);
    const reason = input.reason.trim();
    if (
      reason.length < 3 ||
      reason.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(reason) ||
      redactText(reason) !== reason
    ) {
      throw new ShippingValidationError(
        "Compensation requires a bounded human-readable reason.",
      );
    }
    const handle = await this.#vault.getCompensationHandle(
      input.preflight.effectPlan.digest,
      input.receipt.digest,
    );
    if (!handle) {
      throw new ShippingUnsupportedError(
        "No verified compensation handle is available for this receipt.",
      );
    }
    const operationDigest = autopilotRecordDigest({
      operation: "compensate",
      originalPreflightDigest: input.preflight.digest,
      originalReceiptDigest: input.receipt.digest,
      idempotencyKeyDigest: idempotencyDigest(key),
      reason,
    });
    const challenge = this.#createChallenge({
      operation: "compensate",
      effectPlanDigest: input.preflight.effectPlan.digest,
      operationDigest,
      credentialBindingDigest: credentialDigest,
      summary: `Compensate: ${input.preflight.effectPlan.summary}`,
      expiresInMs: input.expiresInMs,
    });
    const body: Omit<CompensationPreflight, "digest"> = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      originalPreflightDigest: input.preflight.digest,
      originalReceipt: input.receipt,
      originalReceiptDigest: input.receipt.digest,
      credentialBindingDigest: credentialDigest,
      reason,
      challenge,
    };
    return { ...body, digest: autopilotRecordDigest(body) };
  }

  async compensate(
    input: ExecuteCompensationInput,
  ): Promise<ShippingCompensationResult> {
    const effect = this.#verifyPreflight(input.originalPreflight);
    this.#assertSupport(effect);
    if (
      !hasExactKeys(input.compensation, [
        "schemaVersion",
        "originalPreflightDigest",
        "originalReceipt",
        "originalReceiptDigest",
        "credentialBindingDigest",
        "reason",
        "challenge",
        "digest",
      ]) ||
      input.compensation.schemaVersion !== SHIPPING_SCHEMA_VERSION ||
      input.compensation.digest !==
        autopilotRecordDigest(compensationBody(input.compensation)) ||
      input.compensation.originalPreflightDigest !==
        input.originalPreflight.digest ||
      input.compensation.originalReceiptDigest !==
        input.compensation.originalReceipt.digest ||
      !verifyExternalEffectReceipt(input.compensation.originalReceipt).valid
    ) {
      throw new ShippingValidationError(
        "Compensation preflight failed verification.",
      );
    }
    if (
      input.compensation.challenge.operation !== "compensate" ||
      input.compensation.challenge.effectPlanDigest !==
        input.originalPreflight.effectPlan.digest ||
      input.compensation.challenge.credentialBindingDigest !==
        input.compensation.credentialBindingDigest
    ) {
      throw new ShippingValidationError(
        "Compensation challenge does not match the original effect.",
      );
    }
    const credentialHandle = validateCredentialHandle(
      input.credentialHandle,
      effectProvider(effect),
    );
    if (
      credentialBindingDigest(credentialHandle) !==
        input.compensation.credentialBindingDigest
    ) {
      throw new ShippingConfirmationError(
        "Compensation credential handle changed.",
      );
    }
    const key = validateIdempotencyKey(input.idempotencyKey);
    const expectedOperationDigest = autopilotRecordDigest({
      operation: "compensate",
      originalPreflightDigest: input.originalPreflight.digest,
      originalReceiptDigest: input.compensation.originalReceipt.digest,
      idempotencyKeyDigest: idempotencyDigest(key),
      reason: input.compensation.reason,
    });
    if (
      expectedOperationDigest !==
        input.compensation.challenge.operationDigest
    ) {
      throw new ShippingConfirmationError(
        "Compensation idempotency value changed.",
      );
    }
    if (
      input.proofLease &&
      (!verifyProofLease(input.proofLease).valid ||
        input.proofLease.taskId !==
          input.compensation.originalReceipt.taskId ||
        input.proofLease.planDigest !==
          input.originalPreflight.taskPlan.digest)
    ) {
      throw new ShippingValidationError(
        "Proof Lease does not belong to the compensated release.",
      );
    }
    this.#verifyConfirmation(
      input.compensation.challenge,
      input.confirmation,
    );
    const compensationHandle = await this.#vault.getCompensationHandle(
      input.originalPreflight.effectPlan.digest,
      input.compensation.originalReceipt.digest,
    );
    if (!compensationHandle) {
      throw new ShippingUnsupportedError(
        "Compensation handle is unavailable; mutation was refused.",
      );
    }

    const startedAt = this.#now().toISOString();
    const keyDigest = idempotencyDigest(key);
    const approvalReceiptDigest = confirmationDigest(input.confirmation);
    await this.#ledger.reserve({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      idempotencyKeyDigest: keyDigest,
      operationDigest: expectedOperationDigest,
      effectPlanDigest: input.originalPreflight.effectPlan.digest,
      confirmationDigest: approvalReceiptDigest,
      operation: "compensate",
      state: "reserved",
      reservedAt: startedAt,
    });

    let result: ProviderCompensationResult;
    let compensationAdapterFailed = false;
    try {
      result = await this.#compensate(effect, {
        credentialHandle,
        idempotencyKey: key,
        originalEffectPlanDigest:
          input.originalPreflight.effectPlan.digest,
        originalReceiptDigest: input.compensation.originalReceipt.digest,
        compensationHandle,
        reason: input.compensation.reason,
      });
    } catch {
      compensationAdapterFailed = true;
      result = {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "failed",
        summary:
          "The structured compensation adapter failed before recovery could be established.",
        targetStateDigest:
          input.originalPreflight.inspection.currentStateDigest,
        evidenceIds: ["shipping:compensation-adapter-failure"],
        providerReceiptHandle: `failure:${this.#createId()}`,
      };
    }
    const completedAt = this.#now().toISOString();
    const compensationReceiptDigest = autopilotRecordDigest({
      providerReceiptHandle: result.providerReceiptHandle,
    });
    const status =
      result.status === "succeeded"
        ? "compensated"
        : result.status;
    const receipt = createExternalEffectReceipt({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: this.#createId(),
      taskId: input.originalPreflight.effectPlan.taskId,
      effectPlanId: input.originalPreflight.effectPlan.id,
      effectPlanDigest: input.originalPreflight.effectPlan.digest,
      status,
      approvalReceiptDigest,
      preflightEvidenceIds:
        input.originalPreflight.inspection.evidenceIds,
      resultEvidenceIds: result.evidenceIds,
      providerReceiptDigests: compensationAdapterFailed
        ? []
        : [compensationReceiptDigest],
      summary: result.summary,
      startedAt,
      completedAt,
      ...(status === "compensated"
        ? { compensationReceiptDigest }
        : {}),
    });
    await this.#ledger.complete(
      keyDigest,
      expectedOperationDigest,
      receipt.digest,
      completedAt,
    );

    let proofLeaseInvalidation;
    if (
      input.proofLease &&
      ["compensated", "partially_succeeded"].includes(receipt.status)
    ) {
      proofLeaseInvalidation = createProofLeaseInvalidation({
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: this.#createId(),
        taskId: input.proofLease.taskId,
        leaseId: input.proofLease.id,
        leaseDigest: input.proofLease.digest,
        reason: "manual",
        details:
          "The shipped external effect was compensated and is no longer the verified active release.",
        invalidatedBy: "system",
        causedByDigest: receipt.digest,
        invalidatedAt: completedAt,
      });
    }
    return {
      receipt,
      ...(proofLeaseInvalidation ? { proofLeaseInvalidation } : {}),
    };
  }
}
