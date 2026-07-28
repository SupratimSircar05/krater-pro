import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const MARKER_SCHEMA_VERSION = 1;
const KEYCHAIN_SERVICE = "com.supratimsircar.kraterpro.api-key";
const SECRET_SERVICE_APPLICATION = "krater-pro";

export type CredentialBackend =
  | "macos_keychain"
  | "linux_secret_service"
  | "windows_dpapi";

export interface CredentialMarker {
  schemaVersion: 1;
  backend: CredentialBackend;
  account: string;
  createdAt: string;
}

export interface CredentialStoreStatus {
  available: boolean;
  backend?: CredentialBackend;
  reason: string;
}

export interface CredentialStoreResult {
  stored: boolean;
  backend?: CredentialBackend;
  markerPath: string;
  reason: string;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
}

export type SecretCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin: string | undefined,
) => Promise<CommandResult>;

export type SecretCommandReader = (
  executable: string,
  args: readonly string[],
) => CommandResult;

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  runner?: SecretCommandRunner;
  reader?: SecretCommandReader;
  now?: () => string;
}

function canonicalWorkspace(cwd: string): string {
  const requested = resolve(cwd);
  try {
    return realpathSync(requested);
  } catch {
    return requested;
  }
}

function credentialDirectory(cwd: string): string {
  return join(canonicalWorkspace(cwd), ".krater", "credentials");
}

export function credentialMarkerPath(cwd: string): string {
  return join(credentialDirectory(cwd), "credential-handle.json");
}

function dpapiBlobPath(cwd: string): string {
  return join(credentialDirectory(cwd), "api-key.dpapi");
}

