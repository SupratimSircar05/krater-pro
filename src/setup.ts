import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  link,
  lstat,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";
import { join, resolve } from "node:path";
import { KRATER_DEVELOPER_URL } from "./browser-auth.js";
import {
  type ConfigOverrides,
  type KraterConfig,
  loadConfig,
} from "./config.js";
import {
  type CredentialBackend,
  type CredentialStoreOptions,
  inspectCredentialStore,
  storeCredential,
} from "./credential-store.js";
import { isStableRegularFileIdentity } from "./file-identity.js";
import { ROUTER_FALLBACK_MODEL } from "./model-selection.js";
import {
  workspacePreferencesPath,
  writeWorkspacePreferences,
  type DefaultAssurance,
} from "./preferences.js";
import { KraterProvider } from "./provider.js";

export const SETUP_REQUIRED_EXIT_CODE = 4;
export const MISSING_API_KEY_PREFIX = "Krater API key not found.";

const ENV_TEMPLATE = [
  "# Krater Pro workspace configuration.",
  "# Add your own Krater API key below. Never commit this file.",
  "KRATER_API_KEY=",
  "KRATER_MODEL=auto",
  "",
].join("\n");
const MAX_ENVIRONMENT_FILE_BYTES = 1_000_000n;

export type SetupCredentialSource =
  | KraterConfig["apiKeySource"]
  | "hidden_input";
export type SetupPersistence =
  | "none"
  | "credential_store"
  | "environment_file";
export type SetupStatus =
  | "ready"
  | "setup_required"
  | "verification_failed"
  | "storage_unavailable";

export interface CredentialValidationResult {
  verified: boolean;
  modelCount: number;
}

export type CredentialValidator = (input: {
  apiKey: string;
  baseURL: string;
  signal?: AbortSignal;
}) => Promise<CredentialValidationResult>;

export interface SetupCredentialStatus {
  configured: boolean;
  source: SetupCredentialSource;
  verification: "not_attempted" | "verified" | "failed";
  modelCount?: number;
  persisted: boolean;
  persistence: SetupPersistence;
  backend?: CredentialBackend;
}

export interface SetupResult {
  schemaVersion: 1;
  type: "setup_status" | "setup_required";
  mode: "offline_preflight" | "authenticated_setup";
  status: SetupStatus;
  cwd: string;
  credential: SetupCredentialStatus;
  model: {
    id: string;
    source: KraterConfig["modelSource"];
  };
  preferences: {
    path: string;
    defaultAssurance: DefaultAssurance;
    source: KraterConfig["defaultAssuranceSource"];
    persisted: boolean;
  };
  project: {
    path: string;
    selected: true;
  };
  environmentFile: {
    path: string;
    exists: boolean;
    created: boolean;
    updated: boolean;
  };
  developerUrl: string;
  actions: string[];
  limitations: string[];
}

export interface SetupWorkspaceOptions {
  overrides?: ConfigOverrides;
  environment?: NodeJS.ProcessEnv;
  createEnvironmentFile?: boolean;
  credential?: string;
  validateCredential?: boolean;
  persistence?: SetupPersistence;
  validator?: CredentialValidator;
  credentialStore?: CredentialStoreOptions;
  defaultAssurance?: DefaultAssurance;
}

function requiredActions(environmentPath: string): string[] {
  return [
    `Create or retrieve an API key at ${KRATER_DEVELOPER_URL}.`,
    "Run `krater setup` in an interactive terminal for hidden input and OS credential storage.",
    `For a deliberate fallback, store KRATER_API_KEY in the owner-only ${environmentPath}.`,
  ];
}

function credentialIsWellFormed(secret: string): boolean {
  return Boolean(secret) && !/[\u0000-\u001f\u007f]/.test(secret);
}

export const validateKraterCredential: CredentialValidator = async ({
  apiKey,
  baseURL,
  signal,
}) => {
  const provider = new KraterProvider({
    apiKey,
    baseURL,
    model: ROUTER_FALLBACK_MODEL,
  });
  const models = await provider.listModels(signal);
  return {
    verified: models.length > 0,
    modelCount: models.length,
  };
};

