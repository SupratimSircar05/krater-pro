import { type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openEvidenceStore } from "./evidence-runtime.js";
import { VerifiedAutopilotService } from "./autopilot/index.js";
import { createApp } from "./server.js";
import {
  VerifiedWorkCache,
  type CacheDescriptor,
} from "./verified-cache/index.js";

const temporaryPaths: string[] = [];
const servers: Server[] = [];

async function serve(cwd: string): Promise<{ base: string; token: string }> {
  const app = await createApp(loadConfig({ cwd }, {}), { evidenceMode: true });
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

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
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
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Krater Pro Autopilot API", () => {
  it("creates a durable task with an executable proof-bound plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-autopilot-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const response = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: "Prevent duplicate checkout submissions",
        assurance: "high",
        maxTokens: 20_000,
        maxToolSteps: 30,
      }),
    });
    const detail = (await response.json()) as any;

    expect(response.status).toBe(201);
    expect(detail.task).toMatchObject({
      state: "discovery",
      assurance: "high",
      request: "Prevent duplicate checkout submissions",
    });
    expect(detail.autopilot.currentPlan).toMatchObject({
      revision: 1,
      status: "active",
      objective: "Prevent duplicate checkout submissions",
    });
    expect(detail.autopilot.currentPlan.steps).toHaveLength(5);
    expect(
      detail.autopilot.currentPlan.proofObligations.every(
        (obligation: any) =>
          obligation.minimumGrade === "stress_tested" &&
          obligation.status === "pending",
      ),
    ).toBe(true);

    const planResponse = await apiFetch(
      server,
      `/api/v2/tasks/${detail.task.id}/plan`,
    );
    expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({
      currentPlan: { digest: detail.autopilot.currentPlan.digest },
      planRevisions: [{ revision: 1 }],
    });
  });

  it("revises and approves only the exact plan revision the user reviewed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-plan-revision-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Add safe retries" }),
    });
    const created = (await createdResponse.json()) as any;
    const initial = created.autopilot.currentPlan;
    const planPayload = {
      expectedPlanDigest: initial.digest,
      objective: "Add bounded, idempotent retries",
      status: "active",
      revisionReason: "Clarified that retries must be bounded.",
      steps: initial.steps,
      proofObligations: initial.proofObligations,
    };
    const revisionResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(planPayload),
      },
    );
    const revision = (await revisionResponse.json()) as any;

    expect(revisionResponse.status).toBe(200);
    expect(revision.plan).toMatchObject({
      revision: 2,
      objective: "Add bounded, idempotent retries",
      previousPlanDigest: initial.digest,
    });

    const staleApproval = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanDigest: initial.digest }),
      },
    );
    expect(staleApproval.status).toBe(409);

    const approval = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanDigest: revision.plan.digest,
          reason: "This exact behavior and proof scope are correct.",
        }),
      },
    );
    const approved = (await approval.json()) as any;
    expect(approval.status).toBe(200);
    expect(approved).toMatchObject({
      idempotent: false,
      plan: {
        revision: 3,
        status: "approved",
        previousPlanDigest: revision.plan.digest,
      },
    });

    const idempotent = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanDigest: approved.plan.digest,
        }),
      },
    );
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toMatchObject({
      idempotent: true,
      plan: { digest: approved.plan.digest },
    });
  });

  it("records a pending clarification as a durable plan revision without executing it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-clarify-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Add account deletion" }),
    });
    const created = (await createdResponse.json()) as any;
    const store = await openEvidenceStore(cwd);
    const initialProjection = await store.task(created.task.id);
    const contract = {
      ...initialProjection.contract,
      interpretations: [
        {
          id: "interpretation:soft-delete",
          description: "Soft-delete the account and retain audit records.",
          selected: true,
        },
        {
          id: "interpretation:hard-delete",
          description: "Permanently delete the account and personal data.",
          selected: false,
        },
      ],
    };
    await store.append({
      taskId: created.task.id,
      kind: "contract.set",
      payload: { contract },
    });
    await store.append({
      taskId: created.task.id,
      kind: "task.state.changed",
      payload: {
        from: "discovery",
        to: "clarification",
        reason: "Deletion semantics require one user decision.",
      },
    });

    const rejected = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/clarify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "2", execute: true }),
      },
    );
    expect(rejected.status).toBe(400);

    const clarifiedResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/clarify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answer: "2",
          expectedPlanDigest: created.autopilot.currentPlan.digest,
        }),
      },
    );
    const clarified = (await clarifiedResponse.json()) as any;
    expect(clarifiedResponse.status).toBe(200);
    expect(clarified).toMatchObject({
      taskState: "reproduction",
      idempotent: false,
      executionStarted: false,
      plan: {
        revision: 2,
        objective: "Permanently delete the account and personal data.",
        status: "active",
      },
      planDiff: {
        fromDigest: created.autopilot.currentPlan.digest,
        toRevision: 2,
        contractChanged: true,
        selectedInterpretation: {
          id: "interpretation:hard-delete",
        },
      },
    });

    const projection = await store.task(created.task.id);
    expect(projection.contract.interpretations).toEqual([
      expect.objectContaining({
        id: "interpretation:soft-delete",
        selected: false,
      }),
      expect.objectContaining({
        id: "interpretation:hard-delete",
        selected: true,
      }),
    ]);
    expect(projection.autopilot.currentPlan?.contractDigest).not.toBe(
      created.autopilot.currentPlan.contractDigest,
    );

    const retryResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/clarify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "interpretation:hard-delete" }),
      },
    );
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({
      idempotent: true,
      taskState: "reproduction",
      plan: { digest: clarified.plan.digest },
      executionStarted: false,
    });
  });

  it("supports strict digest-bound approval without implying execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-approve-compat-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Add a health endpoint" }),
    });
    const created = (await createdResponse.json()) as any;
    const path = `/api/v2/tasks/${created.task.id}/approve`;
    const planResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan`,
    );
    const plan = (await planResponse.json()) as any;
    expect(planResponse.status).toBe(200);
    expect(planResponse.headers.get("cache-control")).toContain("no-store");
    expect(plan.approval).toMatchObject({
      plan_hash: created.autopilot.currentPlan.digest,
      oneTime: true,
    });

    const unsupported = await apiFetch(server, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_hash: created.autopilot.currentPlan.digest,
        token: plan.approval.token,
        execute: true,
      }),
    });
    expect(unsupported.status).toBe(400);

    const approvalResponse = await apiFetch(server, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_hash: created.autopilot.currentPlan.digest,
        token: plan.approval.token,
        reason: "The exact scope is correct.",
      }),
    });
    const approval = (await approvalResponse.json()) as any;
    expect(approvalResponse.status).toBe(200);
    expect(approval).toMatchObject({
      idempotent: false,
      executionStarted: false,
      approvalMode: "authenticated_exact_plan_digest",
      plan: {
        status: "approved",
        previousPlanDigest: created.autopilot.currentPlan.digest,
      },
    });

    const reusedTokenResponse = await apiFetch(server, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_hash: created.autopilot.currentPlan.digest,
        token: plan.approval.token,
      }),
    });
    expect(reusedTokenResponse.status).toBe(409);

    const approvedPlanResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan`,
    );
    const approvedPlan = (await approvedPlanResponse.json()) as any;
    const idempotentResponse = await apiFetch(server, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan_hash: approval.plan.digest,
        token: approvedPlan.approval.token,
      }),
    });
    expect(idempotentResponse.status).toBe(200);
    expect(await idempotentResponse.json()).toMatchObject({
      idempotent: true,
      executionStarted: false,
      plan: { digest: approval.plan.digest },
    });
  });

  it("indexes only durable proof leases and reports that monitoring is inactive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-lease-index-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Ship a monitored release" }),
    });
    const created = (await createdResponse.json()) as any;
    const initialPlan = created.autopilot.currentPlan;
    const waivedPlanResponse = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanDigest: initialPlan.digest,
          objective: initialPlan.objective,
          status: "approved",
          revisionReason: "Test fixture records explicit human waivers.",
          steps: initialPlan.steps,
          proofObligations: initialPlan.proofObligations.map(
            (obligation: any) => ({
              ...obligation,
              status: "waived",
              evidenceIds: [],
              waiver: { reason: "Fixture-only human waiver." },
            }),
          ),
        }),
      },
    );
    const waivedPlan = ((await waivedPlanResponse.json()) as any).plan;
    expect(waivedPlanResponse.status).toBe(200);

    const store = await openEvidenceStore(cwd);
    const observedAt = new Date().toISOString();
    const evidenceId = "evidence:lease-index";
    await store.append({
      taskId: created.task.id,
      kind: "evidence.recorded",
      payload: {
        evidence: {
          id: evidenceId,
          taskId: created.task.id,
          kind: "human_acceptance",
          grade: "observed",
          origin: "human",
          summary: "A human accepted the fixture release.",
          supportsClaimIds: [],
          contradictsClaimIds: [],
          artifactDigests: [digest("a")],
          stale: false,
          observedAt,
        },
      },
    });
    const autopilot = new VerifiedAutopilotService(store);
    const lease = await autopilot.issueProofLease({
      id: "lease:index",
      taskId: created.task.id,
      planId: waivedPlan.id,
      planRevision: waivedPlan.revision,
      planDigest: waivedPlan.digest,
      proofObligationIds: waivedPlan.proofObligations.map(
        (obligation: any) => obligation.id,
      ),
      evidenceIds: [evidenceId],
      subjectDigest: digest("b"),
      environmentDigest: digest("c"),
      policyDigest: digest("d"),
      toolchainDigest: digest("e"),
      issuedBy: "human",
      issuedAt: observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    });
    await autopilot.recordProductionObservation({
      id: "observation:index",
      taskId: created.task.id,
      environment: "production",
      source: "human",
      status: "healthy",
      summary: "The fixture subject remains healthy.",
      subjectDigest: lease.subjectDigest,
      evidenceIds: [evidenceId],
      artifactDigests: [digest("f")],
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    });

    const response = await apiFetch(server, "/api/v2/leases");
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      activeMonitoring: false,
      leases: [
        {
          taskId: created.task.id,
          lease: { id: lease.id, digest: lease.digest },
          validity: { valid: true, status: "valid" },
          proofState: "verified",
          latestProductionObservation: { status: "healthy" },
        },
      ],
    });
    expect(body.note).toContain("does not poll production");

    const unsupportedQuery = await apiFetch(
      server,
      "/api/v2/leases?watch=true",
    );
    expect(unsupportedQuery.status).toBe(400);
  });

  it("streams resumable task events until a terminal state is recorded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-task-events-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const createdResponse = await apiFetch(server, "/api/v2/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Stream durable task progress" }),
    });
    const created = (await createdResponse.json()) as any;
    const store = await openEvidenceStore(cwd);
    const replay = await store.replay();
    const after = replay.events.at(-1)?.sequence ?? 0;

    const stream = await apiFetch(
      server,
      `/api/v2/tasks/${created.task.id}/events?after=${after}&follow=true`,
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    await store.append({
      taskId: created.task.id,
      kind: "task.state.changed",
      payload: {
        from: "discovery",
        to: "blocked",
        reason: "The test deliberately closes the live event stream.",
      },
    });

    const body = await Promise.race([
      stream.text(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for SSE.")), 3_000),
      ),
    ]);
    expect(body).toContain("event: task.state.changed");
    expect(body).toContain('"to":"blocked"');
    expect(body).toMatch(new RegExp(`id: ${after + 1}\\n`));
  });

  it("prunes expired verified cache entries through the local API", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "krater-server-cache-prune-"));
    temporaryPaths.push(cwd);
    const server = await serve(cwd);
    const cache = new VerifiedWorkCache(join(cwd, ".krater", "cache"));
    const descriptor: CacheDescriptor = {
      namespace: "server-prune",
      artifactKind: "repository_map",
      inputs: {
        source: { digest: "source" },
        config: { version: 1 },
        toolchain: { node: process.versions.node },
        environment: { platform: process.platform },
        policy: { network: false },
      },
    };
    await cache.put(descriptor, { files: [] }, { now: 1, ttlMs: 1 });

    const response = await apiFetch(server, "/api/v2/cache/prune", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 1,
      stats: { entries: 0 },
    });
  });
});
