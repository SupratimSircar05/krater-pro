#!/usr/bin/env node

import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Command } from "commander";
import { AgentSession } from "./agent.js";
import {
  CLARIFICATION_REQUIRED_EXIT_CODE,
  promptWithAmbiguityContext,
  resolveAmbiguityPreflight,
  runAmbiguityPreflight,
  type AmbiguityPreflightResult,
} from "./ambiguity-preflight.js";
import {
  calibrateReliabilityCandidate,
  replayRecordedCausalTwin,
  replayReliabilityEvaluation,
} from "./advanced-adapters.js";
import {
  KRATER_DEVELOPER_URL,
  browserAuthCapabilities,
  openKraterDeveloperPage,
} from "./browser-auth.js";
import {
  type KraterConfig,
  loadConfig,
  requireApiKey,
  type ConfigOverrides,
  type ResponseStyle,
} from "./config.js";
import {
  EvidenceTask,
  cancelEvidenceTask,
  evidencePublicationReadiness,
  finalizeEvidencePublication,
  listEvidenceTasks,
  openEvidenceStore,
  readEvidenceTask,
  recordEvidenceRollback,
  renderPassportMarkdown,
} from "./evidence-runtime.js";
import { IntentFileStore } from "./intent-files/index.js";
import {
  ROUTER_FALLBACK_MODEL,
  isAutomaticModel,
  selectCodingModel,
} from "./model-selection.js";
import { KraterProvider } from "./provider.js";
import {
  verifyChangePassport,
  verifyEvidenceCapsule,
  type TaskProjection,
} from "./proofgraph/index.js";
import {
  StagedTaskWorkspace,
  discardStagedProofPatch,
  loadProofPatchBinding,
  publishBoundProofPatch,
  rollbackBoundProofPatch,
  type PreparedProofPatch,
} from "./staging-workspace.js";
import { startServer } from "./server.js";
import { formatUsageEvent, sanitizeTerminalText } from "./telemetry.js";
import type { AgentEvent, ApprovalRequest } from "./types.js";
import {
  explainPolicyDecision,
  labelContext,
  simulatePolicy,
  type ContextDestination,
  type ContextSensitivity,
  type ContextSource,
  type ContextTrust,
} from "./trust/index.js";
import { VerifiedWorkCache } from "./verified-cache/index.js";

const VERSION = "0.1.0";
const CREATOR_CREDIT = "Built by Supratim with ❤️";
const CREATOR_PROFILE = "https://www.linkedin.com/in/supratimsircar/";
const orange = "\u001b[38;2;255;113;67m";
const cyan = "\u001b[38;2;91;205;255m";
const dim = "\u001b[2m";
const green = "\u001b[32m";
const red = "\u001b[31m";
const reset = "\u001b[0m";
const MAX_LOCAL_ARTIFACT_BYTES = 7 * 1024 * 1024;

interface GlobalOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
  yes?: boolean;
  contextChars?: number;
  toolOutputChars?: number;
  responseStyle?: ResponseStyle;
  maxSteps?: number;
  maxOutputTokens?: number;
  sessionTokenBudget?: number;
  assurance?: "fast" | "standard" | "high";
  maxCostUsd?: number;
  maxTime?: number;
  assume?: "ask" | "best";
  json?: boolean;
}

function logo(): string {
  return `${orange}◉${reset} ${orange}Krater Pro${reset} ${dim}v${VERSION}${reset}`;
}

function globalOverrides(options: GlobalOptions): ConfigOverrides {
  return {
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    model: options.model,
    cwd: options.cwd,
    contextChars: options.contextChars,
    toolOutputChars: options.toolOutputChars,
    responseStyle: options.responseStyle,
    maxSteps: options.maxSteps,
    maxOutputTokens: options.maxOutputTokens,
    sessionTokenBudget: options.sessionTokenBudget,
  };
}

async function readJsonArtifact(
  cwd: string,
  path: string,
  label: string,
): Promise<unknown> {
  const absolute = resolve(cwd, path);
  const contents = await readFile(absolute);
  if (contents.byteLength > MAX_LOCAL_ARTIFACT_BYTES) {
    throw new Error(
      `${label} exceeds the ${MAX_LOCAL_ARTIFACT_BYTES}-byte local artifact limit.`,
    );
  }
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  return JSON.stringify(args);
}

function eventPrinter(event: AgentEvent): void {
  switch (event.type) {
    case "text":
      process.stdout.write(sanitizeTerminalText(event.text));
      break;
    case "tool":
      process.stdout.write(
        `\n${cyan}◇ ${sanitizeTerminalText(event.name)}${reset} ${dim}${sanitizeTerminalText(summarizeArgs(event.args))}${reset}\n`,
      );
      break;
    case "tool_result": {
      const status = event.ok ? `${green}✓${reset}` : `${red}✗${reset}`;
      const compact = event.output.replace(/\s+/g, " ").slice(0, 180);
      process.stdout.write(
        `${status} ${dim}${sanitizeTerminalText(compact)}${event.output.length > 180 ? "…" : ""}${reset}\n`,
      );
      break;
    }
    case "usage":
      process.stdout.write(`${dim}${formatUsageEvent(event)}${reset}\n`);
      break;
    case "route": {
      const confidence = Math.round(event.confidence * 100);
      const reason = event.reasons[0]
        ? ` · ${sanitizeTerminalText(event.reasons[0])}`
        : "";
      process.stdout.write(
        `${cyan}◇ Smart Router${reset} ${sanitizeTerminalText(event.model)} ` +
          `${dim}· ${event.tier} · ${confidence}% confidence · ${event.catalog} catalog${reason}${reset}\n`,
      );
      break;
    }
    case "done":
      process.stdout.write("\n");
      break;
    case "task":
      process.stdout.write(
        `${dim}ProofGraph ${sanitizeTerminalText(event.id)} · ${sanitizeTerminalText(event.state)}${reset}\n`,
      );
      break;
    case "action_gate":
      process.stdout.write(
        `${cyan}◇ Action Gate${reset} ${sanitizeTerminalText(event.outcome)} ${dim}· ${sanitizeTerminalText(event.reasons.join(" "))}${reset}\n`,
      );
      break;
    case "evidence":
      process.stdout.write(
        `${event.ok ? green : red}${event.ok ? "✓" : "✗"}${reset} ${sanitizeTerminalText(event.summary)} ${dim}· ${sanitizeTerminalText(event.grade)}${reset}\n`,
      );
      break;
    case "verdict":
      process.stdout.write(
        `${cyan}◇ Verdict${reset} ${sanitizeTerminalText(event.state)} ${dim}· weakest evidence ${sanitizeTerminalText(event.evidenceGrade)} · ${event.gaps.length} gap(s)${reset}\n`,
      );
      break;
    case "error":
      process.stderr.write(`\n${red}${sanitizeTerminalText(event.message)}${reset}\n`);
      break;
    case "approval":
      break;
  }
}

