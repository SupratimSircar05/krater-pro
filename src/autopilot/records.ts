import {
  canonicalStringify,
  isSha256Digest,
  sha256Digest,
  verifySha256Digest,
} from "../proofgraph/canonical.js";
import { redactForPersistence } from "../proofgraph/redaction.js";
import {
  AUTOPILOT_SCHEMA_VERSION,
  type AgentDelegation,
  type AutopilotDigest,
  type AutopilotRecordVerification,
  type ExternalEffectPlan,
  type ExternalEffectReceipt,
  type PlanStep,
  type ProductionObservation,
  type ProofLease,
  type ProofLeaseInvalidation,
  type ProofObligation,
  type TaskPlan,
} from "./types.js";

export const MAX_PROOF_LEASE_MS = 24 * 60 * 60 * 1_000;
export const MAX_EXTERNAL_EFFECT_PLAN_MS = 24 * 60 * 60 * 1_000;

type DigestedRecord = { digest: AutopilotDigest };
type RecordInput<T extends DigestedRecord> = Omit<T, "digest">;

const PLAN_STATUSES = new Set([
  "draft",
  "approved",
  "active",
  "closed",
  "completed",
  "cancelled",
]);
const STEP_KINDS = new Set([
  "clarify",
  "discover",
  "reproduce",
  "implement",
  "debug",
  "verify",
  "review",
  "publish",
  "external_effect",
]);
const STEP_STATUSES = new Set([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "skipped",
  "cancelled",
]);
const OBLIGATION_KINDS = new Set([
  "acceptance_criterion",
  "negative_guarantee",
  "regression",
  "security",
  "performance",
  "reliability",
  "publication_precondition",
  "production_observation",
]);
const OBLIGATION_STATUSES = new Set([
  "pending",
  "satisfied",
  "failed",
  "not_applicable",
  "waived",
]);
const EVIDENCE_GRADES = new Set([
  "not_established",
  "observed",
  "tested",
  "stress_tested",
  "formally_verified",
]);
const DELEGATION_ROLES = new Set([
  "primary",
  "specialist",
  "debugger",
  "verifier",
  "reviewer",
]);
const DELEGATION_STATUSES = new Set([
  "planned",
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const EFFECT_KINDS = new Set([
  "git_push",
  "pull_request",
  "deployment",
  "migration",
  "external_api_mutation",
  "release",
  "other",
]);
const EFFECT_TARGET_KINDS = new Set([
  "git_remote",
  "repository",
  "environment",
  "database",
  "api",
]);
const EFFECT_RECEIPT_STATUSES = new Set([
  "succeeded",
  "failed",
  "partially_succeeded",
  "refused",
  "compensated",
]);
const LEASE_ISSUERS = new Set(["host_verifier", "blind_verifier", "human"]);
const INVALIDATION_REASONS = new Set([
  "plan_revision",
  "subject_changed",
  "environment_changed",
  "policy_changed",
  "toolchain_changed",
  "evidence_stale",
  "security_event",
  "manual",
]);
const OBSERVATION_ENVIRONMENTS = new Set([
  "local",
  "staging",
  "canary",
  "production",
]);
const OBSERVATION_SOURCES = new Set([
  "health_check",
  "metric",
  "log",
  "trace",
  "synthetic",
  "human",
]);
const OBSERVATION_STATUSES = new Set([
  "healthy",
  "degraded",
  "failed",
  "unknown",
]);

function recordBody<T extends DigestedRecord>(value: T): Omit<T, "digest"> {
  const { digest: _digest, ...body } = value;
  return body;
}

export function autopilotRecordDigest(value: unknown): AutopilotDigest {
  return sha256Digest(canonicalStringify(value)) as AutopilotDigest;
}

function createRecord<T extends DigestedRecord>(input: RecordInput<T>): T {
  const body = redactForPersistence(input);
  return {
    ...body,
    digest: autopilotRecordDigest(body),
  } as T;
}

function nonEmpty(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string.`);
  }
}

function timestamp(
  value: unknown,
  field: string,
  errors: string[],
): number | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    errors.push(`${field} must be an ISO-compatible timestamp.`);
    return undefined;
  }
  return Date.parse(value);
}

function digest(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || !isSha256Digest(value)) {
    errors.push(`${field} must be a SHA-256 digest.`);
  }
}

function optionalDigest(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (value !== undefined) digest(value, field, errors);
}

function stringArray(
  value: unknown,
  field: string,
  errors: string[],
  options: { nonEmpty?: boolean; digests?: boolean } = {},
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    errors.push(`${field} must contain only non-empty strings.`);
    return [];
  }
  if (options.nonEmpty && value.length === 0) {
    errors.push(`${field} must not be empty.`);
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${field} must not contain duplicates.`);
  }
  if (options.digests) {
    value.forEach((item, index) => digest(item, `${field}[${index}]`, errors));
  }
  return value;
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  errors: string[],
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    errors.push(`${field} has an unsupported value.`);
  }
}

