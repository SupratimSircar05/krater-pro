import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/api/[[path]]";
import {
  buildProjectChatMessages,
  loadOwnedProjectForChat,
  validateCloudChatRequest,
} from "../lib/chat";
import { CLOUD_MODEL } from "../lib/krater";
import { SESSION_COOKIE, type ScratchSnapshot } from "../lib/security";
import type {
  CloudEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
  PagesFunctionContext,
} from "../lib/types";

const projectId = "065f47b8-81d8-4b2e-bc9d-0cc46f6fd47b";
const now = Math.floor(Date.now() / 1000);

class RouteStatement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly query: string,
    private readonly projectOwner: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("RETURNING count")) {
      return { count: 1 } as T;
    }
    if (this.query.includes("FROM sessions s")) {
      return {
        token_hash: "stored-hash",
        user_id: "user-a",
        issued_at: now,
        expires_at: now + 3600,
        user_email: "a@example.com",
        user_created_at: now - 60,
      } as T;
    }
    if (this.query.includes("FROM projects WHERE id")) {
      const [, scopedUser] = this.values;
      if (scopedUser !== this.projectOwner) return null;
      return {
        id: projectId,
        user_id: this.projectOwner,
        name: "Owned project",
        snapshot_json: JSON.stringify({
          files: [{ path: "src/index.ts", content: "export const answer = 42;" }],
          messages: [{ role: "assistant", content: "Previous answer" }],
          activePath: "src/index.ts",
        }),
        created_at: now - 30,
        updated_at: now,
      } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }

  async run<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }
}

class RouteDatabase implements D1Database {
  readonly prepared: Array<{ query: string; statement: RouteStatement }> = [];

  constructor(private readonly projectOwner: string) {}

  prepare(query: string): D1PreparedStatement {
    const statement = new RouteStatement(query, this.projectOwner);
    this.prepared.push({ query, statement });
    return statement;
  }

  async batch<T>(): Promise<Array<D1Result<T>>> {
    return [];
  }
}

function chatContext(db: D1Database): PagesFunctionContext<CloudEnv> {
  return {
    request: new Request("https://krater-pro.pages.dev/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://krater-pro.pages.dev",
        Cookie: `${SESSION_COOKIE}=${"s".repeat(43)}`,
        "X-Krater-API-Key": "private-test-key",
      },
      body: JSON.stringify({
        projectId,
        message: "Explain the active file.",
        model: CLOUD_MODEL,
      }),
    }),
    env: {
      DB: db,
      RATE_LIMIT_SALT: "test-rate-salt",
      PASSWORD_PEPPER: "test-password-pepper-value-32-bytes",
    },
    params: { path: ["chat"] },
    waitUntil: () => undefined,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud chat contract", () => {
  it("accepts only the exact public request shape and exact model", () => {
    expect(validateCloudChatRequest({
      projectId,
      message: "Help me debug this.",
      model: CLOUD_MODEL,
    })).toEqual({
      projectId,
      message: "Help me debug this.",
      model: CLOUD_MODEL,
    });
    expect(() => validateCloudChatRequest({
      projectId,
      message: "Help",
      model: "auto",
    })).toThrow(/model must/u);
    expect(() => validateCloudChatRequest({
      projectId,
      message: "Help",
      model: CLOUD_MODEL,
      messages: [],
    })).toThrow(/unsupported fields/u);
  });

  it("builds bounded context from active files and recent saved messages", () => {
    const snapshot: ScratchSnapshot = {
      files: [
        { path: "z.ts", content: "export const z = 1;" },
        { path: "active.ts", content: "export const active = true;" },
      ],
      messages: Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `turn-${index}`,
      })),
      activePath: "active.ts",
    };
    const messages = buildProjectChatMessages(snapshot, "Current question");
    expect(messages).toHaveLength(24);
    expect(messages[0]?.content.indexOf("active.ts")).toBeLessThan(
      messages[0]?.content.indexOf("z.ts") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(messages.at(-1)).toEqual({ role: "user", content: "Current question" });
    expect(messages.some((message) => message.content === "turn-23")).toBe(true);
    expect(
      new TextEncoder().encode(messages.map((message) => message.content).join(""))
        .byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("binds both project ID and authenticated user for chat lookup", async () => {
    const db = new RouteDatabase("user-b");
    await expect(
      loadOwnedProjectForChat(db, projectId, "user-a"),
    ).resolves.toBeNull();
    const projectQuery = db.prepared.find(({ query }) =>
      query.includes("FROM projects WHERE id"));
    expect(projectQuery?.query).toMatch(/id = \? AND user_id = \?/u);
  });

  it("returns 404 and never calls Krater for another user's project", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await onRequest(chatContext(new RouteDatabase("user-b")));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads an owned snapshot server-side and returns the frontend response shape", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe(CLOUD_MODEL);
      expect(body.messages.some(({ content }) => content.includes("answer = 42")))
        .toBe(true);
      expect(body.messages.at(-1)?.content).toBe("Explain the active file.");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "It exports the number 42." } }],
        usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await onRequest(chatContext(new RouteDatabase("user-a")));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reply: "It exports the number 42.",
      usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
