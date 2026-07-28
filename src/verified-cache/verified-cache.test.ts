import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeCacheKey,
  sha256,
  VerifiedWorkCache,
  type CacheDescriptor,
} from "./index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-verified-cache-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function descriptor(
  overrides: Partial<CacheDescriptor> = {},
): CacheDescriptor {
  return {
    namespace: "workspace-map",
    artifactKind: "repository_map",
    inputs: {
      source: { digest: "source-1" },
      config: { parser: "v1" },
      toolchain: { node: "22.0.0" },
      environment: { platform: "test" },
      policy: { network: false },
    },
    ...overrides,
  };
}

describe("cache key declarations", () => {
  it("canonicalizes object key order but varies every declared input group", () => {
    const first = descriptor({
      inputs: {
        source: { b: 2, a: 1 },
        config: { parser: "v1" },
        toolchain: { node: "22.0.0" },
        environment: { platform: "test" },
        policy: { network: false },
      },
    });
    const reordered = descriptor({
      inputs: {
        source: { a: 1, b: 2 },
        config: { parser: "v1" },
        toolchain: { node: "22.0.0" },
        environment: { platform: "test" },
        policy: { network: false },
      },
    });
    const changedPolicy = descriptor({
      inputs: {
        ...reordered.inputs,
        policy: { network: true },
      },
    });

    expect(computeCacheKey(first)).toBe(computeCacheKey(reordered));
    expect(computeCacheKey(changedPolicy)).not.toBe(computeCacheKey(first));
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("rejects non-finite input values before filesystem access", () => {
    expect(() =>
      computeCacheKey(
        descriptor({
          inputs: {
            ...descriptor().inputs,
            config: { unsafe: Number.NaN },
          },
        }),
      ),
    ).toThrow(/non-finite/i);
  });
});

describe("VerifiedWorkCache", () => {
  it(
    "rejects all 10,000 deterministic dependency mutations without a stale hit",
    async () => {
      const cache = new VerifiedWorkCache(await temporaryDirectory());
      const baseline: CacheDescriptor = {
        namespace: "invalidation-property",
        artifactKind: "repository_map",
        schemaVersion: 1,
        inputs: {
          source: { digest: sha256("source:baseline") },
          config: { digest: sha256("config:baseline") },
          toolchain: { digest: sha256("toolchain:baseline") },
          environment: { digest: sha256("environment:baseline") },
          policy: { digest: sha256("policy:baseline") },
          dependencies: { digest: sha256("dependencies:baseline") },
        },
        proofDependencies: [
          {
            id: "proof:baseline",
            digest: sha256("proof:baseline"),
            kind: "test_result",
          },
        ],
      };
      await cache.put(baseline, { generation: "baseline" }, { now: 1_000 });

      const inputDimensions = [
        "source",
        "config",
        "toolchain",
        "environment",
        "policy",
        "dependencies",
      ] as const;
      const dimensions = [
        ...inputDimensions,
        "proofDependencyDigest",
        "proofDependencyId",
        "proofDependencyKind",
        "namespace",
        "artifactKind",
        "schemaVersion",
      ] as const;
      type Dimension = (typeof dimensions)[number];

      // Xorshift32 makes the mutation schedule stable across platforms and
      // Vitest workers without depending on Math.random().
      let randomState = 0x6d2b_79f5;
      const nextRandom = (): number => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return randomState >>> 0;
      };

      const counts = new Map<Dimension, number>(
        dimensions.map((dimension) => [dimension, 0]),
      );
      const mutatedKeys = new Set<string>();
      const mutations: Array<{
        descriptor: CacheDescriptor;
        dimension: Dimension;
        iteration: number;
      }> = [];

      for (let iteration = 0; iteration < 10_000; iteration += 1) {
        const random = nextRandom();
        const dimension = dimensions[random % dimensions.length]!;
        const digest = sha256(
          `verified-cache-invalidation:${iteration}:${random}`,
        );
        const mutated: CacheDescriptor = {
          ...baseline,
          inputs: { ...baseline.inputs },
        };
        if (
          inputDimensions.includes(
            dimension as (typeof inputDimensions)[number],
          )
        ) {
          mutated.inputs = {
            ...baseline.inputs,
            [dimension]: { digest },
          };
        } else if (dimension === "proofDependencyDigest") {
          mutated.proofDependencies = [
            {
              id: "proof:baseline",
              digest,
              kind: "test_result",
            },
          ];
        } else if (dimension === "proofDependencyId") {
          mutated.proofDependencies = [
            {
              id: `proof:${digest}`,
              digest: baseline.proofDependencies![0]!.digest,
              kind: "test_result",
            },
          ];
        } else if (dimension === "proofDependencyKind") {
          mutated.proofDependencies = [
            {
              id: "proof:baseline",
              digest: baseline.proofDependencies![0]!.digest,
              kind: `test_result:${digest}`,
            },
          ];
        } else if (dimension === "namespace") {
          mutated.namespace = `invalidation-property:${digest}`;
        } else if (dimension === "artifactKind") {
          mutated.artifactKind = "semantic_index";
        } else {
          mutated.schemaVersion = iteration + 2;
        }
        counts.set(dimension, (counts.get(dimension) ?? 0) + 1);
        mutatedKeys.add(computeCacheKey(mutated));
        mutations.push({ descriptor: mutated, dimension, iteration });
      }

      const baselineKey = computeCacheKey(baseline);
      expect(mutatedKeys.has(baselineKey)).toBe(false);
      expect([...counts.values()].every((count) => count > 0)).toBe(true);
      expect(mutations).toHaveLength(10_000);

      const stale: Array<{
        dimension: Dimension;
        iteration: number;
        status: string;
      }> = [];
      const batchSize = 128;
      for (let offset = 0; offset < mutations.length; offset += batchSize) {
        const batch = mutations.slice(offset, offset + batchSize);
        const lookups = await Promise.all(
          batch.map(({ descriptor }) => cache.get(descriptor, { now: 1_001 })),
        );
        lookups.forEach((lookup, index) => {
          if (lookup.status !== "miss") {
            const mutation = batch[index]!;
            stale.push({
              dimension: mutation.dimension,
              iteration: mutation.iteration,
              status: lookup.status,
            });
          }
        });
      }

      expect(stale).toEqual([]);
      expect(await cache.get(baseline, { now: 1_001 })).toMatchObject({
        status: "hit",
        value: { generation: "baseline" },
      });
    },
    30_000,
  );

  it("stores content-addressed values and verifies them on read", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const key = descriptor();
    const metadata = await cache.put(key, { files: ["src/app.ts"] }, { now: 100 });
    const lookup = await cache.get(key, { now: 101 });

    expect(lookup).toMatchObject({
      status: "hit",
      value: { files: ["src/app.ts"] },
      metadata: {
        key: computeCacheKey(key),
        evidenceEligible: true,
      },
    });
    expect(metadata.objectDigest).toHaveLength(64);
    expect(await readFile(join(cache.objectsDirectory, `${metadata.objectDigest}.json`), "utf8"))
      .toBe('{"files":["src/app.ts"]}');
  });

  it("enforces TTL at the exact expiry boundary and can prune entries", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const key = descriptor();
    await cache.put(key, { ok: true }, { now: 1_000, ttlMs: 50 });

    expect((await cache.get(key, { now: 1_049 })).status).toBe("hit");
    expect((await cache.get(key, { now: 1_050 })).status).toBe("expired");
    expect(await cache.pruneExpired(1_050)).toBe(1);
    expect((await cache.get(key, { now: 1_050 })).status).toBe("miss");
  });

  it("supports caller validation and explicit invalidation", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const key = descriptor();
    await cache.put(key, { count: 3 });
    expect(
      await cache.get(key, {
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          "count" in value &&
          value.count === 4,
      }),
    ).toMatchObject({ status: "invalid" });
    expect(await cache.invalidate(key)).toBe(true);
    expect(await cache.invalidate(key)).toBe(false);
  });

  it("never treats an unproved model conclusion as evidence", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const unproved = descriptor({
      namespace: "conclusion",
      artifactKind: "model_conclusion",
    });
    await cache.put(unproved, { conclusion: "The tests pass." });

    expect((await cache.get(unproved)).status).toBe("hit");
    expect(await cache.getEvidence(unproved)).toMatchObject({
      status: "ineligible",
      metadata: { evidenceEligible: false },
    });

    const proved = {
      ...unproved,
      proofDependencies: [
        { id: "test:unit", digest: "a".repeat(64), kind: "test_result" },
      ],
    };
    await cache.put(proved, { conclusion: "The tests pass." });
    expect(await cache.getEvidence(proved)).toMatchObject({
      status: "ineligible",
      reason: expect.stringMatching(/host replay/i),
    });
    expect(
      await cache.getEvidence(proved, {
        validateProofDependencies: (dependencies) =>
          dependencies.every(
            (dependency) =>
              dependency.id === "test:unit" &&
              dependency.digest === "a".repeat(64),
          ),
      }),
    ).toMatchObject({
      status: "hit",
      metadata: {
        evidenceEligible: true,
        proofDependencies: [{ id: "test:unit", digest: "a".repeat(64), kind: "test_result" }],
      },
    });
  });

  it("redacts secret-like cache values before content addressing", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const key = descriptor();
    await cache.put(key, {
      apiKey: "kr_demo_abcdefghijklmnopqrstuvwxyz",
      output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    });

    expect(await cache.get(key)).toMatchObject({
      status: "hit",
      value: {
        apiKey: "[REDACTED]",
        output: "Authorization: [REDACTED]",
      },
    });
  });

  it("rejects cache roots whose protected directory is a symbolic link", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(outside, "entries"));
    await symlink(outside, join(parent, "cache"));
    const cache = new VerifiedWorkCache(join(parent, "cache"));

    await expect(cache.put(descriptor(), { safe: true })).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("detects object tampering rather than returning stale evidence", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    const key = descriptor();
    const metadata = await cache.put(key, { safe: true });
    await writeFile(
      join(cache.objectsDirectory, `${metadata.objectDigest}.json`),
      '{"safe":false}',
    );

    expect(await cache.getEvidence(key)).toMatchObject({
      status: "corrupt",
      reason: expect.stringMatching(/digest verification failed/i),
    });
  });

  it("reports trustworthy stats and selective invalidation", async () => {
    const cache = new VerifiedWorkCache(await temporaryDirectory());
    await cache.put(descriptor(), { map: true }, { now: 10 });
    await cache.put(
      descriptor({ namespace: "tests", artifactKind: "test_result" }),
      { passed: true },
      { now: 10, ttlMs: 5 },
    );

    expect(await cache.stats(20)).toMatchObject({
      entries: 2,
      eligibleEvidenceEntries: 2,
      expiredEntries: 1,
    });
    expect(
      await cache.invalidateWhere((metadata) => metadata.namespace === "tests"),
    ).toBe(1);
    expect(await cache.stats(20)).toMatchObject({
      entries: 1,
      eligibleEvidenceEntries: 1,
      expiredEntries: 0,
    });
  });
});
