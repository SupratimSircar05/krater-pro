import { createHash } from "node:crypto";
import type { IntentKind, IntentLink } from "./types.js";

function normalizeStablePart(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

export function createIntentId(
  kind: IntentKind,
  stableKey: string,
  namespace = "krater",
): string {
  const key = normalizeStablePart(stableKey);
  const scope = normalizeStablePart(namespace);
  if (!key) throw new Error("Intent stable key must not be empty.");
  if (!scope) throw new Error("Intent namespace must not be empty.");
  return `intent:${kind}:${digest([scope, kind, key])}`;
}

export function createIntentLinkId(link: IntentLink): string {
  const target = normalizeStablePart(link.target.id);
  const source = normalizeStablePart(link.fromIntentId);
  if (!source || !target) throw new Error("Intent link endpoints must not be empty.");
  return `link:${digest([
    source,
    link.target.kind,
    target,
    link.relation,
  ])}`;
}

export function createStableRecordId(prefix: string, parts: readonly string[]): string {
  const normalizedPrefix = normalizeStablePart(prefix);
  if (!normalizedPrefix) throw new Error("Record ID prefix must not be empty.");
  return `${normalizedPrefix}:${digest(parts.map(normalizeStablePart))}`;
}
