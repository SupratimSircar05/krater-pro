import { describe, expect, it } from "vitest";
import { formatUsage } from "../src/usage.js";

describe("formatUsage", () => {
  it("keeps cumulative cache reuse visible when the current request has zero", () => {
    expect(
      formatUsage({
        promptTokens: 20,
        completionTokens: 5,
        sessionTotalTokens: 75,
        cachedTokens: 0,
        sessionCachedTokens: 30,
      }),
    ).toBe("20 in · 5 out · 75 session · 30 cached in session");
  });

  it("labels request and session cached-token counts separately", () => {
    expect(
      formatUsage({
        cachedTokens: 12,
        sessionCachedTokens: 40,
      }),
    ).toBe("12 cached this request · 40 cached in session");
  });
});
