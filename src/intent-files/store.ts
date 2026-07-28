import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createIntentId,
  createIntentLinkId,
  validateIntentGraph,
  type IntentGraph,
  type IntentLink,
  type IntentNode,
} from "../intent/index.js";
import {
  createGraphArtifact,
  createManifest,
  digestArtifact,
  graphFromArtifact,
  serializeArtifact,
} from "./format.js";
import {
  assertNoSerializedSecrets,
  assertRegularArtifact,
  assertSafeIntentDirectory,
  noFollowFlag,
  resolveIntentDirectory,
} from "./safety.js";
import {
  INTENT_FILE_SCHEMA_VERSION,
  INTENT_GRAPH_FILE,
  INTENT_MANIFEST_FILE,
  type AddIntentInput,
  type AddIntentResult,
  type CheckIntentFilesOptions,
  type InitializeIntentFilesOptions,
  type IntentFileCheckResult,
  type IntentFileManifest,
  type IntentFileStoreOptions,
  IntentFilesError,
  type IntentGraphArtifact,
  type RetireIntentInput,
} from "./types.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function cleanText(value: string, label: string): string {
  const cleaned = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!cleaned) {
    throw new IntentFilesError(
      "invalid_artifact",
      `${label} must not be empty.`,
    );
  }
  return cleaned;
}

function parseManifest(value: unknown): IntentFileManifest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new IntentFilesError("invalid_artifact", "Invalid living-intent manifest.");
  }
  const manifest = value as Partial<IntentFileManifest>;
  if (
    manifest.schemaVersion !== INTENT_FILE_SCHEMA_VERSION ||
    manifest.format !== "krater-living-intent" ||
    manifest.graphFile !== INTENT_GRAPH_FILE ||
    typeof manifest.namespace !== "string" ||
    !manifest.namespace.trim()
  ) {
    throw new IntentFilesError(
      "invalid_artifact",
      "Unsupported or malformed living-intent manifest.",
    );
  }
  return createManifest(cleanText(manifest.namespace, "Intent namespace"));
}

