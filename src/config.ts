import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "dotenv";
import { readStoredCredentialSync } from "./credential-store.js";

export const DEFAULT_BASE_URL = "https://api.krater.ai/v1";
export const AUTO_MODEL = "auto";
export const DEFAULT_MODEL = AUTO_MODEL;
export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_CONTEXT_CHARS = 120_000;
export const DEFAULT_TOOL_OUTPUT_CHARS = 18_000;
export const DEFAULT_RESPONSE_STYLE = "concise" as const;
export const DEFAULT_MAX_STEPS = 48;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_SESSION_TOKEN_BUDGET = 250_000;

export type ResponseStyle = "concise" | "standard";

export interface ConfigOverrides {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  cwd?: string;
  gitExecutable?: string;
  port?: number;
  host?: string;
  contextChars?: number;
  toolOutputChars?: number;
  responseStyle?: ResponseStyle;
  maxSteps?: number;
  maxOutputTokens?: number;
  sessionTokenBudget?: number;
}

export interface KraterConfig {
  apiKey?: string;
  baseURL: string;
  model: string;
  cwd: string;
  gitExecutable?: string;
  port: number;
  host: string;
  contextChars: number;
  toolOutputChars: number;
  responseStyle: ResponseStyle;
  maxSteps: number;
  maxOutputTokens: number;
  sessionTokenBudget: number;
  apiKeySource:
    | "command"
    | "environment"
    | "credential_store"
    | ".env"
    | "missing";
  modelSource: "command" | "environment" | ".env" | "default";
}

