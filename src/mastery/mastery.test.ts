import { describe, expect, it } from "vitest";
import {
  applyMasterySession,
  buildMasteryReflectionPrompt,
  createMasteryGraph,
  createMasterySession,
  decideMasterySolutionDisclosure,
  deleteMasteryData,
  exportMasteryGraph,
  markMasteryTaskPublished,
  MASTERY_PRIVACY_DEFAULTS,
  masteryTaskControls,
  masteryTaskRef,
  recordMasteryHint,
  recordMasteryReflection,
  recordMasterySolutionRevealed,
  serializeMasteryExport,
  type MasteryConceptCandidate,
} from "./index.js";

const T0 = "2026-07-28T00:00:00.000Z";
const T1 = "2026-07-28T00:01:00.000Z";
const T2 = "2026-07-28T00:02:00.000Z";
const T3 = "2026-07-28T00:03:00.000Z";

function candidate(
  overrides: Partial<MasteryConceptCandidate> &
    Pick<MasteryConceptCandidate, "id">,
): MasteryConceptCandidate {
  return {
    id: overrides.id,
    label: overrides.label ?? `Concept ${overrides.id}`,
    domain: overrides.domain ?? "testing",
    invariant:
      overrides.invariant ?? "The externally visible behavior stays stable.",
    hint: overrides.hint ?? "Start from the smallest observable boundary.",
    risk: overrides.risk ?? 0.4,
    declaredStage: overrides.declaredStage,
    source: overrides.source ?? "task_analysis",
  };
}

describe("Mastery Mode opt-in and concept selection", () => {
  it("is disabled per task by default", () => {
    expect(masteryTaskControls().enabled).toBe(false);
    const session = createMasterySession({
      taskId: "task-private-title",
      candidates: [candidate({ id: "transactions", risk: 1 })],
      createdAt: T0,
    });

    expect(session.status).toBe("disabled");
    expect(session.guidance).toEqual([]);
    expect(session.taskRef).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(session)).not.toContain("task-private-title");
  });

  it("selects unfamiliar or high-risk concepts and excludes familiar low-risk work", () => {
    const session = createMasterySession({
      taskId: "task-1",
      controls: { enabled: true, maximumConcepts: 2 },
      candidates: [
        candidate({
          id: "familiar-low",
          risk: 0.2,
          declaredStage: "familiar",
        }),
        candidate({
          id: "familiar-high",
          risk: 0.95,
          declaredStage: "familiar",
        }),
        candidate({
          id: "unfamiliar",
          risk: 0.4,
          declaredStage: "unfamiliar",
        }),
        candidate({
          id: "unassessed",
          risk: 0.1,
          declaredStage: "unassessed",
        }),
      ],
      createdAt: T0,
    });

    expect(session.status).toBe("guidance");
    expect(session.guidance.map((item) => item.conceptId)).toEqual([
      "familiar-high",
      "unfamiliar",
    ]);
    expect(session.guidance[0]?.reasons).toEqual(["high_risk"]);
    expect(session.guidance[1]?.reasons).toEqual(["unfamiliar"]);
  });
});

describe("hint-first and post-publication workflow", () => {
  function activeSession() {
    return createMasterySession({
      taskId: "task-2",
      controls: { enabled: true },
      candidates: [
        candidate({
          id: "atomicity",
          label: "atomic publication",
          risk: 0.9,
          declaredStage: "unfamiliar",
        }),
      ],
      createdAt: T0,
    });
  }

  it("withholds a full solution until a hint is delivered or explicitly bypassed", () => {
    const initial = activeSession();
    expect(
      decideMasterySolutionDisclosure(initial, "atomicity"),
    ).toEqual({
      allowed: false,
      conceptId: "atomicity",
      next: "deliver_hint",
      hint: "Start from the smallest observable boundary.",
      invariant: "The externally visible behavior stays stable.",
    });
    expect(() =>
      recordMasterySolutionRevealed(initial, "atomicity", T1),
    ).toThrow(/hint must be delivered/i);

    const hinted = recordMasteryHint(
      initial,
      "atomicity",
      "delivered",
      T1,
    );
    expect(
      decideMasterySolutionDisclosure(hinted, "atomicity").allowed,
    ).toBe(true);
    const revealed = recordMasterySolutionRevealed(
      hinted,
      "atomicity",
      T2,
    );
    expect(revealed.guidance[0]?.solutionStatus).toBe("revealed");
    expect(revealed.signals.map((signal) => signal.kind)).toEqual([
      "hint_delivered",
      "solution_revealed",
    ]);
  });

  it("asks a 60-second failure-mode check for a high-risk concept", () => {
    const hinted = recordMasteryHint(
      activeSession(),
      "atomicity",
      "bypassed",
      T1,
    );
    const published = markMasteryTaskPublished(hinted, T2);
    const prompt = buildMasteryReflectionPrompt(published, "atomicity");

    expect(prompt).toEqual(
      expect.objectContaining({
        kind: "failure_mode",
        timeboxSeconds: 60,
      }),
    );
    expect(prompt?.prompt).toContain("failure mode");

    const reflected = recordMasteryReflection(
      published,
      "atomicity",
      "demonstrated",
      T3,
    );
    expect(reflected.status).toBe("complete");
    expect(reflected.signals.at(-1)).toEqual(
      expect.objectContaining({
        kind: "failure_mode_identified",
        origin: "local_evaluator",
      }),
    );
    expect(reflected.signals.at(-1)).not.toHaveProperty("response");
    expect(reflected.signals.at(-1)).not.toHaveProperty("score");
  });
});

