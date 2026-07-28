export const AUTOPILOT_SCHEMA_VERSION = 1 as const;

export type AutopilotDigest = `sha256:${string}`;

export type AutopilotEvidenceGrade =
  | "not_established"
  | "observed"
  | "tested"
  | "stress_tested"
  | "formally_verified";

export type PlanStatus =
  | "draft"
  | "approved"
  | "active"
  /**
   * The executable work is over, but the task ended without publication.
   * Unlike "completed", a closed plan may retain explicit proof gaps.
   */
  | "closed"
  | "completed"
  | "cancelled";

export type PlanStepKind =
  | "clarify"
  | "discover"
  | "reproduce"
  | "implement"
  | "debug"
  | "verify"
  | "review"
  | "publish"
  | "external_effect";

export type PlanStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "skipped"
  | "cancelled";

export interface PlanStep {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  kind: PlanStepKind;
  title: string;
  description: string;
  status: PlanStepStatus;
  dependsOnStepIds: string[];
  proofObligationIds: string[];
  allowedCapabilities: string[];
  assignedDelegationId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProofObligationKind =
  | "acceptance_criterion"
  | "negative_guarantee"
  | "regression"
  | "security"
  | "performance"
  | "reliability"
  | "publication_precondition"
  | "production_observation";

export type ProofObligationStatus =
  | "pending"
  | "satisfied"
  | "failed"
  /**
   * The obligation depended on a change or publication that did not occur.
   * This is a disposition, not evidence and never counts as a passed proof.
   */
  | "not_applicable"
  | "waived";

export interface ProofWaiver {
  approvedBy: "user";
  reason: string;
  approvalReceiptDigest: AutopilotDigest;
  approvedAt: string;
}

export interface ProofObligation {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  kind: ProofObligationKind;
  statement: string;
  required: boolean;
  minimumGrade: AutopilotEvidenceGrade;
  status: ProofObligationStatus;
  acceptanceCriterionIds: string[];
  evidenceIds: string[];
  /**
   * Digests of the source, configuration, policy, toolchain, or other inputs
   * whose change makes the proof stale.
   */
  scopeDigests: AutopilotDigest[];
  /**
   * Required whenever status is "not_applicable". It explains why the
   * obligation did not apply without pretending that evidence satisfied it.
   */
  nonApplicabilityReason?: string;
  waiver?: ProofWaiver;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPlan {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  /** Stable across every revision of the same plan. */
  id: string;
  taskId: string;
  revision: number;
  previousPlanDigest?: AutopilotDigest;
  status: PlanStatus;
  objective: string;
  contractDigest?: AutopilotDigest;
  steps: PlanStep[];
  proofObligations: ProofObligation[];
  createdBy: "user" | "agent" | "system";
  revisedBy: "user" | "agent" | "system";
  createdAt: string;
  revisedAt: string;
  revisionReason: string;
  digest: AutopilotDigest;
}

export type DelegationRole =
  | "primary"
  | "specialist"
  | "debugger"
  | "verifier"
  | "reviewer";

export type DelegationStatus =
  | "planned"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentDelegation {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  planId: string;
  planDigest: AutopilotDigest;
  stepIds: string[];
  role: DelegationRole;
  /** Stable host-side agent identity, never an authorization credential. */
  agentRef: string;
  modelId?: string;
  contextDigest: AutopilotDigest;
  workspaceDigest: AutopilotDigest;
  allowedCapabilities: string[];
  status: DelegationStatus;
  issuedAt: string;
  expiresAt?: string;
  completedAt?: string;
  resultEvidenceIds: string[];
  digest: AutopilotDigest;
}

export type ExternalEffectKind =
  | "git_push"
  | "pull_request"
  | "deployment"
  | "migration"
  | "external_api_mutation"
  | "release"
  | "other";

export interface ExternalEffectTarget {
  kind: "git_remote" | "repository" | "environment" | "database" | "api";
  displayName: string;
  /** A digest of the canonical target locator; never a bearer URL. */
  locatorDigest: AutopilotDigest;
  allowedDomains: string[];
}

export interface ExternalEffectRecovery {
  mode: "automatic" | "compensating" | "none";
  description: string;
  requiredCapability?: string;
}

export interface ExternalEffectPlan {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  planId: string;
  planDigest: AutopilotDigest;
  stepId: string;
  kind: ExternalEffectKind;
  summary: string;
  target: ExternalEffectTarget;
  preconditionProofObligationIds: string[];
  requiredCapability: string;
  /** Digest of the host-held idempotency value. */
  idempotencyKeyDigest: AutopilotDigest;
  approvalRequired: boolean;
  recovery: ExternalEffectRecovery;
  createdAt: string;
  expiresAt: string;
  digest: AutopilotDigest;
}

export type ExternalEffectReceiptStatus =
  | "succeeded"
  | "failed"
  | "partially_succeeded"
  | "refused"
  | "compensated";

export interface ExternalEffectReceipt {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  effectPlanId: string;
  effectPlanDigest: AutopilotDigest;
  status: ExternalEffectReceiptStatus;
  approvalReceiptDigest?: AutopilotDigest;
  preflightEvidenceIds: string[];
  resultEvidenceIds: string[];
  /** Digests of provider receipts; raw tokens and provider payloads stay host-side. */
  providerReceiptDigests: AutopilotDigest[];
  summary: string;
  startedAt: string;
  completedAt: string;
  compensationReceiptDigest?: AutopilotDigest;
  digest: AutopilotDigest;
}

export type ProofLeaseIssuer = "host_verifier" | "blind_verifier" | "human";

export interface ProofLease {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  planId: string;
  planRevision: number;
  planDigest: AutopilotDigest;
  proofObligationIds: string[];
  evidenceIds: string[];
  subjectDigest: AutopilotDigest;
  environmentDigest: AutopilotDigest;
  policyDigest: AutopilotDigest;
  toolchainDigest: AutopilotDigest;
  issuedBy: ProofLeaseIssuer;
  issuedAt: string;
  expiresAt: string;
  digest: AutopilotDigest;
}

export type ProofLeaseInvalidationReason =
  | "plan_revision"
  | "subject_changed"
  | "environment_changed"
  | "policy_changed"
  | "toolchain_changed"
  | "evidence_stale"
  | "security_event"
  | "manual";

export interface ProofLeaseInvalidation {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  leaseId: string;
  leaseDigest: AutopilotDigest;
  reason: ProofLeaseInvalidationReason;
  details: string;
  invalidatedBy: "system" | "user" | "verifier";
  causedByDigest?: AutopilotDigest;
  invalidatedAt: string;
  digest: AutopilotDigest;
}

export type ProductionObservationSource =
  | "health_check"
  | "metric"
  | "log"
  | "trace"
  | "synthetic"
  | "human";

export type ProductionObservationStatus =
  | "healthy"
  | "degraded"
  | "failed"
  | "unknown";

export interface ProductionObservation {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  environment: "local" | "staging" | "canary" | "production";
  source: ProductionObservationSource;
  status: ProductionObservationStatus;
  summary: string;
  subjectDigest: AutopilotDigest;
  effectReceiptDigest?: AutopilotDigest;
  evidenceIds: string[];
  artifactDigests: AutopilotDigest[];
  observedAt: string;
  validUntil?: string;
  digest: AutopilotDigest;
}

export interface AutopilotProjection {
  currentPlan?: TaskPlan;
  planRevisions: TaskPlan[];
  delegations: AgentDelegation[];
  externalEffectPlans: ExternalEffectPlan[];
  externalEffectReceipts: ExternalEffectReceipt[];
  proofLeases: ProofLease[];
  proofLeaseInvalidations: ProofLeaseInvalidation[];
  productionObservations: ProductionObservation[];
}

export interface ProofLeaseValidityContext {
  taskId: string;
  planDigest: AutopilotDigest;
  subjectDigest: AutopilotDigest;
  environmentDigest: AutopilotDigest;
  policyDigest: AutopilotDigest;
  toolchainDigest: AutopilotDigest;
  now?: string;
}

export interface ProofLeaseValidity {
  valid: boolean;
  status: "valid" | "expired" | "invalidated" | "mismatched" | "invalid";
  reasons: string[];
}

export interface AutopilotRecordVerification {
  valid: boolean;
  expectedDigest: string;
  actualDigest: string;
  errors: string[];
}
