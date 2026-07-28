import { redactSensitiveText } from "../trust/redaction.js";
import type {
  CapturedText,
  CausalPrivacyOptions,
  ProcessInvocation,
  SanitizedInvocation,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function scrubPii(text: string): string {
  return text
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED_EMAIL]",
    )
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "$HOME")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/g, "%USERPROFILE%");
}

export function scrubCausalText(
  text: string,
  options: CausalPrivacyOptions = {},
): string {
  const secretRedacted = redactSensitiveText(text, {
    secrets: options.secrets,
  });
  return options.redactPii === false ? secretRedacted : scrubPii(secretRedacted);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;

  // TextDecoder removes an incomplete final code point rather than persisting a
  // replacement character whose bytes were not present in the observation.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    bytes.subarray(0, maxBytes),
  );
}

export function captureCausalText(
  raw: string,
  maxBytes: number,
  options: CausalPrivacyOptions = {},
): CapturedText {
  const receivedBytes = Buffer.byteLength(raw, "utf8");
  const scrubbed = scrubCausalText(raw, options);
  const text = truncateUtf8(scrubbed, maxBytes);
  const capturedBytes = Buffer.byteLength(text, "utf8");

  return {
    text,
    receivedBytes,
    capturedBytes,
    truncated: Buffer.byteLength(scrubbed, "utf8") > capturedBytes,
  };
}

export function sanitizeInvocation(
  invocation: ProcessInvocation,
  options: CausalPrivacyOptions = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
): SanitizedInvocation {
  return {
    runtime: invocation.runtime,
    entrypoint: scrubCausalText(invocation.entrypoint, options),
    args: (invocation.args ?? []).map((argument) =>
      scrubCausalText(argument, options),
    ),
    ...(invocation.cwd
      ? { cwd: scrubCausalText(invocation.cwd, options) }
      : {}),
    environmentKeys: Object.keys(invocation.environment ?? {})
      .map((key) => scrubCausalText(key, options))
      .sort(),
    timeoutMs: invocation.timeoutMs ?? defaultTimeoutMs,
  };
}