function createApprovalHandler(
  readline: Interface | undefined,
): (request: ApprovalRequest) => Promise<boolean> {
  return async (request) => {
    if (!readline || !process.stdin.isTTY) return false;
    const answer = await readline.question(
      `${orange}?${reset} ${sanitizeTerminalText(request.reason)}\n  Allow? ${dim}[y/N]${reset} `,
    );
    return /^(y|yes)$/i.test(answer.trim());
  };
}

async function createAgent(
  options: GlobalOptions,
  prompt: string,
  readline?: Interface,
  loadedConfig?: KraterConfig,
  observeEvent?: (event: AgentEvent) => void,
  executionWorkspace?: {
    cwd: string;
    readOnlyDependencyRoots?: readonly string[];
  },
): Promise<{ agent: AgentSession; source: string; model: string; cwd: string }> {
  const config = loadedConfig ?? loadConfig(globalOverrides(options));
  const apiKey = requireApiKey(config);
  const selection = await selectCodingModel({
    requestedModel: config.model,
    prompt,
    contextCharacters: prompt.length,
    expectedOutputTokens: config.maxOutputTokens,
    loadModels: (signal) =>
      new KraterProvider({
        apiKey,
        baseURL: config.baseURL,
        model: ROUTER_FALLBACK_MODEL,
        maxOutputTokens: config.maxOutputTokens,
      }).listModels(signal),
  });
  if (selection.decision) {
    const decision = selection.decision;
    eventPrinter({
      type: "route",
      model: decision.model,
      tier: decision.tier,
      confidence: decision.confidence,
      complexity: decision.assessment.complexity,
      risk: decision.assessment.risk,
      reasons: decision.reasons,
      catalog: selection.catalog === "fallback" ? "fallback" : "live",
    });
  }
  return {
    agent: new AgentSession({
      provider: new KraterProvider({
        apiKey,
        baseURL: config.baseURL,
        model: selection.model,
        maxOutputTokens: config.maxOutputTokens,
      }),
      cwd: executionWorkspace?.cwd ?? config.cwd,
      readOnlyDependencyRoots: executionWorkspace?.readOnlyDependencyRoots,
      model: selection.model,
      autoApprove: options.yes,
      onEvent: (event) => {
        eventPrinter(event);
        observeEvent?.(event);
      },
      requestApproval: createApprovalHandler(readline),
      contextCharBudget: config.contextChars,
      toolOutputCharBudget: config.toolOutputChars,
      responseStyle: config.responseStyle,
      maxSteps: config.maxSteps,
      sessionTokenBudget: config.sessionTokenBudget,
      evidenceMode: true,
    }),
    source: config.apiKeySource,
    model: selection.model,
    cwd: config.cwd,
  };
}

function printPatchPreview(
  prepared: PreparedProofPatch,
  json = false,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "proofpatch", ...prepared })}\n`);
    return;
  }
  process.stdout.write(
    `${cyan}◇ ProofPatch${reset} ${prepared.transactionId} ${dim}· ` +
      `${prepared.preview.operations.length} operation(s) · ` +
      `${prepared.changedPaths.length} affected path(s)${reset}\n`,
  );
  for (const operation of prepared.preview.operations) {
    const path =
      operation.kind === "move"
        ? `${operation.from} → ${operation.to}`
        : operation.path;
    process.stdout.write(
      `${dim}  - ${operation.kind}: ${sanitizeTerminalText(path)}${reset}\n`,
    );
  }
  if (prepared.unsupportedPaths.length) {
    process.stdout.write(
      `${red}  Unsupported paths:${reset} ${prepared.unsupportedPaths
        .map(sanitizeTerminalText)
        .join(", ")}\n`,
    );
  }
}

function printOutcomeQuote(task: EvidenceTask, json = false): void {
  const contract = task.contract;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ type: "contract", contract })}\n`,
    );
    return;
  }
  const budget = contract.budget;
  process.stdout.write(
    `${cyan}◇ Outcome Contract${reset} ${contract.assurance} assurance ` +
      `${dim}· $${budget.maxCostUsd?.toFixed(2) ?? "unbounded"} max · ` +
      `${budget.maxTokens ?? "unbounded"} tokens · ` +
      `${budget.maxTimeMs ? `${Math.round(budget.maxTimeMs / 1_000)}s` : "no time cap"} · ` +
      `${contract.requiredChecks.length} required checks${reset}\n`,
  );
}

async function prepareAmbiguity(
  request: string,
  options: GlobalOptions,
  cwd: string,
  task: EvidenceTask,
  readline?: Interface,
): Promise<AmbiguityPreflightResult | undefined> {
  let result = await runAmbiguityPreflight({
    cwd,
    request,
    mode: options.assume ?? "ask",
  });
  await task.recordAmbiguityPreflight({
    assumptions: result.assumptions,
    interpretations: result.interpretations,
    ...(result.clarification
      ? {
          clarification: {
            id: result.clarification.id,
            question: result.clarification.question,
            interpretations: result.clarification.interpretations,
            score: result.clarification.score,
          },
        }
      : {}),
  });

  if (result.status === "clarification_required" && result.clarification) {
    if (!readline || options.json) {
      process.stdout.write(
        `${JSON.stringify({
          type: "clarification_required",
          exitCode: CLARIFICATION_REQUIRED_EXIT_CODE,
          taskId: task.taskId,
          clarification: result.clarification,
          assumptions: result.assumptions,
          facts: result.facts,
        })}\n`,
      );
      process.exitCode = CLARIFICATION_REQUIRED_EXIT_CODE;
      return undefined;
    }
    process.stdout.write(
      `${orange}?${reset} ${sanitizeTerminalText(result.clarification.question)}\n`,
    );
    result.clarification.interpretations.forEach((interpretation, index) => {
      process.stdout.write(
        `  ${index + 1}. ${sanitizeTerminalText(interpretation)}\n`,
      );
    });
    const answer = await readline.question(
      `${dim}Select a number or enter a precise answer:${reset} `,
    );
    result = resolveAmbiguityPreflight(result, answer);
    await task.recordAmbiguityPreflight({
      assumptions: result.assumptions,
      interpretations: result.interpretations,
    });
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        type: "ambiguity_preflight",
        taskId: task.taskId,
        status: result.status,
        mode: result.mode,
        assumptions: result.assumptions,
        facts: result.facts,
      })}\n`,
    );
  } else if (result.assumptions.length) {
    process.stdout.write(
      `${cyan}◇ Assumptions${reset} ${dim}${result.assumptions
        .map((assumption) => sanitizeTerminalText(assumption.statement))
        .join(" · ")}${reset}\n`,
    );
  }
  return result;
}

function printTaskVerdict(
  projection: TaskProjection,
  json = false,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        type: "verdict",
        taskId: projection.taskId,
        state: projection.state,
        gaps: projection.capsule?.gaps ?? [],
        passportDigest: projection.passport?.digest,
      })}\n`,
    );
    return;
  }
  const grade = projection.passport?.weakestEvidenceGrade ?? "not_established";
  const gaps = projection.capsule?.gaps ?? [];
  process.stdout.write(
    `${cyan}◇ Evidence verdict${reset} ${projection.state} ${dim}· weakest ${grade} · ${gaps.length} gap(s)${reset}\n`,
  );
  if (gaps.length) {
    for (const gap of gaps) {
      process.stdout.write(`${dim}  - ${sanitizeTerminalText(gap)}${reset}\n`);
    }
  }
}

