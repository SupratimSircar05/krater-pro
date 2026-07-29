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

const PRIVATE_KEY_BEGIN_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
] as const;

const PRIVATE_KEY_END_MARKERS = [
  "-----END PRIVATE KEY-----",
  "-----END RSA PRIVATE KEY-----",
  "-----END EC PRIVATE KEY-----",
  "-----END OPENSSH PRIVATE KEY-----",
] as const;

const INLINE_PATTERNS: RegExp[] = [
  /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|refresh[_-]?token|secret)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
  /\b((?:KRATER|OPENAI|ANTHROPIC|GITHUB|AWS|AZURE|GOOGLE)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\s]+/g,
  /\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bkr[_-][A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([?&](?:api[_-]?key|access[_-]?token|auth|token|key|secret)=)[^&#\s]+/gi,
];

function isAsciiLetter(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isSchemeCharacter(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 45 ||
    code === 46
  );
}

function isWhitespace(character: string): boolean {
  return character.trim().length === 0;
}

/**
 * Redact passwords embedded in URL authorities without applying a backtracking
 * expression to the complete, uncontrolled string.
 */
function redactUrlCredentials(value: string): string {
  const chunks: string[] = [];
  let copyStart = 0;
  let cursor = 0;

  while (cursor < value.length) {
    if (!isAsciiLetter(value.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }

    let schemeEnd = cursor + 1;
    while (
      schemeEnd < value.length &&
      isSchemeCharacter(value.charCodeAt(schemeEnd))
    ) {
      schemeEnd += 1;
    }

    if (!value.startsWith("://", schemeEnd)) {
      cursor = schemeEnd;
      continue;
    }

    const authorityStart = schemeEnd + 3;
    let usernameEnd = authorityStart;
    while (usernameEnd < value.length) {
      const character = value[usernameEnd]!;
      if (character === ":") break;
      if (
        character === "/" ||
        character === "@" ||
        isWhitespace(character)
      ) {
        usernameEnd = -1;
        break;
      }
      usernameEnd += 1;
    }

    if (
      usernameEnd <= authorityStart ||
      usernameEnd >= value.length ||
      value[usernameEnd] !== ":"
    ) {
      cursor = authorityStart;
      continue;
    }

    const passwordStart = usernameEnd + 1;
    let passwordEnd = passwordStart;
    while (passwordEnd < value.length) {
      const character = value[passwordEnd]!;
      if (character === "@") break;
      if (character === "/" || isWhitespace(character)) {
        passwordEnd = -1;
        break;
      }
      passwordEnd += 1;
    }

    if (
      passwordEnd <= passwordStart ||
      passwordEnd >= value.length ||
      value[passwordEnd] !== "@"
    ) {
      cursor = authorityStart;
      continue;
    }

    chunks.push(value.slice(copyStart, passwordStart), REDACTED);
    copyStart = passwordEnd;
    cursor = passwordEnd + 1;
  }

  chunks.push(value.slice(copyStart));
  return chunks.join("");
}

function nextMarker(
  value: string,
  start: number,
  markers: readonly string[],
): { index: number; marker: string } | undefined {
  let cursor = start;
  while (cursor < value.length) {
    const index = value.indexOf("-----", cursor);
    if (index < 0) return undefined;
    for (const marker of markers) {
      if (value.startsWith(marker, index)) return { index, marker };
    }
    cursor = index + 1;
  }
  return undefined;
}

function redactPrivateKeyBlocks(value: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const begin = nextMarker(value, cursor, PRIVATE_KEY_BEGIN_MARKERS);
    if (!begin) break;
    chunks.push(value.slice(cursor, begin.index), REDACTED);
    const end = nextMarker(
      value,
      begin.index + begin.marker.length,
      PRIVATE_KEY_END_MARKERS,
    );
    if (!end) {
      cursor = value.length;
      break;
    }
    cursor = end.index + end.marker.length;
  }
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

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
  let redacted = redactUrlCredentials(redactPrivateKeyBlocks(value));
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
