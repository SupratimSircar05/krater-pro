#!/usr/bin/env node

import { readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import { AgentSession } from "../../src/agent.js";
import { KraterProvider } from "../../src/provider.js";
import { sanitizeTerminalText } from "../../src/telemetry.js";
import type { AgentEvent } from "../../src/types.js";

const VERSION = "0.1.0";
const EXPECTED_MODEL = "moonshotai/kimi-k3";
let secretForRedaction = "";

interface Options {
  secretFile: string;
  promptFile: string;
  baseURL: string;
  cwd: string;
  maxSteps: number;
  maxOutputTokens: number;
  sessionTokenBudget: number;
  contextChars: number;
  toolOutputChars: number;
}

function positiveInteger(
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid benchmark argument near ${flag ?? "end of input"}.`);
    }
    if (values.has(flag)) throw new Error(`Duplicate benchmark argument: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set([
    "--secret-file",
    "--prompt-file",
    "--base-url",
    "--cwd",
    "--max-steps",
    "--max-output-tokens",
    "--session-token-budget",
    "--context-chars",
    "--tool-output-chars",
  ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown benchmark argument: ${flag}`);
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) throw new Error(`Missing benchmark argument: ${flag}`);
    return value;
  };
  return {
    secretFile: required("--secret-file"),
    promptFile: required("--prompt-file"),
    baseURL: required("--base-url"),
    cwd: required("--cwd"),
    maxSteps: positiveInteger(values.get("--max-steps"), "max steps", 1, 128),
    maxOutputTokens: positiveInteger(
      values.get("--max-output-tokens"),
      "max output tokens",
      256,
      65_536,
    ),
    sessionTokenBudget: positiveInteger(
      values.get("--session-token-budget"),
      "session token budget",
      1_000,
      10_000_000,
    ),
    contextChars: positiveInteger(
      values.get("--context-chars"),
      "context characters",
      10_000,
      2_000_000,
    ),
    toolOutputChars: positiveInteger(
      values.get("--tool-output-chars"),
      "tool-output characters",
      1_000,
      250_000,
    ),
  };
}

function readAndRemoveSecret(path: string): string {
  let value = "";
  try {
    value = readFileSync(path, "utf8").trim();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // The Harbor adapter also performs best-effort cleanup.
    }
  }
  if (!value) throw new Error("The Krater API key file was empty.");
  return value;
}

function safeWrite(value: unknown, secret: string): void {
  const serialized = JSON.stringify(value).replaceAll(secret, "[redacted]");
  process.stdout.write(`${sanitizeTerminalText(serialized)}\n`);
}

function eventSummary(event: AgentEvent): Record<string, unknown> | undefined {
  switch (event.type) {
    case "text":
      return undefined;
    case "tool":
      return { type: "tool", id: event.id, name: event.name };
    case "tool_result":
      return {
        type: "tool_result",
        id: event.id,
        name: event.name,
        ok: event.ok,
        cached: event.cached ?? false,
        output: event.output.replace(/\s+/g, " ").slice(0, 500),
      };
    case "usage":
      return { ...event };
    case "done":
      return event;
    case "error":
      return event;
    case "approval":
      return undefined;
  }
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const options = parseOptions(process.argv.slice(2));
  const apiKey = readAndRemoveSecret(options.secretFile);
  secretForRedaction = apiKey;
  const prompt = readFileSync(options.promptFile, "utf8");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  try {
    const agent = new AgentSession({
      provider: new KraterProvider({
        apiKey,
        baseURL: options.baseURL,
        model: EXPECTED_MODEL,
        maxOutputTokens: options.maxOutputTokens,
      }),
      cwd: options.cwd,
      model: EXPECTED_MODEL,
      maxSteps: options.maxSteps,
      sessionTokenBudget: options.sessionTokenBudget,
      contextCharBudget: options.contextChars,
      toolOutputCharBudget: options.toolOutputChars,
      responseStyle: "standard",
      autoApprove: true,
      onEvent: (event) => {
        const summary = eventSummary(event);
        if (summary) safeWrite(summary, apiKey);
      },
    });
    await agent.run(prompt, controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((error) => {
  const message = sanitizeTerminalText(
    error instanceof Error ? error.message : String(error),
  ).replaceAll(secretForRedaction, "[redacted]");
  process.stderr.write(`${JSON.stringify({ type: "fatal", message })}\n`);
  process.exitCode = 1;
});
