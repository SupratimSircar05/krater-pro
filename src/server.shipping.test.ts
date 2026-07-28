import { type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerifiedAutopilotService,
  autopilotRecordDigest,
  type AutopilotDigest,
} from "./autopilot/index.js";
import { loadConfig } from "./config.js";
import { openEvidenceStore } from "./evidence-runtime.js";
import { createApp } from "./server.js";
import {
  InMemoryShippingLedger,
  InMemoryShippingRuntimeVault,
  SHIPPING_SCHEMA_VERSION,
  StructuredShippingService,
  targetLocatorDigest,
  type GitHubPushEffect,
  type ShippingCredentialHandle,
  type StructuredShippingExecutor,
} from "./shipping/index.js";

const SOURCE_SHA = "b".repeat(40);
const REMOTE_SHA = "a".repeat(40);
const IDEMPOTENCY_KEY = "server-shipping-idempotency-0001";
const CREDENTIAL: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "github",
  id: "credential:github:server-test",
};
const temporaryPaths: string[] = [];
const servers: Server[] = [];

function digest(value: string): AutopilotDigest {
  return autopilotRecordDigest({ value });
}

const EFFECT: GitHubPushEffect = {
  kind: "github_push",
  owner: "SupratimSircar05",
  repository: "krater-pro",
  branch: "main",
  sourceCommitSha: SOURCE_SHA,
  sourceDigest: digest("server-release-source"),
  expectedRemoteCommitSha: REMOTE_SHA,
};

async function serve(
  cwd: string,
  structuredShipping?: StructuredShippingService,
): Promise<{ base: string; token: string }> {
  const app = await createApp(loadConfig({ cwd }, {}), {
    evidenceMode: true,
    ...(structuredShipping ? { structuredShipping } : {}),
  });
  const server = await new Promise<Server>((resolveServer, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolveServer(instance));
    instance.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind.");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    token: String(app.locals.localToken),
  };
}

