import type {
  IntentGraph,
  IntentGraphValidation,
  IntentKind,
  IntentLink,
  IntentNode,
  ValidateIntentGraphOptions,
} from "../intent/index.js";

export const INTENT_DIRECTORY_NAME = ".krater-intent";
export const INTENT_MANIFEST_FILE = "manifest.json";
export const INTENT_GRAPH_FILE = "intents.json";
export const INTENT_FILE_SCHEMA_VERSION = 1;

export interface IntentFileManifest {
  schemaVersion: typeof INTENT_FILE_SCHEMA_VERSION;
  format: "krater-living-intent";
  graphFile: typeof INTENT_GRAPH_FILE;
  namespace: string;
}

export interface IntentGraphArtifact {
  schemaVersion: typeof INTENT_FILE_SCHEMA_VERSION;
  namespace: string;
  nodes: readonly IntentNode[];
  links: readonly Required<IntentLink>[];
}

export interface IntentFileStoreOptions {
  /**
   * Known in-memory secret values that must never be serialized. Values are
   * retained only by this store instance and are not written to the artifact.
   */
  secrets?: readonly string[];
}

export interface InitializeIntentFilesOptions {
  namespace?: string;
}

export interface AddIntentInput {
  kind: Exclude<IntentKind, "retirement">;
  statement: string;
  stableKey?: string;
  owner?: string;
}

export interface AddIntentResult {
  graph: IntentGraph;
  intent: IntentNode;
  created: boolean;
}

export interface RetireIntentInput {
  intentId: string;
  reason: string;
  replacementIntentId?: string;
  ownerDecisionId?: string;
  retiredAt?: string;
}

export interface CheckIntentFilesOptions extends ValidateIntentGraphOptions {}

export interface IntentFileCheckResult extends IntentGraphValidation {
  artifactDigest: `sha256:${string}`;
}

export class IntentFilesError extends Error {
  readonly code:
    | "invalid_path"
    | "unsafe_symlink"
    | "not_initialized"
    | "already_initialized"
    | "invalid_artifact"
    | "secret_detected"
    | "intent_conflict"
    | "invalid_retirement";

  constructor(
    code: IntentFilesError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntentFilesError";
    this.code = code;
  }
}
