import { createHash, timingSafeEqual } from "node:crypto";

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot represent non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot represent ${typeof value} values.`);
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot represent cycles.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError("Canonical JSON cannot represent sparse arrays.");
        }
      }
      return `[${value.map((item) => serialize(item, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects and arrays.");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalStringify(value: unknown): string {
  return serialize(value, new Set());
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${sha256Hex(value)}`;
}

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value);
}

export function verifySha256Digest(
  value: string | Uint8Array,
  digest: string,
): boolean {
  const match = SHA256_DIGEST.exec(digest);
  if (!match) return false;
  const expected = Buffer.from(match[1], "hex");
  const actual = Buffer.from(sha256Hex(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
