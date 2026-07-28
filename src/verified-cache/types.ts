export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface CacheKeyInputs {
  source: JsonValue;
  config: JsonValue;
  toolchain: JsonValue;
  environment: JsonValue;
  policy: JsonValue;
  dependencies?: JsonValue;
}

export interface ProofDependency {
  id: string;
  digest: string;
  kind?: string;
}

export type CacheArtifactKind =
  | "repository_map"
  | "semantic_index"
  | "dependency_resolution"
  | "test_result"
  | "build_result"
  | "static_analysis"
  | "runtime_trace"
  | "evidence_fragment"
  | "verifier_artifact"
  | "model_conclusion";

export interface CacheDescriptor {
  namespace: string;
  artifactKind: CacheArtifactKind;
  schemaVersion?: number;
  inputs: CacheKeyInputs;
  proofDependencies?: readonly ProofDependency[];
}

export interface CacheWriteOptions {
  ttlMs?: number;
  now?: number;
}

export interface CacheEntryMetadata {
  version: 1;
  key: string;
  namespace: string;
  artifactKind: CacheArtifactKind;
  schemaVersion: number;
  inputDigest: string;
  objectDigest: string;
  createdAt: number;
  expiresAt?: number;
  evidenceEligible: boolean;
  proofDependencies: readonly ProofDependency[];
}

export type CacheLookup<T extends JsonValue = JsonValue> =
  | {
      status: "hit";
      value: T;
      metadata: CacheEntryMetadata;
    }
  | {
      status: "miss" | "expired" | "corrupt" | "invalid" | "ineligible";
      reason: string;
      metadata?: CacheEntryMetadata;
    };

export interface CacheLookupOptions<T extends JsonValue = JsonValue> {
  now?: number;
  requireEvidence?: boolean;
  /**
   * Host-owned replay/lookup of the proof obligations named by a cached
   * conclusion. Supplying old dependency strings is not, by itself, evidence.
   */
  validateProofDependencies?: (
    dependencies: readonly ProofDependency[],
    metadata: CacheEntryMetadata,
  ) => boolean | Promise<boolean>;
  validate?: (
    value: T,
    metadata: CacheEntryMetadata,
  ) => boolean | Promise<boolean>;
}

export interface CacheStats {
  entries: number;
  eligibleEvidenceEntries: number;
  expiredEntries: number;
  objectBytes: number;
}
