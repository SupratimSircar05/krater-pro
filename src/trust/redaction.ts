import type { LabeledContext } from "./types.js";

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|password|passwd|secret|token|cookie|private[_-]?key|client[_-]?secret)/i;

const TEXT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|pk|kr)[_-][A-Za-z0-9_-]{16,}\b/g,
  /(\b(?:api[_-]?key|password|passwd|secret|token|authorization)\b\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactionOptions {
  secrets?: readonly string[];
  replacement?: string;
  redactPii?: boolean;
}

export function redactSensitiveText(
  text: string,
  options: RedactionOptions = {},
): string {
  const replacement = options.replacement ?? REDACTED;
  let redacted = text;
  const secrets = [...new Set(options.secrets?.filter(Boolean) ?? [])].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of secrets) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), replacement);
  }
  for (const pattern of TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix?: string) =>
      prefix && /[:=]\s*$/.test(prefix)
        ? `${prefix}${replacement}`
        : replacement,
    );
  }
  return redacted;
}

export function redactLabeledContext(
  context: LabeledContext,
  options: RedactionOptions = {},
): LabeledContext {
  const redactEntireValue =
    context.sensitivity === "secret" ||
    (context.sensitivity === "pii" && options.redactPii === true);
  return {
    ...context,
    content: redactEntireValue
      ? options.replacement ?? REDACTED
      : redactSensitiveText(context.content, options),
  };
}

export function redactObject(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return options.replacement ?? REDACTED;
    if (typeof current === "string") return redactSensitiveText(current, options);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (current instanceof Date) return current.toISOString();
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(current)) {
      result[childKey] = visit(childValue, childKey);
    }
    return result;
  };

  return visit(value);
}
