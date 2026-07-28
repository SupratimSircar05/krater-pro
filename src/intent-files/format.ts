import { createHash } from "node:crypto";
import {
  createIntentLinkId,
  type IntentGraph,
  type IntentLink,
  type IntentNode,
} from "../intent/index.js";
import {
  INTENT_FILE_SCHEMA_VERSION,
  INTENT_GRAPH_FILE,
  type IntentFileManifest,
  type IntentGraphArtifact,
} from "./types.js";

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function normalizeNode(node: IntentNode): IntentNode {
  return {
    id: node.id,
    kind: node.kind,
    statement: node.statement,
    status: node.status,
    ...(node.owner ? { owner: node.owner } : {}),
    ...(node.retirement
      ? {
          retirement: {
            reason: node.retirement.reason,
            retiredAt: node.retirement.retiredAt,
            ...(node.retirement.replacementIntentId
              ? { replacementIntentId: node.retirement.replacementIntentId }
              : {}),
            ...(node.retirement.ownerDecisionId
              ? { ownerDecisionId: node.retirement.ownerDecisionId }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeLink(link: IntentLink): Required<IntentLink> {
  return {
    id: link.id?.trim() || createIntentLinkId(link),
    fromIntentId: link.fromIntentId,
    target: {
      kind: link.target.kind,
      id: link.target.id,
    },
    relation: link.relation,
    state: link.state ?? "current",
  };
}

export function createManifest(namespace: string): IntentFileManifest {
  return {
    schemaVersion: INTENT_FILE_SCHEMA_VERSION,
    format: "krater-living-intent",
    graphFile: INTENT_GRAPH_FILE,
    namespace,
  };
}

export function createGraphArtifact(
  graph: IntentGraph,
  namespace: string,
): IntentGraphArtifact {
  return {
    schemaVersion: INTENT_FILE_SCHEMA_VERSION,
    namespace,
    nodes: graph.nodes
      .map(normalizeNode)
      .sort((left, right) => compareText(left.id, right.id)),
    links: graph.links
      .map(normalizeLink)
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

export function serializeArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function digestArtifact(serialized: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function graphFromArtifact(artifact: IntentGraphArtifact): IntentGraph {
  return {
    nodes: artifact.nodes.map(normalizeNode),
    links: artifact.links.map(normalizeLink),
  };
}