function parseGraphArtifact(
  value: unknown,
  manifest: IntentFileManifest,
): IntentGraphArtifact {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new IntentFilesError("invalid_artifact", "Invalid living-intent graph.");
  }
  const artifact = value as Partial<IntentGraphArtifact>;
  if (
    artifact.schemaVersion !== INTENT_FILE_SCHEMA_VERSION ||
    artifact.namespace !== manifest.namespace ||
    !Array.isArray(artifact.nodes) ||
    !Array.isArray(artifact.links)
  ) {
    throw new IntentFilesError(
      "invalid_artifact",
      "Unsupported, malformed, or mismatched living-intent graph.",
    );
  }

  for (const node of artifact.nodes) {
    if (
      typeof node !== "object" ||
      node === null ||
      typeof (node as IntentNode).id !== "string" ||
      typeof (node as IntentNode).statement !== "string"
    ) {
      throw new IntentFilesError("invalid_artifact", "Malformed intent node.");
    }
  }
  for (const link of artifact.links) {
    if (
      typeof link !== "object" ||
      link === null ||
      typeof (link as IntentLink).fromIntentId !== "string" ||
      typeof (link as IntentLink).target?.id !== "string"
    ) {
      throw new IntentFilesError("invalid_artifact", "Malformed intent link.");
    }
  }
  return artifact as IntentGraphArtifact;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export class IntentFileStore {
  readonly directory: string;
  readonly manifestPath: string;
  readonly graphPath: string;
  readonly #secrets: readonly string[];

  constructor(
    intentDirectory: string,
    options: IntentFileStoreOptions = {},
  ) {
    this.directory = resolveIntentDirectory(intentDirectory);
    this.manifestPath = join(this.directory, INTENT_MANIFEST_FILE);
    this.graphPath = join(this.directory, INTENT_GRAPH_FILE);
    this.#secrets = [...new Set(options.secrets?.filter(Boolean) ?? [])];
  }

  async isInitialized(): Promise<boolean> {
    await assertSafeIntentDirectory(this.directory, {
      allowMissingTarget: true,
    });
    return (
      (await pathExists(this.manifestPath)) &&
      (await pathExists(this.graphPath))
    );
  }

  async initialize(
    options: InitializeIntentFilesOptions = {},
  ): Promise<IntentGraph> {
    await assertSafeIntentDirectory(this.directory, {
      allowMissingTarget: true,
    });
    if (await pathExists(this.directory)) {
      if (await this.isInitialized()) {
        throw new IntentFilesError(
          "already_initialized",
          "Living intent is already initialized for this project.",
        );
      }
      const entries = await import("node:fs/promises").then(({ readdir }) =>
        readdir(this.directory),
      );
      if (entries.length > 0) {
        throw new IntentFilesError(
          "invalid_path",
          "Refusing to initialize a non-empty .krater-intent directory.",
        );
      }
    } else {
      await mkdir(this.directory, { mode: 0o755 });
    }
    await assertSafeIntentDirectory(this.directory, {
      allowMissingTarget: false,
    });

    const namespace = cleanText(options.namespace ?? basename(dirname(this.directory)), "Intent namespace");
    const manifest = createManifest(namespace);
    const emptyGraph: IntentGraph = { nodes: [], links: [] };
    await this.#writeArtifact(this.manifestPath, serializeArtifact(manifest));
    try {
      await this.#writeGraph(emptyGraph, namespace);
    } catch (error) {
      await rm(this.manifestPath, { force: true });
      throw error;
    }
    return emptyGraph;
  }

  async load(): Promise<IntentGraph> {
    const { artifact } = await this.#readArtifacts();
    return graphFromArtifact(artifact);
  }

  async save(graph: IntentGraph): Promise<IntentGraph> {
    const { manifest } = await this.#readArtifacts();
    const normalized = graphFromArtifact(createGraphArtifact(graph, manifest.namespace));
    await this.#writeGraph(normalized, manifest.namespace);
    return normalized;
  }

  async addIntent(input: AddIntentInput): Promise<AddIntentResult> {
    const statement = cleanText(input.statement, "Intent statement");
    const graph = await this.load();
    const { manifest } = await this.#readArtifacts();
    const id = createIntentId(
      input.kind,
      input.stableKey?.trim() || statement,
      manifest.namespace,
    );
    const existing = graph.nodes.find((node) => node.id === id);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.statement !== statement ||
        (existing.owner ?? "") !== (input.owner?.trim() ?? "")
      ) {
        throw new IntentFilesError(
          "intent_conflict",
          `Stable intent ID ${id} already identifies different content.`,
        );
      }
      return { graph, intent: existing, created: false };
    }

    const intent: IntentNode = {
      id,
      kind: input.kind,
      statement,
      status: "active",
      ...(input.owner?.trim() ? { owner: cleanText(input.owner, "Intent owner") } : {}),
    };
    const saved = await this.save({
      nodes: [...graph.nodes, intent],
      links: graph.links,
    });
    return {
      graph: saved,
      intent: saved.nodes.find((node) => node.id === id) as IntentNode,
      created: true,
    };
  }

  async upsertLink(link: IntentLink): Promise<IntentGraph> {
    const graph = await this.load();
    const normalized: IntentLink = {
      id: link.id?.trim() || createIntentLinkId(link),
      fromIntentId: cleanText(link.fromIntentId, "Intent link source"),
      target: {
        kind: link.target.kind,
        id: cleanText(link.target.id, "Intent link target"),
      },
      relation: link.relation,
      state: link.state ?? "current",
    };
    const links = graph.links.filter(
      (candidate) =>
        (candidate.id?.trim() || createIntentLinkId(candidate)) !== normalized.id,
    );
    return this.save({ nodes: graph.nodes, links: [...links, normalized] });
  }

  async retireIntent(input: RetireIntentInput): Promise<IntentGraph> {
    const reason = cleanText(input.reason, "Retirement reason");
    const replacementIntentId = input.replacementIntentId?.trim();
    const ownerDecisionId = input.ownerDecisionId?.trim();
    if (!replacementIntentId && !ownerDecisionId) {
      throw new IntentFilesError(
        "invalid_retirement",
        "Retirement requires a replacement intent or an explicit owner decision.",
      );
    }
    const retiredAt = input.retiredAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(retiredAt))) {
      throw new IntentFilesError(
        "invalid_retirement",
        "Retirement timestamp must be a valid ISO-compatible date.",
      );
    }

    const graph = await this.load();
    const target = graph.nodes.find((node) => node.id === input.intentId);
    if (!target) {
      throw new IntentFilesError(
        "invalid_retirement",
        `Intent ${input.intentId} does not exist.`,
      );
    }
    if (target.status === "retired") {
      throw new IntentFilesError(
        "invalid_retirement",
        `Intent ${input.intentId} is already retired.`,
      );
    }
    if (replacementIntentId) {
      const replacement = graph.nodes.find(
        (node) => node.id === replacementIntentId,
      );
      if (!replacement || replacement.status !== "active" || replacement.id === target.id) {
        throw new IntentFilesError(
          "invalid_retirement",
          "A replacement must identify a different active intent.",
        );
      }
    }

    const retired: IntentNode = {
      ...target,
      status: "retired",
      retirement: {
        reason,
        retiredAt: new Date(retiredAt).toISOString(),
        ...(replacementIntentId ? { replacementIntentId } : {}),
        ...(ownerDecisionId
          ? { ownerDecisionId: cleanText(ownerDecisionId, "Owner decision ID") }
          : {}),
      },
    };
    const candidate: IntentGraph = {
      nodes: graph.nodes.map((node) => (node.id === retired.id ? retired : node)),
      links: graph.links,
    };
    const validation = validateIntentGraph(candidate, { requireCoverageFor: [] });
    const retirementIssue = validation.issues.find(
      (issue) =>
        issue.code === "invalid_retirement" && issue.intentId === retired.id,
    );
    if (retirementIssue) {
      throw new IntentFilesError(
        "invalid_retirement",
        retirementIssue.message,
      );
    }
    return this.save(candidate);
  }

  async check(
    options: CheckIntentFilesOptions = {},
  ): Promise<IntentFileCheckResult> {
    const { artifact, serializedGraph } = await this.#readArtifacts();
    const validation = validateIntentGraph(graphFromArtifact(artifact), options);
    return {
      ...validation,
      artifactDigest: digestArtifact(serializedGraph),
    };
  }

  async #readArtifacts(): Promise<{
    manifest: IntentFileManifest;
    artifact: IntentGraphArtifact;
    serializedGraph: string;
  }> {
    await assertSafeIntentDirectory(this.directory, {
      allowMissingTarget: false,
    });
    await assertRegularArtifact(this.manifestPath);
    await assertRegularArtifact(this.graphPath);
    const [manifestText, graphText] = await Promise.all([
      readFile(this.manifestPath, "utf8"),
      readFile(this.graphPath, "utf8"),
    ]);
    assertNoSerializedSecrets(manifestText, this.#secrets);
    assertNoSerializedSecrets(graphText, this.#secrets);
    try {
      const manifest = parseManifest(JSON.parse(manifestText));
      const artifact = parseGraphArtifact(JSON.parse(graphText), manifest);
      return { manifest, artifact, serializedGraph: graphText };
    } catch (error) {
      if (error instanceof IntentFilesError) throw error;
      throw new IntentFilesError(
        "invalid_artifact",
        "Living-intent artifacts contain invalid JSON.",
        { cause: error },
      );
    }
  }

  async #writeGraph(graph: IntentGraph, namespace: string): Promise<void> {
    const serialized = serializeArtifact(createGraphArtifact(graph, namespace));
    await this.#writeArtifact(this.graphPath, serialized);
  }

  async #writeArtifact(path: string, serialized: string): Promise<void> {
    assertNoSerializedSecrets(serialized, this.#secrets);
    await assertSafeIntentDirectory(this.directory, {
      allowMissingTarget: false,
    });
    if (await pathExists(path)) await assertRegularArtifact(path);

    const temporary = join(
      this.directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          noFollowFlag(),
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.chmod(0o644);
      await handle.close();
      handle = undefined;
      if (await pathExists(path)) await assertRegularArtifact(path);
      await rename(temporary, path);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
}