describe("private mastery graph lifecycle", () => {
  function completedSession(taskId: string, start: string) {
    const initial = createMasterySession({
      taskId,
      controls: { enabled: true, reflection: "teach_back" },
      candidates: [
        candidate({
          id: "contracts",
          label: "behavioral contracts",
          invariant: "RAW_SOURCE_SHOULD_NOT_PERSIST",
          hint: "const rawSource = 'SHOULD_NOT_EXPORT';",
          declaredStage: "unfamiliar",
        }),
      ],
      createdAt: start,
    });
    const hinted = recordMasteryHint(
      initial,
      "contracts",
      "delivered",
      start,
    );
    const published = markMasteryTaskPublished(hinted, start);
    return recordMasteryReflection(
      published,
      "contracts",
      "demonstrated",
      start,
    );
  }

  it("persists structured signals but neither guidance nor raw answers/source", () => {
    const graph = applyMasterySession(
      createMasteryGraph(T0),
      completedSession("private task request", T1),
      T2,
    );
    const exported = serializeMasteryExport(
      exportMasteryGraph(graph, {
        scope: "signals",
        exportedAt: T3,
      }),
    );

    expect(graph.nodes[0]?.stage).toBe("learning");
    expect(exported).not.toContain("RAW_SOURCE_SHOULD_NOT_PERSIST");
    expect(exported).not.toContain("SHOULD_NOT_EXPORT");
    expect(exported).not.toContain("private task request");
    expect(exported).not.toContain('"response"');
    expect(exported).not.toContain('"productivity"');
    expect(exported).not.toContain('"managerScore"');
  });

  it("uses non-managerial, private, local-only defaults", () => {
    expect(MASTERY_PRIVACY_DEFAULTS).toEqual({
      storage: "local_only",
      owner: "user",
      defaultVisibility: "private",
      rawSourceRetention: false,
      rawResponseRetention: false,
      hiddenTelemetry: false,
      managerialScoring: false,
      employerReporting: false,
      collaboratorSharing: false,
      sharingRequiresExplicitExport: true,
    });
    expect(createMasteryGraph(T0).privacy).toEqual(MASTERY_PRIVACY_DEFAULTS);
  });

  it("moves to familiar only after positive signals across separate tasks", () => {
    const first = applyMasterySession(
      createMasteryGraph(T0),
      completedSession("task-a", T1),
      T1,
    );
    const second = applyMasterySession(
      first,
      completedSession("task-b", T2),
      T2,
    );

    expect(first.nodes[0]?.stage).toBe("learning");
    expect(second.nodes[0]?.stage).toBe("familiar");
    expect(second.nodes[0]?.signals).toHaveLength(4);
  });

  it("exports summaries by default and signals only when explicitly requested", () => {
    const graph = applyMasterySession(
      createMasteryGraph(T0),
      completedSession("task-a", T1),
      T2,
    );
    const summary = exportMasteryGraph(graph, { exportedAt: T3 });
    const detailed = exportMasteryGraph(graph, {
      scope: "signals",
      exportedAt: T3,
    });

    expect(summary.userDirectedExport).toBe(true);
    expect(summary.scope).toBe("summary");
    expect(summary.nodes[0]).not.toHaveProperty("signals");
    expect(detailed.nodes[0]?.signals).toHaveLength(2);
  });

  it("deletes a task's signals, one concept, or the full graph with receipts", () => {
    const graph = applyMasterySession(
      createMasteryGraph(T0),
      completedSession("task-a", T1),
      T2,
    );
    const taskDeleted = deleteMasteryData(
      graph,
      { kind: "task", taskRef: masteryTaskRef("task-a") },
      T3,
    );
    expect(taskDeleted.graph.nodes[0]?.signals).toEqual([]);
    expect(taskDeleted.graph.nodes[0]?.stage).toBe("unassessed");
    expect(taskDeleted.receipt.deletedSignalCount).toBe(2);
    expect(taskDeleted.receipt.requiresPersistence).toBe(true);

    const conceptDeleted = deleteMasteryData(
      graph,
      { kind: "concept", conceptId: "contracts" },
      T3,
    );
    expect(conceptDeleted.graph.nodes).toEqual([]);
    expect(conceptDeleted.receipt.deletedConceptIds).toEqual(["contracts"]);

    const allDeleted = deleteMasteryData(graph, { kind: "all" }, T3);
    expect(allDeleted.graph.nodes).toEqual([]);
    expect(allDeleted.receipt.deletedSignalCount).toBe(2);
  });
});
