import {
  createMasterySignalId,
  masteryTaskRef,
} from "./graph.js";
import type {
  MasteryConceptCandidate,
  MasteryGuidanceItem,
  MasteryHintDecision,
  MasteryReflectionKind,
  MasteryReflectionOutcome,
  MasteryReflectionPrompt,
  MasterySelectionReason,
  MasterySignal,
  MasterySignalKind,
  MasteryStage,
  MasteryTaskControls,
  MasteryTaskSession,
} from "./types.js";

const DEFAULT_CONTROLS = Object.freeze({
  enabled: false,
  hintBeforeSolution: true,
  reflection: "auto",
  maximumConcepts: 3,
  unfamiliarStages: ["unassessed", "unfamiliar"] as const,
  highRiskThreshold: 0.7,
} satisfies MasteryTaskControls);

export function masteryTaskControls(
  overrides: Partial<MasteryTaskControls> = {},
): MasteryTaskControls {
  const controls: MasteryTaskControls = {
    ...DEFAULT_CONTROLS,
    ...overrides,
    unfamiliarStages:
      overrides.unfamiliarStages ?? DEFAULT_CONTROLS.unfamiliarStages,
  };
  if (
    !Number.isInteger(controls.maximumConcepts) ||
    controls.maximumConcepts < 1 ||
    controls.maximumConcepts > 10
  ) {
    throw new Error("Mastery Mode maximumConcepts must be an integer from 1 to 10.");
  }
  if (
    !Number.isFinite(controls.highRiskThreshold) ||
    controls.highRiskThreshold < 0 ||
    controls.highRiskThreshold > 1
  ) {
    throw new Error("Mastery Mode highRiskThreshold must be between 0 and 1.");
  }
  return controls;
}

function stageForCandidate(
  candidate: MasteryConceptCandidate,
  stages: ReadonlyMap<string, MasteryStage>,
): MasteryStage {
  return stages.get(candidate.id) ?? candidate.declaredStage ?? "unassessed";
}

function selectionReasons(
  risk: number,
  stage: MasteryStage,
  controls: MasteryTaskControls,
): readonly MasterySelectionReason[] {
  const reasons: MasterySelectionReason[] = [];
  if (risk >= controls.highRiskThreshold) reasons.push("high_risk");
  if (controls.unfamiliarStages.includes(stage)) {
    reasons.push(stage === "unassessed" ? "unassessed" : "unfamiliar");
  } else if (stage === "learning") {
    reasons.push("still_learning");
  }
  return reasons;
}

function validateCandidate(candidate: MasteryConceptCandidate): void {
  if (candidate.id.trim().length === 0 || candidate.label.trim().length === 0) {
    throw new Error("Mastery concept IDs and labels must be non-empty.");
  }
  if (
    candidate.invariant.trim().length === 0 ||
    candidate.hint.trim().length === 0
  ) {
    throw new Error("Mastery guidance requires an invariant and a hint.");
  }
  if (
    !Number.isFinite(candidate.risk) ||
    candidate.risk < 0 ||
    candidate.risk > 1
  ) {
    throw new Error(
      `Mastery concept ${candidate.id} risk must be between 0 and 1.`,
    );
  }
}

function priority(item: MasteryGuidanceItem): number {
  const stagePriority: Readonly<Record<MasteryStage, number>> = {
    unassessed: 0.5,
    unfamiliar: 0.7,
    learning: 0.35,
    familiar: 0,
  };
  // Risk receives the larger weight: a familiar security-critical concept can
  // still deserve a short failure-mode check before a low-risk novelty.
  return item.risk * 2 + stagePriority[item.stageAtIntake];
}

