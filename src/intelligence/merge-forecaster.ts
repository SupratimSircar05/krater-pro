import type {
  IntentTouch,
  InvariantTouch,
  MigrationTouch,
  SchemaTouch,
  SemanticConflict,
  SemanticMergeForecast,
  SemanticPatch,
  SymbolTouch,
} from "./types.js";

interface OwnedTouch<T> {
  patchId: string;
  touch: T;
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function conflictId(
  category: SemanticConflict["category"],
  target: string,
  patchIds: readonly string[],
  reason: string,
): string {
  const normalized = `${category}:${target}:${canonicalIds(patchIds).join("+")}:${reason}`;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `merge:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function makeConflict(
  conflict: Omit<SemanticConflict, "id" | "patchIds"> & {
    patchIds: readonly string[];
  },
): SemanticConflict {
  const patchIds = canonicalIds(conflict.patchIds);
  return {
    ...conflict,
    id: conflictId(
      conflict.category,
      conflict.target,
      patchIds,
      conflict.reason,
    ),
    patchIds,
  };
}

function addConflict(
  conflicts: Map<string, SemanticConflict>,
  conflict: Omit<SemanticConflict, "id" | "patchIds"> & {
    patchIds: readonly string[];
  },
): void {
  const complete = makeConflict(conflict);
  conflicts.set(complete.id, complete);
}

function groupTouches<T extends { id: string }>(
  patches: readonly SemanticPatch[],
  select: (patch: SemanticPatch) => readonly T[] | undefined,
): Map<string, OwnedTouch<T>[]> {
  const grouped = new Map<string, OwnedTouch<T>[]>();
  for (const patch of patches) {
    for (const touch of select(patch) ?? []) {
      const id = touch.id.trim();
      if (id.length === 0) continue;
      const existing = grouped.get(id) ?? [];
      existing.push({ patchId: patch.id, touch });
      grouped.set(id, existing);
    }
  }
  return grouped;
}

function eachCrossPatchPair<T>(
  touches: readonly OwnedTouch<T>[],
  visit: (left: OwnedTouch<T>, right: OwnedTouch<T>) => void,
): void {
  for (let left = 0; left < touches.length; left += 1) {
    for (let right = left + 1; right < touches.length; right += 1) {
      if (touches[left].patchId === touches[right].patchId) continue;
      visit(touches[left], touches[right]);
    }
  }
}

function detectIntentConflicts(
  patches: readonly SemanticPatch[],
  conflicts: Map<string, SemanticConflict>,
): void {
  for (const [intentId, touches] of groupTouches<IntentTouch>(
    patches,
    (patch) => patch.intents,
  )) {
    eachCrossPatchPair(touches, (left, right) => {
      const effects = new Set([left.touch.effect, right.touch.effect]);
      const activeVsContradicted =
        effects.has("contradicts") &&
        [...effects].some((effect) => effect !== "contradicts");
      const retiredVsActive =
        effects.has("retires") &&
        [...effects].some((effect) => effect !== "retires");
      const divergentFingerprints =
        left.touch.fingerprint !== undefined &&
        right.touch.fingerprint !== undefined &&
        left.touch.fingerprint !== right.touch.fingerprint;
      if (!activeVsContradicted && !retiredVsActive && !divergentFingerprints) {
        return;
      }
      addConflict(conflicts, {
        category: "intent",
        severity: "blocking",
        patchIds: [left.patchId, right.patchId],
        target: intentId,
        reason: activeVsContradicted
          ? "One patch contradicts intent another patch fulfills or modifies."
          : retiredVsActive
            ? "One patch retires intent another patch still treats as active."
            : "Patches encode divergent outcomes for the same intent.",
        recommendation: "human_decision",
      });
    });
  }
}

function detectSymbolConflicts(
  patches: readonly SemanticPatch[],
  conflicts: Map<string, SemanticConflict>,
): void {
  for (const [symbolId, touches] of groupTouches<SymbolTouch>(
    patches,
    (patch) => patch.symbols,
  )) {
    eachCrossPatchPair(touches, (left, right) => {
      const operations = new Set([
        left.touch.operation,
        right.touch.operation,
      ]);
      if (operations.size === 1 && operations.has("read")) return;

      if (operations.has("delete")) {
        addConflict(conflicts, {
          category: "symbol",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: symbolId,
          reason: "A deleted symbol is concurrently read or changed.",
          recommendation: "serialize",
        });
        return;
      }

      const bothMutate =
        left.touch.operation !== "read" && right.touch.operation !== "read";
      const divergentContracts =
        left.touch.contractDigest !== right.touch.contractDigest ||
        left.touch.contractDigest === undefined;
      if (bothMutate && divergentContracts) {
        addConflict(conflicts, {
          category: "symbol",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: symbolId,
          reason: "Concurrent symbol mutations do not share a proven contract.",
          recommendation: "serialize",
        });
        return;
      }

      const read = left.touch.operation === "read" ? left.touch : right.touch;
      const write = left.touch.operation === "read" ? right.touch : left.touch;
      if (
        read.contractDigest !== undefined &&
        write.contractDigest !== undefined &&
        read.contractDigest !== write.contractDigest
      ) {
        addConflict(conflicts, {
          category: "symbol",
          severity: "warning",
          patchIds: [left.patchId, right.patchId],
          target: symbolId,
          reason: "A reader assumes a different symbol contract than the writer.",
          recommendation: "serialize",
        });
      }
    });
  }
}

function detectSchemaConflicts(
  patches: readonly SemanticPatch[],
  conflicts: Map<string, SemanticConflict>,
): void {
  for (const [schemaId, touches] of groupTouches<SchemaTouch>(
    patches,
    (patch) => patch.schemas,
  )) {
    eachCrossPatchPair(touches, (left, right) => {
      const operations = new Set([
        left.touch.operation,
        right.touch.operation,
      ]);
      if (operations.size === 1 && operations.has("read")) return;
      if (operations.has("drop")) {
        addConflict(conflicts, {
          category: "schema",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: schemaId,
          reason: "A dropped schema is concurrently read, added, or altered.",
          recommendation: "serialize",
        });
        return;
      }

      const bothMutate =
        left.touch.operation !== "read" && right.touch.operation !== "read";
      const shapesDiffer =
        left.touch.shapeDigest !== right.touch.shapeDigest ||
        left.touch.shapeDigest === undefined;
      if (bothMutate && shapesDiffer) {
        addConflict(conflicts, {
          category: "schema",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: schemaId,
          reason: "Concurrent schema mutations produce different or unknown shapes.",
          recommendation: "serialize",
        });
        return;
      }

      const read = left.touch.operation === "read" ? left.touch : right.touch;
      const mutation =
        left.touch.operation === "read" ? right.touch : left.touch;
      if (
        read.shapeDigest !== undefined &&
        mutation.shapeDigest !== undefined &&
        read.shapeDigest !== mutation.shapeDigest
      ) {
        addConflict(conflicts, {
          category: "schema",
          severity: "warning",
          patchIds: [left.patchId, right.patchId],
          target: schemaId,
          reason: "A reader was designed against a different schema shape.",
          recommendation: "serialize",
        });
      }
    });
  }
}

function detectInvariantConflicts(
  patches: readonly SemanticPatch[],
  conflicts: Map<string, SemanticConflict>,
): void {
  for (const [invariantId, touches] of groupTouches<InvariantTouch>(
    patches,
    (patch) => patch.invariants,
  )) {
    for (const owned of touches) {
      if (owned.touch.effect !== "violates") continue;
      addConflict(conflicts, {
        category: "invariant",
        severity: "blocking",
        patchIds: [owned.patchId],
        target: invariantId,
        reason: "The patch declares that it violates an active invariant.",
        recommendation: "human_decision",
      });
    }
    eachCrossPatchPair(touches, (left, right) => {
      const effects = new Set([left.touch.effect, right.touch.effect]);
      const weakensAgainstProtection =
        effects.has("weakens") &&
        (effects.has("preserves") || effects.has("strengthens"));
      const divergentFingerprints =
        left.touch.fingerprint !== undefined &&
        right.touch.fingerprint !== undefined &&
        left.touch.fingerprint !== right.touch.fingerprint;
      if (!weakensAgainstProtection && !divergentFingerprints) return;
      addConflict(conflicts, {
        category: "invariant",
        severity: "blocking",
        patchIds: [left.patchId, right.patchId],
        target: invariantId,
        reason: weakensAgainstProtection
          ? "One patch weakens an invariant another patch preserves or strengthens."
          : "Patches encode incompatible forms of the same invariant.",
        recommendation: "human_decision",
      });
    });
  }
}

interface Dag {
  outgoing: Map<string, Set<string>>;
  indegree: Map<string, number>;
}

function addEdge(dag: Dag, from: string, to: string): void {
  if (from === to) return;
  const outgoing = dag.outgoing.get(from);
  if (outgoing === undefined || outgoing.has(to)) return;
  outgoing.add(to);
  dag.indegree.set(to, (dag.indegree.get(to) ?? 0) + 1);
}

function migrationFingerprint(touch: MigrationTouch): string {
  return [
    touch.resource,
    touch.order,
    touch.fromVersion ?? "",
    touch.toVersion ?? "",
    touch.effectDigest ?? "",
  ].join("|");
}

function detectMigrations(
  patches: readonly SemanticPatch[],
  dag: Dag,
  conflicts: Map<string, SemanticConflict>,
): void {
  const migrations = new Map<string, OwnedTouch<MigrationTouch>[]>();
  const byResource = new Map<string, OwnedTouch<MigrationTouch>[]>();
  for (const patch of patches) {
    for (const touch of patch.migrations ?? []) {
      const byId = migrations.get(touch.id) ?? [];
      byId.push({ patchId: patch.id, touch });
      migrations.set(touch.id, byId);
      const resourceTouches = byResource.get(touch.resource) ?? [];
      resourceTouches.push({ patchId: patch.id, touch });
      byResource.set(touch.resource, resourceTouches);
    }
  }

  for (const [migrationId, owners] of migrations) {
    eachCrossPatchPair(owners, (left, right) => {
      if (migrationFingerprint(left.touch) === migrationFingerprint(right.touch)) {
        return;
      }
      addConflict(conflicts, {
        category: "migration",
        severity: "blocking",
        patchIds: [left.patchId, right.patchId],
        target: migrationId,
        reason: "The same migration ID has divergent definitions.",
        recommendation: "human_decision",
      });
    });
  }

  for (const owners of migrations.values()) {
    for (const owner of owners) {
      for (const dependencyId of owner.touch.dependsOn ?? []) {
        const dependencies = migrations.get(dependencyId);
        if (dependencies === undefined) {
          addConflict(conflicts, {
            category: "missing_dependency",
            severity: "blocking",
            patchIds: [owner.patchId],
            target: dependencyId,
            reason: `Migration ${owner.touch.id} depends on a missing migration.`,
            recommendation: "add_dependency",
          });
          continue;
        }
        for (const dependency of dependencies) {
          addEdge(dag, dependency.patchId, owner.patchId);
          if (dependency.touch.order >= owner.touch.order) {
            addConflict(conflicts, {
              category: "migration",
              severity: "blocking",
              patchIds: [dependency.patchId, owner.patchId],
              target: owner.touch.resource,
              reason: "Migration dependency order is not strictly increasing.",
              recommendation: "reorder",
            });
          }
        }
      }
    }
  }

  for (const [resource, touches] of byResource) {
    eachCrossPatchPair(touches, (left, right) => {
      if (
        left.touch.order === right.touch.order &&
        migrationFingerprint(left.touch) !== migrationFingerprint(right.touch)
      ) {
        addConflict(conflicts, {
          category: "migration",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: resource,
          reason: "Different migrations claim the same resource order.",
          recommendation: "reorder",
        });
      }
      if (
        left.touch.fromVersion !== undefined &&
        left.touch.fromVersion === right.touch.fromVersion &&
        left.touch.toVersion !== right.touch.toVersion
      ) {
        addConflict(conflicts, {
          category: "migration",
          severity: "blocking",
          patchIds: [left.patchId, right.patchId],
          target: resource,
          reason: "Migrations fork the same starting schema version.",
          recommendation: "human_decision",
        });
      }
    });
  }
}

function buildDag(
  patches: readonly SemanticPatch[],
  conflicts: Map<string, SemanticConflict>,
): Dag {
  const patchIds = new Set(patches.map((patch) => patch.id));
  const dag: Dag = {
    outgoing: new Map(
      [...patchIds].map((patchId) => [patchId, new Set<string>()]),
    ),
    indegree: new Map([...patchIds].map((patchId) => [patchId, 0])),
  };
  for (const patch of patches) {
    for (const dependency of canonicalIds(patch.dependencies ?? [])) {
      if (!patchIds.has(dependency)) {
        addConflict(conflicts, {
          category: "missing_dependency",
          severity: "blocking",
          patchIds: [patch.id],
          target: dependency,
          reason: `Patch ${patch.id} depends on a missing patch.`,
          recommendation: "add_dependency",
        });
        continue;
      }
      addEdge(dag, dependency, patch.id);
    }
  }
  return dag;
}

function topologicalOrder(
  dag: Dag,
  conflicts: Map<string, SemanticConflict>,
): string[] {
  const indegree = new Map(dag.indegree);
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    ordered.push(current);
    for (const next of [...(dag.outgoing.get(current) ?? [])].sort()) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  const cyclic = [...indegree.entries()]
    .filter(([, count]) => count > 0)
    .map(([id]) => id)
    .sort();
  if (cyclic.length > 0) {
    addConflict(conflicts, {
      category: "dependency_cycle",
      severity: "blocking",
      patchIds: cyclic,
      target: "patch-dependency-dag",
      reason: "The combined patch dependency graph contains a cycle.",
      recommendation: "reorder",
    });
  }
  return ordered;
}

export function forecastSemanticMerge(
  patches: readonly SemanticPatch[],
): SemanticMergeForecast {
  const conflicts = new Map<string, SemanticConflict>();
  const seenPatchIds = new Set<string>();
  for (const patch of patches) {
    const id = patch.id.trim();
    if (id.length === 0) {
      addConflict(conflicts, {
        category: "duplicate_patch",
        severity: "blocking",
        patchIds: [patch.id],
        target: "<empty>",
        reason: "Patch IDs must be non-empty.",
        recommendation: "human_decision",
      });
    } else if (seenPatchIds.has(id)) {
      addConflict(conflicts, {
        category: "duplicate_patch",
        severity: "blocking",
        patchIds: [id],
        target: id,
        reason: "Patch IDs must be unique.",
        recommendation: "human_decision",
      });
    }
    seenPatchIds.add(id);
  }

  const uniquePatches = patches.filter(
    (patch, index) =>
      patch.id.trim().length > 0 &&
      patches.findIndex((candidate) => candidate.id === patch.id) === index,
  );
  const dag = buildDag(uniquePatches, conflicts);
  detectMigrations(uniquePatches, dag, conflicts);
  detectIntentConflicts(uniquePatches, conflicts);
  detectSymbolConflicts(uniquePatches, conflicts);
  detectSchemaConflicts(uniquePatches, conflicts);
  detectInvariantConflicts(uniquePatches, conflicts);
  const orderedPatchIds = topologicalOrder(dag, conflicts);

  const sortedConflicts = [...conflicts.values()].sort(
    (left, right) =>
      (left.severity === right.severity
        ? 0
        : left.severity === "blocking"
          ? -1
          : 1) ||
      left.category.localeCompare(right.category) ||
      left.target.localeCompare(right.target) ||
      left.id.localeCompare(right.id),
  );
  const blockingConflictCount = sortedConflicts.filter(
    (conflict) => conflict.severity === "blocking",
  ).length;
  const warningCount = sortedConflicts.length - blockingConflictCount;

  return {
    safeToCombine: blockingConflictCount === 0,
    orderedPatchIds,
    conflicts: sortedConflicts,
    blockingConflictCount,
    warningCount,
    riskScore: Math.min(1, blockingConflictCount * 0.25 + warningCount * 0.05),
  };
}
