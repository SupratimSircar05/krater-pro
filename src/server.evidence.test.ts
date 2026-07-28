import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const evidenceProviderState = vi.hoisted(() => ({
  instances: 0,
  calls: [] as unknown[][],
}));

vi.mock("./provider.js", () => ({
  KraterProvider: class FakeEvidenceProvider {
    private step = 0;

    constructor() {
      evidenceProviderState.instances += 1;
    }

    async complete(
      messages: unknown,
      _tools: unknown,
      onText: (text: string) => void,
    ) {
      const conversation = messages as Array<{
        role?: string;
        content?: string | null;
      }>;
      evidenceProviderState.calls.push(structuredClone(conversation));
      const lastUser = [...conversation]
        .reverse()
        .find((message) => message.role === "user")?.content;
      if (lastUser === "Wait for cancellation") {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "cancel-command",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: "pwd" }),
                },
              },
            ],
          },
        };
      }
      if (lastUser === "Continue from the prior investigation") {
        onText("The prior file evidence and tool results are still available.");
        return {
          message: {
            role: "assistant",
            content:
              "The prior file evidence and tool results are still available.",
          },
        };
      }
      const calls = [
        {
          id: "read-evidence",
          name: "read_file",
          args: { path: "source.txt" },
        },
        {
          id: "gate-evidence",
          name: "record_action_gate",
          args: {
            outcome: "change_required",
            reasons: ["The requested value is absent."],
            evidenceRefs: ["read-evidence"],
          },
        },
        {
          id: "write-evidence",
          name: "write_file",
          args: { path: "source.txt", content: "agent staged\n" },
        },
      ] as const;
      const call = calls[this.step];
      this.step += 1;
      if (call) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          },
        };
      }
      onText("The reviewed patch is staged.");
      return {
        message: {
          role: "assistant",
          content: "The reviewed patch is staged.",
        },
      };
    }

    async listModels() {
      return [{ id: "evidence/model", ownedBy: "test" }];
    }
  },
}));
import { loadConfig } from "./config.js";
import { EvidenceTask } from "./evidence-runtime.js";
import { createApp } from "./server.js";
import {
  loadProofPatchBinding,
  StagedTaskWorkspace,
} from "./staging-workspace.js";
import type { AgentEvent } from "./types.js";

const temporaryPaths: string[] = [];
const servers: Server[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-server-evidence-"));
  temporaryPaths.push(path);
  return path;
}

async function serve(cwd: string): Promise<{
  base: string;
  token: string;
}> {
  const app = await createApp(loadConfig({ cwd }, {}), { evidenceMode: true });
  const server = await new Promise<Server>((resolveServer, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolveServer(instance));
    instance.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
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

async function currentProjectId(server: {
  base: string;
  token: string;
}): Promise<string> {
  const response = await apiFetch(server, "/api/status");
  const payload = (await response.json()) as { projectId: string };
  return payload.projectId;
}

function parseEvents(stream: string): AgentEvent[] {
  return stream
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)) as AgentEvent);
}