async function validateWithTimeout(
  validator: CredentialValidator,
  input: { apiKey: string; baseURL: string },
): Promise<CredentialValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const result = await validator({ ...input, signal: controller.signal });
    return {
      verified: result.verified === true && result.modelCount > 0,
      modelCount:
        Number.isSafeInteger(result.modelCount) && result.modelCount >= 0
          ? result.modelCount
          : 0,
    };
  } catch {
    return { verified: false, modelCount: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeEnvironmentCredential(
  cwd: string,
  secret: string,
): Promise<{ created: boolean; updated: boolean }> {
  const path = join(cwd, ".env");
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(
        "The workspace .env is not a regular file; credential fallback was refused.",
      );
    }
    if (code !== "ENOENT") throw error;
    created = true;
  }
  if (handle) {
    const existingHandle = handle;
    try {
      const opened = await existingHandle.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (!isStableRegularFileIdentity(opened, current)) {
        throw new Error(
          "The workspace .env is not a regular file; credential fallback was refused.",
        );
      }
      if (opened.size < 0n || opened.size > MAX_ENVIRONMENT_FILE_BYTES) {
        throw new Error(
          "The workspace .env is too large for safe credential persistence.",
        );
      }
      const existing = parseDotenv(await existingHandle.readFile("utf8"));
      if (existing.KRATER_API_KEY === secret) {
        await existingHandle.close();
        handle = undefined;
        return { created: false, updated: false };
      }
      throw new Error(
        "The workspace .env already exists. To avoid overwriting concurrent or unrelated settings, edit KRATER_API_KEY there manually or use the OS credential store.",
      );
    } catch (error) {
      await existingHandle.close().catch(() => undefined);
      handle = undefined;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "The workspace .env changed while it was opened; credential fallback was refused.",
        );
      }
      throw error;
    }
  }

  const assignment = `KRATER_API_KEY=${JSON.stringify(secret)}`;
  const contents = `${assignment}\nKRATER_MODEL=auto\n`;
  const temporary = join(cwd, `.env.krater-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (created) {
      try {
        // A hard link publishes the complete temporary file only if `.env`
        // is still absent; unlike rename, it never replaces a concurrent file.
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            "The workspace .env was created concurrently; credential persistence was refused.",
          );
        }
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { created, updated: false };
}

function offlineResult(
  config: KraterConfig,
  environmentFileExists: boolean,
  environmentFileCreated: boolean,
  requestedDefaultAssurance?: DefaultAssurance,
): SetupResult {
  const environmentPath = join(config.cwd, ".env");
  const configured = Boolean(config.apiKey);
  return {
    schemaVersion: 1,
    type: configured ? "setup_status" : "setup_required",
    mode: "offline_preflight",
    status: configured ? "ready" : "setup_required",
    cwd: config.cwd,
    credential: {
      configured,
      source: config.apiKeySource,
      verification: "not_attempted",
      persisted:
        config.apiKeySource === "credential_store" ||
        config.apiKeySource === ".env",
      persistence:
        config.apiKeySource === "credential_store"
          ? "credential_store"
          : config.apiKeySource === ".env"
            ? "environment_file"
            : "none",
    },
    model: {
      id: config.model,
      source: config.modelSource,
    },
    preferences: {
      path: workspacePreferencesPath(config.cwd),
      defaultAssurance:
        requestedDefaultAssurance ?? config.defaultAssurance,
      source: requestedDefaultAssurance
        ? "command"
        : config.defaultAssuranceSource,
      persisted: config.defaultAssuranceSource === "workspace_preferences",
    },
    project: {
      path: config.cwd,
      selected: true,
    },
    environmentFile: {
      path: environmentPath,
      exists: environmentFileExists,
      created: environmentFileCreated,
      updated: false,
    },
    developerUrl: KRATER_DEVELOPER_URL,
    actions: configured ? [] : requiredActions(environmentPath),
    limitations: [
      "API access was not verified.",
      "No credential value was captured or changed.",
    ],
  };
}

export async function setupWorkspace(
  options: SetupWorkspaceOptions = {},
): Promise<SetupResult> {
  const environment = options.environment ?? process.env;
  const config = loadConfig(options.overrides, environment);
  const environmentPath = join(config.cwd, ".env");
  let environmentFileExists = false;
  let environmentFileCreated = false;

  const shouldCreateEnvironmentFile =
    !config.apiKey &&
    !options.credential &&
    options.createEnvironmentFile === true;
  if (shouldCreateEnvironmentFile) {
    try {
      await writeFile(environmentPath, ENV_TEMPLATE, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      environmentFileExists = true;
      environmentFileCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      environmentFileExists = true;
    }
  } else {
    environmentFileExists = existsSync(environmentPath);
  }

  const candidate = options.credential ?? config.apiKey;
  if (!options.validateCredential) {
    return offlineResult(
      config,
      environmentFileExists,
      environmentFileCreated,
      options.defaultAssurance,
    );
  }
  if (!candidate || !credentialIsWellFormed(candidate)) {
    return offlineResult(
      config,
      environmentFileExists,
      environmentFileCreated,
      options.defaultAssurance,
    );
  }

  const validation = await validateWithTimeout(
    options.validator ?? validateKraterCredential,
    {
      apiKey: candidate,
      baseURL: config.baseURL,
    },
  );
  const requestedPersistence = options.persistence ?? "none";
  const source: SetupCredentialSource = options.credential
    ? "hidden_input"
    : config.apiKeySource;
  const existingPersistence: SetupPersistence =
    source === "credential_store"
      ? "credential_store"
      : source === ".env"
        ? "environment_file"
        : "none";
  const baseResult: SetupResult = {
    schemaVersion: 1,
    type: "setup_status",
    mode: "authenticated_setup",
    status: validation.verified ? "ready" : "verification_failed",
    cwd: config.cwd,
    credential: {
      configured: true,
      source,
      verification: validation.verified ? "verified" : "failed",
      modelCount: validation.modelCount,
      persisted: !options.credential && existingPersistence !== "none",
      persistence: options.credential ? "none" : existingPersistence,
    },
    model: {
      id: config.model,
      source: config.modelSource,
    },
    preferences: {
      path: workspacePreferencesPath(config.cwd),
      defaultAssurance:
        options.defaultAssurance ?? config.defaultAssurance,
      source: options.defaultAssurance
        ? "command"
        : config.defaultAssuranceSource,
      persisted: config.defaultAssuranceSource === "workspace_preferences",
    },
    project: {
      path: config.cwd,
      selected: true,
    },
    environmentFile: {
      path: environmentPath,
      exists: environmentFileExists,
      created: environmentFileCreated,
      updated: false,
    },
    developerUrl: KRATER_DEVELOPER_URL,
    actions: [],
    limitations: [],
  };
  if (!validation.verified) {
    baseResult.actions.push(
      "Confirm the key has Krater API access, then run setup again.",
    );
    return baseResult;
  }
  const persistPreferences = async (): Promise<void> => {
    if (!options.defaultAssurance) return;
    const path = await writeWorkspacePreferences(config.cwd, {
      schemaVersion: 1,
      defaultAssurance: options.defaultAssurance,
    });
    baseResult.preferences = {
      path,
      defaultAssurance: options.defaultAssurance,
      source: "workspace_preferences",
      persisted: true,
    };
  };
  if (!options.credential || requestedPersistence === "none") {
    await persistPreferences();
    if (options.credential) {
      baseResult.actions.push(
        "The verified key was not persisted; provide KRATER_API_KEY again for future commands.",
      );
    }
    return baseResult;
  }

  if (requestedPersistence === "credential_store") {
    const stored = await storeCredential(
      config.cwd,
      candidate,
      options.credentialStore,
    );
    if (!stored.stored) {
      baseResult.status = "storage_unavailable";
      baseResult.credential.backend = stored.backend;
      baseResult.actions.push(stored.reason);
      baseResult.actions.push(
        "Choose the explicitly disclosed owner-only .env fallback or leave the key unpersisted.",
      );
      return baseResult;
    }
    baseResult.credential = {
      ...baseResult.credential,
      source: "credential_store",
      persisted: true,
      persistence: "credential_store",
      backend: stored.backend,
    };
    await persistPreferences();
    return baseResult;
  }

  const environmentWrite = await writeEnvironmentCredential(
    config.cwd,
    candidate,
  );
  baseResult.credential = {
    ...baseResult.credential,
    source: ".env",
    persisted: true,
    persistence: "environment_file",
  };
  baseResult.environmentFile = {
    path: environmentPath,
    exists: true,
    created: environmentWrite.created,
    updated: environmentWrite.updated,
  };
  baseResult.limitations.push(
    "The key is stored as plaintext in an owner-only workspace file.",
  );
  await persistPreferences();
  return baseResult;
}

export async function credentialStoreStatus(
  options: CredentialStoreOptions = {},
) {
  return inspectCredentialStore(options);
}

export function createSetupRequiredResult(cwd: string): SetupResult {
  const resolvedCwd = resolve(cwd);
  const environmentPath = join(resolvedCwd, ".env");
  return {
    schemaVersion: 1,
    type: "setup_required",
    mode: "offline_preflight",
    status: "setup_required",
    cwd: resolvedCwd,
    credential: {
      configured: false,
      source: "missing",
      verification: "not_attempted",
      persisted: false,
      persistence: "none",
    },
    model: {
      id: "auto",
      source: "default",
    },
    preferences: {
      path: workspacePreferencesPath(resolvedCwd),
      defaultAssurance: "standard",
      source: "default",
      persisted: false,
    },
    project: {
      path: resolvedCwd,
      selected: true,
    },
    environmentFile: {
      path: environmentPath,
      exists: existsSync(environmentPath),
      created: false,
      updated: false,
    },
    developerUrl: KRATER_DEVELOPER_URL,
    actions: requiredActions(environmentPath),
    limitations: [
      "API access was not verified.",
      "No credential value was captured or changed.",
    ],
  };
}

export function isSetupRequiredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(MISSING_API_KEY_PREFIX)
  );
}

export function renderSetupResult(
  result: SetupResult,
  json = false,
): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;

  if (
    result.status === "verification_failed" ||
    result.status === "storage_unavailable"
  ) {
    return [
      result.status === "verification_failed"
        ? "Krater could not verify API/model access."
        : "The key was verified, but safe credential persistence is unavailable.",
      `Workspace: ${result.cwd}`,
      ...result.actions.map((action) => `Next: ${action}`),
      "No credential value was printed.",
      "",
    ].join("\n");
  }
  if (result.status === "ready") {
    const verification =
      result.credential.verification === "verified"
        ? `verified by authenticated model discovery (${result.credential.modelCount ?? 0} model(s))`
        : "configured but not live-verified";
    const persistence = result.credential.persisted
      ? `stored via ${result.credential.persistence}`
      : "not persisted by setup";
    return [
      "Krater Pro configuration is ready.",
      `Workspace: ${result.cwd}`,
      `Credential: ${verification}; ${persistence}`,
      `Model: ${result.model.id} (${result.model.source})`,
      `Trust dial: ${result.preferences.defaultAssurance} (${result.preferences.source})`,
      `Initial project: ${result.project.path}`,
      ...result.actions.map((action) => `Next: ${action}`),
      "",
    ].join("\n");
  }

  const environmentState = result.environmentFile.created
    ? "created with private owner-only permissions"
    : result.environmentFile.exists
      ? "already exists and was not changed"
      : "not created";
  return [
    "Setup required: no Krater API key is configured.",
    `Workspace: ${result.cwd}`,
    `.env: ${environmentState}`,
    ...result.actions.map((action, index) => `${index + 1}. ${action}`),
    "Krater Pro never reads browser cookies or prints credential values.",
    "",
  ].join("\n");
}
