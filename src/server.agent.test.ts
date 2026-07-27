import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  options: [] as Array<{
    apiKey: string;
    baseURL: string;
    model: string;
    maxOutputTokens?: number;
  }>,
}));

vi.mock("./provider.js", () => ({
  KraterProvider: class FakeKraterProvider {
    private step = 0;

    constructor(options: {
      apiKey: string;
      baseURL: string;
      model: string;
      maxOutputTokens?: number;
    }) {
      providerState.options.push(options);
    }

    async complete(
      _messages: unknown,
      _tools: unknown,
      onText: (text: string) => void,
    ) {
      if (this.step === 0) {
        this.step += 1;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write-from-server",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "from-browser.txt",
                    content: "approved through HTTP",
                  }),
                },
              },
            ],
          },
        };
      }
      this.step += 1;
      onText("Saved.");
      return { message: { role: "assistant", content: "Saved." } };
    }

    async listModels() {
      return [
        { id: "a/model", ownedBy: "a" },
        { id: "b/model", ownedBy: "b" },
      ];
    }
  },
}));

import { loadConfig } from "./config.js";
import { createApp, startServer } from "./server.js";
import type { AgentEvent } from "./types.js";

const temporaryPaths: string[] = [];
const servers: Server[] = [];
const localTokens = new Map<string, string>();

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-server-agent-"));
  temporaryPaths.push(path);
  return path;
}

async function availablePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.listen(0, "127.0.0.1", resolveListen);
    probe.once("error", reject);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a test port.");
  }
  await new Promise<void>((resolveClose, reject) => {
    probe.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function serve(cwd: string): Promise<string> {
  const app = await createApp(loadConfig({ cwd }, {}));
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

function parseEvents(stream: string): AgentEvent[] {
  return stream
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)) as AgentEvent);
}

beforeEach(() => {
  providerState.options.length = 0;
});

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

describe("Krater Pro streamed browser agent", () => {
  it("streams an approval, accepts it through HTTP, and resumes the tool loop", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(cwd);
    const sessionResponse = await apiFetch(`${base}/api/sessions`, {
      method: "POST",
    });
    const { id: sessionId } = (await sessionResponse.json()) as { id: string };

    const messageResponse = await apiFetch(
      `${base}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Create a file",
          apiKey: "kr_browser",
          model: "browser/model",
        }),
      },
    );
    expect(messageResponse.status).toBe(200);
    expect(messageResponse.headers.get("content-type")).toContain("text/event-stream");
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
      `${base}/api/sessions/${sessionId}/approvals/${approval.id}`,
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

    expect(events.map((event) => event.type)).toEqual([
      "tool",
      "approval",
      "tool_result",
      "text",
      "done",
    ]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      type: "tool_result",
      id: "write-from-server",
      ok: true,
    });
    expect(await readFile(join(cwd, "from-browser.txt"), "utf8")).toBe(
      "approved through HTTP",
    );
    expect(providerState.options).toEqual([
      {
        apiKey: "kr_browser",
        baseURL: "https://api.krater.ai/v1",
        model: "browser/model",
        maxOutputTokens: 8_192,
      },
    ]);

    const changedConfiguration = await apiFetch(
      `${base}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Continue with a different model",
          apiKey: "kr_browser",
          model: "other/model",
        }),
      },
    );
    expect(changedConfiguration.status).toBe(200);
    expect(parseEvents(await changedConfiguration.text())).toContainEqual({
      type: "error",
      message:
        "The API key or model changed during this task. Start a new task before continuing.",
    });
    expect(providerState.options).toHaveLength(1);
  });

  it("lists fake provider models without external network access", async () => {
    const cwd = await temporaryDirectory();
    const base = await serve(cwd);

    const response = await apiFetch(`${base}/api/models`, {
      headers: { "x-krater-api-key": "kr_header" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [
        { id: "a/model", ownedBy: "a" },
        { id: "b/model", ownedBy: "b" },
      ],
    });
    expect(providerState.options[0]).toMatchObject({
      apiKey: "kr_header",
      model: "openai/gpt-4o-mini",
    });

    const cachedResponse = await apiFetch(`${base}/api/models`, {
      headers: { "x-krater-api-key": "kr_header" },
    });
    expect(cachedResponse.status).toBe(200);
    expect(cachedResponse.headers.get("x-krater-cache")).toBe("hit");
    expect(providerState.options).toHaveLength(1);
  });

  it("aborts a pending approval and closes promptly during server shutdown", async () => {
    const cwd = await temporaryDirectory();
    const port = await availablePort();
    const running = await startServer(loadConfig({ cwd, port }, {}));
    try {
      const bootstrap = await fetch(running.url);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("Expected the loopback bootstrap cookie.");

      const sessionResponse = await fetch(`${running.url}/api/sessions`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      const { id } = (await sessionResponse.json()) as { id: string };
      const messageResponse = await fetch(`${running.url}/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({
          message: "Create a file and wait for approval",
          apiKey: "kr_browser",
          model: "browser/model",
        }),
      });
      const reader = messageResponse.body?.getReader();
      if (!reader) throw new Error("Expected an SSE response body.");
      const decoder = new TextDecoder();
      let stream = "";
      while (!parseEvents(stream).some((event) => event.type === "approval")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before the approval.");
        stream += decoder.decode(chunk.value, { stream: true });
      }

      const started = Date.now();
      await running.close();
      expect(Date.now() - started).toBeLessThan(1_000);
      await expect(readFile(join(cwd, "from-browser.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await running.close();
    }
  });
});