async function seedReviewedProofPatch(
  cwd: string,
  contentBytes = 0,
): Promise<string> {
  const beforeContent =
    contentBytes > 0 ? `${"a".repeat(contentBytes)}\n` : "before\n";
  const afterContent =
    contentBytes > 0 ? `${"b".repeat(contentBytes)}\n` : "after\n";
  await writeFile(join(cwd, "source.txt"), beforeContent);
  const staged = await StagedTaskWorkspace.create(cwd, "server-evidence");
  await writeFile(join(staged.stageRoot, "source.txt"), afterContent);
  const task = await EvidenceTask.start({
    cwd,
    projectId: "project",
    request: "Update the source",
    assurance: "fast",
  });
  task.accept({
    type: "tool",
    id: "read-source",
    name: "read_file",
    args: { path: "source.txt" },
  });
  task.accept({
    type: "tool_result",
    id: "read-source",
    name: "read_file",
    output: "before",
    ok: true,
  });
  task.accept({
    type: "action_gate",
    outcome: "change_required",
    shouldStageCode: true,
    reasons: ["The requested source value is not present."],
    evidenceRefs: ["read-source"],
  });
  task.accept({
    type: "tool",
    id: "write-source",
    name: "write_file",
    args: { path: "source.txt", content: "after" },
  });
  task.accept({
    type: "tool_result",
    id: "write-source",
    name: "write_file",
    output: "updated",
    ok: true,
  });
  task.accept({
    type: "tool",
    id: "test-source",
    name: "run_command",
    args: { command: "npm test -- source" },
  });
  task.accept({
    type: "tool_result",
    id: "test-source",
    name: "run_command",
    output: "Exit code: 0",
    ok: true,
  });
  await task.recordVerifierResult({
    passed: true,
    summary:
      "A context-isolated verifier confirmed the requested source behavior.",
    kind: "test",
    grade: "tested",
    origin: "blind_verifier",
    command: "sealed-checker source behavior",
    tool: "test-verifier",
  });
  await task.recordVerifierResult({
    linkToCriterion: false,
    passed: true,
    summary:
      "A context-isolated security verifier found no protected-data or unsafe-success regression.",
    kind: "security",
    grade: "tested",
    origin: "blind_verifier",
    command: "sealed-security-check",
    tool: "security-verifier",
  });
  const prepared = await staged.prepareProofPatch(task.taskId);
  await task.finish({
    baseWorkspaceDigest: prepared.baseWorkspaceDigest,
    finalWorkspaceDigest: prepared.finalWorkspaceDigest,
  });
  return task.taskId;
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

describe("Krater Pro evidence-native API", () => {
  it("cancels an approval-blocked task once when its browser session closes", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "source.txt"), "base\n");
    const server = await serve(cwd);
    const projectId = await currentProjectId(server);
    const sessionResponse = await apiFetch(server, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    expect(sessionResponse.status).toBe(201);
    const { id: sessionId } = (await sessionResponse.json()) as { id: string };

    const messageResponse = await apiFetch(
      server,
      `/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          message: "Wait for cancellation",
          apiKey: "kr_evidence",
          model: "evidence/model",
          assurance: "high",
        }),
      },
    );
    expect(messageResponse.status).toBe(200);
    const reader = messageResponse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamed = "";
    while (!streamed.includes('"type":"approval"')) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      streamed += decoder.decode(chunk.value, { stream: true });
    }

    const deleteResponse = await apiFetch(
      server,
      `/api/sessions/${sessionId}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(204);
    await reader!.cancel();

    await vi.waitFor(
      async () => {
        const tasksResponse = await apiFetch(server, "/api/v2/tasks");
        expect(tasksResponse.status).toBe(200);
        const tasks = (await tasksResponse.json()) as {
          tasks: Array<{ state: string }>;
        };
        expect(tasks.tasks).toHaveLength(1);
        expect(tasks.tasks[0].state).toBe("cancelled");
      },
      { timeout: 5_000, interval: 25 },
    );
    const statusResponse = await apiFetch(server, "/api/status");
    expect(statusResponse.status).toBe(200);
  });

  it("keeps browser-agent edits isolated until explicit evidence publication", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "source.txt"), "base\n");
    const server = await serve(cwd);
    const projectId = await currentProjectId(server);
    const sessionResponse = await apiFetch(server, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    expect(sessionResponse.status).toBe(201);
    const { id: sessionId } = (await sessionResponse.json()) as { id: string };

    const messageResponse = await apiFetch(
      server,
      `/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          message: "Update source.txt",
          apiKey: "kr_evidence",
          model: "evidence/model",
          assurance: "fast",
        }),
      },
    );
    expect(messageResponse.status).toBe(200);
    const reader = messageResponse.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body.");
    const decoder = new TextDecoder();
    let stream = "";
    let approval: Extract<AgentEvent, { type: "approval" }> | undefined;
    while (!approval) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before approval.");
      stream += decoder.decode(chunk.value, { stream: true });
      approval = parseEvents(stream).find(
        (event): event is Extract<AgentEvent, { type: "approval" }> =>
          event.type === "approval",
      );
    }
    const approvalResponse = await apiFetch(
      server,
      `/api/sessions/${sessionId}/approvals/${approval.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(approvalResponse.status).toBe(200);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
    }
    stream += decoder.decode();
    const events = parseEvents(stream);
    const task = events.find(
      (event): event is Extract<AgentEvent, { type: "task" }> =>
        event.type === "task",
    );
    if (!task) throw new Error("Expected a durable task event.");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action_gate",
        outcome: "change_required",
      }),
    );
    const binding = await loadProofPatchBinding(cwd, task.id);
    expect(binding).toMatchObject({
      taskId: task.id,
      status: "staged",
      changedPaths: ["source.txt"],
    });
    expect(binding.finalWorkspaceDigest).not.toBe(binding.baseWorkspaceDigest);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "verdict",
        state: "review",
      }),
    );
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    const published = await apiFetch(
      server,
      `/api/v2/tasks/${task.id}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: true }),
      },
    );
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({
      verdict: "accepted_with_gaps",
      proofPatch: { status: "published" },
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "agent staged\n",
    );
    expect(evidenceProviderState.instances).toBeGreaterThan(0);

    const followupResponse = await apiFetch(
      server,
      `/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          message: "Continue from the prior investigation",
          apiKey: "kr_evidence",
          model: "evidence/model",
          assurance: "fast",
        }),
      },
    );
    expect(followupResponse.status).toBe(200);
    expect(parseEvents(await followupResponse.text())).toContainEqual({
      type: "text",
      text: "The prior file evidence and tool results are still available.",
    });

    const followupContext = evidenceProviderState.calls.at(-1) as Array<{
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id?: string }>;
      tool_call_id?: string;
    }>;
    const serializedContext = JSON.stringify(followupContext);
    expect(serializedContext).not.toContain("kr_evidence");
    expect(serializedContext.length).toBeLessThan(120_000);
    expect(followupContext).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            id: "read-evidence",
          }),
        ],
      }),
    );
    expect(followupContext).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "read-evidence",
        content: expect.stringContaining("base"),
      }),
    );
    expect(followupContext.at(-1)).toEqual({
      role: "user",
      content: "Continue from the prior investigation",
    });
  });

  it("publishes and rolls back a reviewed ProofPatch through API v2", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedProofPatch(cwd);
    const server = await serve(cwd);

    const before = await apiFetch(server, `/api/v2/tasks/${taskId}`);
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      task: { id: taskId, state: "review" },
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );

    const published = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: false }),
      },
    );
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({
      verdict: "complete",
      proofPatch: { status: "published" },
      task: { task: { state: "complete" } },
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "after\n",
    );

    const rolledBack = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/rollback`,
      { method: "POST" },
    );
    expect(rolledBack.status).toBe(200);
    await expect(rolledBack.json()).resolves.toMatchObject({
      proofPatch: { status: "rolled_back" },
      task: {
        task: { state: "complete" },
        gaps: [
          "The published ProofPatch was subsequently rolled back; its changed behavior is no longer present in the workspace.",
        ],
      },
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
  });

  it("refuses publication with unaccepted evidence gaps", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "source.txt"), "before\n");
    const staged = await StagedTaskWorkspace.create(cwd, "server-gap");
    await writeFile(join(staged.stageRoot, "source.txt"), "after\n");
    const task = await EvidenceTask.start({
      cwd,
      projectId: "project",
      request: "Update without verification",
      assurance: "standard",
    });
    task.accept({
      type: "tool",
      id: "read",
      name: "read_file",
      args: { path: "source.txt" },
    });
    task.accept({
      type: "tool_result",
      id: "read",
      name: "read_file",
      output: "before",
      ok: true,
    });
    task.accept({
      type: "action_gate",
      outcome: "change_required",
      shouldStageCode: true,
      reasons: ["A change is required."],
      evidenceRefs: ["read"],
    });
    task.accept({
      type: "tool",
      id: "write",
      name: "write_file",
      args: { path: "source.txt", content: "after" },
    });
    task.accept({
      type: "tool_result",
      id: "write",
      name: "write_file",
      output: "updated",
      ok: true,
    });
    const prepared = await staged.prepareProofPatch(task.taskId);
    await task.finish({
      baseWorkspaceDigest: prepared.baseWorkspaceDigest,
      finalWorkspaceDigest: prepared.finalWorkspaceDigest,
    });
    const server = await serve(cwd);

    const response = await apiFetch(
      server,
      `/api/v2/tasks/${task.taskId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: false }),
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { gaps: string[] };
    };
    expect(body.error.gaps.length).toBeGreaterThan(0);
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
  });

  it("cancels a reviewed task only after discarding its staged ProofPatch", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedProofPatch(cwd);
    const server = await serve(cwd);

    const response = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "The user stopped before publication." }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      verdict: "cancelled",
      proofPatch: { status: "rolled_back" },
      task: {
        task: { state: "cancelled" },
        gaps: expect.arrayContaining([
          "The user stopped before publication.",
          "The staged ProofPatch was discarded; no task change was published.",
        ]),
      },
    });
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    const discardedBinding = await loadProofPatchBinding(cwd, taskId);
    expect(discardedBinding.status).toBe("rolled_back");
    expect(discardedBinding).not.toHaveProperty("publishedAt");

    const retried = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/cancel`,
      { method: "POST" },
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      verdict: "cancelled",
      task: { task: { state: "cancelled" } },
    });
  });

  it("refuses to cancel a published task and points to explicit rollback", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedProofPatch(cwd);
    const server = await serve(cwd);
    const published = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: false }),
      },
    );
    expect(published.status).toBe(200);

    const cancelled = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(409);
    expect(JSON.stringify(await cancelled.json())).toContain(
      `/api/v2/tasks/${taskId}/rollback`,
    );
    await expect(readFile(join(cwd, "source.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
  });

  it("serializes concurrent ProofPatch lifecycle mutations", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedProofPatch(cwd);
    const server = await serve(cwd);

    const [publish, cancel] = await Promise.all([
      apiFetch(server, `/api/v2/tasks/${taskId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: false }),
      }),
      apiFetch(server, `/api/v2/tasks/${taskId}/cancel`, {
        method: "POST",
      }),
    ]);
    const responses = [publish, cancel];
    expect(responses.map((response) => response.status).sort()).toEqual([
      200,
      409,
    ]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(JSON.stringify(await conflict.json())).toMatch(
      /Another ProofPatch publish, rollback, or cancellation is already in progress/i,
    );
  });

  it("isolates the ProofPatch lifecycle window from terminal operations", async () => {
    const cwd = await temporaryDirectory();
    const taskId = await seedReviewedProofPatch(cwd);
    const server = await serve(cwd);
    const projectId = await currentProjectId(server);

    const runningTerminal = apiFetch(server, "/api/ide/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        command: 'node -e "setTimeout(() => {}, 250)"',
        timeoutMs: 5_000,
      }),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const blockedCancellation = await apiFetch(
      server,
      `/api/v2/tasks/${taskId}/cancel`,
      { method: "POST" },
    );
    expect(blockedCancellation.status).toBe(409);
    expect(JSON.stringify(await blockedCancellation.json())).toMatch(
      /active editor, Git, or terminal work/i,
    );
    expect((await runningTerminal).status).toBe(200);
    expect(
      (
        await apiFetch(server, `/api/v2/tasks/${taskId}/cancel`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);

    const publishTaskId = await seedReviewedProofPatch(cwd, 4 * 1024 * 1024);
    const publishing = apiFetch(
      server,
      `/api/v2/tasks/${publishTaskId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptGaps: false }),
      },
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    const blockedTerminal = await apiFetch(server, "/api/ide/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        command: 'node -e "process.stdout.write(\\"unexpected\\")"',
        timeoutMs: 5_000,
      }),
    });
    expect(blockedTerminal.status).toBe(409);
    expect(JSON.stringify(await blockedTerminal.json())).toMatch(
      /active ProofPatch lifecycle mutation/i,
    );
    expect((await publishing).status).toBe(200);
  });
});
