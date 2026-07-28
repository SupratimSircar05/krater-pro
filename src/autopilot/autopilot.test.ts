import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOPILOT_SCHEMA_VERSION,
  VerifiedAutopilotService,
  createTaskPlan,
  evaluateProofLease,
  verifyTaskPlan,
  type PlanStepInput,
  type ProofObligationInput,
} from "./index.js";
import {
  ProofGraphStore,
  sha256Digest,
  type EvidenceRecord,
  type TaskContract,
} from "../proofgraph/index.js";

const CREATED_AT = "2026-07-28T10:00:00.000Z";
const REVISED_AT = "2026-07-28T10:05:00.000Z";
const LEASE_EXPIRES_AT = "2026-07-28T11:00:00.000Z";
const temporaryRoots: string[] = [];

function digest(label: string): `sha256:${string}` {
  return sha256Digest(label) as `sha256:${string}`;
}

function contract(taskId: string): TaskContract {
  return {
    schemaVersion: 1,
    id: `contract-${taskId}`,
    taskId,
    request: "Publish a verified change",
    interpretations: [],
    assumptions: [],
    acceptanceCriteria: [
      { id: "acceptance-1", statement: "Behavior is verified", required: true },
    ],
    nonGoals: [],
    assurance: "high",
    budget: { maxToolSteps: 20 },
    allowedCapabilities: ["read", "write", "git_push"],
    requiredChecks: ["npm test"],
    negativeGuarantees: ["Do not expose credentials"],
    createdAt: CREATED_AT,
  };
}

function evidence(taskId: string): EvidenceRecord {
  return {
    id: "evidence-1",
    taskId,
    kind: "test",
    grade: "tested",
    origin: "blind_verifier",
    summary: "Repository tests passed",
    supportsClaimIds: [],
    contradictsClaimIds: [],
    artifactDigests: [digest("test-report")],
    stale: false,
    observedAt: CREATED_AT,
  };
}

function planInputs(
  taskId: string,
  updatedAt = CREATED_AT,
): {
  steps: PlanStepInput[];
  proofObligations: ProofObligationInput[];
} {
  return {
    steps: [
      {
        id: "step-verify",
        taskId,
        kind: "verify",
        title: "Verify the staged change",
        description: "Run the repository-owned acceptance checks.",
        status: "completed",
        dependsOnStepIds: [],
        proofObligationIds: ["proof-1"],
        allowedCapabilities: ["read"],
        createdAt: CREATED_AT,
        updatedAt,
      },
      {
        id: "step-publish",
        taskId,
        kind: "external_effect",
        title: "Publish the verified change",
        description: "Push only after proof and exact approval are present.",
        status: "ready",
        dependsOnStepIds: ["step-verify"],
        proofObligationIds: ["proof-1"],
        allowedCapabilities: ["git_push"],
        createdAt: CREATED_AT,
        updatedAt,
      },
    ],
    proofObligations: [
      {
        id: "proof-1",
        taskId,
        kind: "publication_precondition",
        statement: "Repository tests pass against the staged subject.",
        required: true,
        minimumGrade: "tested",
        status: "satisfied",
        acceptanceCriterionIds: ["acceptance-1"],
        evidenceIds: ["evidence-1"],
        scopeDigests: [digest("workspace")],
        createdAt: CREATED_AT,
        updatedAt,
      },
    ],
  };
}

async function temporaryStore(): Promise<ProofGraphStore> {
  const root = await mkdtemp(join(tmpdir(), "krater-autopilot-"));
  temporaryRoots.push(root);
  return ProofGraphStore.open({ root });
}

