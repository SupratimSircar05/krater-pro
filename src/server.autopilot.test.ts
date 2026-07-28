import { type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openEvidenceStore } from "./evidence-runtime.js";
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