async function runPrompt(prompt: string, options: GlobalOptions): Promise<void> {
  const readline = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let stagedWorkspace: StagedTaskWorkspace | undefined;
  let evidenceTask: EvidenceTask | undefined;
  let prepared = false;
  try {
    const config = loadConfig(globalOverrides(options));
    evidenceTask = await EvidenceTask.start({
      cwd: config.cwd,
      projectId: "cli",
      request: prompt,
      ...(!isAutomaticModel(config.model) ? { model: config.model } : {}),
      assurance: options.assurance ?? "standard",
      ...(options.maxCostUsd === undefined
        ? {}
        : { maxCostUsd: options.maxCostUsd }),
      ...(options.maxTime === undefined ? {} : { maxTimeMs: options.maxTime }),
    });
    const preflight = await prepareAmbiguity(
      prompt,
      options,
      config.cwd,
      evidenceTask,
      readline,
    );
    if (!preflight) return;
    const executionPrompt = promptWithAmbiguityContext(preflight);
    stagedWorkspace = await StagedTaskWorkspace.create(config.cwd);
    const { agent } = await createAgent(
      options,
      executionPrompt,
      readline,
      config,
      (event) => evidenceTask?.accept(event),
      {
        cwd: stagedWorkspace.stageRoot,
        readOnlyDependencyRoots: stagedWorkspace.readOnlyDependencyRoots,
      },
    );
    if (!options.json) {
      eventPrinter({
        type: "task",
        id: evidenceTask.taskId,
        state: evidenceTask.currentState,
      });
    }
    printOutcomeQuote(evidenceTask, options.json);
    const controller = new AbortController();
    const timeout =
      options.maxTime === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.maxTime);
    try {
      await agent.run(executionPrompt, controller.signal);
      await evidenceTask.flush();
      let projection: TaskProjection;
      if (evidenceTask.actionGate?.shouldStageCode) {
        const proofPatch = await stagedWorkspace.prepareProofPatch(
          evidenceTask.taskId,
        );
        prepared = true;
        printPatchPreview(proofPatch, options.json);
        projection = await evidenceTask.finish({
          baseWorkspaceDigest: proofPatch.baseWorkspaceDigest,
          finalWorkspaceDigest: proofPatch.finalWorkspaceDigest,
          additionalGaps: proofPatch.unsupportedPaths.map(
            (path) =>
              `ProofPatch cannot publish ${path} because its parent directory does not exist in the base workspace.`,
          ),
        });
        if (projection.state === "review" && !options.json) {
          process.stdout.write(
            `${dim}Review first, then publish with: krater task publish ${evidenceTask.taskId}${reset}\n`,
          );
        }
      } else {
        await stagedWorkspace.discard();
        projection = await evidenceTask.finish({
          baseWorkspaceDigest: stagedWorkspace.initialWorkspaceDigest,
          finalWorkspaceDigest: stagedWorkspace.initialWorkspaceDigest,
        });
      }
      printTaskVerdict(projection, options.json);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (error) {
    if (
      evidenceTask &&
      evidenceTask.currentState !== "clarification"
    ) {
      await evidenceTask.fail((error as Error).message).catch(() => undefined);
    }
    throw error;
  } finally {
    if (stagedWorkspace && !prepared) {
      await stagedWorkspace.discard().catch(() => undefined);
    }
    readline?.close();
  }
}

async function interactive(options: GlobalOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("No prompt provided. Pass a prompt or run Krater Pro in a terminal.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const config = loadConfig(globalOverrides(options));
  requireApiKey(config);
  const configuredModel = isAutomaticModel(config.model)
    ? "Auto · Smart Router"
    : config.model;
  let active:
    | { agent: AgentSession; source: string; model: string; cwd: string }
    | undefined;
  let currentEvidenceTask: EvidenceTask | undefined;
  let lastProjection: TaskProjection | undefined;
  let lastTaskId: string | undefined;
  process.stdout.write(
    `\n${logo()}\n${dim}${configuredModel} · ${config.cwd} · key from ${config.apiKeySource}${reset}\n` +
      `${dim}${CREATOR_CREDIT} · ${CREATOR_PROFILE}${reset}\n` +
      `${dim}Type /help for commands, or describe a coding task.${reset}\n\n`,
  );

  try {
    while (true) {
      let input: string;
      try {
        input = (await readline.question(`${orange}›${reset} `)).trim();
      } catch {
        break;
      }
      if (!input) continue;
      if (["/exit", "/quit"].includes(input)) break;
      if (input === "/clear") {
        active?.agent.clear();
        active = undefined;
        process.stdout.write(`${dim}Conversation cleared.${reset}\n`);
        continue;
      }
      if (input === "/help") {
        process.stdout.write(
          [
            `${dim}/clear${reset}  clear conversation context`,
            `${dim}/contract${reset} show the latest outcome contract`,
            `${dim}/assumptions${reset} show recorded assumptions`,
            `${dim}/evidence${reset} show the latest evidence verdict`,
            `${dim}/why${reset} explain the latest action gate and gaps`,
            `${dim}/publish${reset} publish only an atomic reviewed ProofPatch`,
            `${dim}/rollback${reset} roll back a published ProofPatch transaction`,
            `${dim}/exit${reset}   leave Krater Pro`,
            `${dim}Tip:${reset} file edits and shell commands ask before running`,
            "",
          ].join("\n"),
        );
        continue;
      }
      if (input === "/contract") {
        if (!lastProjection) {
          process.stdout.write(`${dim}No completed task contract yet.${reset}\n`);
        } else {
          process.stdout.write(
            `${JSON.stringify(lastProjection.contract, null, 2)}\n`,
          );
        }
        continue;
      }
      if (input === "/assumptions") {
        const assumptions = lastProjection?.contract.assumptions ?? [];
        process.stdout.write(
          assumptions.length
            ? `${assumptions
                .map(
                  (assumption) =>
                    `- ${sanitizeTerminalText(assumption.statement)} (${assumption.resolved ? "resolved" : "open"})`,
                )
                .join("\n")}\n`
            : `${dim}No recorded assumptions.${reset}\n`,
        );
        continue;
      }
      if (input === "/evidence" || input === "/why") {
        if (!lastProjection) {
          process.stdout.write(`${dim}No evidence capsule yet.${reset}\n`);
        } else if (input === "/evidence") {
          printTaskVerdict(lastProjection);
        } else {
          const claims = lastProjection.claims.map((claim) => claim.statement);
          const gaps = lastProjection.capsule?.gaps ?? [];
          process.stdout.write(
            [
              claims.length
                ? claims.map((claim) => `- ${sanitizeTerminalText(claim)}`).join("\n")
                : "- No supported claims recorded.",
              gaps.length
                ? gaps.map((gap) => `- Gap: ${sanitizeTerminalText(gap)}`).join("\n")
                : "- No known gaps.",
              "",
            ].join("\n"),
          );
        }
        continue;
      }
      if (input === "/publish") {
        if (!lastTaskId || !lastProjection) {
          process.stdout.write(`${dim}No reviewed ProofPatch is available.${reset}\n`);
          continue;
        }
        try {
          const readiness = await evidencePublicationReadiness(
            config.cwd,
            lastTaskId,
          );
          if (!readiness.canPublish) {
            process.stdout.write(
              `${dim}Task ${lastTaskId} is ${readiness.state}, not awaiting publication.${reset}\n`,
            );
            continue;
          }
          let acceptGaps = false;
          if (readiness.requiresGapAcceptance) {
            process.stdout.write(
              readiness.gaps
                .map((gap) => `${red}  - ${sanitizeTerminalText(gap)}${reset}`)
                .join("\n") + "\n",
            );
            const answer = await readline.question(
              `${orange}?${reset} Publish and explicitly accept every documented gap? ${dim}[y/N]${reset} `,
            );
            acceptGaps = /^(y|yes)$/i.test(answer.trim());
            if (!acceptGaps) {
              process.stdout.write(`${dim}Publication cancelled; the base workspace is unchanged.${reset}\n`);
              continue;
            }
          }
          let binding = await loadProofPatchBinding(config.cwd, lastTaskId);
          if (binding.status === "staged") {
            binding = (await publishBoundProofPatch(config.cwd, lastTaskId))
              .binding;
          } else if (binding.status !== "published") {
            throw new Error(
              `ProofPatch transaction is ${binding.status}, not publishable.`,
            );
          }
          lastProjection = await finalizeEvidencePublication(
            config.cwd,
            lastTaskId,
            {
              acceptGaps,
              baseWorkspaceDigest: binding.baseWorkspaceDigest,
              finalWorkspaceDigest: binding.finalWorkspaceDigest,
              transactionId: binding.transactionId,
            },
          );
          printTaskVerdict(lastProjection);
        } catch (error) {
          process.stderr.write(
            `${red}${sanitizeTerminalText((error as Error).message)}${reset}\n`,
          );
        }
        continue;
      }
      if (input === "/rollback") {
        if (!lastTaskId) {
          process.stdout.write(`${dim}No ProofPatch transaction is available.${reset}\n`);
          continue;
        }
        try {
          const before = await loadProofPatchBinding(config.cwd, lastTaskId);
          const binding = await rollbackBoundProofPatch(config.cwd, lastTaskId);
          lastProjection = await recordEvidenceRollback(
            config.cwd,
            lastTaskId,
            {
              transactionId: binding.transactionId,
              wasPublished: before.status === "published",
              baseWorkspaceDigest: binding.baseWorkspaceDigest,
              finalWorkspaceDigest: binding.finalWorkspaceDigest,
            },
          );
          process.stdout.write(
            `${green}✓ ProofPatch rolled back${reset} ${binding.transactionId}\n`,
          );
        } catch (error) {
          process.stderr.write(
            `${red}${sanitizeTerminalText((error as Error).message)}${reset}\n`,
          );
        }
        continue;
      }
      let stagedWorkspace: StagedTaskWorkspace | undefined;
      let prepared = false;
      try {
        currentEvidenceTask = await EvidenceTask.start({
          cwd: config.cwd,
          projectId: "cli",
          request: input,
          ...(!isAutomaticModel(config.model) ? { model: config.model } : {}),
          assurance: options.assurance ?? "standard",
          ...(options.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: options.maxCostUsd }),
          ...(options.maxTime === undefined
            ? {}
            : { maxTimeMs: options.maxTime }),
        });
        lastTaskId = currentEvidenceTask.taskId;
        const preflight = await prepareAmbiguity(
          input,
          options,
          config.cwd,
          currentEvidenceTask,
          readline,
        );
        if (!preflight) continue;
        const executionPrompt = promptWithAmbiguityContext(preflight);
        stagedWorkspace = await StagedTaskWorkspace.create(config.cwd);
        active = await createAgent(
          options,
          executionPrompt,
          readline,
          config,
          (event) => currentEvidenceTask?.accept(event),
          {
            cwd: stagedWorkspace.stageRoot,
            readOnlyDependencyRoots: stagedWorkspace.readOnlyDependencyRoots,
          },
        );
        if (!options.json) {
          eventPrinter({
            type: "task",
            id: currentEvidenceTask.taskId,
            state: currentEvidenceTask.currentState,
          });
        }
        printOutcomeQuote(currentEvidenceTask, options.json);
        const controller = new AbortController();
        const timeout =
          options.maxTime === undefined
            ? undefined
            : setTimeout(() => controller.abort(), options.maxTime);
        try {
          await active.agent.run(executionPrompt, controller.signal);
          await currentEvidenceTask.flush();
          if (currentEvidenceTask.actionGate?.shouldStageCode) {
            const proofPatch = await stagedWorkspace.prepareProofPatch(
              currentEvidenceTask.taskId,
            );
            prepared = true;
            printPatchPreview(proofPatch, options.json);
            lastProjection = await currentEvidenceTask.finish({
              baseWorkspaceDigest: proofPatch.baseWorkspaceDigest,
              finalWorkspaceDigest: proofPatch.finalWorkspaceDigest,
              additionalGaps: proofPatch.unsupportedPaths.map(
                (path) =>
                  `ProofPatch cannot publish ${path} because its parent directory does not exist in the base workspace.`,
              ),
            });
          } else {
            await stagedWorkspace.discard();
            lastProjection = await currentEvidenceTask.finish({
              baseWorkspaceDigest: stagedWorkspace.initialWorkspaceDigest,
              finalWorkspaceDigest: stagedWorkspace.initialWorkspaceDigest,
            });
          }
          printTaskVerdict(lastProjection, options.json);
          if (lastProjection.state === "review") {
            process.stdout.write(
              `${dim}Use /publish after reviewing the patch and evidence, or /rollback to discard it.${reset}\n`,
            );
          }
        } catch (error) {
          lastProjection = await currentEvidenceTask.fail(
            (error as Error).message,
          );
          if (!prepared) await stagedWorkspace.discard().catch(() => undefined);
          throw error;
        } finally {
          if (timeout) clearTimeout(timeout);
          currentEvidenceTask = undefined;
        }
      } catch (error) {
        if (currentEvidenceTask?.currentState !== "clarification") {
          lastProjection = await currentEvidenceTask
            ?.fail((error as Error).message)
            .catch(() => lastProjection);
        }
        process.stderr.write(
          `${red}${sanitizeTerminalText((error as Error).message)}${reset}\n`,
        );
      } finally {
        if (stagedWorkspace && !prepared) {
          await stagedWorkspace.discard().catch(() => undefined);
        }
        active = undefined;
        currentEvidenceTask = undefined;
      }
    }
  } finally {
    readline.close();
  }
}

function addGlobalOptions(command: Command): Command {
  return command
    .option("-k, --api-key <key>", "Krater API key (overrides env and .env)")
    .option("--base-url <url>", "Krater-compatible OpenAI API base URL")
    .option(
      "-m, --model <id>",
      'model ID returned by Krater /v1/models, or "auto" for Smart Router',
    )
    .option("-C, --cwd <path>", "workspace directory", process.cwd())
    .option("-y, --yes", "approve file edits and shell commands automatically", false)
    .option(
      "--context-chars <number>",
      "maximum estimated conversation characters sent per request",
      (value) => Number(value),
    )
    .option(
      "--tool-output-chars <number>",
      "maximum characters retained from each tool result",
      (value) => Number(value),
    )
    .option(
      "--response-style <style>",
      "response style: concise or standard",
    )
    .option(
      "--max-steps <number>",
      "maximum model/tool turns per task",
      (value) => Number(value),
    )
    .option(
      "--max-output-tokens <number>",
      "maximum tokens generated by each model response",
      (value) => Number(value),
    )
    .option(
      "--session-token-budget <number>",
      "stop before starting another request after this many reported tokens",
      (value) => Number(value),
    )
    .option(
      "--assurance <level>",
      "evidence assurance: fast, standard, or high",
      (value) => {
        if (!["fast", "standard", "high"].includes(value)) {
          throw new Error('Assurance must be "fast", "standard", or "high".');
        }
        return value as "fast" | "standard" | "high";
      },
      "standard",
    )
    .option(
      "--max-cost-usd <amount>",
      "maximum quoted task cost in USD",
      (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("Maximum cost must be a positive number.");
        }
        return parsed;
      },
    )
    .option(
      "--max-time <duration>",
      "maximum task time, such as 30s, 5m, or 1h",
      (value) => {
        const match = /^(\d+)(ms|s|m|h)$/.exec(value);
        if (!match) {
          throw new Error("Maximum time must use ms, s, m, or h (for example 5m).");
        }
        const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
        const parsed =
          Number(match[1]) * units[match[2] as keyof typeof units];
        if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 86_400_000) {
          throw new Error("Maximum time must be between 100ms and 24h.");
        }
        return parsed;
      },
    )
    .option(
      "--assume <mode>",
      "ambiguity behavior: ask or best",
      (value) => {
        if (value !== "ask" && value !== "best") {
          throw new Error('Assume mode must be "ask" or "best".');
        }
        return value as "ask" | "best";
      },
      "ask",
    )
    .option("--json", "emit machine-readable task contracts and verdicts", false);
}

