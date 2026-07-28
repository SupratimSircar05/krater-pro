import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceTask,
  cancelEvidenceTask,
  evidencePublicationReadiness,
  finalizeEvidencePublication,
  listEvidenceTasks,
  openEvidenceStore,
  readEvidenceTask,
  renderPassportMarkdown,
} from "./evidence-runtime.js";
import {
  verifyChangePassport,
  verifyEvidenceCapsule,
} from "./proofgraph/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-evidence-runtime-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("EvidenceTask", () => {
  it("durably cancels an active task with a verifiable capsule and passport", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Investigate without publishing",
      assurance: "standard",
    });

    const cancelled = await cancelEvidenceTask(cwd, task.taskId, {
      reason: "The user stopped this investigation.",
    });
    expect(cancelled).toMatchObject({
      state: "cancelled",
      capsule: {
        state: "cancelled",
        changedBehavior: [],
        approvals: ["human:requested_task_cancellation"],
      },
      passport: {
        verdict: "cancelled",
      },
    });
    expect(cancelled.capsule?.gaps).toContain(
      "The user stopped this investigation.",
    );
    expect(verifyEvidenceCapsule(cancelled.capsule!).valid).toBe(true);
    expect(
      verifyChangePassport(cancelled.passport!, cancelled.capsule!).valid,
    ).toBe(true);

    const beforeRetry = await (await openEvidenceStore(cwd)).replay();
    const retried = await cancelEvidenceTask(cwd, task.taskId);
    const afterRetry = await (await openEvidenceStore(cwd)).replay();
    expect(retried.lastEventHash).toBe(cancelled.lastEventHash);
    expect(afterRetry.events).toHaveLength(beforeRetry.events.length);
  });

  it("durably records structured ambiguity state before model execution", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Update config.ts",
      assurance: "standard",
    });

    await task.recordAmbiguityPreflight({
      assumptions: [
        {
          id: "assumption:user-choice",
          statement: "The user selected server/config.ts.",
          source: "user",
          resolved: true,
        },
      ],
      interpretations: [
        {
          id: "interpretation:client",
          description: "Update client/config.ts",
          selected: false,
        },
        {
          id: "interpretation:server",
          description: "Update server/config.ts",
          selected: true,
        },
      ],
      clarification: {
        id: "clarification:target",
        question: "Which config.ts?",
        interpretations: ["client/config.ts", "server/config.ts"],
        score: 2,
      },
    });

    const detail = await readEvidenceTask(cwd, "project-1", task.taskId);
    expect(task.currentState).toBe("clarification");
    expect(detail.task.state).toBe("clarification");
    expect(detail.contract.assumptions).toEqual([
      "The user selected server/config.ts.",
    ]);
    expect(detail.contract.interpretations).toEqual([
      expect.objectContaining({ id: "interpretation:client", selected: false }),
      expect.objectContaining({ id: "interpretation:server", selected: true }),
    ]);
    expect(detail.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assumption",
          text: "The user selected server/config.ts.",
        }),
      ]),
    );
  });

  it("continues from clarification only after a selected interpretation is recorded", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Update config.ts",
    });
    await task.recordAmbiguityPreflight({
      assumptions: [],
      interpretations: [
        {
          id: "interpretation:client",
          description: "Update client/config.ts",
          selected: false,
        },
        {
          id: "interpretation:server",
          description: "Update server/config.ts",
          selected: false,
        },
      ],
      clarification: {
        id: "clarification:target",
        question: "Which config.ts?",
        interpretations: ["client/config.ts", "server/config.ts"],
        score: 2,
      },
    });
    expect(task.currentState).toBe("clarification");

    await task.recordAmbiguityPreflight({
      assumptions: [
        {
          id: "assumption:user-choice",
          statement: "The user selected server/config.ts.",
          source: "user",
          resolved: true,
        },
      ],
      interpretations: [
        {
          id: "interpretation:client",
          description: "Update client/config.ts",
          selected: false,
        },
        {
          id: "interpretation:server",
          description: "Update server/config.ts",
          selected: true,
        },
      ],
    });

    expect(task.currentState).toBe("reproduction");
    const detail = await readEvidenceTask(cwd, "project-1", task.taskId);
    expect(detail.task.state).toBe("reproduction");
    expect(detail.contract.interpretations.at(-1)?.selected).toBe(true);
  });

  it("blocks completion when the Action/Abstention Gate is missing", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Explain the parser",
      assurance: "fast",
    });

    const projection = await task.finish();

    expect(projection.state).toBe("blocked");
    expect(projection.capsule?.gaps).toContain(
      "Action/Abstention Gate was not established from repository evidence.",
    );
    expect(projection.passport?.weakestEvidenceGrade).toBe("not_established");
  });

  it("treats an evidence-backed no-change result as a successful abstention", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Do not change a parser that already passes",
      assurance: "fast",
    });
    task.accept({
      type: "tool",
      id: "test-1",
      name: "run_command",
      args: { command: "npm test -- parser" },
    });
    task.accept({
      type: "tool_result",
      id: "test-1",
      name: "run_command",
      output: "Exit code: 0",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "already_satisfied_no_change",
      shouldStageCode: false,
      reasons: ["The repository regression test already passes."],
      evidenceRefs: ["test-1"],
    });

    const projection = await task.finish();

    expect(projection.state).toBe("abstained");
    expect(projection.evidence.map((item) => item.grade)).toContain("tested");
    expect(projection.passport?.verdict).toBe("abstained");
  });

  it("keeps a changed task in review and reports every missing proof obligation", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Repair the parser",
      assurance: "standard",
    });
    task.accept({
      type: "tool",
      id: "read-1",
      name: "read_file",
      args: { path: "src/parser.ts" },
    });
    task.accept({
      type: "tool_result",
      id: "read-1",
      name: "read_file",
      output: "parser source",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "change_required",
      shouldStageCode: true,
      reasons: ["The parser contradicts the required behavior."],
      evidenceRefs: ["read-1"],
    });
    task.accept({
      type: "tool",
      id: "write-1",
      name: "replace_in_file",
      args: {
        path: "src/parser.ts",
        search: "broken",
        replacement: "fixed",
      },
    });
    task.accept({
      type: "tool_result",
      id: "write-1",
      name: "replace_in_file",
      output: "Updated src/parser.ts",
      ok: true,
    });
    task.accept({
      type: "tool",
      id: "test-1",
      name: "run_command",
      args: { command: "npm test -- parser" },
    });
    task.accept({
      type: "tool_result",
      id: "test-1",
      name: "run_command",
      output: "Exit code: 0",
      ok: true,
    });

    const projection = await task.finish({
      baseWorkspaceDigest: `sha256:${"a".repeat(64)}`,
      finalWorkspaceDigest: `sha256:${"b".repeat(64)}`,
    });

    expect(projection.state).toBe("review");
    expect(projection.passport?.changedPaths).toEqual(["src/parser.ts"]);
    expect(projection.capsule?.gaps).toContain(
      "Required check not established: typecheck",
    );
    expect(projection.capsule?.gaps).toContain(
      "Required check not established: secret_scan",
    );
    expect(projection.capsule?.gaps).toContain(
      "Transactional publication is pending explicit user acceptance.",
    );
    expect(renderPassportMarkdown(projection)).toContain(
      "# Krater Pro Change Passport",
    );
  });

  it("redacts persisted secret fields and exposes task list/detail projections", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Inspect configuration",
      assurance: "fast",
    });
    task.accept({
      type: "tool",
      id: "read-1",
      name: "read_file",
      args: {
        path: ".env.example",
        apiKey: ["sk", "live", "do-not-persist-123456789"].join("-"),
      },
    });
    task.accept({
      type: "tool_result",
      id: "read-1",
      name: "read_file",
      output: "No source change required.",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "already_satisfied_no_change",
      shouldStageCode: false,
      reasons: ["Configuration is already documented."],
      evidenceRefs: ["read-1"],
    });
    await task.finish();

    const summaries = await listEvidenceTasks(cwd, "project-1");
    const detail = await readEvidenceTask(cwd, "project-1", task.taskId);
    const persisted = await readFile(
      join(cwd, ".krater", "proofgraph", "events.ndjson"),
      "utf8",
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: task.taskId,
      state: "abstained",
    });
    expect(detail.eventCount).toBeGreaterThan(3);
    expect(persisted).not.toContain("do-not-persist");
    expect(persisted).toContain("[REDACTED]");
  });

  it("requires explicit gap acceptance and durably finalizes a published ProofPatch", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Repair the parser",
      assurance: "standard",
    });
    task.accept({
      type: "tool",
      id: "read-1",
      name: "read_file",
      args: { path: "parser.ts" },
    });
    task.accept({
      type: "tool_result",
      id: "read-1",
      name: "read_file",
      output: "broken",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "change_required",
      shouldStageCode: true,
      reasons: ["The parser is broken."],
      evidenceRefs: ["read-1"],
    });
    task.accept({
      type: "tool",
      id: "write-1",
      name: "write_file",
      args: { path: "parser.ts", content: "fixed" },
    });
    task.accept({
      type: "tool_result",
      id: "write-1",
      name: "write_file",
      output: "updated",
      ok: true,
    });
    const baseWorkspaceDigest = `sha256:${"c".repeat(64)}`;
    const finalWorkspaceDigest = `sha256:${"d".repeat(64)}`;
    await task.finish({ baseWorkspaceDigest, finalWorkspaceDigest });

    const readiness = await evidencePublicationReadiness(cwd, task.taskId);
    expect(readiness).toMatchObject({
      canPublish: true,
      requiresGapAcceptance: true,
    });
    expect(readiness.gaps).not.toContain(
      "Transactional publication is pending explicit user acceptance.",
    );
    await expect(
      finalizeEvidencePublication(cwd, task.taskId, {
        baseWorkspaceDigest,
        finalWorkspaceDigest,
      }),
    ).rejects.toThrow("Explicitly accept gaps");

    const projection = await finalizeEvidencePublication(cwd, task.taskId, {
      acceptGaps: true,
      baseWorkspaceDigest,
      finalWorkspaceDigest,
      transactionId: "transaction-1",
    });

    expect(projection.state).toBe("accepted_with_gaps");
    expect(projection.capsule?.gaps).not.toContain(
      "Transactional publication is pending explicit user acceptance.",
    );
    expect(projection.evidence).toContainEqual(
      expect.objectContaining({
        tool: "ProofPatch",
        grade: "tested",
      }),
    );
    expect(projection.passport?.summary).toContain("atomically published");
  });

  it("resumes interrupted publication finalization and remains idempotent", async () => {
    const cwd = await temporaryDirectory();
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Repair the parser",
      assurance: "fast",
    });
    task.accept({
      type: "tool",
      id: "read-1",
      name: "read_file",
      args: { path: "parser.ts" },
    });
    task.accept({
      type: "tool_result",
      id: "read-1",
      name: "read_file",
      output: "broken",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "change_required",
      shouldStageCode: true,
      reasons: ["The parser is broken."],
      evidenceRefs: ["read-1"],
    });
    task.accept({
      type: "tool",
      id: "write-1",
      name: "write_file",
      args: { path: "parser.ts", content: "fixed" },
    });
    task.accept({
      type: "tool_result",
      id: "write-1",
      name: "write_file",
      output: "updated",
      ok: true,
    });
    task.accept({
      type: "tool",
      id: "test-1",
      name: "run_command",
      args: { command: "npm test -- parser" },
    });
    task.accept({
      type: "tool_result",
      id: "test-1",
      name: "run_command",
      output: "Exit code: 0",
      ok: true,
    });
    const baseWorkspaceDigest = `sha256:${"e".repeat(64)}`;
    const finalWorkspaceDigest = `sha256:${"f".repeat(64)}`;
    await task.finish({ baseWorkspaceDigest, finalWorkspaceDigest });

    // Simulate a crash after ProofPatch has published and the durable state
    // reached `publication`, but before the final capsule/passport were written.
    const store = await openEvidenceStore(cwd);
    await store.append({
      taskId: task.taskId,
      kind: "task.state.changed",
      payload: {
        from: "review",
        to: "publication",
        reason: "Atomic ProofPatch publication succeeded.",
      },
    });

    expect(await evidencePublicationReadiness(cwd, task.taskId)).toMatchObject({
      state: "publication",
      canPublish: true,
    });
    const completed = await finalizeEvidencePublication(cwd, task.taskId, {
      baseWorkspaceDigest,
      finalWorkspaceDigest,
      transactionId: "transaction-resume",
    });
    expect(completed).toMatchObject({
      state: "complete",
      capsule: { state: "complete", gaps: [] },
      passport: { verdict: "complete" },
    });

    const beforeRetry = (await store.replay()).events.length;
    const retried = await finalizeEvidencePublication(cwd, task.taskId, {
      baseWorkspaceDigest,
      finalWorkspaceDigest,
      transactionId: "transaction-resume",
    });
    const afterRetry = (await store.replay()).events.length;
    expect(retried.lastEventHash).toBe(completed.lastEventHash);
    expect(afterRetry).toBe(beforeRetry);
  });
});