export function createMasterySession(input: {
  taskId: string;
  controls?: Partial<MasteryTaskControls>;
  candidates: readonly MasteryConceptCandidate[];
  knownStages?: ReadonlyMap<string, MasteryStage>;
  createdAt?: string;
}): MasteryTaskSession {
  const controls = masteryTaskControls(input.controls);
  const timestamp = input.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid mastery timestamp: ${timestamp}`);
  }
  input.candidates.forEach(validateCandidate);

  if (!controls.enabled) {
    return {
      schemaVersion: 1,
      taskRef: masteryTaskRef(input.taskId),
      controls,
      status: "disabled",
      guidance: [],
      signals: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  const stages = input.knownStages ?? new Map<string, MasteryStage>();
  const guidance = input.candidates
    .map((candidate): MasteryGuidanceItem | undefined => {
      const stageAtIntake = stageForCandidate(candidate, stages);
      const reasons = selectionReasons(
        candidate.risk,
        stageAtIntake,
        controls,
      );
      if (reasons.length === 0) return undefined;
      return {
        conceptId: candidate.id.trim(),
        label: candidate.label.trim(),
        ...(candidate.domain?.trim()
          ? { domain: candidate.domain.trim() }
          : {}),
        invariant: candidate.invariant.trim(),
        hint: candidate.hint.trim(),
        risk: candidate.risk,
        stageAtIntake,
        reasons,
        hintStatus: controls.hintBeforeSolution ? "pending" : "bypassed",
        solutionStatus: controls.hintBeforeSolution ? "locked" : "available",
        reflectionStatus: "unavailable",
      };
    })
    .filter((item): item is MasteryGuidanceItem => item !== undefined)
    .sort(
      (left, right) =>
        priority(right) - priority(left) ||
        left.conceptId.localeCompare(right.conceptId),
    )
    .slice(0, controls.maximumConcepts);

  return {
    schemaVersion: 1,
    taskRef: masteryTaskRef(input.taskId),
    controls,
    status: guidance.length === 0 ? "no_relevant_concepts" : "guidance",
    guidance,
    signals: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function selected(
  session: MasteryTaskSession,
  conceptId: string,
): MasteryGuidanceItem | undefined {
  return session.guidance.find((item) => item.conceptId === conceptId);
}

export function decideMasterySolutionDisclosure(
  session: MasteryTaskSession,
  conceptId: string,
): MasteryHintDecision {
  const item = selected(session, conceptId);
  if (!item) {
    return {
      allowed: true,
      conceptId,
      next: "concept_not_selected",
    };
  }
  if (item.solutionStatus === "revealed") {
    return {
      allowed: true,
      conceptId,
      next: "solution_already_revealed",
    };
  }
  if (item.hintStatus === "pending") {
    return {
      allowed: false,
      conceptId,
      next: "deliver_hint",
      hint: item.hint,
      invariant: item.invariant,
    };
  }
  return {
    allowed: true,
    conceptId,
    next: "solution_available",
  };
}

function withSignal(
  session: MasteryTaskSession,
  conceptId: string,
  kind: MasterySignalKind,
  origin: MasterySignal["origin"],
  occurredAt?: string,
): {
  timestamp: string;
  signal: MasterySignal;
  signals: readonly MasterySignal[];
} {
  const timestamp = occurredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid mastery timestamp: ${timestamp}`);
  }
  const signal: MasterySignal = {
    id: createMasterySignalId({
      taskRef: session.taskRef,
      conceptId,
      kind,
      occurredAt: timestamp,
      sequence: session.signals.length,
    }),
    conceptId,
    taskRef: session.taskRef,
    kind,
    origin,
    occurredAt: timestamp,
  };
  return {
    timestamp,
    signal,
    signals: [...session.signals, signal],
  };
}

export function recordMasteryHint(
  session: MasteryTaskSession,
  conceptId: string,
  decision: "delivered" | "bypassed",
  occurredAt?: string,
): MasteryTaskSession {
  const item = selected(session, conceptId);
  if (!item) throw new Error(`Mastery concept is not selected: ${conceptId}`);
  if (item.hintStatus !== "pending") {
    throw new Error(`Mastery hint already resolved for concept: ${conceptId}`);
  }
  const added = withSignal(
    session,
    conceptId,
    decision === "delivered" ? "hint_delivered" : "hint_bypassed",
    decision === "bypassed" ? "user" : "workflow",
    occurredAt,
  );
  return {
    ...session,
    guidance: session.guidance.map((current) =>
      current.conceptId === conceptId
        ? {
            ...current,
            hintStatus: decision,
            solutionStatus: "available",
          }
        : current,
    ),
    signals: added.signals,
    updatedAt: added.timestamp,
  };
}