const program = addGlobalOptions(
  new Command()
    .name("krater")
    .description("Krater Pro — a Krater-powered coding agent for terminal and web")
    .version(VERSION)
    .addHelpText("beforeAll", "◉ Krater Pro\n")
    .addHelpText(
      "afterAll",
      `\n${CREATOR_CREDIT} — ${CREATOR_PROFILE}\n`,
    ),
);

program
  .argument("[prompt...]", "task to run; omit for interactive mode")
  .action(async (parts: string[], _localOptions: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const prompt = parts.join(" ").trim();
    if (prompt) await runPrompt(prompt, options);
    else await interactive(options);
  });

program
  .command("models")
  .description("list model IDs available to your Krater API key")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const provider = new KraterProvider({
      apiKey: requireApiKey(config),
      baseURL: config.baseURL,
      model: isAutomaticModel(config.model)
        ? ROUTER_FALLBACK_MODEL
        : config.model,
      maxOutputTokens: config.maxOutputTokens,
    });
    const models = await provider.listModels();
    for (const model of models) process.stdout.write(`${model.id}\n`);
  });

const taskCommands = program
  .command("task")
  .description("run and inspect durable evidence-native tasks");

taskCommands
  .command("run")
  .description("run one evidence-native coding task")
  .argument("<prompt...>", "task request")
  .action(async (parts: string[], _localOptions: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    await runPrompt(parts.join(" ").trim(), options);
  });