export interface ConfigDependencies {
  readStoredCredential?: (cwd: string) => string | undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readEnvFile(cwd: string): Record<string, string> {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return {};

  try {
    return parse(readFileSync(path));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid port "${value}". Expected a number from 1 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port "${value}". Expected a number from 1 to 65535.`);
  }
  return port;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${name} "${value}". Expected an integer from ${minimum} to ${maximum}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid ${name} "${value}". Expected an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function parseResponseStyle(value: string | undefined): ResponseStyle {
  if (!value) return DEFAULT_RESPONSE_STYLE;
  if (value === "concise" || value === "standard") return value;
  throw new Error(
    `Invalid response style "${value}". Expected "concise" or "standard".`,
  );
}

export function loadConfig(
  overrides: ConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ConfigDependencies = {},
): KraterConfig {
  const requestedCwd = resolve(overrides.cwd ?? process.cwd());
  let cwd: string;
  try {
    cwd = realpathSync(requestedCwd);
    if (!statSync(cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`Workspace is not a directory: ${requestedCwd}`);
  }

  const file = readEnvFile(cwd);
  const gitExecutable =
    clean(overrides.gitExecutable) ??
    clean(environment.KRATER_GIT_EXECUTABLE);
  if (
    gitExecutable !== undefined &&
    (!isAbsolute(gitExecutable) ||
      gitExecutable.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(gitExecutable))
  ) {
    throw new Error(
      "The trusted Git executable must be a safe absolute host-selected path.",
    );
  }
  const commandKey = clean(overrides.apiKey);
  const environmentKey = clean(environment.KRATER_API_KEY);
  const storedKey =
    !commandKey && !environmentKey
      ? clean(
          (dependencies.readStoredCredential ?? readStoredCredentialSync)(cwd),
        )
      : undefined;
  const fileKey = clean(file.KRATER_API_KEY);
  const apiKey = commandKey ?? environmentKey ?? storedKey ?? fileKey;
  const apiKeySource = commandKey
    ? "command"
    : environmentKey
      ? "environment"
      : storedKey
        ? "credential_store"
        : fileKey
          ? ".env"
          : "missing";

  const baseURL = (
    clean(overrides.baseURL) ??
    clean(environment.KRATER_BASE_URL) ??
    clean(file.KRATER_BASE_URL) ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  let parsedBaseURL: URL;
  try {
    parsedBaseURL = new URL(baseURL);
  } catch {
    throw new Error(`Invalid Krater base URL: ${baseURL}`);
  }
  if (!["http:", "https:"].includes(parsedBaseURL.protocol)) {
    throw new Error("Krater base URL must use http or https.");
  }
  if (parsedBaseURL.username || parsedBaseURL.password) {
    throw new Error("Krater base URL must not contain embedded credentials.");
  }
  if (parsedBaseURL.search || parsedBaseURL.hash) {
    throw new Error("Krater base URL must not contain a query string or fragment.");
  }
  const loopbackBaseURL = ["127.0.0.1", "localhost", "[::1]"].includes(
    parsedBaseURL.hostname.toLowerCase(),
  );
  if (parsedBaseURL.protocol !== "https:" && !loopbackBaseURL) {
    throw new Error(
      "Krater base URL must use HTTPS unless it targets the local loopback interface.",
    );
  }

  const commandModel = clean(overrides.model);
  const environmentModel = clean(environment.KRATER_MODEL);
  const fileModel = clean(file.KRATER_MODEL);
  const model =
    commandModel ?? environmentModel ?? fileModel ?? DEFAULT_MODEL;
  const modelSource = commandModel
    ? "command"
    : environmentModel
      ? "environment"
      : fileModel
        ? ".env"
        : "default";
  const port =
    overrides.port === undefined
      ? parsePort(clean(environment.KRATER_PORT) ?? clean(file.KRATER_PORT), DEFAULT_PORT)
      : parsePort(String(overrides.port), DEFAULT_PORT);
  const host =
    clean(overrides.host) ??
    clean(environment.KRATER_HOST) ??
    clean(file.KRATER_HOST) ??
    DEFAULT_HOST;
  const contextChars = parseBoundedInteger(
    overrides.contextChars === undefined
      ? clean(environment.KRATER_CONTEXT_CHARS) ?? clean(file.KRATER_CONTEXT_CHARS)
      : String(overrides.contextChars),
    DEFAULT_CONTEXT_CHARS,
    "context character budget",
    10_000,
    2_000_000,
  );
  const toolOutputChars = parseBoundedInteger(
    overrides.toolOutputChars === undefined
      ? clean(environment.KRATER_TOOL_OUTPUT_CHARS) ??
          clean(file.KRATER_TOOL_OUTPUT_CHARS)
      : String(overrides.toolOutputChars),
    DEFAULT_TOOL_OUTPUT_CHARS,
    "tool-output character budget",
    1_000,
    250_000,
  );
  const responseStyle = parseResponseStyle(
    clean(overrides.responseStyle) ??
      clean(environment.KRATER_RESPONSE_STYLE) ??
      clean(file.KRATER_RESPONSE_STYLE),
  );
  const maxSteps = parseBoundedInteger(
    overrides.maxSteps === undefined
      ? clean(environment.KRATER_MAX_STEPS) ?? clean(file.KRATER_MAX_STEPS)
      : String(overrides.maxSteps),
    DEFAULT_MAX_STEPS,
    "maximum agent steps",
    1,
    128,
  );
  const maxOutputTokens = parseBoundedInteger(
    overrides.maxOutputTokens === undefined
      ? clean(environment.KRATER_MAX_OUTPUT_TOKENS) ??
          clean(file.KRATER_MAX_OUTPUT_TOKENS)
      : String(overrides.maxOutputTokens),
    DEFAULT_MAX_OUTPUT_TOKENS,
    "maximum output tokens",
    256,
    65_536,
  );
  const sessionTokenBudget = parseBoundedInteger(
    overrides.sessionTokenBudget === undefined
      ? clean(environment.KRATER_SESSION_TOKEN_BUDGET) ??
          clean(file.KRATER_SESSION_TOKEN_BUDGET)
      : String(overrides.sessionTokenBudget),
    DEFAULT_SESSION_TOKEN_BUDGET,
    "session token budget",
    1_000,
    10_000_000,
  );

  return {
    apiKey,
    baseURL,
    model,
    cwd,
    gitExecutable,
    port,
    host,
    contextChars,
    toolOutputChars,
    responseStyle,
    maxSteps,
    maxOutputTokens,
    sessionTokenBudget,
    apiKeySource,
    modelSource,
  };
}

export function requireApiKey(config: KraterConfig): string {
  if (!config.apiKey) {
    throw new Error(
      "Krater API key not found. Pass --api-key, set KRATER_API_KEY, or add it to .env. Run `krater setup` for hidden input and OS credential storage.",
    );
  }
  return config.apiKey;
}
