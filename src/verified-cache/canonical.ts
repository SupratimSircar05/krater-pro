import { createHash } from "node:crypto";
import type {
  CacheDescriptor,
  JsonValue,
  ProofDependency,
} from "./types.js";

function canonicalJsonInner(value: JsonValue, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cache keys and values cannot contain non-finite numbers.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`Cache JSON contains unsupported ${typeof value} value.`);
  }
  if (ancestors.has(value)) {
    throw new Error("Cache JSON cannot contain circular references.");
  }
  ancestors.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value
      .map((item) => canonicalJsonInner(item, ancestors))
      .join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    throw new Error("Cache JSON can contain only arrays and plain objects.");
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  serialized = `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonInner(object[key], ancestors)}`,
    )
    .join(",")}}`;
  ancestors.delete(value);
  return serialized;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalJsonInner(value, new WeakSet());
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeProofDependencies(
  dependencies: readonly ProofDependency[] | undefined,
): ProofDependency[] {
  const seen = new Set<string>();
  const normalized = (dependencies ?? []).map((dependency) => {
    const id = dependency.id.trim();
    const digest = dependency.digest.trim().toLocaleLowerCase("en-US");
    const kind = dependency.kind?.trim() || undefined;
    if (!id || !/^(?:sha256:)?[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        "Proof dependencies require non-empty IDs and SHA-256 digests.",
      );
    }
    const identity = `${kind ?? ""}\0${id}\0${digest}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate proof dependency: ${id}.`);
    }
    seen.add(identity);
    return { id, digest, ...(kind ? { kind } : {}) };
  });
  return normalized.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      (left.kind ?? "").localeCompare(right.kind ?? "") ||
      left.digest.localeCompare(right.digest),
  );
}

export interface NormalizedDescriptor {
  namespace: string;
  artifactKind: CacheDescriptor["artifactKind"];
  schemaVersion: number;
  inputs: CacheDescriptor["inputs"];
  proofDependencies: ProofDependency[];
}

export function normalizeDescriptor(
  descriptor: CacheDescriptor,
): NormalizedDescriptor {
  const namespace = descriptor.namespace.normalize("NFC").trim();
  if (!namespace) throw new Error("Cache namespace must not be empty.");
  const schemaVersion = descriptor.schemaVersion ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error("Cache schema version must be a positive safe integer.");
  }
  // Canonicalizing here eagerly rejects invalid JSON values before any I/O.
  canonicalJson(descriptor.inputs as unknown as JsonValue);
  return {
    namespace,
    artifactKind: descriptor.artifactKind,
    schemaVersion,
    inputs: descriptor.inputs,
    proofDependencies: normalizeProofDependencies(descriptor.proofDependencies),
  };
}

export function computeCacheKey(descriptor: CacheDescriptor): string {
  const normalized = normalizeDescriptor(descriptor);
  return sha256(
    canonicalJson(
      {
        namespace: normalized.namespace,
        artifactKind: normalized.artifactKind,
        schemaVersion: normalized.schemaVersion,
        inputs: normalized.inputs,
        proofDependencies: normalized.proofDependencies,
      } as unknown as JsonValue,
    ),
  );
}

export function computeInputDigest(descriptor: CacheDescriptor): string {
  const normalized = normalizeDescriptor(descriptor);
  return sha256(canonicalJson(normalized.inputs as unknown as JsonValue));
}