taskCommands
  .command("list")
  .description("list local ProofGraph tasks for the workspace")
  .action(async (_localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const tasks = await listEvidenceTasks(config.cwd, "cli");
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ tasks }, null, 2)}\n`);
      return;
    }
    if (!tasks.length) {
      process.stdout.write(`${dim}No evidence-native tasks recorded.${reset}\n`);
      return;
    }
    for (const task of tasks) {
      process.stdout.write(
        `${task.id}  ${task.state.padEnd(18)}  ${task.assurance.padEnd(8)}  ${sanitizeTerminalText(task.request)}\n`,
      );
    }
  });

taskCommands
  .command("show")
  .description("show a durable task contract, evidence, and gaps")
  .argument("<taskId>", "ProofGraph task ID")
  .action(async (taskId: string, _localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const detail = await readEvidenceTask(config.cwd, "cli", taskId);
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
  });

taskCommands
  .command("resume")
  .description("inspect the durable state available for a resumed task")
  .argument("<taskId>", "ProofGraph task ID")
  .action(async (taskId: string, _localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const detail = await readEvidenceTask(config.cwd, "cli", taskId);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...detail,
          resumable:
            detail.task.state === "review" ||
            detail.task.state === "blocked" ||
            detail.task.state === "accepted_with_gaps",
          note:
            "The contract and evidence are durable. Raw transcripts are opt-in, so a new model turn must be started explicitly.",
        },
        null,
        2,
      )}\n`,
    );
  });