function validateSchema(
  value: { schemaVersion?: unknown },
  label: string,
  errors: string[],
): void {
  if (value.schemaVersion !== AUTOPILOT_SCHEMA_VERSION) {
    errors.push(`${label} has an unsupported schema version.`);
  }
}

function validatePlanStep(
  step: PlanStep,
  taskId: string,
  errors: string[],
): void {
  validateSchema(step, `Plan step ${step?.id ?? ""}`, errors);
  nonEmpty(step.id, "Plan step ID", errors);
  if (step.taskId !== taskId) {
    errors.push(`Plan step ${step.id} has a mismatched task ID.`);
  }
  enumValue(step.kind, STEP_KINDS, `Plan step ${step.id} kind`, errors);
  enumValue(step.status, STEP_STATUSES, `Plan step ${step.id} status`, errors);
  nonEmpty(step.title, `Plan step ${step.id} title`, errors);
  nonEmpty(step.description, `Plan step ${step.id} description`, errors);
  stringArray(
    step.dependsOnStepIds,
    `Plan step ${step.id} dependencies`,
    errors,
  );
  stringArray(
    step.proofObligationIds,
    `Plan step ${step.id} proof obligations`,
    errors,
  );
  stringArray(
    step.allowedCapabilities,
    `Plan step ${step.id} capabilities`,
    errors,
  );
  if (step.assignedDelegationId !== undefined) {
    nonEmpty(
      step.assignedDelegationId,
      `Plan step ${step.id} delegation ID`,
      errors,
    );
  }
  const createdAt = timestamp(
    step.createdAt,
    `Plan step ${step.id} createdAt`,
    errors,
  );
  const updatedAt = timestamp(
    step.updatedAt,
    `Plan step ${step.id} updatedAt`,
    errors,
  );
  if (createdAt !== undefined && updatedAt !== undefined && updatedAt < createdAt) {
    errors.push(`Plan step ${step.id} updatedAt precedes createdAt.`);
  }
}