function apiFetch(
  server: { base: string; token: string },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-krater-local-token", server.token);
  return fetch(`${server.base}${path}`, { ...init, headers });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    ),
  );
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function shippingFixture(cwd: string): Promise<{
  taskId: string;
  planDigest: AutopilotDigest;
  stepId: string;
}> {
  const store = await openEvidenceStore(cwd);
  const now = new Date().toISOString();
  const taskId = "task-server-shipping";
  await store.append({
    taskId,
    kind: "task.created",
    occurredAt: now,
    payload: {
      contract: {
        schemaVersion: 1,
        id: "contract-server-shipping",
        taskId,
        request: "Ship the exact verified source",
        interpretations: [],
        assumptions: [],
        acceptanceCriteria: [
          {
            id: "release-ready",
            statement: "The verified source is released.",
            required: true,
          },
        ],
        nonGoals: [],
        assurance: "high",
        budget: {},
        allowedCapabilities: ["github.push"],
        requiredChecks: ["release-check"],
        negativeGuarantees: ["Do not force push."],
        createdAt: now,
      },
    },
  });
  await store.append({
    taskId,
    kind: "evidence.recorded",
    occurredAt: now,
    payload: {
      evidence: {
        id: "evidence-server-release",
        taskId,
        kind: "test",
        grade: "tested",
        origin: "repository",
        summary: "The exact source passed the release checks.",
        supportsClaimIds: [],
        contradictsClaimIds: [],
        artifactDigests: [EFFECT.sourceDigest],
        stale: false,
        observedAt: now,
      },
    },
  });
  const stepId = "ship-release";
  const plan = await new VerifiedAutopilotService(store).revisePlan({
    id: "plan-server-shipping",
    taskId,
    status: "active",
    objective: "Ship the exact verified source.",
    steps: [
      {
        id: stepId,
        taskId,
        kind: "external_effect",
        title: "Ship verified release",
        description: "Push through the structured GitHub adapter.",
        status: "ready",
        dependsOnStepIds: [],
        proofObligationIds: ["proof-server-release"],
        allowedCapabilities: ["github.push"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    proofObligations: [
      {
        id: "proof-server-release",
        taskId,
        kind: "publication_precondition",
        statement: "The exact source passed release checks.",
        required: true,
        minimumGrade: "tested",
        status: "satisfied",
        acceptanceCriterionIds: ["release-ready"],
        evidenceIds: ["evidence-server-release"],
        scopeDigests: [EFFECT.sourceDigest],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdBy: "user",
    revisedBy: "user",
    revisedAt: now,
    revisionReason: "Structured shipping API fixture.",
  });
  return { taskId, planDigest: plan.digest, stepId };
}

function fakeShipping(): {
  service: StructuredShippingService;
  mutationCalls: () => number;
} {
  let mutations = 0;
  const executor: StructuredShippingExecutor = {
    inspectGitHubPush: async () => ({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectKind: EFFECT.kind,
      targetLocatorDigest: targetLocatorDigest(EFFECT),
      currentStateDigest: digest("server-remote-before"),
      evidenceIds: ["evidence-server-inspection"],
      canMutate: true,
      remoteCommitSha: REMOTE_SHA,
    }),
    pushGitHub: async () => {
      mutations += 1;
      return {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "succeeded",
        summary: "The fake adapter accepted the exact source.",
        targetStateDigest: EFFECT.sourceDigest,
        evidenceIds: ["evidence-server-provider-result"],
        providerReceiptHandle: "github:server-test-receipt",
        compensationHandle: "github:server-test-compensation",
      };
    },
    compensateGitHubPush: async () => ({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary: "The fake adapter restored the prior branch.",
      targetStateDigest: digest("server-remote-before"),
      evidenceIds: ["evidence-server-compensation"],
      providerReceiptHandle: "github:server-test-compensation-receipt",
    }),
  };
  return {
    service: new StructuredShippingService({
      executor,
      ledger: new InMemoryShippingLedger(),
      vault: new InMemoryShippingRuntimeVault(),
      allowVolatileState: true,
    }),
    mutationCalls: () => mutations,
  };
}

describe("Krater Pro structured shipping API", () => {
  it("fails closed when no host-owned structured adapter is configured", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-shipping-closed-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Prepare a release" }),
    });
    const created = (await createdResponse.json()) as any;

    const preflightResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/ship/preflight`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(preflightResponse.status).toBe(501);
    expect(await preflightResponse.json()).toMatchObject({
      error: {
        code: "shipping_adapter_unavailable",
        message: expect.stringContaining("no external effect was attempted"),
      },
    });

    const statusResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/ship`,
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      taskId: created.task.id,
      externalMutationsEnabled: false,
      externalEffectPlans: [],
      reconciliationGaps: [],
    });
  });

  it("requires exact confirmation and durably records one fake execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-shipping-api-"));
    temporaryPaths.push(cwd);
    const fixture = await shippingFixture(cwd);
    const fake = fakeShipping();
    const server = await serve(cwd, fake.service);
    const preflightResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/preflight`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanDigest: fixture.planDigest,
          stepId: fixture.stepId,
          effect: EFFECT,
          credentialHandle: CREDENTIAL,
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      },
    );
    const preflightText = await preflightResponse.text();
    const preflight = JSON.parse(preflightText) as any;
    expect(preflightResponse.status).toBe(201);
    expect(fake.mutationCalls()).toBe(0);
    expect(preflight).toMatchObject({
      effectPlan: {
        taskId: fixture.taskId,
        planDigest: fixture.planDigest,
      },
      safety: {
        externalMutationOccurred: false,
        credentialValuePersisted: false,
        idempotencyValuePersisted: false,
      },
    });
    expect(preflightText).not.toContain(IDEMPOTENCY_KEY);
    expect(preflightText).not.toContain(CREDENTIAL.id);

    const confirmationBody = {
      effectPlanId: preflight.effectPlan.id,
      expectedPlanDigest: fixture.planDigest,
      expectedEffectPlanDigest: preflight.effectPlan.digest,
      expectedPreflightDigest: preflight.preflightDigest,
      expectedChallengeDigest: preflight.challenge.digest,
      credentialHandle: CREDENTIAL,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    const staleConfirmation = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...confirmationBody,
          expectedPlanDigest: digest("stale-plan"),
        }),
      },
    );
    expect(staleConfirmation.status).toBe(409);
    expect(fake.mutationCalls()).toBe(0);

    const confirmationResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirmationBody),
      },
    );
    const confirmationText = await confirmationResponse.text();
    const confirmation = JSON.parse(confirmationText) as any;
    expect(confirmationResponse.status).toBe(200);
    expect(confirmation.idempotent).toBe(false);
    expect(confirmation.safety.externalMutationOccurred).toBe(false);
    expect(confirmationText).not.toContain(IDEMPOTENCY_KEY);
    expect(confirmationText).not.toContain(CREDENTIAL.id);
    expect(fake.mutationCalls()).toBe(0);

    const executionBody = {
      ...confirmationBody,
      expectedAuthorizationDigest: confirmation.authorization.digest,
      lease: {
        environmentDigest: digest("server-environment"),
        policyDigest: digest("server-policy"),
        toolchainDigest: digest("server-toolchain"),
        issuedBy: "blind_verifier",
        ttlMs: 60_000,
      },
    };
    const executionResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(executionBody),
      },
    );
    const execution = (await executionResponse.json()) as any;
    expect(executionResponse.status).toBe(200);
    expect(execution).toMatchObject({
      idempotent: false,
      providerState: "recorded",
      reconciliationRequired: false,
      receipt: { status: "succeeded" },
      proofLease: {
        planDigest: fixture.planDigest,
        subjectDigest: EFFECT.sourceDigest,
      },
    });
    expect(fake.mutationCalls()).toBe(1);

    const wrongAuthorizationResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...executionBody,
          expectedAuthorizationDigest: digest("wrong-authorization"),
        }),
      },
    );
    expect(wrongAuthorizationResponse.status).toBe(409);
    expect(fake.mutationCalls()).toBe(1);

    const replayResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(executionBody),
      },
    );
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      idempotent: true,
      receipt: { digest: execution.receipt.digest },
    });
    expect(fake.mutationCalls()).toBe(1);

    const statusResponse = await apiFetch(
      server,
      `/api/v2/tasks/${fixture.taskId}/ship`,
    );
    expect(await statusResponse.json()).toMatchObject({
      externalMutationsEnabled: true,
      phases: [
        {
          state: "recorded",
          receiptDigest: execution.receipt.digest,
          proofLeaseDigest: execution.proofLease.digest,
        },
      ],
      reconciliationGaps: [],
    });

    const durableText = JSON.stringify(
      await (await openEvidenceStore(cwd)).replay(),
    );
    expect(durableText).not.toContain(IDEMPOTENCY_KEY);
    expect(durableText).not.toContain(CREDENTIAL.id);
  });
});
