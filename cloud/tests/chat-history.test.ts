import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_PROMPT_BYTES,
  MAX_SAVED_MESSAGES_BYTES,
  isChatPromptWithinLimit,
  pruneChatHistory,
  utf8ByteLength,
} from "../public/chat-history.js";

describe("Cloud Lab saved chat boundaries", () => {
  it("keeps the newest 12 complete user/assistant turns", () => {
    const messages = Array.from({ length: 14 }, (_, index) => [
      { role: "user", content: `user-${index}` },
      { role: "assistant", content: `assistant-${index}` },
    ]).flat();

    const result = pruneChatHistory(messages);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toHaveLength(24);
    expect(result.messages[0]).toEqual({ role: "user", content: "user-2" });
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "assistant-13" });
  });

  it("uses UTF-8 bytes and keeps the newest complete turns at the aggregate boundary", () => {
    const exact16KiB = "😀".repeat(4_096);
    expect(utf8ByteLength(exact16KiB)).toBe(16 * 1_024);

    const messages = [
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant" },
      { role: "user", content: exact16KiB },
      { role: "assistant", content: exact16KiB },
      { role: "user", content: exact16KiB },
      { role: "assistant", content: exact16KiB },
    ];
    const result = pruneChatHistory(messages);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual(messages.slice(2));
    expect(result.bytes).toBe(MAX_SAVED_MESSAGES_BYTES);
  });

  it("drops an invalid oversized turn without splitting another turn", () => {
    const oversized = "😀".repeat(5_121);
    const latest = [
      { role: "user", content: "valid latest question" },
      { role: "assistant", content: "valid latest answer" },
    ];
    const result = pruneChatHistory([
      { role: "user", content: oversized },
      { role: "assistant", content: "answer to oversized prompt" },
      ...latest,
    ]);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual(latest);
  });

  it("drops malformed and partial messages while preserving the newest complete turn", () => {
    const result = pruneChatHistory([
      { role: "assistant", content: "orphan answer" },
      { role: "user", content: "abandoned question" },
      { role: "system", content: "unsupported role" },
      { role: "user", content: "newest complete question" },
      { role: "assistant", content: "newest complete answer" },
      { role: "user", content: "unfinished latest question" },
    ]);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual([
      { role: "user", content: "newest complete question" },
      { role: "assistant", content: "newest complete answer" },
    ]);
  });

  it("rejects a multibyte prompt one UTF-8 code point beyond 20 KiB", () => {
    const exact = "😀".repeat(5_120);
    const over = `${exact}😀`;

    expect(utf8ByteLength(exact)).toBe(MAX_CHAT_PROMPT_BYTES);
    expect(isChatPromptWithinLimit(exact)).toBe(true);
    expect(utf8ByteLength(over)).toBe(MAX_CHAT_PROMPT_BYTES + 4);
    expect(isChatPromptWithinLimit(over)).toBe(false);
  });
});