function validateProofObligation(
  obligation: ProofObligation,
  taskId: string,
  errors: string[],
): void {
  validateSchema(obligation, `Proof obligation ${obligation?.id ?? ""}`, errors);
  nonEmpty(obligation.id, "Proof obligation ID", errors);
  if (obligation.taskId !== taskId) {
    errors.push(`Proof obligation ${obligation.id} has a mismatched task ID.`);
  }
  enumValue(
    obligation.kind,
    OBLIGATION_KINDS,
    `Proof obligation ${obligation.id} kind`,
    errors,
  );
  enumValue(
    obligation.status,
    OBLIGATION_STATUSES,
    `Proof obligation ${obligation.id} status`,
    errors,
  );
  enumValue(
    obligation.minimumGrade,
    EVIDENCE_GRADES,
    `Proof obligation ${obligation.id} minimum grade`,
    errors,
  );
  nonEmpty(
    obligation.statement,
    `Proof obligation ${obligation.id} statement`,
    errors,
  );
  if (typeof obligation.required !== "boolean") {
    errors.push(`Proof obligation ${obligation.id} required must be boolean.`);
  }
  stringArray(
    obligation.acceptanceCriterionIds,
    `Proof obligation ${obligation.id} acceptance criteria`,
    errors,
  );
  const evidenceIds = stringArray(
    obligation.evidenceIds,
    `Proof obligation ${obligation.id} evidence`,
    errors,
  );
  stringArray(
    obligation.scopeDigests,
    `Proof obligation ${obligation.id} scope digests`,
    errors,
    { digests: true },
  );
  if (obligation.status === "satisfied" && evidenceIds.length === 0) {
    errors.push(
      `Satisfied proof obligation ${obligation.id} requires supporting evidence.`,
    );
  }
  if (obligation.status === "not_applicable") {
    nonEmpty(
      obligation.nonApplicabilityReason,
      `Proof obligation ${obligation.id} non-applicability reason`,
      errors,
    );
    if (evidenceIds.length > 0) {
      errors.push(
        `Not-applicable proof obligation ${obligation.id} cannot claim supporting evidence.`,
      );
    }
  } else if (obligation.nonApplicabilityReason !== undefined) {
    errors.push(
      `Proof obligation ${obligation.id} has a non-applicability reason but is not marked not applicable.`,
    );
  }
  if (obligation.status === "waived") {
    if (!obligation.waiver) {
      errors.push(`Waived proof obligation ${obligation.id} requires a waiver.`);
    } else {
      if (obligation.waiver.approvedBy !== "user") {
        errors.push(`Proof obligation ${obligation.id} waiver must be user-approved.`);
      }
      nonEmpty(
        obligation.waiver.reason,
        `Proof obligation ${obligation.id} waiver reason`,
        errors,
      );
      digest(
        obligation.waiver.approvalReceiptDigest,
        `Proof obligation ${obligation.id} waiver receipt`,
        errors,
      );
      timestamp(
        obligation.waiver.approvedAt,
        `Proof obligation ${obligation.id} waiver approvedAt`,
        errors,
      );
    }
  } else if (obligation.waiver) {
    errors.push(
      `Proof obligation ${obligation.id} has a waiver but is not marked waived.`,
    );
  }
  const createdAt = timestamp(
    obligation.createdAt,
    `Proof obligation ${obligation.id} createdAt`,
    errors,
  );
  const updatedAt = timestamp(
    obligation.updatedAt,
    `Proof obligation ${obligation.id} updatedAt`,
    errors,
  );
  if (createdAt !== undefined && updatedAt !== undefined && updatedAt < createdAt) {
    errors.push(`Proof obligation ${obligation.id} updatedAt precedes createdAt.`);
  }
}

