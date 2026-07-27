import { describe, expect, it } from "vitest";
import {
  addUsage,
  compactToolOutput,
  emptyUsageTotals,
  prepareContext,
  stableStringify,
} from "./efficiency.js";
import type { ModelMessage } from "./types.js";

describe("stableStringify", () => {
  it("produces the same key regardless of object insertion order", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(
      stableStringify({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });
});

describe("compactToolOutput", () => {
  it("removes terminal escapes and redundant blank lines", () => {
    expect(compactToolOutput("\u001b[31merror\u001b[0m\n\n\n\nnext  \n", 1_000)).toBe(
      "error\n\nnext\n",
    );
  });

  it("keeps diagnostically useful head and tail content within the budget", () => {
    const compacted = compactToolOutput(`BEGIN-${"x".repeat(1_000)}-END`, 240);
    expect(compacted.length).toBeLessThanOrEqual(240);
    expect(compacted).toContain("BEGIN-");
    expect(compacted).toContain("-END");
    expect(compacted).toContain("characters omitted by Krater Pro");
  });
});

describe("prepareContext", () => {
  it("drops complete old turns without orphaning tool results", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "stable system prefix" },
      { role: "user", content: "old request ".repeat(30) },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "old-tool",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"old.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "old-tool", content: "old output".repeat(30) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new request" },
      { role: "assistant", content: "new answer" },
    ];

    const prepared = prepareContext(messages, 220, 80);
    expect(prepared.messages[0]).toEqual(messages[0]);
    expect(prepared.omittedTurns).toBe(1);
    expect(prepared.messages).not.toContainEqual(
      expect.objectContaining({ tool_call_id: "old-tool" }),
    );
    expect(prepared.messages.at(-2)).toEqual({ role: "user", content: "new request" });
    expect(prepared.messages.at(-1)).toEqual({
      role: "assistant",
      content: "new answer",
    });
  });

  it("compacts tool results before sending them back to the provider", () => {
    const prepared = prepareContext(
      [
        { role: "system", content: "system" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool",
              type: "function",
              function: { name: "run_command", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tool", content: "x".repeat(2_000) },
      ],
      10_000,
      220,
    );
    const tool = prepared.messages.at(-1);
    expect(tool?.role).toBe("tool");
    expect(tool?.content.length).toBeLessThanOrEqual(220);
  });

  it("never sends an oversized newest turn past the estimated context cap", () => {
    expect(() =>
      prepareContext(
        [
          { role: "system", content: "system" },
          { role: "user", content: "x".repeat(1_000) },
        ],
        500,
        200,
      ),
    ).toThrow(/newest conversation turn exceeds.*context budget/i);
  });

  it("accounts for the omission note while staying inside the hard estimate", () => {
    const prepared = prepareContext(
      [
        { role: "system", content: "system" },
        { role: "user", content: "old ".repeat(80) },
        { role: "assistant", content: "old response" },
        { role: "user", content: "new request" },
        { role: "assistant", content: "new response" },
      ],
      190,
      100,
    );

    expect(prepared.omittedTurns).toBe(1);
    expect(prepared.estimatedChars).toBeLessThanOrEqual(190);
    expect(prepared.messages.some((message) => message.role === "system")).toBe(true);
  });
});

describe("usage totals", () => {
  it("accumulates provider and cached prompt tokens", () => {
    const totals = addUsage(emptyUsageTotals(), {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 75,
    });
    expect(totals).toEqual({
      requestCount: 1,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 75,
    });
  });
});
