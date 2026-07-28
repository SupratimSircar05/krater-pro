const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "authtoken",
  "accesskey",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passphrase",
  "passwd",
  "privatekey",
  "refreshtoken",
  "sessioncookie",
  "sessionid",
  "sessiontoken",
  "signingkey",
  "encryptionkey",
  "secret",
  "setcookie",
  "token",
]);

const INLINE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|refresh[_-]?token|secret)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
  /\b((?:KRATER|OPENAI|ANTHROPIC|GITHUB|AWS|AZURE|GOOGLE)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\s]+/g,
  /\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bkr[_-][A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi,
  /([?&](?:api[_-]?key|access[_-]?token|auth|token|key|secret)=)[^&#\s]+/gi,
];

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("encryptionkey") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("sessioncookie") ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("sessiontoken") ||
    normalized.endsWith("signingkey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of INLINE_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix: string | undefined) =>
      typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  return redacted;
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior) return prior;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactValue(item, seen));
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ProofGraph persistence accepts only plain JSON objects.");
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
  }
  return copy;
}

export function redactForPersistence<T>(value: T): T {
  return redactValue(value, new WeakMap()) as T;
}

export const REDACTED_VALUE = REDACTED;
