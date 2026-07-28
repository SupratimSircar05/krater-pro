export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskState =
  | "intake"
  | "discovery"
  | "clarification"
  | "reproduction"
  | "staging"
  | "verification"
  | "review"
  | "publication"
  | "complete"
  | "abstained"
  | "blocked"
  | "accepted_with_gaps"
  | "cancelled";

export type AssuranceLevel = "fast" | "standard" | "high";

export type EvidenceGrade =
  | "not_established"
  | "observed"
  | "tested"
  | "stress_tested"
  | "formally_verified";

export interface TaskBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxTimeMs?: number;
  maxToolSteps?: number;
}

export interface TaskInterpretation {
  id: string;
  description: string;
  selected: boolean;
}

export interface TaskAssumption {
  id: string;
  statement: string;
  source: "user" | "repository" | "policy" | "agent";
  resolved: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  required: boolean;
}

export interface TaskContract {
  schemaVersion: 1;
  id: string;
  taskId: string;
  request: string;
  interpretations: TaskInterpretation[];
  assumptions: TaskAssumption[];
  acceptanceCriteria: AcceptanceCriterion[];
  nonGoals: string[];
  assurance: AssuranceLevel;
  budget: TaskBudget;
  allowedCapabilities: string[];
  requiredChecks: string[];
  negativeGuarantees: string[];
  createdAt: string;
}

export type IntentKind =
  | "requirement"
  | "invariant"
  | "decision"
  | "assumption"
  | "non_goal"
  | "retirement";

export type IntentStatus =
  | "active"
  | "fulfilled"
  | "contradicted"
  | "uncovered"
  | "stale"
  | "retired";

export interface IntentLink {
  type: "symbol" | "file" | "test" | "schema" | "evidence" | "patch" | "commit";
  target: string;
}

export interface IntentNode {
  id: string;
  taskId: string;
  kind: IntentKind;
  statement: string;
  status: IntentStatus;
  links: IntentLink[];
  owner?: string;
  supersedes?: string[];
  retirementReason?: string;
  replacementIntentId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProvenanceSource =
  | "user"
  | "system_policy"
  | "repository"
  | "local_tool"
  | "external_tool"
  | "generated";

export type TrustLevel = "authoritative" | "approved_policy" | "untrusted";
export type Sensitivity =
  | "public"
  | "proprietary"
  | "pii"
  | "secret"
  | "license_restricted";

export interface Provenance {
  source: ProvenanceSource;
  trust: TrustLevel;
  sensitivity: Sensitivity;
}

export interface SideEffect {
  kind: string;
  target: string;
  reversible: boolean;
  recovery?: string;
}

export interface ActionRecord {
  id: string;
  taskId: string;
  name: string;
  capability: string;
  provenance: Provenance;
  input: JsonValue;
  output?: JsonValue;
  sideEffects: SideEffect[];
  status: "planned" | "running" | "succeeded" | "failed" | "denied";
  startedAt: string;
  completedAt?: string;
}

export type EvidenceKind =
  | "reproduction"
  | "test"
  | "mutation"
  | "non_vacuity"
  | "property"
  | "differential"
  | "static_analysis"
  | "runtime_trace"
  | "security"
  | "formal_proof"
  | "human_acceptance";

export type EvidenceOrigin =
  | "repository"
  | "agent_author"
  | "blind_verifier"
  | "human"
  | "tool";

export interface EvidenceRecord {
  id: string;
  taskId: string;
  kind: EvidenceKind;
  grade: EvidenceGrade;
  origin: EvidenceOrigin;
  summary: string;
  supportsClaimIds: string[];
  contradictsClaimIds: string[];
  command?: string;
  tool?: string;
  toolVersion?: string;
  environmentDigest?: string;
  artifactDigests: string[];
  proofArtifactDigest?: string;
  stale: boolean;
  observedAt: string;
}

export interface ClaimRecord {
  id: string;
  taskId: string;
  statement: string;
  grade: EvidenceGrade;
  status: "supported" | "contradicted" | "unresolved";
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  createdAt: string;
}

export interface UsageCost {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd?: number;
  elapsedMs: number;
}

export interface EvidenceCapsule {
  schemaVersion: 1;
  taskId: string;
  contract: TaskContract;
  state: TaskState;
  baseWorkspaceDigest?: string;
  finalWorkspaceDigest?: string;
  changedBehavior: string[];
  negativeGuarantees: string[];
  evidence: EvidenceRecord[];
  claims: ClaimRecord[];
  gaps: string[];
  approvals: string[];
  cost: UsageCost;
  generatedAt: string;
  digest: string;
}

export interface ChangePassport {
  schemaVersion: 1;
  taskId: string;
  title: string;
  summary: string;
  verdict: TaskState;
  assurance: AssuranceLevel;
  intentIds: string[];
  changedPaths: string[];
  evidenceGrades: EvidenceGrade[];
  weakestEvidenceGrade: EvidenceGrade;
  gaps: string[];
  approvals: string[];
  provenance: Provenance[];
  capsuleDigest: string;
  generatedAt: string;
  digest: string;
}

export interface TaskStateChange {
  from?: TaskState;
  to: TaskState;
  reason?: string;
}

export interface ProofGraphEventPayloads {
  "task.created": { contract: TaskContract };
  "task.state.changed": TaskStateChange;
  "contract.set": { contract: TaskContract };
  "intent.recorded": { intent: IntentNode };
  "action.recorded": { action: ActionRecord };
  "evidence.recorded": { evidence: EvidenceRecord };
  "claim.recorded": { claim: ClaimRecord };
  "capsule.generated": { capsule: EvidenceCapsule };
  "passport.generated": { passport: ChangePassport };
}

export type ProofGraphEventKind = keyof ProofGraphEventPayloads;

export type AppendProofGraphEvent = {
  [Kind in ProofGraphEventKind]: {
    taskId: string;
    kind: Kind;
    payload: ProofGraphEventPayloads[Kind];
    eventId?: string;
    occurredAt?: string;
  };
}[ProofGraphEventKind];

export interface StoredProofGraphEvent<
  Kind extends ProofGraphEventKind = ProofGraphEventKind,
> {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  taskId: string;
  occurredAt: string;
  kind: Kind;
  payload: ProofGraphEventPayloads[Kind];
  previousHash: string | null;
  hash: string;
}

export interface TaskStateHistoryEntry {
  state: TaskState;
  sequence: number;
  occurredAt: string;
  reason?: string;
}

export interface TaskProjection {
  taskId: string;
  state: TaskState;
  contract: TaskContract;
  intents: IntentNode[];
  actions: ActionRecord[];
  evidence: EvidenceRecord[];
  claims: ClaimRecord[];
  stateHistory: TaskStateHistoryEntry[];
  capsule?: EvidenceCapsule;
  passport?: ChangePassport;
  lastSequence: number;
  lastEventHash: string;
}
