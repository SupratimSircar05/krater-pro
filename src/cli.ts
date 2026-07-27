#!/usr/bin/env node

import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Command } from "commander";
import { AgentSession } from "./agent.js";
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
  ROUTER_FALLBACK_MODEL,
  isAutomaticModel,
  selectCodingModel,
} from "./model-selection.js";
import { KraterProvider } from "./provider.js";
import { startServer } from "./server.js";
import { formatUsageEvent, sanitizeTerminalText } from "./telemetry.js";
import type { AgentEvent, ApprovalRequest } from "./types.js";

const VERSION = "0.1.0";
const CREATOR_CREDIT = "Built by Supratim with ❤️";
const CREATOR_PROFILE = "https://www.linkedin.com/in/supratimsircar/";
const orange = "\u001b[38;2;255;113;67m";
const cyan = "\u001b[38;2;91;205;255m";
const dim = "\u001b[2m";
const green = "\u001b[32m";
const red = "\u001b[31m";
const reset = "\u001b[0m";

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
      cwd: config.cwd,
      model: selection.model,
      autoApprove: options.yes,
      onEvent: eventPrinter,
      requestApproval: createApprovalHandler(readline),
      contextCharBudget: config.contextChars,
      toolOutputCharBudget: config.toolOutputChars,
      responseStyle: config.responseStyle,
      maxSteps: config.maxSteps,
      sessionTokenBudget: config.sessionTokenBudget,
    }),
    source: config.apiKeySource,
    model: selection.model,
    cwd: config.cwd,
  };
}

async function runPrompt(prompt: string, options: GlobalOptions): Promise<void> {
  const readline = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    const { agent } = await createAgent(options, prompt, readline);
    await agent.run(prompt);
  } finally {
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
        if (isAutomaticModel(config.model)) active = undefined;
        process.stdout.write(`${dim}Conversation cleared.${reset}\n`);
        continue;
      }
      if (input === "/help") {
        process.stdout.write(
          [
            `${dim}/clear${reset}  clear conversation context`,
            `${dim}/exit${reset}   leave Krater Pro`,
            `${dim}Tip:${reset} file edits and shell commands ask before running`,
            "",
          ].join("\n"),
        );
        continue;
      }
      try {
        active ??= await createAgent(options, input, readline, config);
        await active.agent.run(input);
      } catch {
        // The event stream already printed the actionable error.
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
    );
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
    const server = await startServer(config, { dev: webOptions.dev });
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