taskCommands
  .command("cancel")
  .description("cancel an unpublished task and discard its staged ProofPatch")
  .argument("<taskId>", "ProofGraph task ID")
  .option("--reason <text>", "record a concise cancellation reason")
  .action(
    async (
      taskId: string,
      localOptions: { reason?: string },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const detail = await readEvidenceTask(config.cwd, "cli", taskId);
      let binding:
        | Awaited<ReturnType<typeof loadProofPatchBinding>>
        | undefined;
      try {
        binding = await loadProofPatchBinding(config.cwd, taskId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (binding?.status === "published" || binding?.publishedAt) {
        throw new Error(
          `Task ${taskId} has a published ProofPatch and cannot be cancelled. Use "krater task rollback ${taskId}" to undo its workspace changes.`,
        );
      }
      if (
        detail.task.state !== "cancelled" &&
        [
          "complete",
          "abstained",
          "blocked",
          "accepted_with_gaps",
          "publication",
        ].includes(detail.task.state)
      ) {
        throw new Error(
          `Task is already ${detail.task.state} and cannot be cancelled.`,
        );
      }
      if (binding?.status === "staged") {
        binding = await discardStagedProofPatch(config.cwd, taskId);
      }
      const projection = await cancelEvidenceTask(config.cwd, taskId, {
        ...(localOptions.reason ? { reason: localOptions.reason } : {}),
        ...(binding
          ? {
              discardedProofPatch: {
                transactionId: binding.transactionId,
                baseWorkspaceDigest: binding.baseWorkspaceDigest,
                finalWorkspaceDigest: binding.finalWorkspaceDigest,
                changedPaths: binding.changedPaths,
              },
            }
          : {}),
      });
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            type: "cancellation",
            taskId,
            verdict: projection.state,
            ...(binding
              ? {
                  proofPatch: {
                    transactionId: binding.transactionId,
                    status: binding.status,
                    changedPaths: binding.changedPaths,
                  },
                }
              : {}),
            capsuleDigest: projection.capsule?.digest,
            passportDigest: projection.passport?.digest,
          })}\n`,
        );
        return;
      }
      process.stdout.write(
        `${green}✓ Task cancelled${reset} ${taskId}` +
          `${binding ? ` · ProofPatch ${binding.status}` : ""}\n`,
      );
    },
  );

taskCommands
  .command("publish")
  .description("atomically publish an attached reviewed ProofPatch transaction")
  .argument("<taskId>", "ProofGraph task ID")
  .option(
    "--accept-gaps",
    "explicitly publish despite every documented evidence gap",
    false,
  )
  .action(
    async (
      taskId: string,
      localOptions: { acceptGaps: boolean },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const readiness = await evidencePublicationReadiness(config.cwd, taskId);
      if (!readiness.canPublish) {
        throw new Error(
          `Only reviewed tasks can be published; current state is ${readiness.state}.`,
        );
      }
      if (readiness.requiresGapAcceptance && !localOptions.acceptGaps) {
        throw new Error(
          `Publication is blocked by ${readiness.gaps.length} evidence gap(s). Review them with "krater task show ${taskId}", then rerun with --accept-gaps only if you accept each one.`,
        );
      }
      let binding = await loadProofPatchBinding(config.cwd, taskId);
      if (binding.status === "staged") {
        binding = (await publishBoundProofPatch(config.cwd, taskId)).binding;
      } else if (binding.status !== "published") {
        throw new Error(
          `ProofPatch transaction is ${binding.status}, not publishable.`,
        );
      }
      const projection = await finalizeEvidencePublication(
        config.cwd,
        taskId,
        {
          acceptGaps: localOptions.acceptGaps,
          baseWorkspaceDigest: binding.baseWorkspaceDigest,
          finalWorkspaceDigest: binding.finalWorkspaceDigest,
          transactionId: binding.transactionId,
        },
      );
      printTaskVerdict(projection, options.json);
    },
  );

taskCommands
  .command("rollback")
  .description("safely roll back an attached ProofPatch transaction")
  .argument("<taskId>", "ProofGraph task ID")
  .action(async (taskId: string, _localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    await readEvidenceTask(config.cwd, "cli", taskId);
    const before = await loadProofPatchBinding(config.cwd, taskId);
    const binding = await rollbackBoundProofPatch(config.cwd, taskId);
    const projection = await recordEvidenceRollback(config.cwd, taskId, {
      transactionId: binding.transactionId,
      wasPublished: before.status === "published",
      baseWorkspaceDigest: binding.baseWorkspaceDigest,
      finalWorkspaceDigest: binding.finalWorkspaceDigest,
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          type: "rollback",
          binding,
          verdict: projection.state,
          gaps: projection.capsule?.gaps ?? [],
        })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${green}✓ ProofPatch rolled back${reset} ${binding.transactionId}\n`,
    );
  });

const proofCommands = program
  .command("proof")
  .description("inspect, export, and verify evidence capsules and passports");

proofCommands
  .command("show")
  .argument("<taskId>", "ProofGraph task ID")
  .description("render a task Change Passport")
  .action(async (taskId: string, _localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const projection = await (await openEvidenceStore(config.cwd)).task(taskId);
    process.stdout.write(renderPassportMarkdown(projection));
  });

