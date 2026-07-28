import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  rankAmbiguities,
  type AmbiguityCandidate,
  type RankedAmbiguity,
} from "./intent/index.js";

export type AmbiguityAssumeMode = "ask" | "best";
export const CLARIFICATION_REQUIRED_EXIT_CODE = 3;

export interface RepositoryFact {
  id: string;
  kind: "workspace" | "manifest" | "path";
  statement: string;
  path?: string;
}

export interface PreflightAssumption {
  id: string;
  statement: string;
  source: "repository" | "agent" | "user";
  resolved: boolean;
}

export interface PreflightInterpretation {
  id: string;
  description: string;
  selected: boolean;
}

export interface AmbiguityPreflightResult {
  request: string;
  mode: AmbiguityAssumeMode;
  status: "ready" | "clarification_required";
  facts: RepositoryFact[];
  assumptions: PreflightAssumption[];
  interpretations: PreflightInterpretation[];
  candidates: RankedAmbiguity[];
  clarification?: RankedAmbiguity;
}

export interface AmbiguityPreflightOptions {
  cwd: string;
  request: string;
  mode?: AmbiguityAssumeMode;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 2_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".krater",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizeChoice(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`]|["'`]$/g, "")
    .toLowerCase();
}

function safeRelativePath(root: string, candidate: string): string | undefined {
  const cleaned = candidate
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[),.;:!?]+$/g, "");
  if (
    !cleaned ||
    cleaned.length > 240 ||
    cleaned.includes("://") ||
    cleaned.startsWith("/") ||
    cleaned.startsWith("~")
  ) {
    return undefined;
  }
  const absolute = resolve(root, cleaned);
  const fromRoot = relative(root, absolute);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.includes("\0")
  ) {
    return undefined;
  }
  return fromRoot.split(sep).join("/");
}

