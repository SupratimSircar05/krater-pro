export function formatUsage(usage: Record<string, unknown>): string {
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens;
  const session = usage.sessionTotalTokens;
  const requestCached = usage.cachedTokens;
  const sessionCached = usage.sessionCachedTokens;

  const parts = [
    typeof input === "number" ? `${input.toLocaleString()} in` : "",
    typeof output === "number" ? `${output.toLocaleString()} out` : "",
    typeof session === "number" ? `${session.toLocaleString()} session` : "",
    typeof requestCached === "number" && requestCached > 0
      ? `${requestCached.toLocaleString()} cached this request`
      : "",
    typeof sessionCached === "number" && sessionCached > 0
      ? `${sessionCached.toLocaleString()} cached in session`
      : "",
  ].filter(Boolean);

  return parts.length ? parts.join(" · ") : "Response complete";
}
