import type { AgentEvent } from "./types.js";

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function formatUsageEvent(event: UsageEvent): string {
  const parts = [`tokens: ${event.totalTokens ?? 0}`];
  if (
    typeof event.sessionTotalTokens === "number" &&
    event.sessionTotalTokens !== event.totalTokens
  ) {
    parts.push(`session ${event.sessionTotalTokens}`);
  }
  if (typeof event.cachedTokens === "number" && event.cachedTokens > 0) {
    parts.push(`cached request ${event.cachedTokens}`);
  }
  if (
    typeof event.sessionCachedTokens === "number" &&
    event.sessionCachedTokens > 0
  ) {
    parts.push(`cached session ${event.sessionCachedTokens}`);
  }
  return parts.join(" · ");
}