export function recordMasterySolutionRevealed(
  session: MasteryTaskSession,
  conceptId: string,
  occurredAt?: string,
): MasteryTaskSession {
  const decision = decideMasterySolutionDisclosure(session, conceptId);
  if (!decision.allowed) {
    throw new Error(
      `Mastery hint must be delivered or explicitly bypassed before revealing ${conceptId}.`,
    );
  }
  const item = selected(session, conceptId);
  if (!item) return session;
  if (item.solutionStatus === "revealed") return session;

  const added = withSignal(
    session,
    conceptId,
    "solution_revealed",
    "workflow",
    occurredAt,
  );
  return {
    ...session,
    guidance: session.guidance.map((current) =>
      current.conceptId === conceptId
        ? { ...current, solutionStatus: "revealed" }
        : current,
    ),
    signals: added.signals,
    updatedAt: added.timestamp,
  };
}

function reflectionKind(
  session: MasteryTaskSession,
  item: MasteryGuidanceItem,
): MasteryReflectionKind | undefined {
  if (session.controls.reflection === "off") return undefined;
  if (session.controls.reflection === "teach_back") return "teach_back";
  if (session.controls.reflection === "failure_mode") return "failure_mode";
  return item.risk >= session.controls.highRiskThreshold
    ? "failure_mode"
    : "teach_back";
}

export function markMasteryTaskPublished(
  session: MasteryTaskSession,
  publishedAt?: string,
): MasteryTaskSession {
  if (session.status === "disabled" || session.status === "no_relevant_concepts") {
    return session;
  }
  const timestamp = publishedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid mastery timestamp: ${timestamp}`);
  }
  const guidance = session.guidance.map((item) => ({
    ...item,
    reflectionStatus:
      reflectionKind(session, item) === undefined
        ? ("unavailable" as const)
        : ("pending" as const),
  }));
  return {
    ...session,
    status: guidance.some((item) => item.reflectionStatus === "pending")
      ? "published"
      : "complete",
    guidance,
    updatedAt: timestamp,
  };
}

export function buildMasteryReflectionPrompt(
  session: MasteryTaskSession,
  conceptId: string,
): MasteryReflectionPrompt | undefined {
  const item = selected(session, conceptId);
  if (!item || item.reflectionStatus !== "pending") return undefined;
  const kind = reflectionKind(session, item);
  if (!kind) return undefined;
  return {
    conceptId,
    kind,
    timeboxSeconds: 60,
    prompt:
      kind === "failure_mode"
        ? `In about 60 seconds, name one realistic failure mode for ${item.label} and the evidence that would expose it.`
        : `In about 60 seconds, explain ${item.label} in your own words and state the invariant that must remain true.`,
    invariant: item.invariant,
  };
}

function reflectionSignalKind(
  kind: MasteryReflectionKind,
  outcome: MasteryReflectionOutcome,
): MasterySignalKind {
  if (outcome === "skipped") return "reflection_skipped";
  if (kind === "failure_mode") {
    return outcome === "demonstrated"
      ? "failure_mode_identified"
      : "failure_mode_missed";
  }
  if (outcome === "demonstrated") return "teach_back_demonstrated";
  return "teach_back_partial";
}

export function recordMasteryReflection(
  session: MasteryTaskSession,
  conceptId: string,
  outcome: MasteryReflectionOutcome,
  occurredAt?: string,
): MasteryTaskSession {
  const item = selected(session, conceptId);
  if (!item || item.reflectionStatus !== "pending") {
    throw new Error(
      `No pending Mastery Mode reflection for concept: ${conceptId}`,
    );
  }
  const kind = reflectionKind(session, item);
  if (!kind) {
    throw new Error(`Mastery Mode reflection is disabled for: ${conceptId}`);
  }
  const added = withSignal(
    session,
    conceptId,
    reflectionSignalKind(kind, outcome),
    outcome === "skipped" ? "user" : "local_evaluator",
    occurredAt,
  );
  const guidance = session.guidance.map((current) =>
    current.conceptId === conceptId
      ? {
          ...current,
          reflectionStatus:
            outcome === "skipped" ? ("skipped" as const) : ("recorded" as const),
        }
      : current,
  );
  return {
    ...session,
    status: guidance.every(
      (current) => current.reflectionStatus !== "pending",
    )
      ? "complete"
      : session.status,
    guidance,
    signals: added.signals,
    updatedAt: added.timestamp,
  };
}