async function createTask(store: ProofGraphStore, taskId = "task-1"): Promise<void> {
  await store.append({
    taskId,
    kind: "task.created",
    payload: { contract: contract(taskId) },
    occurredAt: CREATED_AT,
  });
  await store.append({
    taskId,
    kind: "evidence.recorded",
    payload: { evidence: evidence(taskId) },
    occurredAt: CREATED_AT,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("Verified Autopilot records", () => {
  it("redacts before digesting and detects post-creation tampering", () => {
    const inputs = planInputs("task-1");
    const plan = createTaskPlan({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: "plan-1",
      taskId: "task-1",
      revision: 1,
      status: "active",
      objective: "Use Authorization: Bearer top-secret-value to publish",
      steps: inputs.steps.map((step) => ({
        ...step,
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      })),
      proofObligations: inputs.proofObligations.map((obligation) => ({
        ...obligation,
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      })),
      createdBy: "agent",
      revisedBy: "agent",
      createdAt: CREATED_AT,
      revisedAt: CREATED_AT,
      revisionReason: "Initial executable plan",
    });

    expect(plan.objective).toContain("[REDACTED]");
    expect(plan.objective).not.toContain("top-secret-value");
    expect(verifyTaskPlan(plan)).toMatchObject({ valid: true });
    expect(
      verifyTaskPlan({ ...plan, objective: "tampered after digest" }),
    ).toMatchObject({ valid: false });
  });

  it("rejects cyclic plans and revisions without a previous digest", () => {
    const inputs = planInputs("task-1");
    inputs.steps[0].dependsOnStepIds = ["step-publish"];
    expect(() =>
      createTaskPlan({
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: "plan-1",
        taskId: "task-1",
        revision: 2,
        status: "active",
        objective: "Invalid plan",
        steps: inputs.steps.map((step) => ({
          ...step,
          schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        })),
        proofObligations: inputs.proofObligations.map((obligation) => ({
          ...obligation,
          schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        })),
        createdBy: "agent",
        revisedBy: "agent",
        createdAt: CREATED_AT,
        revisedAt: REVISED_AT,
        revisionReason: "Broken revision",
      }),
    ).toThrow(/previous plan digest|cycle/i);
  });

  it("closes no-change work without treating non-applicable proof as passed", () => {
    const inputs = planInputs("task-1");
    const steps = inputs.steps.map((step) => ({
      ...step,
      status: "skipped" as const,
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    }));
    const proof = {
      ...inputs.proofObligations[0],
      status: "not_applicable" as const,
      evidenceIds: [],
      nonApplicabilityReason:
        "No patch was created, so publication proof did not apply.",
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    };
    const plan = createTaskPlan({
      schemaVersion: AUTOPILOT_SCHEMA_VERSION,
      id: "plan-no-change",
      taskId: "task-1",
      revision: 1,
      status: "closed",
      objective: "Keep the already-correct repository unchanged",
      steps,
      proofObligations: [proof],
      createdBy: "system",
      revisedBy: "system",
      createdAt: CREATED_AT,
      revisedAt: CREATED_AT,
      revisionReason: "Repository evidence justified no change.",
    });

    expect(verifyTaskPlan(plan)).toMatchObject({ valid: true });
    expect(plan.proofObligations[0]).toMatchObject({
      status: "not_applicable",
      evidenceIds: [],
    });

    const {
      nonApplicabilityReason: _reason,
      ...invalidProof
    } = proof;
    expect(() =>
      createTaskPlan({
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: "plan-invalid-no-change",
        taskId: "task-1",
        revision: 1,
        status: "closed",
        objective: "Keep the already-correct repository unchanged",
        steps,
        proofObligations: [invalidProof],
        createdBy: "system",
        revisedBy: "system",
        createdAt: CREATED_AT,
        revisedAt: CREATED_AT,
        revisionReason: "Repository evidence justified no change.",
      }),
    ).toThrow(/non-applicability reason/i);
  });
});

describe("VerifiedAutopilotService", () => {
  it("persists a complete append-only plan, delegation, effect, lease, and observation flow", async () => {
    const store = await temporaryStore();
    await createTask(store);
    const service = new VerifiedAutopilotService(store, {
      now: () => new Date(CREATED_AT),
      createId: () => "invalidation-1",
    });
    const inputs = planInputs("task-1");
    const plan = await service.revisePlan({
      id: "plan-1",
      taskId: "task-1",
      status: "active",
      objective: "Verify and publish the task",
      ...inputs,
      createdBy: "agent",
      revisedBy: "agent",
      createdAt: CREATED_AT,
      revisedAt: CREATED_AT,
      revisionReason: "Initial executable plan",
    });

    const delegation = await service.recordDelegation({
      id: "delegation-1",
      taskId: "task-1",
      planId: plan.id,
      planDigest: plan.digest,
      stepIds: ["step-verify"],
      role: "verifier",
      agentRef: "local:sealed-verifier",
      modelId: "krater:auto",
      contextDigest: digest("sealed-context"),
      workspaceDigest: digest("workspace"),
      allowedCapabilities: ["read"],
      status: "completed",
      issuedAt: CREATED_AT,
      completedAt: REVISED_AT,
      resultEvidenceIds: ["evidence-1"],
    });

    const effectPlan = await service.planExternalEffect({
      id: "effect-1",
      taskId: "task-1",
      planId: plan.id,
      planDigest: plan.digest,
      stepId: "step-publish",
      kind: "git_push",
      summary: "Push the verified commit to the approved remote.",
      target: {
        kind: "git_remote",
        displayName: "origin",
        locatorDigest: digest("git@github.com:example/repo.git"),
        allowedDomains: ["github.com"],
      },
      preconditionProofObligationIds: ["proof-1"],
      requiredCapability: "git_push",
      idempotencyKeyDigest: digest("push-main-commit"),
      approvalRequired: true,
      recovery: {
        mode: "compensating",
        description: "Revert the published commit through a new reviewed commit.",
        requiredCapability: "git_push",
      },
      createdAt: CREATED_AT,
      expiresAt: LEASE_EXPIRES_AT,
    });

    const receipt = await service.recordExternalEffectReceipt({
      id: "effect-receipt-1",
      taskId: "task-1",
      effectPlanId: effectPlan.id,
      effectPlanDigest: effectPlan.digest,
      status: "succeeded",
      approvalReceiptDigest: digest("user-approval"),
      preflightEvidenceIds: ["evidence-1"],
      resultEvidenceIds: ["evidence-1"],
      providerReceiptDigests: [digest("remote-push-receipt")],
      summary: "Remote accepted the exact verified commit.",
      startedAt: CREATED_AT,
      completedAt: REVISED_AT,
    });

    const lease = await service.issueProofLease({
      id: "lease-1",
      taskId: "task-1",
      planId: plan.id,
      planRevision: plan.revision,
      planDigest: plan.digest,
      proofObligationIds: ["proof-1"],
      evidenceIds: ["evidence-1"],
      subjectDigest: digest("workspace"),
      environmentDigest: digest("environment"),
      policyDigest: digest("policy"),
      toolchainDigest: digest("toolchain"),
      issuedBy: "blind_verifier",
      issuedAt: CREATED_AT,
      expiresAt: LEASE_EXPIRES_AT,
    });

    await service.recordProductionObservation({
      id: "observation-1",
      taskId: "task-1",
      environment: "production",
      source: "health_check",
      status: "healthy",
      summary: "The published service passed its bounded health check.",
      subjectDigest: digest("workspace"),
      effectReceiptDigest: receipt.digest,
      evidenceIds: ["evidence-1"],
      artifactDigests: [digest("health-report")],
      observedAt: REVISED_AT,
    });

    const validityContext = {
      taskId: "task-1",
      planDigest: plan.digest,
      subjectDigest: digest("workspace"),
      environmentDigest: digest("environment"),
      policyDigest: digest("policy"),
      toolchainDigest: digest("toolchain"),
      now: REVISED_AT,
    } as const;
    expect(await service.evaluateLease("task-1", lease.id, validityContext)).toEqual({
      valid: true,
      status: "valid",
      reasons: [],
    });

    const projection = await store.task("task-1");
    expect(projection.autopilot.currentPlan).toEqual(plan);
    expect(projection.autopilot.planRevisions).toEqual([plan]);
    expect(projection.autopilot.delegations).toEqual([delegation]);
    expect(projection.autopilot.externalEffectPlans).toEqual([effectPlan]);
    expect(projection.autopilot.externalEffectReceipts).toEqual([receipt]);
    expect(projection.autopilot.proofLeases).toEqual([lease]);
    expect(projection.autopilot.productionObservations).toHaveLength(1);
  });

  it("invalidates outstanding proof leases whenever the plan advances", async () => {
    const store = await temporaryStore();
    await createTask(store);
    const service = new VerifiedAutopilotService(store, {
      createId: () => "invalidation-1",
    });
    const inputs = planInputs("task-1");
    const initial = await service.revisePlan({
      id: "plan-1",
      taskId: "task-1",
      status: "active",
      objective: "Initial plan",
      ...inputs,
      createdBy: "agent",
      revisedBy: "agent",
      createdAt: CREATED_AT,
      revisedAt: CREATED_AT,
      revisionReason: "Initial executable plan",
    });
    const lease = await service.issueProofLease({
      id: "lease-1",
      taskId: "task-1",
      planId: initial.id,
      planRevision: initial.revision,
      planDigest: initial.digest,
      proofObligationIds: ["proof-1"],
      evidenceIds: ["evidence-1"],
      subjectDigest: digest("workspace"),
      environmentDigest: digest("environment"),
      policyDigest: digest("policy"),
      toolchainDigest: digest("toolchain"),
      issuedBy: "host_verifier",
      issuedAt: CREATED_AT,
      expiresAt: LEASE_EXPIRES_AT,
    });

    const revisedInputs = planInputs("task-1", REVISED_AT);
    const revised = await service.revisePlan({
      id: "plan-1",
      taskId: "task-1",
      status: "active",
      objective: "Revised plan",
      ...revisedInputs,
      revisedBy: "user",
      revisedAt: REVISED_AT,
      revisionReason: "User changed the publication scope",
    });
    const projection = await store.task("task-1");

    expect(revised.revision).toBe(2);
    expect(revised.previousPlanDigest).toBe(initial.digest);
    expect(projection.autopilot.planRevisions).toEqual([initial, revised]);
    expect(projection.autopilot.proofLeaseInvalidations).toMatchObject([
      {
        id: "invalidation-1",
        leaseId: lease.id,
        leaseDigest: lease.digest,
        reason: "plan_revision",
        causedByDigest: revised.digest,
      },
    ]);
    expect(
      evaluateProofLease(lease, projection.autopilot, {
        taskId: "task-1",
        planDigest: revised.digest,
        subjectDigest: digest("workspace"),
        environmentDigest: digest("environment"),
        policyDigest: digest("policy"),
        toolchainDigest: digest("toolchain"),
        now: REVISED_AT,
      }),
    ).toMatchObject({ valid: false, status: "invalidated" });
  });

  it("rejects undeclared effects, mismatched leases, and unredacted persistence", async () => {
    const store = await temporaryStore();
    await createTask(store);
    const service = new VerifiedAutopilotService(store);
    const inputs = planInputs("task-1");
    const plan = await service.revisePlan({
      id: "plan-1",
      taskId: "task-1",
      status: "active",
      objective: "api_key=must-not-reach-events",
      ...inputs,
      revisedBy: "agent",
      revisedAt: CREATED_AT,
      revisionReason: "Initial plan",
    });

    await expect(
      service.planExternalEffect({
        id: "effect-invalid",
        taskId: "task-1",
        planId: plan.id,
        planDigest: plan.digest,
        stepId: "missing-step",
        kind: "deployment",
        summary: "Undeclared deployment",
        target: {
          kind: "environment",
          displayName: "production",
          locatorDigest: digest("production"),
          allowedDomains: ["example.com"],
        },
        preconditionProofObligationIds: ["proof-1"],
        requiredCapability: "deployment",
        idempotencyKeyDigest: digest("deployment"),
        approvalRequired: true,
        recovery: { mode: "none", description: "No rollback is available." },
        createdAt: CREATED_AT,
        expiresAt: LEASE_EXPIRES_AT,
      }),
    ).rejects.toThrow(/missing plan step/i);

    await expect(
      service.issueProofLease({
        id: "lease-invalid",
        taskId: "task-1",
        planId: plan.id,
        planRevision: plan.revision,
        planDigest: plan.digest,
        proofObligationIds: ["proof-1"],
        evidenceIds: ["missing-evidence"],
        subjectDigest: digest("workspace"),
        environmentDigest: digest("environment"),
        policyDigest: digest("policy"),
        toolchainDigest: digest("toolchain"),
        issuedBy: "host_verifier",
        issuedAt: CREATED_AT,
        expiresAt: LEASE_EXPIRES_AT,
      }),
    ).rejects.toThrow(/lacks current evidence|missing evidence/i);

    const persisted = await readFile(store.eventsPath, "utf8");
    expect(persisted).not.toContain("must-not-reach-events");
    expect(persisted).toContain("[REDACTED]");
  });
});
