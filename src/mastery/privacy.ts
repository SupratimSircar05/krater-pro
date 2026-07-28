import type {
  MasteryExportBundle,
  MasteryExportScope,
  MasteryGraph,
  MasteryPrivacyDefaults,
} from "./types.js";

export const MASTERY_PRIVACY_DEFAULTS: MasteryPrivacyDefaults = Object.freeze({
  storage: "local_only",
  owner: "user",
  defaultVisibility: "private",
  rawSourceRetention: false,
  rawResponseRetention: false,
  hiddenTelemetry: false,
  managerialScoring: false,
  employerReporting: false,
  collaboratorSharing: false,
  sharingRequiresExplicitExport: true,
});

function clonedPrivacyDefaults(): MasteryPrivacyDefaults {
  return { ...MASTERY_PRIVACY_DEFAULTS };
}

/**
 * Creates an explicit, user-directed export. Export nodes cannot contain raw
 * source, task requests, free-form reflection answers, productivity scores, or
 * team/employer fields because none exist in the durable graph schema.
 */
export function exportMasteryGraph(
  graph: MasteryGraph,
  options: {
    scope?: MasteryExportScope;
    exportedAt?: string;
  } = {},
): MasteryExportBundle {
  const scope = options.scope ?? "summary";
  return {
    format: "krater-mastery-v1",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    scope,
    userDirectedExport: true,
    privacy: clonedPrivacyDefaults(),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      ...(node.domain ? { domain: node.domain } : {}),
      stage: node.stage,
      signalCount: node.signals.length,
      ...(scope === "signals"
        ? {
            signals: node.signals.map((signal) => ({ ...signal })),
          }
        : {}),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    })),
  };
}

export function serializeMasteryExport(bundle: MasteryExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
