import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { windowsSystemExecutable } from "./windows-system-executable.js";

const KEYCHAIN_SERVICE = "com.supratimsircar.kraterpro.api-key";
const SECRET_SERVICE_APPLICATION = "krater-pro";
const DPAPI_REGISTRY_PATH = String.raw`Software\KraterPro\Credentials`;
const WINDOWS_DPAPI_POWERSHELL =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

export type CredentialBackend =
  "macos_keychain" | "linux_secret_service" | "windows_dpapi";

export interface CredentialStoreStatus {
  available: boolean;
  backend?: CredentialBackend;
  reason: string;
}

export interface CredentialStoreResult {
  stored: boolean;
  backend?: CredentialBackend;
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
}

function workspaceAccount(cwd: string): string {
  return `workspace-${createHash("sha256")
    // Use the selected lexical path, not realpath(), so an ancestor swap cannot
    // select another workspace's credential between verification and use.
    .update(resolve(cwd))
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
    // CurrentUser DPAPI locates its master-key material through the loaded
    // Windows profile. Preserve only the non-secret identity/location values
    // required by that OS service; executable selection remains fixed and
    // independent of all of them.
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "USERNAME",
    "USERDOMAIN",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function spawnCompatibleSecretExecutable(executable: string): string {
  return process.platform === "win32" &&
    executable === WINDOWS_DPAPI_POWERSHELL
    ? windowsSystemExecutable("powershell.exe")
    : executable;
}

const defaultRunner: SecretCommandRunner = (executable, args, stdin) =>
  new Promise((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnCompatibleSecretExecutable(executable), [...args], {
        env: safeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolveRun({ ok: false, stdout: "" });
      return;
    }
    if (!child.stdin || !child.stdout) {
      child.kill();
      resolveRun({ ok: false, stdout: "" });
      return;
    }
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
  try {
    const result = spawnSync(
      spawnCompatibleSecretExecutable(executable),
      [...args],
      {
        env: safeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
    return {
      ok: result.status === 0 && !result.error,
      stdout:
        typeof result.stdout === "string"
          ? result.stdout.slice(0, 64 * 1024)
          : "",
    };
  } catch {
    return { ok: false, stdout: "" };
  }
};

function backendForPlatform(
  platform: NodeJS.Platform,
): CredentialBackend | undefined {
  if (platform === "darwin") return "macos_keychain";
  if (platform === "linux") return "linux_secret_service";
  if (platform === "win32") return "windows_dpapi";
  return undefined;
}

function backendExecutable(backend: CredentialBackend): {
  executable: string;
  probeArgs: readonly string[];
} {
  switch (backend) {
    case "macos_keychain":
      return { executable: "/usr/bin/security", probeArgs: ["help"] };
    case "linux_secret_service":
      return { executable: "/usr/bin/secret-tool", probeArgs: ["--help"] };
    case "windows_dpapi":
      return {
        executable: WINDOWS_DPAPI_POWERSHELL,
        probeArgs: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodedPowerShellCommand(DPAPI_PROBE_SCRIPT),
        ],
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

function cleanRetrievedSecret(value: string): string | undefined {
  const secret = value.replace(/[\r\n]+$/, "");
  if (!secret || /[\u0000-\u001f\u007f]/.test(secret)) return undefined;
  return secret;
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const DPAPI_PROBE_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$plain = [byte[]](75, 82, 65, 84, 69, 82)",
  "$protected = $null",
  "$roundtrip = $null",
  "try { $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); $roundtrip = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); if ($roundtrip.Length -ne $plain.Length) { exit 3 }; for ($index = 0; $index -lt $plain.Length; $index += 1) { if ($roundtrip[$index] -ne $plain[$index]) { exit 3 } } } finally { [Array]::Clear($plain, 0, $plain.Length); if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }; if ($null -ne $roundtrip) { [Array]::Clear($roundtrip, 0, $roundtrip.Length) } }",
].join("; ");

function powerShellAccountLiteral(account: string): string {
  if (!/^workspace-[a-f0-9]{24}$/.test(account)) {
    throw new Error("Credential account identity is invalid.");
  }
  return `'${account}'`;
}

function dpapiReadScript(account: string): string {
  return [
    "Add-Type -AssemblyName System.Security",
    `$keyPath = '${DPAPI_REGISTRY_PATH}'`,
    `$name = ${powerShellAccountLiteral(account)}`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)",
    "if ($null -eq $key) { exit 2 }",
    "try { $protected = $key.GetValue($name, $null) } finally { $key.Dispose() }",
    "if (-not ($protected -is [byte[]]) -or $protected.Length -eq 0) { exit 2 }",
    "$plain = $null",
    "try { $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) } finally { if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }; [Array]::Clear($protected, 0, $protected.Length) }",
  ].join("; ");
}

function dpapiWriteScript(account: string): string {
  return [
    "Add-Type -AssemblyName System.Security",
    `$keyPath = '${DPAPI_REGISTRY_PATH}'`,
    `$name = ${powerShellAccountLiteral(account)}`,
    "$plainText = [Console]::In.ReadToEnd()",
    "$plain = [Text.Encoding]::UTF8.GetBytes($plainText)",
    "$plainText = $null",
    "$protected = $null",
    "$key = $null",
    "try { $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath, $true); if ($null -eq $key) { throw 'Credential registry key is unavailable.' }; $key.SetValue($name, $protected, [Microsoft.Win32.RegistryValueKind]::Binary) } finally { if ($null -ne $key) { $key.Dispose() }; [Array]::Clear($plain, 0, $plain.Length); if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) } }",
  ].join("; ");
}

export function readStoredCredentialSync(
  cwd: string,
  options: CredentialStoreOptions = {},
): string | undefined {
  const backend = backendForPlatform(options.platform ?? process.platform);
  if (!backend) return undefined;
  const account = workspaceAccount(cwd);
  const reader = options.reader ?? defaultReader;
  let result: CommandResult;
  switch (backend) {
    case "macos_keychain":
      result = reader(backendExecutable(backend).executable, [
        "find-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      break;
    case "linux_secret_service":
      result = reader(backendExecutable(backend).executable, [
        "lookup",
        "application",
        SECRET_SERVICE_APPLICATION,
        "account",
        account,
      ]);
      break;
    case "windows_dpapi":
      result = reader(backendExecutable(backend).executable, [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShellCommand(dpapiReadScript(account)),
      ]);
      break;
  }
  return result.ok ? cleanRetrievedSecret(result.stdout) : undefined;
}

export async function storeCredential(
  cwd: string,
  secret: string,
  options: CredentialStoreOptions = {},
): Promise<CredentialStoreResult> {
  if (!secret || /[\u0000-\u001f\u007f]/.test(secret)) {
    return {
      stored: false,
      reason:
        "The credential is empty or contains unsupported control characters.",
    };
  }
  // Compute the account before yielding to the backend probe so a runner cannot
  // redirect a relative workspace by changing process.cwd() afterward.
  const account = workspaceAccount(cwd);
  const status = await inspectCredentialStore(options);
  if (!status.available || !status.backend) {
    return {
      stored: false,
      ...(status.backend ? { backend: status.backend } : {}),
      reason: status.reason,
    };
  }
  const runner = options.runner ?? defaultRunner;
  let command: {
    executable: string;
    args: readonly string[];
    stdin: string;
  };
  switch (status.backend) {
    case "macos_keychain":
      command = {
        executable: backendExecutable(status.backend).executable,
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
        executable: backendExecutable(status.backend).executable,
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
        executable: backendExecutable(status.backend).executable,
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodedPowerShellCommand(dpapiWriteScript(account)),
        ],
        stdin: secret,
      };
      break;
  }
  const stored = await runner(command.executable, command.args, command.stdin);
  if (!stored.ok) {
    return {
      stored: false,
      backend: status.backend,
      reason: "The operating-system credential backend rejected the write.",
    };
  }
  return {
    stored: true,
    backend: status.backend,
    reason: status.reason,
  };
}
