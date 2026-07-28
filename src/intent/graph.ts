import { createIntentLinkId } from "./stable-id.js";
import type {
  IntentGraph,
  IntentGraphIssue,
  IntentGraphValidation,
  IntentKind,
  IntentLink,
  IntentNode,
  IntentTargetKind,
} from "./types.js";

export interface ValidateIntentGraphOptions {
  requireCoverageFor?: readonly IntentKind[];
  knownTargets?: Partial<
    Record<Exclude<IntentTargetKind, "intent">, ReadonlySet<string> | readonly string[]>
  >;
}

function addIssue(
  issues: IntentGraphIssue[],
  issue: IntentGraphIssue,
): void {
  issues.push(issue);
}

function linkId(link: IntentLink): string {
  try {
    return link.id?.trim() || createIntentLinkId(link);
  } catch {
    return link.id?.trim() || "link:invalid";
  }
}

function targetExists(
  link: IntentLink,
  nodeIds: ReadonlySet<string>,
  knownTargets: ValidateIntentGraphOptions["knownTargets"],
): boolean {
  const targetId = link.target.id.trim();
  if (!targetId) return false;
  if (link.target.kind === "intent") return nodeIds.has(targetId);
  const configured = knownTargets?.[link.target.kind];
  if (!configured) return true;
  return Array.isArray(configured)
    ? configured.includes(targetId)
    : (configured as ReadonlySet<string>).has(targetId);
}

function validateRetirement(
  node: IntentNode,
  nodesById: ReadonlyMap<string, IntentNode>,
  issues: IntentGraphIssue[],
): void {
  if (node.status === "active") {
    if (node.retirement) {
      addIssue(issues, {
        code: "invalid_retirement",
        severity: "error",
        intentId: node.id,
        message: `Active intent ${node.id} cannot contain retirement metadata.`,
      });
    }
    return;
  }

  const retirement = node.retirement;
  const reason = retirement?.reason.trim();
  const retiredAt = retirement?.retiredAt.trim();
  const hasAuthority = Boolean(
    retirement?.replacementIntentId?.trim() || retirement?.ownerDecisionId?.trim(),
  );
  const timestampValid = Boolean(
    retiredAt && Number.isFinite(Date.parse(retiredAt)),
  );
  const replacementValid =
    !retirement?.replacementIntentId ||
    (retirement.replacementIntentId !== node.id &&
      nodesById.get(retirement.replacementIntentId)?.status === "active");

  if (!reason || !timestampValid || !hasAuthority || !replacementValid) {
    addIssue(issues, {
      code: "invalid_retirement",
      severity: "error",
      intentId: node.id,
      message:
        `Retired intent ${node.id} requires a reason, valid timestamp, and either ` +
        "an existing replacement intent or an owner decision.",
    });
  }
}

export function validateIntentGraph(
  graph: IntentGraph,
  options: ValidateIntentGraphOptions = {},
): IntentGraphValidation {
  const issues: IntentGraphIssue[] = [];
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, IntentNode>();
  const duplicateNodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) duplicateNodeIds.add(node.id);
    nodeIds.add(node.id);
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }
  for (const id of duplicateNodeIds) {
    addIssue(issues, {
      code: "duplicate_intent_id",
      severity: "error",
      intentId: id,
      message: `Intent ID ${id} appears more than once.`,
    });
  }

  for (const node of graph.nodes) validateRetirement(node, nodesById, issues);

  const seenLinkIds = new Set<string>();
  const fulfilled = new Set<string>();
  const contradicted = new Set<string>();
  const stale = new Set<string>();
  const currentCoverage = new Set<string>();

  for (const link of graph.links) {
    const id = linkId(link);
    if (seenLinkIds.has(id)) {
      addIssue(issues, {
        code: "duplicate_link_id",
        severity: "error",
        linkId: id,
        message: `Intent link ID ${id} appears more than once.`,
      });
    }
    seenLinkIds.add(id);

    const sourceExists = nodeIds.has(link.fromIntentId);
    const validTarget = targetExists(link, nodeIds, options.knownTargets);
    if (!sourceExists) {
      addIssue(issues, {
        code: "missing_source_intent",
        severity: "error",
        linkId: id,
        intentId: link.fromIntentId,
        message: `Intent link ${id} refers to missing source ${link.fromIntentId}.`,
      });
    }
    if (!validTarget) {
      addIssue(issues, {
        code: "missing_target",
        severity: "error",
        linkId: id,
        intentId: link.fromIntentId,
        message: `Intent link ${id} refers to missing ${link.target.kind} target ${link.target.id}.`,
      });
    }

    if (link.state === "stale") {
      if (sourceExists) stale.add(link.fromIntentId);
      addIssue(issues, {
        code: "stale_link",
        severity: "warning",
        linkId: id,
        intentId: link.fromIntentId,
        message: `Intent link ${id} is stale and cannot establish current coverage.`,
      });
      continue;
    }

    if (link.relation === "contradicts") {
      if (sourceExists && validTarget) contradicted.add(link.fromIntentId);
      addIssue(issues, {
        code: "contradiction",
        severity: "error",
        linkId: id,
        intentId: link.fromIntentId,
        message: `Current evidence or intent ${link.target.id} contradicts ${link.fromIntentId}.`,
      });
      continue;
    }

    if (
      sourceExists &&
      validTarget &&
      nodesById.get(link.fromIntentId)?.status === "active" &&
      (link.relation === "fulfills" || link.relation === "covers")
    ) {
      fulfilled.add(link.fromIntentId);
      currentCoverage.add(link.fromIntentId);
    }
  }

  const requiredKinds = new Set(
    options.requireCoverageFor ?? (["requirement", "invariant"] as const),
  );
  const uncovered = new Set<string>();
  for (const node of graph.nodes) {
    if (
      node.status === "active" &&
      requiredKinds.has(node.kind) &&
      !currentCoverage.has(node.id)
    ) {
      uncovered.add(node.id);
      addIssue(issues, {
        code: "missing_link",
        severity: "error",
        intentId: node.id,
        message: `Active ${node.kind} ${node.id} has no current fulfilling or covering link.`,
      });
    }
    if (
      node.status === "active" &&
      node.kind === "retirement" &&
      !graph.links.some(
        (link) =>
          link.fromIntentId === node.id &&
          link.state !== "stale" &&
          link.relation === "retires" &&
          targetExists(link, nodeIds, options.knownTargets),
      )
    ) {
      uncovered.add(node.id);
      addIssue(issues, {
        code: "missing_link",
        severity: "error",
        intentId: node.id,
        message: `Retirement intent ${node.id} has no current retires link.`,
      });
    }
  }

  const retired = graph.nodes
    .filter((node) => node.status === "retired")
    .map((node) => node.id)
    .sort();
  const sortSet = (set: ReadonlySet<string>): string[] => [...set].sort();

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    fulfilledIntentIds: sortSet(fulfilled),
    contradictedIntentIds: sortSet(contradicted),
    uncoveredIntentIds: sortSet(uncovered),
    staleIntentIds: sortSet(stale),
    retiredIntentIds: retired,
  };
}