function workspaceAccount(cwd: string): string {
  return `workspace-${createHash("sha256")
    .update(canonicalWorkspace(cwd))
    .digest("hex")
    .slice(0, 24)}`;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

const defaultRunner: SecretCommandRunner = (
  executable,
  args,
  stdin,
) =>
  new Promise((resolveRun) => {
    const child = spawn(executable, [...args], {
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout: "" });
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 4_096) {
        stdout += chunk.slice(0, 4_096 - stdout.length);
      }
    });
    child.once("error", () => finish({ ok: false, stdout: "" }));
    child.once("close", (code) =>
      finish({ ok: code === 0, stdout: stdout.slice(0, 4_096) }),
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

const defaultReader: SecretCommandReader = (executable, args) => {
  const result = spawnSync(executable, [...args], {
    env: safeEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout:
      typeof result.stdout === "string"
        ? result.stdout.slice(0, 64 * 1024)
        : "",
  };
};

function backendForPlatform(
  platform: NodeJS.Platform,
): CredentialBackend | undefined {
  if (platform === "darwin") return "macos_keychain";
  if (platform === "linux") return "linux_secret_service";
  if (platform === "win32") return "windows_dpapi";
  return undefined;
}

function backendExecutable(
  backend: CredentialBackend,
): { executable: string; probeArgs: readonly string[] } {
  switch (backend) {
    case "macos_keychain":
      return { executable: "security", probeArgs: ["help"] };
    case "linux_secret_service":
      return { executable: "secret-tool", probeArgs: ["--help"] };
    case "windows_dpapi":
      return {
        executable: "powershell.exe",
        probeArgs: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      };
  }
}

export async function inspectCredentialStore(
  options: CredentialStoreOptions = {},
): Promise<CredentialStoreStatus> {
  const platform = options.platform ?? process.platform;
  const backend = backendForPlatform(platform);
  if (!backend) {
    return {
      available: false,
      reason: `No audited credential backend is implemented for ${platform}.`,
    };
  }
  const command = backendExecutable(backend);
  const probe = await (options.runner ?? defaultRunner)(
    command.executable,
    command.probeArgs,
    undefined,
  );
  if (!probe.ok) {
    return {
      available: false,
      backend,
      reason:
        backend === "linux_secret_service"
          ? "Secret Service is unavailable. Install secret-tool and start a Secret Service session."
          : `${command.executable} is unavailable.`,
    };
  }
  return {
    available: true,
    backend,
    reason:
      backend === "macos_keychain"
        ? "macOS Keychain is available."
        : backend === "linux_secret_service"
          ? "Linux Secret Service is available."
          : "Windows DPAPI is available.",
  };
}

function markerIsValid(
  value: unknown,
  cwd: string,
): value is CredentialMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Partial<CredentialMarker>;
  return (
    marker.schemaVersion === MARKER_SCHEMA_VERSION &&
    ["macos_keychain", "linux_secret_service", "windows_dpapi"].includes(
      String(marker.backend),
    ) &&
    marker.account === workspaceAccount(cwd) &&
    typeof marker.createdAt === "string" &&
    Number.isFinite(Date.parse(marker.createdAt))
  );
}

export function readCredentialMarker(
  cwd: string,
): CredentialMarker | undefined {
  const path = credentialMarkerPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return markerIsValid(parsed, cwd) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cleanRetrievedSecret(value: string): string | undefined {
  const secret = value.replace(/[\r\n]+$/, "");
  if (!secret || /[\u0000-\u001f\u007f]/.test(secret)) return undefined;
  return secret;
}

const DPAPI_READ_SCRIPT = [
  "$path = $args[0]",
  "if (-not (Test-Path -LiteralPath $path)) { exit 2 }",
  "$protected = [IO.File]::ReadAllBytes($path)",
  "$plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
].join("; ");

const DPAPI_WRITE_SCRIPT = [
  "$path = $args[0]",
  "$plainText = [Console]::In.ReadToEnd()",
  "$plain = [Text.Encoding]::UTF8.GetBytes($plainText)",
  "$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[IO.File]::WriteAllBytes($path, $protected)",
  "[Array]::Clear($plain, 0, $plain.Length)",
].join("; ");

export function readStoredCredentialSync(
  cwd: string,
  options: CredentialStoreOptions = {},
): string | undefined {
  const marker = readCredentialMarker(cwd);
  if (!marker) return undefined;
  const reader = options.reader ?? defaultReader;
  let result: CommandResult;
  switch (marker.backend) {
    case "macos_keychain":
      result = reader("security", [
        "find-generic-password",
        "-a",
        marker.account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      break;
    case "linux_secret_service":
      result = reader("secret-tool", [
        "lookup",
        "application",
        SECRET_SERVICE_APPLICATION,
        "account",
        marker.account,
      ]);
      break;
    case "windows_dpapi":
      result = reader("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        DPAPI_READ_SCRIPT,
        dpapiBlobPath(cwd),
      ]);
      break;
  }
  return result.ok ? cleanRetrievedSecret(result.stdout) : undefined;
}

async function writeMarker(
  cwd: string,
  marker: CredentialMarker,
): Promise<void> {
  const directory = credentialDirectory(cwd);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const path = credentialMarkerPath(cwd);
  const temporary = join(directory, `.credential-handle-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function storeCredential(
  cwd: string,
  secret: string,
  options: CredentialStoreOptions = {},
): Promise<CredentialStoreResult> {
  const markerPath = credentialMarkerPath(cwd);
  if (!secret || /[\u0000-\u001f\u007f]/.test(secret)) {
    return {
      stored: false,
      markerPath,
      reason: "The credential is empty or contains unsupported control characters.",
    };
  }
  const status = await inspectCredentialStore(options);
  if (!status.available || !status.backend) {
    return {
      stored: false,
      ...(status.backend ? { backend: status.backend } : {}),
      markerPath,
      reason: status.reason,
    };
  }
  const runner = options.runner ?? defaultRunner;
  const account = workspaceAccount(cwd);
  await mkdir(credentialDirectory(cwd), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(credentialDirectory(cwd), 0o700);
  }
  let command: {
    executable: string;
    args: readonly string[];
    stdin: string;
  };
  switch (status.backend) {
    case "macos_keychain":
      command = {
        executable: "security",
        args: [
          "add-generic-password",
          "-U",
          "-a",
          account,
          "-s",
          KEYCHAIN_SERVICE,
          "-l",
          "Krater Pro API key",
          "-w",
        ],
        stdin: `${secret}\n`,
      };
      break;
    case "linux_secret_service":
      command = {
        executable: "secret-tool",
        args: [
          "store",
          "--label=Krater Pro API key",
          "application",
          SECRET_SERVICE_APPLICATION,
          "account",
          account,
        ],
        stdin: secret,
      };
      break;
    case "windows_dpapi":
      command = {
        executable: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          DPAPI_WRITE_SCRIPT,
          dpapiBlobPath(cwd),
        ],
        stdin: secret,
      };
      break;
  }
  try {
    await writeMarker(cwd, {
      schemaVersion: MARKER_SCHEMA_VERSION,
      backend: status.backend,
      account,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
    });
  } catch {
    return {
      stored: false,
      backend: status.backend,
      markerPath,
      reason:
        "The local credential handle could not be recorded, so the key was not sent to the credential backend.",
    };
  }
  const stored = await runner(command.executable, command.args, command.stdin);
  if (!stored.ok) {
    await rm(markerPath, { force: true }).catch(() => undefined);
    if (status.backend === "windows_dpapi") {
      await rm(dpapiBlobPath(cwd), { force: true }).catch(() => undefined);
    }
    return {
      stored: false,
      backend: status.backend,
      markerPath,
      reason: "The operating-system credential backend rejected the write.",
    };
  }
  return {
    stored: true,
    backend: status.backend,
    markerPath,
    reason: status.reason,
  };
}
