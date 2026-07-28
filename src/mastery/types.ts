export const MASTERY_STAGES = [
  "unassessed",
  "unfamiliar",
  "learning",
  "familiar",
] as const;

export type MasteryStage = (typeof MASTERY_STAGES)[number];

/**
 * Mastery Mode records learning signals only. It deliberately has no
 * productivity, ranking, employee, or team-comparison fields.
 */
export type MasterySignalKind =
  | "unfamiliar_declared"
  | "familiar_declared"
  | "hint_delivered"
  | "hint_bypassed"
  | "solution_revealed"
  | "teach_back_demonstrated"
  | "teach_back_partial"
  | "failure_mode_identified"
  | "failure_mode_missed"
  | "reflection_skipped";

export type MasterySignalOrigin = "user" | "local_evaluator" | "workflow";

export interface MasterySignal {
  id: `signal:${string}`;
  conceptId: string;
  /**
   * A one-way digest of the task identifier. Raw task requests and source
   * content are never part of a mastery signal.
   */
  taskRef: `sha256:${string}`;
  kind: MasterySignalKind;
  origin: MasterySignalOrigin;
  occurredAt: string;
}

export interface MasteryConceptNode {
  id: string;
  label: string;
  domain?: string;
  stage: MasteryStage;
  signals: readonly MasterySignal[];
  createdAt: string;
  updatedAt: string;
}

export interface MasteryPrivacyDefaults {
  storage: "local_only";
  owner: "user";
  defaultVisibility: "private";
  rawSourceRetention: false;
  rawResponseRetention: false;
  hiddenTelemetry: false;
  managerialScoring: false;
  employerReporting: false;
  collaboratorSharing: false;
  sharingRequiresExplicitExport: true;
}

export interface MasteryGraph {
  schemaVersion: 1;
  ownerScope: "local_user";
  privacy: MasteryPrivacyDefaults;
  nodes: readonly MasteryConceptNode[];
  createdAt: string;
  updatedAt: string;
}

export type MasteryReflectionPreference =
  | "auto"
  | "teach_back"
  | "failure_mode"
  | "off";

export interface MasteryTaskControls {
  /**
   * False by default. Mastery Mode is activated independently for each task.
   */
  enabled: boolean;
  hintBeforeSolution: boolean;
  reflection: MasteryReflectionPreference;
  maximumConcepts: number;
  unfamiliarStages: readonly MasteryStage[];
  highRiskThreshold: number;
}

export type MasteryConceptSource =
  | "user_declared"
  | "task_analysis"
  | "intent_graph";

/**
 * Guidance is volatile task state. Only id, label, and domain are eligible for
 * the durable mastery graph; invariant and hint text are never copied there.
 */
export interface MasteryConceptCandidate {
  id: string;
  label: string;
  domain?: string;
  invariant: string;
  hint: string;
  risk: number;
  declaredStage?: MasteryStage;
  source: MasteryConceptSource;
}

export type MasterySelectionReason =
  | "high_risk"
  | "unassessed"
  | "unfamiliar"
  | "still_learning";

export type MasteryHintStatus = "pending" | "delivered" | "bypassed";
export type MasterySolutionStatus = "locked" | "available" | "revealed";
export type MasteryReflectionStatus =
  | "unavailable"
  | "pending"
  | "recorded"
  | "skipped";

export interface MasteryGuidanceItem {
  conceptId: string;
  label: string;
  domain?: string;
  invariant: string;
  hint: string;
  risk: number;
  stageAtIntake: MasteryStage;
  reasons: readonly MasterySelectionReason[];
  hintStatus: MasteryHintStatus;
  solutionStatus: MasterySolutionStatus;
  reflectionStatus: MasteryReflectionStatus;
}

export type MasterySessionStatus =
  | "disabled"
  | "no_relevant_concepts"
  | "guidance"
  | "published"
  | "complete";

export interface MasteryTaskSession {
  schemaVersion: 1;
  taskRef: `sha256:${string}`;
  controls: MasteryTaskControls;
  status: MasterySessionStatus;
  guidance: readonly MasteryGuidanceItem[];
  signals: readonly MasterySignal[];
  createdAt: string;
  updatedAt: string;
}

export interface MasteryHintDecision {
  allowed: boolean;
  conceptId: string;
  next:
    | "deliver_hint"
    | "solution_available"
    | "solution_already_revealed"
    | "concept_not_selected";
  hint?: string;
  invariant?: string;
}

export type MasteryReflectionKind = "teach_back" | "failure_mode";

export interface MasteryReflectionPrompt {
  conceptId: string;
  kind: MasteryReflectionKind;
  timeboxSeconds: 60;
  prompt: string;
  invariant: string;
}

export type MasteryReflectionOutcome =
  | "demonstrated"
  | "partial"
  | "missed"
  | "skipped";

export type MasteryExportScope = "summary" | "signals";

export interface MasteryExportNode {
  id: string;
  label: string;
  domain?: string;
  stage: MasteryStage;
  signalCount: number;
  signals?: readonly MasterySignal[];
  createdAt: string;
  updatedAt: string;
}

export interface MasteryExportBundle {
  format: "krater-mastery-v1";
  exportedAt: string;
  scope: MasteryExportScope;
  userDirectedExport: true;
  privacy: MasteryPrivacyDefaults;
  nodes: readonly MasteryExportNode[];
}

export type MasteryDeletionSelector =
  | { kind: "concept"; conceptId: string }
  | { kind: "task"; taskRef: `sha256:${string}` }
  | { kind: "all" };

export interface MasteryDeletionReceipt {
  deletedAt: string;
  selector: MasteryDeletionSelector;
  deletedConceptIds: readonly string[];
  deletedSignalCount: number;
  /**
   * The caller must durably replace its stored graph with the returned graph.
   * The receipt itself is transient and contains no deleted content.
   */
  requiresPersistence: true;
}

export interface MasteryDeletionResult {
  graph: MasteryGraph;
  receipt: MasteryDeletionReceipt;
}
