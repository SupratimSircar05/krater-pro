import { request as httpRequest, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type KraterConfig } from "./config.js";
import { createApp, startServer } from "./server.js";
import { Workspace } from "./workspace.js";

const temporaryPaths: string[] = [];
const servers: Server[] = [];
const localTokens = new Map<string, string>();

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-server-"));
  temporaryPaths.push(path);
  return path;
}

async function serve(config: KraterConfig): Promise<string> {
  const app = await createApp(config);
  const server = await new Promise<Server>((resolveServer, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolveServer(instance));
    instance.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  localTokens.set(base, String(app.locals.localToken));
  return base;
}

function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = [...localTokens.keys()].find((candidate) => input.startsWith(candidate));
  if (!base) throw new Error(`No local test token registered for ${input}`);
  const headers = new Headers(init.headers);
  headers.set("x-krater-local-token", localTokens.get(base)!);
  return fetch(input, { ...init, headers });
}

function requestStatus(
  input: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const url = new URL(input);
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  localTokens.clear();
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

describe("Krater Pro HTTP API", () => {
  it("reports non-secret status and applies API security headers", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig(
      {
        cwd,
        apiKey: "kr_status_secret",
        model: "test/model",
        baseURL: "https://api.krater.test/v1",
      },
      {},
    );
    const base = await serve(config);

    const response = await apiFetch(`${base}/api/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(body).toEqual({
      configured: true,
      model: "test/model",
      modelSource: "command",
      smartRouting: false,
      cwd: config.cwd,
      projectId: expect.stringMatching(/^local-/),
      projectKind: "local",
      version: "0.1.0",
      baseURL: "https://api.krater.test/v1",
      contextChars: config.contextChars,
      toolOutputChars: config.toolOutputChars,
      responseStyle: config.responseStyle,
      maxSteps: config.maxSteps,
      maxOutputTokens: config.maxOutputTokens,
      sessionTokenBudget: config.sessionTokenBudget,
    });
    expect(JSON.stringify(body)).not.toContain("kr_status_secret");
  });

  it("lists and switches among local and scratch projects while expiring old sessions", async () => {
    const cwd = await temporaryDirectory();
    const other = await temporaryDirectory();
    const config = loadConfig({ cwd }, {});
    const otherPath = await realpath(other);
    const base = await serve(config);

    const initialResponse = await apiFetch(`${base}/api/projects`);
    expect(initialResponse.status).toBe(200);
    const initial = (await initialResponse.json()) as {
      currentId: string;
      current: { id: string; kind: string; path: string };
      projects: Array<{ id: string; kind: string; path: string }>;
    };
    expect(initial.current).toMatchObject({
      id: initial.currentId,
      kind: "local",
      path: config.cwd,
    });
    expect(initial.projects).toHaveLength(1);

    const sessionResponse = await apiFetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: initial.currentId }),
    });
    const { id: oldSessionId } = (await sessionResponse.json()) as { id: string };

    const scratchResponse = await apiFetch(`${base}/api/projects/scratch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "throwaway work" }),
    });
    expect(scratchResponse.status).toBe(201);
    const scratch = (await scratchResponse.json()) as {
      current: { id: string; kind: string; path: string };
      projects: Array<{ id: string }>;
    };
    expect(scratch.current.kind).toBe("scratch");
    expect(scratch.current.path).toContain(join(config.cwd, ".krater", "scratch"));
    expect(scratch.projects).toHaveLength(2);

    const expiredSession = await apiFetch(
      `${base}/api/sessions/${oldSessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Must not run in the old workspace." }),
      },
    );
    expect(expiredSession.status).toBe(404);

    const localResponse = await apiFetch(`${base}/api/projects/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: other }),
    });
    expect(localResponse.status).toBe(201);
    const local = (await localResponse.json()) as {
      current: { id: string; kind: string; path: string };
      projects: Array<{ id: string }>;
    };
    expect(local.current).toMatchObject({ kind: "local", path: otherPath });
    expect(local.projects).toHaveLength(3);

    const selectResponse = await apiFetch(`${base}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: initial.currentId }),
    });
    expect(selectResponse.status).toBe(200);

    const status = await apiFetch(`${base}/api/status`);
    await expect(status.json()).resolves.toMatchObject({
      cwd: config.cwd,
      projectId: initial.currentId,
      projectKind: "local",
    });
  });

  it("rejects stale mutating IDE requests after a project switch", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));
    const initial = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string };
    const scratch = (await (
      await apiFetch(`${base}/api/projects/scratch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "isolation" }),
      })
    ).json()) as { current: { id: string; path: string } };

    const staleSave = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: initial.projectId,
        path: "stale-save.txt",
        content: "must not cross projects\n",
        revision: null,
      }),
    });
    expect(staleSave.status).toBe(409);

    const staleTerminal = await apiFetch(`${base}/api/ide/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: initial.projectId,
        command: "touch stale-terminal.txt",
      }),
    });
    expect(staleTerminal.status).toBe(409);
    await expect(readFile(join(scratch.current.path, "stale-save.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(scratch.current.path, "stale-terminal.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back project selection when a registered workspace disappears", async () => {
    const cwd = await temporaryDirectory();
    const other = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));
    const initial = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string; cwd: string };
    const registered = (await (
      await apiFetch(`${base}/api/projects/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: other }),
      })
    ).json()) as { current: { id: string } };
    await apiFetch(`${base}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: initial.projectId }),
    });
    await rm(other, { recursive: true, force: true });

    const failed = await apiFetch(`${base}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: registered.current.id }),
    });
    expect(failed.status).toBe(404);
    await expect(
      (await apiFetch(`${base}/api/status`)).json(),
    ).resolves.toMatchObject({
      projectId: initial.projectId,
      cwd: initial.cwd,
    });
  });

  it("rejects invalid project sources without starting Git", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));

    const relative = await apiFetch(`${base}/api/projects/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "relative/project" }),
    });
    expect(relative.status).toBe(400);

    const unknown = await apiFetch(`${base}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing" }),
    });
    expect(unknown.status).toBe(404);

    const unsafeRemote = await apiFetch(`${base}/api/projects/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    expect(unsafeRemote.status).toBe(400);
    await expect(unsafeRemote.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("public https://github.com/") },
    });
  });

  it("supports project-scoped explorer, conflict-safe editor, Git, and terminal APIs", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(join(cwd, ".env"), "KRATER_API_KEY=must_not_leak\n");
    await writeFile(join(outside, "outside.ts"), "private\n");
    await symlink(join(outside, "outside.ts"), join(cwd, "alias.ts"));
    const workspace = new Workspace(cwd);
    await workspace.runCommand("git init -q");
    await workspace.runCommand("git add src/main.ts");
    await workspace.runCommand(
      "git -c user.name=Krater -c user.email=krater@example.invalid commit -qm initial",
    );
    await writeFile(join(cwd, "src", "main.ts"), "export const value = 2;\n");
    const base = await serve(loadConfig({ cwd }, {}));

    const statusPayload = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string };
    const treeResponse = await apiFetch(
      `${base}/api/ide/tree?depth=2&projectId=${encodeURIComponent(statusPayload.projectId)}`,
    );
    expect(treeResponse.status).toBe(200);
    const tree = (await treeResponse.json()) as {
      projectId: string;
      root: string;
      entries: Array<{ path: string; type: string }>;
    };
    expect(tree.projectId).toMatch(/^local-/);
    expect(tree.root).toBe(await realpath(cwd));
    expect(tree.entries).toContainEqual(
      expect.objectContaining({ path: "src/main.ts", type: "file" }),
    );
    expect(tree.entries.map((entry) => entry.path)).not.toContain(".env");
    expect(tree.entries.map((entry) => entry.path)).not.toContain("alias.ts");

    const openedResponse = await apiFetch(
      `${base}/api/ide/file?path=${encodeURIComponent("src/main.ts")}&projectId=${encodeURIComponent(tree.projectId)}`,
    );
    expect(openedResponse.status).toBe(200);
    const opened = (await openedResponse.json()) as {
      revision: string;
      content: string;
    };
    expect(opened.content).toBe("export const value = 2;\n");

    const savedResponse = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: tree.projectId,
        path: "src/main.ts",
        content: "export const value = 3;\n",
        revision: opened.revision,
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as {
      saved: boolean;
      revision: string;
    };
    expect(saved.saved).toBe(true);
    expect(saved.revision).not.toBe(opened.revision);
    expect(await readFile(join(cwd, "src", "main.ts"), "utf8")).toBe(
      "export const value = 3;\n",
    );

    await writeFile(join(cwd, "src", "main.ts"), "external edit\n");
    const conflict = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: tree.projectId,
        path: "src/main.ts",
        content: "stale overwrite\n",
        revision: saved.revision,
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("changed on disk") },
    });
    expect(await readFile(join(cwd, "src", "main.ts"), "utf8")).toBe(
      "external edit\n",
    );

    const protectedRead = await apiFetch(
      `${base}/api/ide/file?path=${encodeURIComponent(".env")}&projectId=${encodeURIComponent(tree.projectId)}`,
    );
    expect(protectedRead.status).toBe(400);
    expect(JSON.stringify(await protectedRead.json())).not.toContain(
      "must_not_leak",
    );

    const statusResponse = await apiFetch(
      `${base}/api/ide/git/status?projectId=${encodeURIComponent(tree.projectId)}`,
    );
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json();
    expect(status).toMatchObject({
      clean: false,
      entries: [
        expect.objectContaining({ path: "src/main.ts" }),
      ],
    });
    expect(JSON.stringify(status)).not.toContain(".env");

    const diffResponse = await apiFetch(
      `${base}/api/ide/git/diff?projectId=${encodeURIComponent(tree.projectId)}`,
    );
    expect(diffResponse.status).toBe(200);
    const diff = await diffResponse.json();
    expect(diff.diff).toContain("external edit");
    expect(JSON.stringify(diff)).not.toContain("must_not_leak");

    const terminalResponse = await apiFetch(`${base}/api/ide/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: tree.projectId,
        command:
          'node -e "process.stdout.write(process.cwd() + String(process.env.KRATER_API_KEY))"',
        timeoutMs: 5_000,
      }),
    });
    expect(terminalResponse.status).toBe(200);
    await expect(terminalResponse.json()).resolves.toMatchObject({
      exitCode: 0,
      stdout: `${await realpath(cwd)}undefined`,
      stderr: "",
      timedOut: false,
    });

    const destructive = await apiFetch(`${base}/api/ide/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: tree.projectId, command: "rm -rf /" }),
    });
    expect(destructive.status).toBe(400);
    await expect(destructive.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("irreversibly destroy") },
    });
  });

  it("bounds IDE inputs and returns structured JSON parser errors", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));
    const statusPayload = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string };

    const depth = await apiFetch(
      `${base}/api/ide/tree?depth=99&projectId=${encodeURIComponent(statusPayload.projectId)}`,
    );
    expect(depth.status).toBe(400);

    const missingRevision = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: statusPayload.projectId,
        path: "new.txt",
        content: "hello",
      }),
    });
    expect(missingRevision.status).toBe(400);

    const longCommand = await apiFetch(`${base}/api/ide/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: statusPayload.projectId,
        command: "x".repeat(8_193),
      }),
    });
    expect(longCommand.status).toBe(400);

    const escapedButValid = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: statusPayload.projectId,
        path: "escaped.txt",
        content: "\n".repeat(900_000),
        revision: null,
      }),
    });
    expect(escapedButValid.status).toBe(200);

    const oversized = await apiFetch(`${base}/api/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: statusPayload.projectId,
        path: "huge.txt",
        content: "x".repeat(7_500_000),
        revision: null,
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: { message: "JSON request body exceeds the 7 MB limit." },
    });
  });

  it("blocks project switches while a user terminal command is active", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));
    const statusPayload = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string };
    const running = apiFetch(`${base}/api/ide/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: statusPayload.projectId,
        command: 'node -e "setTimeout(() => {}, 250)"',
        timeoutMs: 5_000,
      }),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    const projectChange = await apiFetch(`${base}/api/projects/scratch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "must-wait" }),
    });
    expect(projectChange.status).toBe(409);
    await expect(projectChange.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("editor, Git, or terminal") },
    });

    const terminal = await running;
    expect(terminal.status).toBe(200);
  });

  it("requires its launch token and rejects cross-origin or rebound requests", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));

    const unauthenticated = await fetch(`${base}/api/status`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("set-cookie")).toContain("HttpOnly");
    expect(unauthenticated.headers.get("set-cookie")).toContain("SameSite=Strict");

    const crossOrigin = await apiFetch(`${base}/api/status`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(crossOrigin.status).toBe(403);

    const reboundStatus = await requestStatus(`${base}/api/status`, {
      Host: "attacker.example",
      "x-krater-local-token": localTokens.get(base)!,
    });
    expect(reboundStatus).toBe(403);
  });

  it("reports safe browser-auth capabilities without exposing session access", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));

    const response = await apiFetch(`${base}/api/auth/capabilities`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      oauth: false,
      mode: "api-key-handoff",
      developerUrl: "https://krater.ai/developers",
    });
  });

  it("rejects model discovery without an API key before making a provider request", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));

    const response = await apiFetch(`${base}/api/models`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Add a Krater API key in Settings or configure KRATER_API_KEY.",
      },
    });
  });

  it("creates and deletes sessions while validating message and approval payloads", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));
    const { projectId } = (await (
      await apiFetch(`${base}/api/status`)
    ).json()) as { projectId: string };

    const createdResponse = await apiFetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const emptyMessage = await apiFetch(
      `${base}/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, message: "   " }),
      },
    );
    expect(emptyMessage.status).toBe(400);
    await expect(emptyMessage.json()).resolves.toEqual({
      error: { message: "Message cannot be empty." },
    });

    const missingKey = await apiFetch(
      `${base}/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, message: "Hello" }),
      },
    );
    expect(missingKey.status).toBe(401);

    const invalidApproval = await apiFetch(
      `${base}/api/sessions/${created.id}/approvals/missing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: "yes" }),
      },
    );
    expect(invalidApproval.status).toBe(400);

    const unknownApproval = await apiFetch(
      `${base}/api/sessions/${created.id}/approvals/missing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(unknownApproval.status).toBe(404);

    const deleted = await apiFetch(`${base}/api/sessions/${created.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await apiFetch(
      `${base}/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      },
    );
    expect(afterDelete.status).toBe(404);
  });

  it("returns structured not-found errors for unknown sessions", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(loadConfig({ cwd }, {}));

    const response = await apiFetch(`${base}/api/sessions/not-a-session/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Session not found." },
    });
  });

  it("refuses non-loopback hosts before exposing workspace tools", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig({ cwd, host: "0.0.0.0" }, {});
    await expect(startServer(config)).rejects.toThrow(/non-loopback host/);
  });
});