proofCommands
  .command("verify")
  .argument("<taskId>", "ProofGraph task ID")
  .description("verify capsule and passport digests offline")
  .action(async (taskId: string, _localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const projection = await (await openEvidenceStore(config.cwd)).task(taskId);
    if (!projection.capsule || !projection.passport) {
      throw new Error("This task has no capsule and passport to verify.");
    }
    const result = {
      capsule: verifyEvidenceCapsule(projection.capsule),
      passport: verifyChangePassport(projection.passport, projection.capsule),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.capsule.valid || !result.passport.valid) process.exitCode = 2;
  });

proofCommands
  .command("export")
  .argument("<taskId>", "ProofGraph task ID")
  .description("export a redacted passport as Markdown or JSON")
  .option("--format <format>", "markdown or json", "markdown")
  .option("-o, --output <path>", "write the export to this path")
  .action(
    async (
      taskId: string,
      localOptions: { format: string; output?: string },
      command: Command,
    ) => {
      if (localOptions.format !== "markdown" && localOptions.format !== "json") {
        throw new Error('Proof export format must be "markdown" or "json".');
      }
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const projection = await (await openEvidenceStore(config.cwd)).task(taskId);
      if (!projection.capsule || !projection.passport) {
        throw new Error("This task has no capsule and passport to export.");
      }
      const content =
        localOptions.format === "markdown"
          ? renderPassportMarkdown(projection)
          : `${JSON.stringify(
              {
                capsule: projection.capsule,
                passport: projection.passport,
              },
              null,
              2,
            )}\n`;
      if (!localOptions.output) {
        process.stdout.write(content);
        return;
      }
      const output = resolve(config.cwd, localOptions.output);
      await writeFile(output, content, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`${green}Exported:${reset} ${output}\n`);
    },
  );

const policyCommands = program
  .command("policy")
  .description("explain and simulate context-flow policy before model spend");

function addPolicyCoordinates(command: Command): Command {
  return command
    .requiredOption("--operation <operation>", "exact requested operation")
    .requiredOption("--resource <resource>", "exact target resource")
    .requiredOption("--scope <scope>", "exact capability scope")
    .requiredOption(
      "--destination <destination>",
      "model, network, command, cache, export, or local_tool",
    )
    .option("--content <text>", "sample context to classify", "")
    .option("--source <source>", "context source", "user")
    .option("--trust <trust>", "context trust", "authoritative_instruction")
    .option("--sensitivity <sensitivity>", "context sensitivity", "public")
    .option(
      "--requires-capability",
      "require an exact capability (simulation has none)",
      false,
    );
}

for (const subcommand of ["simulate", "explain"] as const) {
  addPolicyCoordinates(
    policyCommands
      .command(subcommand)
      .description(
        subcommand === "simulate"
          ? "simulate one labeled context flow"
          : "explain why one labeled context flow is allowed or denied",
      ),
  ).action(
    (
      localOptions: {
        operation: string;
        resource: string;
        scope: string;
        destination: string;
        content: string;
        source: string;
        trust: string;
        sensitivity: string;
        requiresCapability: boolean;
      },
      command: Command,
    ) => {
      const destinations = [
        "model",
        "network",
        "command",
        "cache",
        "export",
        "local_tool",
      ];
      const sources = [
        "user",
        "system_policy",
        "repository",
        "local_tool",
        "external_tool",
        "generated",
      ];
      const trusts = [
        "authoritative_instruction",
        "approved_policy",
        "untrusted_data",
      ];
      const sensitivities = [
        "public",
        "proprietary",
        "pii",
        "secret",
        "license_restricted",
      ];
      if (!destinations.includes(localOptions.destination)) {
        throw new Error("Unsupported policy destination.");
      }
      if (!sources.includes(localOptions.source)) {
        throw new Error("Unsupported context source.");
      }
      if (!trusts.includes(localOptions.trust)) {
        throw new Error("Unsupported context trust.");
      }
      if (!sensitivities.includes(localOptions.sensitivity)) {
        throw new Error("Unsupported context sensitivity.");
      }
      const context = labelContext({
        content: localOptions.content,
        source: localOptions.source as ContextSource,
        trust: localOptions.trust as ContextTrust,
        sensitivity: localOptions.sensitivity as ContextSensitivity,
      });
      const decision = simulatePolicy({
        operation: localOptions.operation,
        resource: localOptions.resource,
        scope: localOptions.scope,
        destination: localOptions.destination as ContextDestination,
        contexts: [context],
        requiresCapability: localOptions.requiresCapability,
      });
      const options = command.optsWithGlobals<GlobalOptions>();
      process.stdout.write(
        subcommand === "explain" && !options.json
          ? `${explainPolicyDecision(decision)}\n`
          : `${JSON.stringify({ decision, explanation: explainPolicyDecision(decision) }, null, 2)}\n`,
      );
    },
  );
}

const debugCommands = program
  .command("debug")
  .description("inspect failures with bounded, evidence-labeled debugging");

debugCommands
  .command("causal")
  .description(
    "replay a Causal Twin plan from recorded Node.js or Python process outcomes",
  )
  .requiredOption(
    "--input <path>",
    "JSON object containing a causal plan and ordered recorded executions",
  )
  .action(
    async (
      localOptions: { input: string },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const input = await readJsonArtifact(
        config.cwd,
        localOptions.input,
        "Causal replay input",
      );
      const result = await replayRecordedCausalTwin(input);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    },
  );

const labCommands = program
  .command("lab")
  .description(
    "score sealed reliability results and evaluate promotion gates locally",
  );

labCommands
  .command("replay")
  .description(
    "score a sealed recorded evaluation (does not execute benchmark fixtures)",
  )
  .requiredOption(
    "--input <path>",
    "JSON object containing an evaluation field",
  )
  .action(
    async (
      localOptions: { input: string },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const input = await readJsonArtifact(
        config.cwd,
        localOptions.input,
        "Reliability replay input",
      );
      process.stdout.write(
        `${JSON.stringify(replayReliabilityEvaluation(input), null, 2)}\n`,
      );
    },
  );

labCommands
  .command("calibrate")
  .description(
    "evaluate a candidate against sealed rule-generation and private holdout results",
  )
  .requiredOption(
    "--input <path>",
    "JSON reliability promotion input",
  )
  .action(
    async (
      localOptions: { input: string },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const input = await readJsonArtifact(
        config.cwd,
        localOptions.input,
        "Reliability calibration input",
      );
      const result = calibrateReliabilityCandidate(input);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.decision.promote) process.exitCode = 2;
    },
  );

const cacheCommands = program
  .command("cache")
  .description("inspect and prune the local verified work cache");

