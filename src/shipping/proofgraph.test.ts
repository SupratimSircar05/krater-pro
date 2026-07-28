import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOPILOT_SCHEMA_VERSION,
  VerifiedAutopilotService,
  autopilotRecordDigest,
  type AutopilotDigest,
} from "../autopilot/index.js";
import { ProofGraphStore } from "../proofgraph/index.js";
import {
  InMemoryShippingLedger,
  InMemoryShippingRuntimeVault,
  ProofGraphShippingCoordinator,
  SHIPPING_SCHEMA_VERSION,
  StructuredShippingService,
  durableShippingStatus,
  targetLocatorDigest,
  type DurableShippingExecutionInput,
  type GitHubPushEffect,
  type ShippingCredentialHandle,
  type StructuredShippingExecutor,
} from "./index.js";

const NOW = "2026-07-28T10:00:00.000Z";
const IDEMPOTENCY = "proofgraph-shipping-idempotency-0001";
const SOURCE_SHA = "b".repeat(40);
const REMOTE_SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

function digest(value: string): AutopilotDigest {
  return autopilotRecordDigest({ value });
}

const effect: GitHubPushEffect = {
  kind: "github_push",
  owner: "SupratimSircar05",
  repository: "krater-pro",
  branch: "main",
  sourceCommitSha: SOURCE_SHA,
  sourceDigest: digest("release-source"),
  expectedRemoteCommitSha: REMOTE_SHA,
};

