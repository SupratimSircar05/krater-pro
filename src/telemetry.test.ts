import { describe, expect, it } from "vitest";
import { formatUsageEvent, sanitizeTerminalText } from "./telemetry.js";

describe("formatUsageEvent", () => {
  it("shows cumulative cached tokens even when this request has none", () => {
    expect(
      formatUsageEvent({
        type: "usage",
        totalTokens: 12,
        sessionTotalTokens: 40,
        cachedTokens: 0,
        sessionCachedTokens: 25,
      }),
    ).toBe("tokens: 12 · session 40 · cached session 25");
  });

  it("labels request and session cache counters independently", () => {
    expect(
      formatUsageEvent({
        type: "usage",
        totalTokens: 12,
        cachedTokens: 8,
        sessionCachedTokens: 18,
      }),
    ).toBe("tokens: 12 · cached request 8 · cached session 18");
  });
});

describe("sanitizeTerminalText", () => {
  it("removes CSI, OSC clipboard, and unsafe C0 controls", () => {
    expect(
      sanitizeTerminalText(
        "safe\u001b[31m red\u001b[0m\u001b]52;c;YXR0YWNr\u0007\nnext\u0000\u0008\tok",
      ),
    ).toBe("safe red\nnext\tok");
  });

  it("neutralizes a split escape prefix when chunks are sanitized separately", () => {
    expect(sanitizeTerminalText("\u001b")).toBe("");
    expect(sanitizeTerminalText("[31mvisible")).toBe("[31mvisible");
  });
});
