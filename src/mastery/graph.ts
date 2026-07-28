import { createHash } from "node:crypto";
import { MASTERY_PRIVACY_DEFAULTS } from "./privacy.js";
import type {
  MasteryConceptNode,
  MasteryDeletionResult,
  MasteryDeletionSelector,
  MasteryGraph,
  MasterySignal,
  MasterySignalKind,
  MasteryStage,
  MasteryTaskSession,
} from "./types.js";

const MAX_CONCEPT_ID_LENGTH = 160;
const MAX_CONCEPT_LABEL_LENGTH = 160;
const MAX_DOMAIN_LENGTH = 100;

function isoNow(value?: string): string {
  const timestamp = value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid mastery timestamp: ${timestamp}`);
  }
  return timestamp;
}

function oneLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty.`);
  }
  if (normalized.length > maximum) {
    throw new Error(`${field} must be at most ${maximum} characters.`);
  }
  return normalized;
}

export function masteryTaskRef(taskId: string): `sha256:${string}` {
  const normalized = taskId.trim();
  if (normalized.length === 0) {
    throw new Error("Task ID must be non-empty.");
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function createMasteryGraph(createdAt?: string): MasteryGraph {
  const timestamp = isoNow(createdAt);
  return {
    schemaVersion: 1,
    ownerScope: "local_user",
    privacy: { ...MASTERY_PRIVACY_DEFAULTS },
    nodes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function stageFromSignals(
  previous: MasteryStage,
  signals: readonly MasterySignal[],
): MasteryStage {
  if (signals.length === 0) return previous;

  let stage = previous;
  const positiveTaskRefs = new Set<string>();
  for (const signal of signals) {
    if (signal.kind === "unfamiliar_declared") {
      stage = "unfamiliar";
    } else if (signal.kind === "familiar_declared") {
      stage = "familiar";
    } else if (
      signal.kind === "hint_delivered" ||
      signal.kind === "teach_back_partial"
    ) {
      if (stage !== "familiar") stage = "learning";
    } else if (
      signal.kind === "teach_back_demonstrated" ||
      signal.kind === "failure_mode_identified"
    ) {
      positiveTaskRefs.add(signal.taskRef);
      if (stage !== "familiar") stage = "learning";
    } else if (
      signal.kind === "failure_mode_missed" &&
      stage === "unassessed"
    ) {
      stage = "unfamiliar";
    }
  }

  if (positiveTaskRefs.size >= 2) return "familiar";
  return stage;
}

function normalizedSignal(signal: MasterySignal): MasterySignal {
  return {
    ...signal,
    conceptId: oneLine(
      signal.conceptId,
      "Mastery signal concept ID",
      MAX_CONCEPT_ID_LENGTH,
    ),
    occurredAt: isoNow(signal.occurredAt),
  };
}

function mergeSignals(
  existing: readonly MasterySignal[],
  incoming: readonly MasterySignal[],
): readonly MasterySignal[] {
  const byId = new Map(existing.map((signal) => [signal.id, signal]));
  for (const signal of incoming) {
    const normalized = normalizedSignal(signal);
    const previous = byId.get(normalized.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`Mastery signal ID collision: ${normalized.id}`);
    }
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
}

interface DurableConcept {
  id: string;
  label: string;
  domain?: string;
  stageAtIntake: MasteryStage;
}

function durableConcepts(session: MasteryTaskSession): readonly DurableConcept[] {
  return session.guidance.map((item) => ({
    id: oneLine(item.conceptId, "Concept ID", MAX_CONCEPT_ID_LENGTH),
    label: oneLine(item.label, "Concept label", MAX_CONCEPT_LABEL_LENGTH),
    ...(item.domain
      ? { domain: oneLine(item.domain, "Concept domain", MAX_DOMAIN_LENGTH) }
      : {}),
    stageAtIntake: item.stageAtIntake,
  }));
}

/**
 * Commits only structured mastery metadata and categorical signals. Volatile
 * hints, invariants, task text, source, and reflection answers are omitted.
 */
export function applyMasterySession(
  graph: MasteryGraph,
  session: MasteryTaskSession,
  updatedAt?: string,
): MasteryGraph {
  const timestamp = isoNow(updatedAt ?? session.updatedAt);
  const concepts = durableConcepts(session);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const concept of concepts) {
    const current = nodes.get(concept.id);
    const conceptSignals = session.signals.filter(
      (signal) => signal.conceptId === concept.id,
    );
    const signals = mergeSignals(current?.signals ?? [], conceptSignals);
    const initialStage = current?.stage ?? concept.stageAtIntake;
    const stage = stageFromSignals(initialStage, signals);
    const createdAt = current?.createdAt ?? timestamp;
    const node: MasteryConceptNode = {
      id: concept.id,
      label: concept.label,
      ...(concept.domain ? { domain: concept.domain } : {}),
      stage,
      signals,
      createdAt,
      updatedAt:
        conceptSignals.length > 0 || !current ? timestamp : current.updatedAt,
    };
    nodes.set(concept.id, node);
  }

  return {
    ...graph,
    privacy: { ...MASTERY_PRIVACY_DEFAULTS },
    nodes: [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    updatedAt: timestamp,
  };
}

function resetNodeAfterTaskDeletion(
  node: MasteryConceptNode,
  taskRef: string,
  deletedAt: string,
): {
  node: MasteryConceptNode;
  deletedSignalCount: number;
} {
  const signals = node.signals.filter((signal) => signal.taskRef !== taskRef);
  const deletedSignalCount = node.signals.length - signals.length;
  return {
    node: {
      ...node,
      signals,
      stage: stageFromSignals("unassessed", signals),
      updatedAt: deletedSignalCount > 0 ? deletedAt : node.updatedAt,
    },
    deletedSignalCount,
  };
}

export function deleteMasteryData(
  graph: MasteryGraph,
  selector: MasteryDeletionSelector,
  deletedAt?: string,
): MasteryDeletionResult {
  const timestamp = isoNow(deletedAt);
  let nodes: readonly MasteryConceptNode[];
  let deletedConceptIds: readonly string[] = [];
  let deletedSignalCount = 0;

  if (selector.kind === "all") {
    nodes = [];
    deletedConceptIds = graph.nodes.map((node) => node.id);
    deletedSignalCount = graph.nodes.reduce(
      (total, node) => total + node.signals.length,
      0,
    );
  } else if (selector.kind === "concept") {
    const removed = graph.nodes.filter(
      (node) => node.id === selector.conceptId,
    );
    nodes = graph.nodes.filter((node) => node.id !== selector.conceptId);
    deletedConceptIds = removed.map((node) => node.id);
    deletedSignalCount = removed.reduce(
      (total, node) => total + node.signals.length,
      0,
    );
  } else {
    const results = graph.nodes.map((node) =>
      resetNodeAfterTaskDeletion(node, selector.taskRef, timestamp),
    );
    nodes = results.map((result) => result.node);
    deletedSignalCount = results.reduce(
      (total, result) => total + result.deletedSignalCount,
      0,
    );
  }

  return {
    graph: {
      ...graph,
      privacy: { ...MASTERY_PRIVACY_DEFAULTS },
      nodes,
      updatedAt: timestamp,
    },
    receipt: {
      deletedAt: timestamp,
      selector,
      deletedConceptIds,
      deletedSignalCount,
      requiresPersistence: true,
    },
  };
}

export function createMasterySignalId(input: {
  taskRef: `sha256:${string}`;
  conceptId: string;
  kind: MasterySignalKind;
  occurredAt: string;
  sequence: number;
}): `signal:${string}` {
  const digest = createHash("sha256")
    .update(
      [
        input.taskRef,
        input.conceptId,
        input.kind,
        input.occurredAt,
        input.sequence.toString(),
      ].join("\0"),
    )
    .digest("hex");
  return `signal:${digest}`;
}