const credential: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "github",
  id: "credential:github:test",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{
  store: ProofGraphStore;
  taskId: string;
  planDigest: AutopilotDigest;
  stepId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "krater-shipping-proofgraph-"));
  temporaryDirectories.push(root);
  const store = await ProofGraphStore.open({ root: join(root, ".krater") });
  const taskId = "task-shipping";
  await store.append({
    taskId,
    kind: "task.created",
    occurredAt: NOW,
    payload: {
      contract: {
        schemaVersion: 1,
        id: "contract-shipping",
        taskId,
        request: "Ship the verified release",
        interpretations: [],
        assumptions: [],
        acceptanceCriteria: [
          {
            id: "release-ready",
            statement: "The exact verified source is released.",
            required: true,
          },
        ],
        nonGoals: [],
        assurance: "high",
        budget: {},
        allowedCapabilities: ["github.push"],
        requiredChecks: ["release-check"],
        negativeGuarantees: ["Do not force push."],
        createdAt: NOW,
      },
    },
  });
  await store.append({
    taskId,
    kind: "evidence.recorded",
    occurredAt: NOW,
    payload: {
      evidence: {
        id: "evidence-release",
        taskId,
        kind: "test",
        grade: "tested",
        origin: "repository",
        summary: "The release checks passed.",
        supportsClaimIds: [],
        contradictsClaimIds: [],
        artifactDigests: [effect.sourceDigest],
        stale: false,
        observedAt: NOW,
      },
    },
  });
  const stepId = "ship-release";
  const plan = await new VerifiedAutopilotService(store, {
    now: () => new Date(NOW),
    createId: () => "autopilot-id",
  }).revisePlan({
    id: "plan-shipping",
    taskId,
    status: "active",
    objective: "Ship the exact verified source.",
    steps: [
      {
        id: stepId,
        taskId,
        kind: "external_effect",
        title: "Ship verified release",
        description: "Push the exact source commit through a structured adapter.",
        status: "ready",
        dependsOnStepIds: [],
        proofObligationIds: ["proof-release"],
        allowedCapabilities: ["github.push"],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proofObligations: [
      {
        id: "proof-release",
        taskId,
        kind: "publication_precondition",
        statement: "The exact source passed release checks.",
        required: true,
        minimumGrade: "tested",
        status: "satisfied",
        acceptanceCriterionIds: ["release-ready"],
        evidenceIds: ["evidence-release"],
        scopeDigests: [effect.sourceDigest],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdBy: "user",
    revisedBy: "user",
    revisedAt: NOW,
    revisionReason: "Verified shipping fixture.",
  });
  return { store, taskId, planDigest: plan.digest, stepId };
}

function adapter(): {
  executor: StructuredShippingExecutor;
  mutationCalls: () => number;
} {
  let mutations = 0;
  const inspection = async () => ({
    schemaVersion: SHIPPING_SCHEMA_VERSION,
    effectKind: effect.kind,
    targetLocatorDigest: targetLocatorDigest(effect),
    currentStateDigest: digest("remote-before"),
    evidenceIds: ["evidence-inspection"],
    canMutate: true,
    remoteCommitSha: REMOTE_SHA,
  });
  const executor: StructuredShippingExecutor = {
    inspectGitHubPush: inspection,
    pushGitHub: async () => {
      mutations += 1;
      return {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "succeeded",
        summary: "The fake adapter accepted the exact source commit.",
        targetStateDigest: effect.sourceDigest,
        evidenceIds: ["evidence-provider-result"],
        providerReceiptHandle: "github:test-receipt",
        compensationHandle: "github:test-compensation",
      };
    },
    compensateGitHubPush: async () => ({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary: "The fake adapter restored the prior branch.",
      targetStateDigest: digest("remote-before"),
      evidenceIds: ["evidence-compensation"],
      providerReceiptHandle: "github:test-compensation-receipt",
    }),
  };
  return { executor, mutationCalls: () => mutations };
}

function structured(executor: StructuredShippingExecutor) {
  let id = 0;
  return new StructuredShippingService({
    executor,
    ledger: new InMemoryShippingLedger(),
    vault: new InMemoryShippingRuntimeVault(),
    allowVolatileState: true,
    now: () => new Date(NOW),
    createId: () => `shipping-${++id}`,
  });
}

describe("ProofGraph shipping integration", () => {
  it("persists an exact preflight, confirmation, receipt, and Proof Lease", async () => {
    const prepared = await fixture();
    const fake = adapter();
    let coordinatorId = 0;
    const coordinator = new ProofGraphShippingCoordinator({
      store: prepared.store,
      shipping: structured(fake.executor),
      now: () => new Date(NOW),
      createId: () => `coordinator-${++coordinatorId}`,
    });
    const preflight = await coordinator.prepare({
      taskId: prepared.taskId,
      expectedPlanDigest: prepared.planDigest,
      stepId: prepared.stepId,
      effect,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
    });
    expect(fake.mutationCalls()).toBe(0);
    expect(
      (await prepared.store.task(prepared.taskId)).autopilot.externalEffectPlans,
    ).toEqual([preflight.effectPlan]);

    await expect(
      coordinator.confirm({
        taskId: prepared.taskId,
        effectPlanId: preflight.effectPlan.id,
        expectedPlanDigest: prepared.planDigest,
        expectedEffectPlanDigest: digest("wrong-effect-plan"),
        expectedPreflightDigest: preflight.digest,
        expectedChallengeDigest: preflight.challenge.digest,
        credentialHandle: credential,
        idempotencyKey: IDEMPOTENCY,
      }),
    ).rejects.toThrow("exact durable preflight");

    const confirmation = await coordinator.confirm({
      taskId: prepared.taskId,
      effectPlanId: preflight.effectPlan.id,
      expectedPlanDigest: prepared.planDigest,
      expectedEffectPlanDigest: preflight.effectPlan.digest,
      expectedPreflightDigest: preflight.digest,
      expectedChallengeDigest: preflight.challenge.digest,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
    });
    expect(confirmation.idempotent).toBe(false);
    expect(fake.mutationCalls()).toBe(0);

    const executionInput: DurableShippingExecutionInput = {
      taskId: prepared.taskId,
      effectPlanId: preflight.effectPlan.id,
      expectedPlanDigest: prepared.planDigest,
      expectedEffectPlanDigest: preflight.effectPlan.digest,
      expectedPreflightDigest: preflight.digest,
      expectedChallengeDigest: preflight.challenge.digest,
      expectedAuthorizationDigest: confirmation.authorization.digest,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      lease: {
        environmentDigest: digest("environment"),
        policyDigest: digest("policy"),
        toolchainDigest: digest("toolchain"),
        issuedBy: "blind_verifier",
        ttlMs: 60_000,
      },
    };
    const execution = await coordinator.execute(executionInput);
    expect(execution).toMatchObject({
      idempotent: false,
      providerState: "recorded",
      reconciliationRequired: false,
      receipt: { status: "succeeded" },
      proofLease: {
        planDigest: prepared.planDigest,
        subjectDigest: effect.sourceDigest,
      },
    });
    expect(fake.mutationCalls()).toBe(1);

    await expect(
      coordinator.execute({
        ...executionInput,
        expectedAuthorizationDigest: digest("wrong-authorization"),
      }),
    ).rejects.toThrow("exact durable user authorization");
    await expect(
      coordinator.execute({
        ...executionInput,
        idempotencyKey: "proofgraph-shipping-idempotency-wrong",
      }),
    ).rejects.toThrow("Idempotency value changed");
    expect(fake.mutationCalls()).toBe(1);

    const replay = await coordinator.execute(executionInput);
    expect(replay.idempotent).toBe(true);
    expect(replay.receipt.digest).toBe(execution.receipt.digest);
    expect(fake.mutationCalls()).toBe(1);

    const projection = await prepared.store.task(prepared.taskId);
    expect(projection.autopilot.externalEffectReceipts).toHaveLength(1);
    expect(projection.autopilot.proofLeases).toHaveLength(1);
    expect(
      projection.actions.map((action) => action.name),
    ).toEqual(
      expect.arrayContaining([
        "shipping.preflight.persisted",
        "shipping.confirmation.persisted",
        "shipping.execution.started",
        "shipping.execution.completed",
      ]),
    );
    const status = await durableShippingStatus(
      prepared.store,
      prepared.taskId,
    );
    expect(status.phases).toEqual([
      expect.objectContaining({
        state: "recorded",
        receiptDigest: execution.receipt.digest,
        proofLeaseDigest: execution.proofLease?.digest,
      }),
    ]);
    expect(status.reconciliationGaps).toEqual([]);

    const durableBytes = JSON.stringify(await prepared.store.replay());
    expect(durableBytes).not.toContain(IDEMPOTENCY);
    expect(durableBytes).not.toContain(credential.id);
  });

  it("reports an execution without a durable receipt as provider-state unknown", async () => {
    const prepared = await fixture();
    const fake = adapter();
    class InterruptedShippingService extends StructuredShippingService {
      override async execute(
        _input: Parameters<StructuredShippingService["execute"]>[0],
      ): Promise<Awaited<ReturnType<StructuredShippingService["execute"]>>> {
        throw new Error("simulated process interruption");
      }
    }
    const base = structured(fake.executor);
    const interrupted = new InterruptedShippingService({
      executor: fake.executor,
      ledger: new InMemoryShippingLedger(),
      vault: new InMemoryShippingRuntimeVault(),
      allowVolatileState: true,
      now: () => new Date(NOW),
      createId: () => "interrupted-shipping",
    });
    void base;
    let coordinatorId = 0;
    const coordinator = new ProofGraphShippingCoordinator({
      store: prepared.store,
      shipping: interrupted,
      now: () => new Date(NOW),
      createId: () => `interrupted-${++coordinatorId}`,
    });
    const preflight = await coordinator.prepare({
      taskId: prepared.taskId,
      expectedPlanDigest: prepared.planDigest,
      stepId: prepared.stepId,
      effect,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
    });
    const confirmation = await coordinator.confirm({
      taskId: prepared.taskId,
      effectPlanId: preflight.effectPlan.id,
      expectedPlanDigest: prepared.planDigest,
      expectedEffectPlanDigest: preflight.effectPlan.digest,
      expectedPreflightDigest: preflight.digest,
      expectedChallengeDigest: preflight.challenge.digest,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
    });
    await expect(
      coordinator.execute({
        taskId: prepared.taskId,
        effectPlanId: preflight.effectPlan.id,
        expectedPlanDigest: prepared.planDigest,
        expectedEffectPlanDigest: preflight.effectPlan.digest,
        expectedPreflightDigest: preflight.digest,
        expectedChallengeDigest: preflight.challenge.digest,
        expectedAuthorizationDigest: confirmation.authorization.digest,
        credentialHandle: credential,
        idempotencyKey: IDEMPOTENCY,
        lease: {
          environmentDigest: digest("environment"),
          policyDigest: digest("policy"),
          toolchainDigest: digest("toolchain"),
          issuedBy: "blind_verifier",
          ttlMs: 60_000,
        },
      }),
    ).rejects.toThrow("Provider reconciliation is required");

    const status = await durableShippingStatus(
      prepared.store,
      prepared.taskId,
    );
    expect(status.phases[0].state).toBe("execution_unknown");
    expect(status.reconciliationGaps).toEqual([
      expect.objectContaining({
        code: "provider_state_unknown",
        severity: "critical",
        blocksRetry: true,
      }),
    ]);
  });
});
