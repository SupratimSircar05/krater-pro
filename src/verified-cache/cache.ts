import {
  constants,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureProtectedDirectory,
  noFollowFlag,
  rejectSymlink,
} from "../proofgraph/filesystem.js";
import { redactForPersistence } from "../proofgraph/redaction.js";
import {
  canonicalJson,
  computeCacheKey,
  computeInputDigest,
  normalizeDescriptor,
  sha256,
} from "./canonical.js";
import type {
  CacheArtifactKind,
  CacheDescriptor,
  CacheEntryMetadata,
  CacheLookup,
  CacheLookupOptions,
  CacheStats,
  CacheWriteOptions,
  JsonValue,
} from "./types.js";

const CACHE_ARTIFACT_KINDS = new Set<CacheArtifactKind>([
  "repository_map",
  "semantic_index",
  "dependency_resolution",
  "test_result",
  "build_result",
  "static_analysis",
  "runtime_trace",
  "evidence_fragment",
  "verifier_artifact",
  "model_conclusion",
]);

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function asMetadata(value: unknown): CacheEntryMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CacheEntryMetadata>;
  if (
    candidate.version !== 1 ||
    typeof candidate.key !== "string" ||
    typeof candidate.namespace !== "string" ||
    !CACHE_ARTIFACT_KINDS.has(candidate.artifactKind as CacheArtifactKind) ||
    !Number.isSafeInteger(candidate.schemaVersion) ||
    (candidate.schemaVersion ?? 0) <= 0 ||
    typeof candidate.inputDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.inputDigest) ||
    typeof candidate.objectDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.objectDigest) ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (candidate.createdAt ?? -1) < 0 ||
    typeof candidate.evidenceEligible !== "boolean" ||
    !Array.isArray(candidate.proofDependencies)
  ) {
    return undefined;
  }
  if (
    candidate.expiresAt !== undefined &&
    !Number.isSafeInteger(candidate.expiresAt)
  ) {
    return undefined;
  }
  if (
    !candidate.proofDependencies.every(
      (dependency) =>
        dependency !== null &&
        typeof dependency === "object" &&
        typeof dependency.id === "string" &&
        Boolean(dependency.id.trim()) &&
        typeof dependency.digest === "string" &&
        Boolean(dependency.digest.trim()) &&
        (dependency.kind === undefined || typeof dependency.kind === "string"),
    )
  ) {
    return undefined;
  }
  const expectedEligibility =
    candidate.artifactKind !== "model_conclusion" ||
    candidate.proofDependencies.length > 0;
  if (candidate.evidenceEligible !== expectedEligibility) return undefined;
  return candidate as CacheEntryMetadata;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureProtectedDirectory(dirname(path));
  await rejectSymlink(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      noFollowFlag(),
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readPrivateText(path: string): Promise<string> {
  await ensureProtectedDirectory(dirname(path));
  await rejectSymlink(path);
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink > 1) {
      throw new Error(`Verified cache path is not a private regular file: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export class VerifiedWorkCache {
  readonly root: string;
  readonly entriesDirectory: string;
  readonly objectsDirectory: string;

  constructor(root: string) {
    const normalized = root.trim();
    if (!normalized) throw new Error("Verified cache root must not be empty.");
    this.root = resolve(normalized);
    if (this.root === parse(this.root).root) {
      throw new Error("Verified cache root must be a dedicated non-root directory.");
    }
    this.entriesDirectory = join(this.root, "entries");
    this.objectsDirectory = join(this.root, "objects");
  }

  private async initialize(): Promise<void> {
    await ensureProtectedDirectory(this.root);
    await ensureProtectedDirectory(this.entriesDirectory);
    await ensureProtectedDirectory(this.objectsDirectory);
  }

  private entryPath(key: string): string {
    return join(this.entriesDirectory, `${key}.json`);
  }

  private objectPath(digest: string): string {
    return join(this.objectsDirectory, `${digest}.json`);
  }

  async put<T extends JsonValue>(
    descriptor: CacheDescriptor,
    value: T,
    options: CacheWriteOptions = {},
  ): Promise<CacheEntryMetadata> {
    await this.initialize();
    const normalized = normalizeDescriptor(descriptor);
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Cache write time must be a non-negative safe integer.");
    }
    if (
      options.ttlMs !== undefined &&
      (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0)
    ) {
      throw new Error("Cache TTL must be a positive safe integer.");
    }
    const expiresAt =
      options.ttlMs === undefined ? undefined : now + options.ttlMs;
    if (expiresAt !== undefined && !Number.isSafeInteger(expiresAt)) {
      throw new Error("Cache expiry exceeds the supported timestamp range.");
    }

    const key = computeCacheKey(descriptor);
    const serializedValue = canonicalJson(
      redactForPersistence(value) as JsonValue,
    );
    const objectDigest = sha256(serializedValue);
    const evidenceEligible =
      normalized.artifactKind !== "model_conclusion" ||
      normalized.proofDependencies.length > 0;
    const metadata: CacheEntryMetadata = {
      version: 1,
      key,
      namespace: normalized.namespace,
      artifactKind: normalized.artifactKind,
      schemaVersion: normalized.schemaVersion,
      inputDigest: computeInputDigest(descriptor),
      objectDigest,
      createdAt: now,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      evidenceEligible,
      proofDependencies: normalized.proofDependencies,
    };

    await atomicWrite(this.objectPath(objectDigest), serializedValue);
    await atomicWrite(
      this.entryPath(key),
      canonicalJson(metadata as unknown as JsonValue),
    );
    return metadata;
  }

  async get<T extends JsonValue = JsonValue>(
    descriptor: CacheDescriptor,
    options: CacheLookupOptions<T> = {},
  ): Promise<CacheLookup<T>> {
    await this.initialize();
    const normalized = normalizeDescriptor(descriptor);
    const key = computeCacheKey(descriptor);
    let rawMetadata: string;
    try {
      rawMetadata = await readPrivateText(this.entryPath(key));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { status: "miss", reason: "No cache entry matches the declared inputs." };
      }
      throw error;
    }

    let metadata: CacheEntryMetadata | undefined;
    try {
      metadata = asMetadata(JSON.parse(rawMetadata));
    } catch {
      // Report malformed metadata as corruption without attempting object access.
    }
    if (!metadata) {
      return { status: "corrupt", reason: "Cache entry metadata is malformed." };
    }
    if (
      metadata.key !== key ||
      metadata.inputDigest !== computeInputDigest(descriptor) ||
      metadata.namespace !== normalized.namespace ||
      metadata.artifactKind !== normalized.artifactKind ||
      metadata.schemaVersion !== normalized.schemaVersion ||
      canonicalJson(metadata.proofDependencies as unknown as JsonValue) !==
        canonicalJson(normalized.proofDependencies as unknown as JsonValue)
    ) {
      return {
        status: "corrupt",
        reason: "Cache entry metadata does not match the declared inputs.",
        metadata,
      };
    }
    const now = options.now ?? Date.now();
    if (metadata.expiresAt !== undefined && now >= metadata.expiresAt) {
      return {
        status: "expired",
        reason: "Cache entry has exceeded its declared TTL.",
        metadata,
      };
    }
    if (options.requireEvidence && !metadata.evidenceEligible) {
      return {
        status: "ineligible",
        reason:
          "A cached model conclusion is not evidence without declared proof dependencies.",
        metadata,
      };
    }
    if (
      options.requireEvidence &&
      metadata.artifactKind === "model_conclusion"
    ) {
      if (!options.validateProofDependencies) {
        return {
          status: "ineligible",
          reason:
            "Cached model conclusions require host replay of every proof dependency before reuse as evidence.",
          metadata,
        };
      }
      if (
        !(await options.validateProofDependencies(
          metadata.proofDependencies,
          metadata,
        ))
      ) {
        return {
          status: "invalid",
          reason: "A cached model conclusion has a stale or invalid proof dependency.",
          metadata,
        };
      }
    }

    let serializedValue: string;
    try {
      serializedValue = await readPrivateText(
        this.objectPath(metadata.objectDigest),
      );
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return {
          status: "corrupt",
          reason: "Cache object is missing.",
          metadata,
        };
      }
      throw error;
    }
    if (sha256(serializedValue) !== metadata.objectDigest) {
      return {
        status: "corrupt",
        reason: "Cache object digest verification failed.",
        metadata,
      };
    }

    let value: T;
    try {
      value = JSON.parse(serializedValue) as T;
    } catch {
      return {
        status: "corrupt",
        reason: "Cache object is not valid JSON.",
        metadata,
      };
    }
    if (options.validate && !(await options.validate(value, metadata))) {
      return {
        status: "invalid",
        reason: "The caller-provided cache validator rejected this entry.",
        metadata,
      };
    }
    return { status: "hit", value, metadata };
  }

  async getEvidence<T extends JsonValue = JsonValue>(
    descriptor: CacheDescriptor,
    options: Omit<CacheLookupOptions<T>, "requireEvidence"> = {},
  ): Promise<CacheLookup<T>> {
    return this.get(descriptor, { ...options, requireEvidence: true });
  }

  async invalidate(descriptor: CacheDescriptor): Promise<boolean> {
    await this.initialize();
    return removeIfPresent(this.entryPath(computeCacheKey(descriptor)));
  }

  async invalidateWhere(
    predicate: (metadata: CacheEntryMetadata) => boolean | Promise<boolean>,
  ): Promise<number> {
    await this.initialize();
    let files: string[];
    try {
      files = await readdir(this.entriesDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    }
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.entriesDirectory, file);
      try {
        const metadata = asMetadata(JSON.parse(await readPrivateText(path)));
        if (metadata && (await predicate(metadata)) && (await removeIfPresent(path))) {
          removed += 1;
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    return removed;
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    return this.invalidateWhere(
      (metadata) => metadata.expiresAt !== undefined && now >= metadata.expiresAt,
    );
  }

  async stats(now = Date.now()): Promise<CacheStats> {
    await this.initialize();
    let files: string[];
    try {
      files = await readdir(this.entriesDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return {
          entries: 0,
          eligibleEvidenceEntries: 0,
          expiredEntries: 0,
          objectBytes: 0,
        };
      }
      throw error;
    }
    const objectDigests = new Set<string>();
    let entries = 0;
    let eligibleEvidenceEntries = 0;
    let expiredEntries = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const metadata = asMetadata(
          JSON.parse(
            await readPrivateText(join(this.entriesDirectory, file)),
          ),
        );
        if (!metadata) continue;
        entries += 1;
        objectDigests.add(metadata.objectDigest);
        if (metadata.evidenceEligible) eligibleEvidenceEntries += 1;
        if (metadata.expiresAt !== undefined && now >= metadata.expiresAt) {
          expiredEntries += 1;
        }
      } catch {
        // Corrupt entries are intentionally excluded from trusted statistics.
      }
    }
    let objectBytes = 0;
    for (const digest of objectDigests) {
      try {
        const objectPath = this.objectPath(digest);
        await rejectSymlink(objectPath);
        const details = await lstat(objectPath);
        if (!details.isFile() || details.nlink > 1) continue;
        objectBytes += details.size;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    return {
      entries,
      eligibleEvidenceEntries,
      expiredEntries,
      objectBytes,
    };
  }
}