function referencedPathTokens(request: string, root: string): string[] {
  const values = new Set<string>();
  const patterns = [
    /`([^`\r\n]+)`/g,
    /"([^"\r\n]+)"/g,
    /'([^'\r\n]+)'/g,
    /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@()+-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of request.matchAll(pattern)) {
      const path = safeRelativePath(root, match[1] ?? "");
      if (path) values.add(path);
    }
  }
  return [...values].slice(0, 24);
}

function explicitAlternativeCandidates(request: string): AmbiguityCandidate[] {
  const candidates: AmbiguityCandidate[] = [];
  const pattern =
    /\beither\s+([^,.;?!\r\n]{1,80}?)\s+or\s+([^,.;?!\r\n]{1,80})(?=$|[,.;?!\r\n])/gi;
  for (const match of request.matchAll(pattern)) {
    const left = match[1]?.trim();
    const right = match[2]?.trim();
    if (!left || !right) continue;
    const fingerprints = [normalizeChoice(left), normalizeChoice(right)];
    candidates.push({
      id: stableId("ambiguity", `${left}\0${right}`),
      question: `Which requested alternative should Krater implement: “${left}” or “${right}”?`,
      interpretations: [left, right],
      implementationFingerprints: fingerprints,
      impact: 0.75,
      risk: 0.7,
      irreversibility: 0.55,
      questionCost: 0.2,
    });
  }
  return candidates;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface RepositoryDiscovery {
  facts: RepositoryFact[];
  assumptions: PreflightAssumption[];
  candidates: AmbiguityCandidate[];
}

async function discoverRepository(
  root: string,
  request: string,
  maxEntries: number,
): Promise<RepositoryDiscovery> {
  const facts: RepositoryFact[] = [
    {
      id: stableId("fact", `workspace:${root}`),
      kind: "workspace",
      statement: "The selected local workspace exists.",
    },
  ];
  const assumptions: PreflightAssumption[] = [];
  const candidates: AmbiguityCandidate[] = [];
  const topLevel = await readdir(root, { withFileTypes: true });
  for (const entry of topLevel.slice(0, 256)) {
    if (entry.isFile() && MANIFESTS.has(entry.name)) {
      facts.push({
        id: stableId("fact", `manifest:${entry.name}`),
        kind: "manifest",
        statement: `Repository manifest ${entry.name} exists.`,
        path: entry.name,
      });
    }
  }

  const tokens = referencedPathTokens(request, root);
  if (!tokens.length) return { facts, assumptions, candidates };

  const bareNames = new Set(
    tokens.filter((token) => !token.includes("/")).map((token) => basename(token)),
  );
  const matches = new Map<string, Array<{ path: string; physicalPath: string }>>();
  for (const name of bareNames) matches.set(name, []);

  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    if (visited >= maxEntries) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited += 1;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute);
        continue;
      }
      if (!bareNames.has(entry.name)) continue;
      const path = relative(root, absolute).split(sep).join("/");
      let physicalPath = absolute;
      try {
        physicalPath = await realpath(absolute);
      } catch {
        // A broken link is still a distinct repository target.
      }
      matches.get(entry.name)!.push({ path, physicalPath });
    }
  };
  if (bareNames.size) await walk(root);

  for (const token of tokens) {
    if (token.includes("/")) {
      if (await pathExists(resolve(root, token))) {
        facts.push({
          id: stableId("fact", `path:${token}`),
          kind: "path",
          statement: `Referenced repository path ${token} exists.`,
          path: token,
        });
      }
      continue;
    }
    const namedMatches = matches.get(basename(token)) ?? [];
    const uniquePaths = [...new Set(namedMatches.map((match) => match.path))].sort();
    if (uniquePaths.length === 1) {
      const selected = uniquePaths[0]!;
      facts.push({
        id: stableId("fact", `path:${selected}`),
        kind: "path",
        statement: `The referenced file ${token} resolves uniquely to ${selected}.`,
        path: selected,
      });
      assumptions.push({
        id: stableId("assumption", `${token}:${selected}`),
        statement: `“${token}” refers to repository path “${selected}”.`,
        source: "repository",
        resolved: true,
      });
      continue;
    }
    if (uniquePaths.length > 1) {
      const physicalByPath = new Map(
        namedMatches.map((match) => [match.path, match.physicalPath]),
      );
      candidates.push({
        id: stableId("ambiguity", `path:${token}:${uniquePaths.join("\0")}`),
        question: `Which repository file named “${token}” should this task target?`,
        interpretations: uniquePaths,
        implementationFingerprints: uniquePaths.map(
          (path) => physicalByPath.get(path) ?? path,
        ),
        impact: 0.95,
        risk: 0.9,
        irreversibility: 0.7,
        questionCost: 0.15,
      });
    }
  }
  return { facts, assumptions, candidates };
}

function interpretationsFor(
  request: string,
  candidates: readonly RankedAmbiguity[],
  selected?: { candidateId: string; description: string },
): PreflightInterpretation[] {
  if (!candidates.length) {
    return [
      {
        id: stableId("interpretation", request),
        description: request,
        selected: true,
      },
    ];
  }
  return candidates.flatMap((candidate) => {
    const descriptions = [...candidate.interpretations];
    if (
      selected?.candidateId === candidate.id &&
      !descriptions.includes(selected.description)
    ) {
      descriptions.push(selected.description);
    }
    return descriptions.map((description) => ({
      id: stableId("interpretation", `${candidate.id}:${description}`),
      description: `${candidate.question} ${description}`,
      selected:
        selected?.candidateId === candidate.id &&
        selected.description === description,
    }));
  });
}

export async function runAmbiguityPreflight(
  options: AmbiguityPreflightOptions,
): Promise<AmbiguityPreflightResult> {
  const request = options.request.trim();
  if (!request) throw new Error("Ambiguity preflight request must not be empty.");
  const mode = options.mode ?? "ask";
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000) {
    throw new Error("Ambiguity preflight maxEntries must be between 1 and 20,000.");
  }
  const root = await realpath(resolve(options.cwd));
  const discovery = await discoverRepository(root, request, maxEntries);
  const candidates = rankAmbiguities([
    ...discovery.candidates,
    ...explicitAlternativeCandidates(request),
  ]);
  const clarification = candidates[0];
  if (!clarification) {
    return {
      request,
      mode,
      status: "ready",
      facts: discovery.facts,
      assumptions: discovery.assumptions,
      interpretations: interpretationsFor(request, candidates),
      candidates,
    };
  }
  if (mode === "best") {
    const selected = clarification.interpretations[0]!;
    return {
      request,
      mode,
      status: "ready",
      facts: discovery.facts,
      assumptions: [
        ...discovery.assumptions,
        {
          id: stableId("assumption", `${clarification.id}:${selected}`),
          statement: `Krater selected “${selected}” for “${clarification.question}” under --assume=best.`,
          source: "agent",
          resolved: false,
        },
      ],
      interpretations: interpretationsFor(request, candidates, {
        candidateId: clarification.id,
        description: selected,
      }),
      candidates,
    };
  }
  return {
    request,
    mode,
    status: "clarification_required",
    facts: discovery.facts,
    assumptions: discovery.assumptions,
    interpretations: interpretationsFor(request, candidates),
    candidates,
    clarification,
  };
}

export function resolveAmbiguityPreflight(
  result: AmbiguityPreflightResult,
  answer: string,
): AmbiguityPreflightResult {
  if (result.status !== "clarification_required" || !result.clarification) {
    return result;
  }
  const normalized = answer.trim();
  if (!normalized) throw new Error("A clarification answer must not be empty.");
  const numeric = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
  const selected =
    result.clarification.interpretations[numeric] ??
    result.clarification.interpretations.find(
      (interpretation) =>
        normalizeChoice(interpretation) === normalizeChoice(normalized),
    ) ??
    normalized;
  return {
    ...result,
    status: "ready",
    assumptions: [
      ...result.assumptions,
      {
        id: stableId(
          "assumption",
          `${result.clarification.id}:user:${selected}`,
        ),
        statement: `The user selected “${selected}” for “${result.clarification.question}”.`,
        source: "user",
        resolved: true,
      },
    ],
    interpretations: interpretationsFor(result.request, result.candidates, {
      candidateId: result.clarification.id,
      description: selected,
    }),
    clarification: undefined,
  };
}

export function promptWithAmbiguityContext(
  result: AmbiguityPreflightResult,
): string {
  if (result.status !== "ready" || !result.assumptions.length) {
    return result.request;
  }
  const context = result.assumptions
    .map(
      (assumption) =>
        `- ${assumption.statement}${assumption.resolved ? "" : " (best-judgment assumption; verify during discovery)"}`,
    )
    .join("\n");
  return `${result.request}\n\nKrater preflight context:\n${context}`;
}