function validateStepGraph(steps: readonly PlanStep[], errors: string[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    for (const dependencyId of step.dependsOnStepIds) {
      if (!byId.has(dependencyId)) {
        errors.push(
          `Plan step ${step.id} references missing dependency ${dependencyId}.`,
        );
      }
      if (dependencyId === step.id) {
        errors.push(`Plan step ${step.id} cannot depend on itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) {
      errors.push(`Plan step dependency graph contains a cycle at ${stepId}.`);
      return;
    }
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    const step = byId.get(stepId);
    for (const dependency of step?.dependsOnStepIds ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function taskPlanErrors(plan: TaskPlan): string[] {
  const errors: string[] = [];
  validateSchema(plan, "Task plan", errors);
  nonEmpty(plan.id, "Task plan ID", errors);
  nonEmpty(plan.taskId, "Task plan task ID", errors);
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    errors.push("Task plan revision must be a positive safe integer.");
  }
  if (plan.revision === 1 && plan.previousPlanDigest !== undefined) {
    errors.push("The first task plan revision cannot reference a previous digest.");
  }
  if (plan.revision > 1 && !plan.previousPlanDigest) {
    errors.push("A revised task plan must reference the previous plan digest.");
  }
  optionalDigest(plan.previousPlanDigest, "Task plan previous digest", errors);
  optionalDigest(plan.contractDigest, "Task plan contract digest", errors);
  enumValue(plan.status, PLAN_STATUSES, "Task plan status", errors);
  nonEmpty(plan.objective, "Task plan objective", errors);
  enumValue(
    plan.createdBy,
    new Set(["user", "agent", "system"]),
    "Task plan creator",
    errors,
  );
  enumValue(
    plan.revisedBy,
    new Set(["user", "agent", "system"]),
    "Task plan reviser",
    errors,
  );
  nonEmpty(plan.revisionReason, "Task plan revision reason", errors);
  const createdAt = timestamp(plan.createdAt, "Task plan createdAt", errors);
  const revisedAt = timestamp(plan.revisedAt, "Task plan revisedAt", errors);
  if (createdAt !== undefined && revisedAt !== undefined && revisedAt < createdAt) {
    errors.push("Task plan revisedAt precedes createdAt.");
  }

  if (!Array.isArray(plan.steps) || !Array.isArray(plan.proofObligations)) {
    errors.push("Task plan steps and proof obligations must be arrays.");
    return errors;
  }
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    validatePlanStep(step, plan.taskId, errors);
    if (stepIds.has(step.id)) errors.push(`Duplicate plan step ID: ${step.id}.`);
    stepIds.add(step.id);
  }
  const obligationIds = new Set<string>();
  for (const obligation of plan.proofObligations) {
    validateProofObligation(obligation, plan.taskId, errors);
    if (obligationIds.has(obligation.id)) {
      errors.push(`Duplicate proof obligation ID: ${obligation.id}.`);
    }
    obligationIds.add(obligation.id);
  }
  for (const step of plan.steps) {
    for (const obligationId of step.proofObligationIds) {
      if (!obligationIds.has(obligationId)) {
        errors.push(
          `Plan step ${step.id} references missing proof obligation ${obligationId}.`,
        );
      }
    }
  }
  validateStepGraph(plan.steps, errors);

  if (plan.status === "completed" || plan.status === "closed") {
    const incompleteSteps = plan.steps.filter(
      (step) => !["completed", "skipped", "cancelled"].includes(step.status),
    );
    if (incompleteSteps.length) {
      errors.push(
        `A ${plan.status} task plan cannot retain incomplete steps.`,
      );
    }
  }
  if (plan.status === "completed") {
    const unsatisfied = plan.proofObligations.filter(
      (obligation) =>
        obligation.required &&
        !["satisfied", "waived"].includes(obligation.status),
    );
    if (unsatisfied.length) {
      errors.push(
        "A completed task plan cannot retain required unsatisfied proof obligations.",
      );
    }
  }
  if (
    plan.status !== "closed" &&
    plan.proofObligations.some(
      (obligation) => obligation.status === "not_applicable",
    )
  ) {
    errors.push(
      "Only a closed no-change plan can contain not-applicable proof obligations.",
    );
  }
  return errors;
}

function delegationErrors(value: AgentDelegation): string[] {
  const errors: string[] = [];
  validateSchema(value, "Agent delegation", errors);
  for (const [field, item] of [
    ["Agent delegation ID", value.id],
    ["Agent delegation task ID", value.taskId],
    ["Agent delegation plan ID", value.planId],
    ["Agent delegation agent reference", value.agentRef],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  digest(value.planDigest, "Agent delegation plan digest", errors);
  digest(value.contextDigest, "Agent delegation context digest", errors);
  digest(value.workspaceDigest, "Agent delegation workspace digest", errors);
  stringArray(value.stepIds, "Agent delegation step IDs", errors, {
    nonEmpty: true,
  });
  stringArray(
    value.allowedCapabilities,
    "Agent delegation capabilities",
    errors,
  );
  stringArray(
    value.resultEvidenceIds,
    "Agent delegation result evidence",
    errors,
  );
  enumValue(value.role, DELEGATION_ROLES, "Agent delegation role", errors);
  enumValue(
    value.status,
    DELEGATION_STATUSES,
    "Agent delegation status",
    errors,
  );
  const issuedAt = timestamp(value.issuedAt, "Agent delegation issuedAt", errors);
  const expiresAt =
    value.expiresAt === undefined
      ? undefined
      : timestamp(value.expiresAt, "Agent delegation expiresAt", errors);
  const completedAt =
    value.completedAt === undefined
      ? undefined
      : timestamp(value.completedAt, "Agent delegation completedAt", errors);
  if (issuedAt !== undefined && expiresAt !== undefined && expiresAt <= issuedAt) {
    errors.push("Agent delegation expiresAt must follow issuedAt.");
  }
  if (
    issuedAt !== undefined &&
    completedAt !== undefined &&
    completedAt < issuedAt
  ) {
    errors.push("Agent delegation completedAt precedes issuedAt.");
  }
  if (value.status === "completed" && completedAt === undefined) {
    errors.push("A completed agent delegation requires completedAt.");
  }
  return errors;
}

function externalEffectPlanErrors(value: ExternalEffectPlan): string[] {
  const errors: string[] = [];
  validateSchema(value, "External effect plan", errors);
  for (const [field, item] of [
    ["External effect plan ID", value.id],
    ["External effect task ID", value.taskId],
    ["External effect task plan ID", value.planId],
    ["External effect step ID", value.stepId],
    ["External effect summary", value.summary],
    ["External effect required capability", value.requiredCapability],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  digest(value.planDigest, "External effect task plan digest", errors);
  digest(
    value.idempotencyKeyDigest,
    "External effect idempotency key digest",
    errors,
  );
  enumValue(value.kind, EFFECT_KINDS, "External effect kind", errors);
  if (typeof value.approvalRequired !== "boolean") {
    errors.push("External effect approvalRequired must be boolean.");
  }
  if (!value.target || typeof value.target !== "object") {
    errors.push("External effect target is required.");
  } else {
    enumValue(
      value.target.kind,
      EFFECT_TARGET_KINDS,
      "External effect target kind",
      errors,
    );
    nonEmpty(value.target.displayName, "External effect target name", errors);
    digest(
      value.target.locatorDigest,
      "External effect target locator digest",
      errors,
    );
    stringArray(
      value.target.allowedDomains,
      "External effect target domains",
      errors,
    );
  }
  stringArray(
    value.preconditionProofObligationIds,
    "External effect proof preconditions",
    errors,
    { nonEmpty: true },
  );
  if (!value.recovery || typeof value.recovery !== "object") {
    errors.push("External effect recovery declaration is required.");
  } else {
    enumValue(
      value.recovery.mode,
      new Set(["automatic", "compensating", "none"]),
      "External effect recovery mode",
      errors,
    );
    nonEmpty(
      value.recovery.description,
      "External effect recovery description",
      errors,
    );
    if (value.recovery.requiredCapability !== undefined) {
      nonEmpty(
        value.recovery.requiredCapability,
        "External effect recovery capability",
        errors,
      );
    }
  }
  const createdAt = timestamp(value.createdAt, "External effect createdAt", errors);
  const expiresAt = timestamp(value.expiresAt, "External effect expiresAt", errors);
  if (createdAt !== undefined && expiresAt !== undefined) {
    if (expiresAt <= createdAt) {
      errors.push("External effect expiresAt must follow createdAt.");
    }
    if (expiresAt - createdAt > MAX_EXTERNAL_EFFECT_PLAN_MS) {
      errors.push("External effect authorization window exceeds 24 hours.");
    }
  }
  return errors;
}

function externalEffectReceiptErrors(value: ExternalEffectReceipt): string[] {
  const errors: string[] = [];
  validateSchema(value, "External effect receipt", errors);
  for (const [field, item] of [
    ["External effect receipt ID", value.id],
    ["External effect receipt task ID", value.taskId],
    ["External effect receipt plan ID", value.effectPlanId],
    ["External effect receipt summary", value.summary],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  digest(value.effectPlanDigest, "External effect receipt plan digest", errors);
  optionalDigest(
    value.approvalReceiptDigest,
    "External effect approval receipt digest",
    errors,
  );
  optionalDigest(
    value.compensationReceiptDigest,
    "External effect compensation receipt digest",
    errors,
  );
  stringArray(
    value.preflightEvidenceIds,
    "External effect receipt preflight evidence",
    errors,
  );
  const resultEvidence = stringArray(
    value.resultEvidenceIds,
    "External effect receipt result evidence",
    errors,
  );
  const providerReceipts = stringArray(
    value.providerReceiptDigests,
    "External effect provider receipt digests",
    errors,
    { digests: true },
  );
  enumValue(
    value.status,
    EFFECT_RECEIPT_STATUSES,
    "External effect receipt status",
    errors,
  );
  const startedAt = timestamp(
    value.startedAt,
    "External effect receipt startedAt",
    errors,
  );
  const completedAt = timestamp(
    value.completedAt,
    "External effect receipt completedAt",
    errors,
  );
  if (
    startedAt !== undefined &&
    completedAt !== undefined &&
    completedAt < startedAt
  ) {
    errors.push("External effect receipt completedAt precedes startedAt.");
  }
  if (
    ["succeeded", "partially_succeeded", "compensated"].includes(value.status) &&
    resultEvidence.length === 0 &&
    providerReceipts.length === 0
  ) {
    errors.push(
      "A mutating external effect receipt requires result evidence or a provider receipt digest.",
    );
  }
  if (value.status === "compensated" && !value.compensationReceiptDigest) {
    errors.push("A compensated external effect requires a compensation receipt.");
  }
  return errors;
}

function proofLeaseErrors(value: ProofLease): string[] {
  const errors: string[] = [];
  validateSchema(value, "Proof lease", errors);
  for (const [field, item] of [
    ["Proof lease ID", value.id],
    ["Proof lease task ID", value.taskId],
    ["Proof lease plan ID", value.planId],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 1) {
    errors.push("Proof lease plan revision must be a positive safe integer.");
  }
  for (const [field, item] of [
    ["Proof lease plan digest", value.planDigest],
    ["Proof lease subject digest", value.subjectDigest],
    ["Proof lease environment digest", value.environmentDigest],
    ["Proof lease policy digest", value.policyDigest],
    ["Proof lease toolchain digest", value.toolchainDigest],
  ] as const) {
    digest(item, field, errors);
  }
  stringArray(value.proofObligationIds, "Proof lease obligations", errors, {
    nonEmpty: true,
  });
  stringArray(value.evidenceIds, "Proof lease evidence", errors, {
    nonEmpty: true,
  });
  enumValue(value.issuedBy, LEASE_ISSUERS, "Proof lease issuer", errors);
  const issuedAt = timestamp(value.issuedAt, "Proof lease issuedAt", errors);
  const expiresAt = timestamp(value.expiresAt, "Proof lease expiresAt", errors);
  if (issuedAt !== undefined && expiresAt !== undefined) {
    if (expiresAt <= issuedAt) {
      errors.push("Proof lease expiresAt must follow issuedAt.");
    }
    if (expiresAt - issuedAt > MAX_PROOF_LEASE_MS) {
      errors.push("Proof lease validity exceeds 24 hours.");
    }
  }
  return errors;
}

function invalidationErrors(value: ProofLeaseInvalidation): string[] {
  const errors: string[] = [];
  validateSchema(value, "Proof lease invalidation", errors);
  for (const [field, item] of [
    ["Proof lease invalidation ID", value.id],
    ["Proof lease invalidation task ID", value.taskId],
    ["Proof lease invalidation lease ID", value.leaseId],
    ["Proof lease invalidation details", value.details],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  digest(value.leaseDigest, "Proof lease invalidation lease digest", errors);
  optionalDigest(
    value.causedByDigest,
    "Proof lease invalidation cause digest",
    errors,
  );
  enumValue(
    value.reason,
    INVALIDATION_REASONS,
    "Proof lease invalidation reason",
    errors,
  );
  enumValue(
    value.invalidatedBy,
    new Set(["system", "user", "verifier"]),
    "Proof lease invalidator",
    errors,
  );
  timestamp(
    value.invalidatedAt,
    "Proof lease invalidation timestamp",
    errors,
  );
  return errors;
}

function observationErrors(value: ProductionObservation): string[] {
  const errors: string[] = [];
  validateSchema(value, "Production observation", errors);
  for (const [field, item] of [
    ["Production observation ID", value.id],
    ["Production observation task ID", value.taskId],
    ["Production observation summary", value.summary],
  ] as const) {
    nonEmpty(item, field, errors);
  }
  enumValue(
    value.environment,
    OBSERVATION_ENVIRONMENTS,
    "Production observation environment",
    errors,
  );
  enumValue(
    value.source,
    OBSERVATION_SOURCES,
    "Production observation source",
    errors,
  );
  enumValue(
    value.status,
    OBSERVATION_STATUSES,
    "Production observation status",
    errors,
  );
  digest(value.subjectDigest, "Production observation subject digest", errors);
  optionalDigest(
    value.effectReceiptDigest,
    "Production observation effect receipt digest",
    errors,
  );
  const evidence = stringArray(
    value.evidenceIds,
    "Production observation evidence",
    errors,
  );
  const artifacts = stringArray(
    value.artifactDigests,
    "Production observation artifact digests",
    errors,
    { digests: true },
  );
  if (evidence.length === 0 && artifacts.length === 0) {
    errors.push(
      "A production observation requires evidence or an artifact digest.",
    );
  }
  const observedAt = timestamp(
    value.observedAt,
    "Production observation observedAt",
    errors,
  );
  const validUntil =
    value.validUntil === undefined
      ? undefined
      : timestamp(
          value.validUntil,
          "Production observation validUntil",
          errors,
        );
  if (
    observedAt !== undefined &&
    validUntil !== undefined &&
    validUntil <= observedAt
  ) {
    errors.push("Production observation validUntil must follow observedAt.");
  }
  return errors;
}

function verifyRecord<T extends DigestedRecord>(
  value: T,
  structuralErrors: (value: T) => string[],
): AutopilotRecordVerification {
  const errors: string[] = [];
  let body = {} as Omit<T, "digest">;
  let actualDigest = "";
  try {
    body = recordBody(value);
    const canonical = canonicalStringify(body);
    actualDigest = autopilotRecordDigest(body);
    if (!isSha256Digest(value.digest)) {
      errors.push("Record digest is not a SHA-256 digest.");
    } else if (!verifySha256Digest(canonical, value.digest)) {
      errors.push("Record digest does not match its canonical contents.");
    }
    if (canonicalStringify(redactForPersistence(body)) !== canonical) {
      errors.push("Record contains unredacted secret-like content.");
    }
    errors.push(...structuralErrors(value));
  } catch (error) {
    errors.push(
      `Record cannot be validated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    valid: errors.length === 0,
    expectedDigest:
      value && typeof value.digest === "string" ? value.digest : "",
    actualDigest,
    errors,
  };
}

function assertValid(
  label: string,
  verification: AutopilotRecordVerification,
): void {
  if (!verification.valid) {
    throw new TypeError(`${label} is invalid: ${verification.errors.join(" ")}`);
  }
}

export function createTaskPlan(input: RecordInput<TaskPlan>): TaskPlan {
  const plan = createRecord<TaskPlan>(input);
  assertValid("Task plan", verifyTaskPlan(plan));
  return plan;
}

export function verifyTaskPlan(plan: TaskPlan): AutopilotRecordVerification {
  return verifyRecord(plan, taskPlanErrors);
}

export function assertValidTaskPlan(plan: TaskPlan): void {
  assertValid("Task plan", verifyTaskPlan(plan));
}

export function assertValidPlanRevision(
  previous: TaskPlan | undefined,
  next: TaskPlan,
): void {
  assertValidTaskPlan(next);
  if (!previous) {
    if (next.revision !== 1 || next.previousPlanDigest !== undefined) {
      throw new TypeError(
        "The initial task plan must be revision 1 without a previous digest.",
      );
    }
    return;
  }
  if (next.id !== previous.id || next.taskId !== previous.taskId) {
    throw new TypeError("A plan revision must preserve its plan and task IDs.");
  }
  if (next.revision !== previous.revision + 1) {
    throw new TypeError(
      `Task plan revision must advance from ${previous.revision} to ${
        previous.revision + 1
      }.`,
    );
  }
  if (next.previousPlanDigest !== previous.digest) {
    throw new TypeError(
      "Task plan revision does not reference the current plan digest.",
    );
  }
  if (next.createdAt !== previous.createdAt) {
    throw new TypeError("A plan revision must preserve its original createdAt.");
  }
  if (next.createdBy !== previous.createdBy) {
    throw new TypeError("A plan revision must preserve its original creator.");
  }
  if (Date.parse(next.revisedAt) < Date.parse(previous.revisedAt)) {
    throw new TypeError("A plan revision cannot move revisedAt backwards.");
  }
}

export function createAgentDelegation(
  input: RecordInput<AgentDelegation>,
): AgentDelegation {
  const value = createRecord<AgentDelegation>(input);
  assertValid("Agent delegation", verifyAgentDelegation(value));
  return value;
}

export function verifyAgentDelegation(
  value: AgentDelegation,
): AutopilotRecordVerification {
  return verifyRecord(value, delegationErrors);
}

export function assertValidAgentDelegation(value: AgentDelegation): void {
  assertValid("Agent delegation", verifyAgentDelegation(value));
}

export function createExternalEffectPlan(
  input: RecordInput<ExternalEffectPlan>,
): ExternalEffectPlan {
  const value = createRecord<ExternalEffectPlan>(input);
  assertValid("External effect plan", verifyExternalEffectPlan(value));
  return value;
}

export function verifyExternalEffectPlan(
  value: ExternalEffectPlan,
): AutopilotRecordVerification {
  return verifyRecord(value, externalEffectPlanErrors);
}

export function assertValidExternalEffectPlan(value: ExternalEffectPlan): void {
  assertValid("External effect plan", verifyExternalEffectPlan(value));
}

export function createExternalEffectReceipt(
  input: RecordInput<ExternalEffectReceipt>,
): ExternalEffectReceipt {
  const value = createRecord<ExternalEffectReceipt>(input);
  assertValid("External effect receipt", verifyExternalEffectReceipt(value));
  return value;
}

export function verifyExternalEffectReceipt(
  value: ExternalEffectReceipt,
): AutopilotRecordVerification {
  return verifyRecord(value, externalEffectReceiptErrors);
}

export function assertValidExternalEffectReceipt(
  value: ExternalEffectReceipt,
): void {
  assertValid("External effect receipt", verifyExternalEffectReceipt(value));
}

export function createProofLease(input: RecordInput<ProofLease>): ProofLease {
  const value = createRecord<ProofLease>(input);
  assertValid("Proof lease", verifyProofLease(value));
  return value;
}

export function verifyProofLease(
  value: ProofLease,
): AutopilotRecordVerification {
  return verifyRecord(value, proofLeaseErrors);
}

export function assertValidProofLease(value: ProofLease): void {
  assertValid("Proof lease", verifyProofLease(value));
}

export function createProofLeaseInvalidation(
  input: RecordInput<ProofLeaseInvalidation>,
): ProofLeaseInvalidation {
  const value = createRecord<ProofLeaseInvalidation>(input);
  assertValid(
    "Proof lease invalidation",
    verifyProofLeaseInvalidation(value),
  );
  return value;
}

export function verifyProofLeaseInvalidation(
  value: ProofLeaseInvalidation,
): AutopilotRecordVerification {
  return verifyRecord(value, invalidationErrors);
}

export function assertValidProofLeaseInvalidation(
  value: ProofLeaseInvalidation,
): void {
  assertValid(
    "Proof lease invalidation",
    verifyProofLeaseInvalidation(value),
  );
}

export function createProductionObservation(
  input: RecordInput<ProductionObservation>,
): ProductionObservation {
  const value = createRecord<ProductionObservation>(input);
  assertValid("Production observation", verifyProductionObservation(value));
  return value;
}

export function verifyProductionObservation(
  value: ProductionObservation,
): AutopilotRecordVerification {
  return verifyRecord(value, observationErrors);
}

export function assertValidProductionObservation(
  value: ProductionObservation,
): void {
  assertValid("Production observation", verifyProductionObservation(value));
}