cacheCommands
  .command("stats")
  .description("show local verified-cache statistics")
  .action(async (_localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const cache = new VerifiedWorkCache(join(config.cwd, ".krater", "cache"));
    process.stdout.write(`${JSON.stringify(await cache.stats(), null, 2)}\n`);
  });

const intentCommands = program
  .command("intent")
  .description("manage opt-in, version-controlled living intent");

intentCommands
  .command("init")
  .description("explicitly create .krater-intent for this project")
  .option("--namespace <name>", "stable intent namespace")
  .action(
    async (
      localOptions: { namespace?: string },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const store = new IntentFileStore(
        join(config.cwd, ".krater-intent"),
        { secrets: config.apiKey ? [config.apiKey] : [] },
      );
      const graph = await store.initialize({
        ...(localOptions.namespace
          ? { namespace: localOptions.namespace }
          : {}),
      });
      process.stdout.write(
        `${green}Initialized living intent:${reset} ${store.directory}\n` +
          `${dim}${graph.nodes.length} intents · source-controlled by opt-in${reset}\n`,
      );
    },
  );

intentCommands
  .command("check")
  .description("validate intent coverage, staleness, contradictions, and retirement")
  .action(async (_localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const result = await new IntentFileStore(
      join(config.cwd, ".krater-intent"),
      { secrets: config.apiKey ? [config.apiKey] : [] },
    ).check();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 2;
  });

intentCommands
  .command("add")
  .description("add a stable intent node")
  .requiredOption(
    "--kind <kind>",
    "requirement, invariant, decision, assumption, or non_goal",
  )
  .requiredOption("--statement <text>", "human-readable intent")
  .option("--stable-key <key>", "stable identity key")
  .option("--owner <owner>", "optional intent owner")
  .action(
    async (
      localOptions: {
        kind: string;
        statement: string;
        stableKey?: string;
        owner?: string;
      },
      command: Command,
    ) => {
      const kinds = [
        "requirement",
        "invariant",
        "decision",
        "assumption",
        "non_goal",
      ] as const;
      if (!kinds.includes(localOptions.kind as (typeof kinds)[number])) {
        throw new Error("Unsupported intent kind.");
      }
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const result = await new IntentFileStore(
        join(config.cwd, ".krater-intent"),
        { secrets: config.apiKey ? [config.apiKey] : [] },
      ).addIntent({
        kind: localOptions.kind as (typeof kinds)[number],
        statement: localOptions.statement,
        ...(localOptions.stableKey
          ? { stableKey: localOptions.stableKey }
          : {}),
        ...(localOptions.owner ? { owner: localOptions.owner } : {}),
      });
      process.stdout.write(`${JSON.stringify(result.intent, null, 2)}\n`);
    },
  );

intentCommands
  .command("retire")
  .description("retire intent explicitly without silent disappearance")
  .argument("<intentId>", "intent ID")
  .requiredOption("--reason <reason>", "retirement reason")
  .option("--replacement <intentId>", "replacement active intent")
  .option("--owner-decision <id>", "explicit owner decision ID")
  .action(
    async (
      intentId: string,
      localOptions: {
        reason: string;
        replacement?: string;
        ownerDecision?: string;
      },
      command: Command,
    ) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const config = loadConfig(globalOverrides(options));
      const graph = await new IntentFileStore(
        join(config.cwd, ".krater-intent"),
        { secrets: config.apiKey ? [config.apiKey] : [] },
      ).retireIntent({
        intentId,
        reason: localOptions.reason,
        ...(localOptions.replacement
          ? { replacementIntentId: localOptions.replacement }
          : {}),
        ...(localOptions.ownerDecision
          ? { ownerDecisionId: localOptions.ownerDecision }
          : {}),
      });
      process.stdout.write(
        `${JSON.stringify(
          graph.nodes.find((intent) => intent.id === intentId),
          null,
          2,
        )}\n`,
      );
    },
  );

cacheCommands
  .command("prune")
  .description("remove expired verified-cache entries")
  .action(async (_localOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    const cache = new VerifiedWorkCache(join(config.cwd, ".krater", "cache"));
    process.stdout.write(
      `${JSON.stringify({ removed: await cache.pruneExpired() })}\n`,
    );
  });

const auth = program.command("auth").description("configure Krater account access");

auth
  .command("login")
  .description("open Krater's account/API setup in your browser")
  .option("--no-open", "print the setup URL without opening a browser")
  .action(async (authOptions: { open: boolean }) => {
    const capabilities = browserAuthCapabilities();
    if (authOptions.open) await openKraterDeveloperPage();
    process.stdout.write(
      [
        authOptions.open
          ? `${green}Opened Krater API setup in your browser.${reset}`
          : `Krater API setup: ${KRATER_DEVELOPER_URL}`,
        `${dim}${capabilities.explanation}${reset}`,
        `${dim}After creating a key, add KRATER_API_KEY=kr_live_… to the workspace .env,`,
        `or paste it into the Krater Pro GUI Settings for this tab only.${reset}`,
        "",
      ].join("\n"),
    );
  });

auth
  .command("status")
  .description("show whether this workspace has a configured Krater credential")
  .action((_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const config = loadConfig(globalOverrides(options));
    process.stdout.write(
      config.apiKey
        ? `${green}Key configured (unverified)${reset} · ${config.apiKeySource} · ${
            isAutomaticModel(config.model)
              ? "Auto · Smart Router"
              : config.model
          }\n`
        : `${red}No key configured${reset} · run krater auth login\n`,
    );
  });

program
  .command("web")
  .description("start the local Krater Pro web GUI")
  .option("-p, --port <number>", "port to listen on")
  .option("--host <host>", "host to bind")
  .option("--dev", "source checkout only: serve through Vite", false)
  .action(async (webOptions, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    if (
      webOptions.port !== undefined &&
      !/^\d+$/.test(String(webOptions.port))
    ) {
      throw new Error(
        `Invalid port "${webOptions.port}". Expected a number from 1 to 65535.`,
      );
    }
    const port =
      webOptions.port === undefined ? undefined : Number(webOptions.port);
    const config = loadConfig({
      ...globalOverrides(options),
      port,
      host: webOptions.host,
    });
    const server = await startServer(config, {
      dev: webOptions.dev,
      evidenceMode: true,
    });
    process.stdout.write(
      `\n${logo()}\n${green}Web GUI ready:${reset} ${server.url}\n` +
        `${dim}Workspace: ${config.cwd}\nPress Ctrl+C to stop.${reset}\n`,
    );
    const stop = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${red}Error:${reset} ${(error as Error).message}\n`);
  process.exitCode = 1;
});
