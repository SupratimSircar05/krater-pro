import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTaskPlan } from "./autopilot/index.js";
import { EvidenceTask } from "./evidence-runtime.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Adaptive Plan Compiler", () => {
  it("attaches an executable, evidence-bound plan to every new task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-task-plan-"));
    temporaryPaths.push(cwd);
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Prevent duplicate checkout submissions",
      assurance: "standard",
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    const projection = await task.store.task(task.taskId);
    const plan = projection.autopilot.currentPlan;

    expect(plan).toBeDefined();
    expect(plan && verifyTaskPlan(plan)).toMatchObject({ valid: true });
    expect(plan).toMatchObject({
      revision: 1,
      status: "active",
      objective: "Prevent duplicate checkout submissions",
      createdBy: "system",
      revisedBy: "system",
    });
    expect(plan?.steps.map((step) => step.kind)).toEqual([
      "discover",
      "implement",
      "verify",
      "review",
      "publish",
    ]);
    expect(plan?.steps[0].status).toBe("running");
    expect(plan?.proofObligations.length).toBeGreaterThanOrEqual(2);
    expect(
      plan?.proofObligations.some(
        (obligation) =>
          obligation.kind === "acceptance_criterion" &&
          obligation.statement === "Prevent duplicate checkout submissions" &&
          obligation.minimumGrade === "tested",
      ),
    ).toBe(true);
    expect(
      plan?.proofObligations.every(
        (obligation) =>
          obligation.scopeDigests.includes(plan.contractDigest!) &&
          obligation.status === "pending",
      ),
    ).toBe(true);
  });

  it("raises the minimum proof grade for high-stakes work", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-high-plan-"));
    temporaryPaths.push(cwd);
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project-1",
      request: "Harden the payment authorization boundary",
      assurance: "high",
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    const plan = (await task.store.task(task.taskId)).autopilot.currentPlan;

    expect(plan?.proofObligations.length).toBeGreaterThan(0);
    expect(
      plan?.proofObligations.every(
        (obligation) => obligation.minimumGrade === "stress_tested",
      ),
    ).toBe(true);
  });
});
