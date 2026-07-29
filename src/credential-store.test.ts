import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  type SecretCommandReader,
  type SecretCommandRunner,
  inspectCredentialStore,
  readStoredCredentialSync,
  storeCredential,
} from "./credential-store.js";
import { windowsSystemExecutable } from "./windows-system-executable.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-credential-store-"));
  temporaryPaths.push(path);
  return path;
}

function expectedWorkspaceAccount(cwd: string): string {
  return `workspace-${createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 24)}`;
}

function decodedPowerShellCommand(args: readonly string[]): string {
  const encodedCommandIndex = args.indexOf("-EncodedCommand");
  const encodedCommand = args[encodedCommandIndex + 1];
  if (encodedCommandIndex < 0 || !encodedCommand) {
    throw new Error("Expected an encoded PowerShell command.");
  }
  return Buffer.from(encodedCommand, "base64").toString("utf16le");
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("credential store", () => {
  it.runIf(process.platform === "win32")(
    "probes the live Windows DPAPI backend through canonical PowerShell",
    async () => {
      await expect(inspectCredentialStore()).resolves.toMatchObject({
        available: true,
        backend: "windows_dpapi",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "round-trips a live DPAPI credential through canonical PowerShell",
    async () => {
      const cwd = await temporaryDirectory();
      const credentialValue = ["krater", "windows", "roundtrip"].join("-");
      const account = expectedWorkspaceAccount(cwd);
      const canonicalPowerShell = windowsSystemExecutable("powershell.exe");
      const cleanupScript = [
        `$keyPath = 'Software\\KraterPro\\Credentials'`,
        `$name = '${account}'`,
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)",
        "if ($null -ne $key) { try { $key.DeleteValue($name, $false) } finally { $key.Dispose() } }",
      ].join("; ");

      try {
        expect(canonicalPowerShell).toMatch(
          /^[a-z]:\\.+\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/i,
        );
        await expect(storeCredential(cwd, credentialValue)).resolves.toMatchObject(
          {
            stored: true,
            backend: "windows_dpapi",
          },
        );
        expect(readStoredCredentialSync(cwd)).toBe(credentialValue);
      } finally {
        const cleanup = spawnSync(
          canonicalPowerShell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encodedPowerShellCommand(cleanupScript),
          ],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
            timeout: 5_000,
          },
        );
        expect(cleanup.error).toBeUndefined();
        expect(cleanup.status).toBe(0);
      }
    },
    20_000,
  );

  it("passes a macOS credential only through stdin and leaves no workspace marker", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["unit", "credential", "alpha"].join("-");
    const calls: Array<{
      executable: string;
      args: readonly string[];
      stdin: string | undefined;
    }> = [];
    const runner: SecretCommandRunner = async (executable, args, stdin) => {
      calls.push({ executable, args, stdin });
      return { ok: true, stdout: "" };
    };

    const result = await storeCredential(cwd, credentialValue, {
      platform: "darwin",
      runner,
    });

    expect(result).toMatchObject({
      stored: true,
      backend: "macos_keychain",
    });
    expect(result).not.toHaveProperty("markerPath");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.executable)).toEqual([
      "/usr/bin/security",
      "/usr/bin/security",
    ]);
    expect(calls[1]?.args.at(-1)).toBe("-w");
    expect(calls[1]?.stdin).toBe(`${credentialValue}\n`);
    for (const call of calls) {
      expect(call.executable).not.toContain(credentialValue);
      expect(call.args.join(" ")).not.toContain(credentialValue);
      expect(call.args.join(" ")).not.toContain(cwd);
    }
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it("resolves the deterministic host account without a workspace marker", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["unit", "credential", "beta"].join("-");
    let selectedWorkspace = cwd;
    const reader: SecretCommandReader = vi.fn((executable, args) => {
      expect(executable).toBe("/usr/bin/security");
      expect(args).toContain(expectedWorkspaceAccount(selectedWorkspace));
      expect(args.join(" ")).not.toContain(selectedWorkspace);
      expect(args.join(" ")).not.toContain(credentialValue);
      return { ok: true, stdout: `${credentialValue}\n` };
    });

    expect(readStoredCredentialSync(cwd, { platform: "darwin", reader })).toBe(
      credentialValue,
    );
    expect(reader).toHaveBeenCalledOnce();
    vi.mocked(reader).mockClear();

    const config = loadConfig(
      { cwd },
      {},
      {
        readStoredCredential: (workspace) => {
          selectedWorkspace = workspace;
          return readStoredCredentialSync(workspace, {
            platform: "darwin",
            reader,
          });
        },
      },
    );
    expect(config.apiKey).toBe(credentialValue);
    expect(config.apiKeySource).toBe("credential_store");
    expect(reader).toHaveBeenCalledOnce();
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it("does not follow a hostile legacy marker through a symlinked ancestor", async () => {
    if (process.platform === "win32") return;
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideMarker = join(outside, "credential-handle.json");
    const markerBytes = JSON.stringify({
      schemaVersion: 1,
      backend: "linux_secret_service",
      account: "attacker-selected-account",
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    await writeFile(outsideMarker, markerBytes, { mode: 0o600 });
    await symlink(outside, join(cwd, ".krater"));
    const reader: SecretCommandReader = vi.fn((executable, args) => {
      expect(executable).toBe("/usr/bin/security");
      expect(args).toContain(expectedWorkspaceAccount(cwd));
      expect(args).not.toContain("attacker-selected-account");
      return { ok: true, stdout: "host-owned-credential\n" };
    });

    expect(readStoredCredentialSync(cwd, { platform: "darwin", reader })).toBe(
      "host-owned-credential",
    );
    expect(reader).toHaveBeenCalledOnce();
    await expect(readFile(outsideMarker, "utf8")).resolves.toBe(markerBytes);
  });

  it("cannot redirect a DPAPI write or cleanup with an ancestor swap and restore", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const credentialValue = ["unit", "credential", "swap-write"].join("-");
    const kraterDirectory = join(cwd, ".krater");
    const parkedDirectory = join(cwd, ".krater-parked");
    const credentialsDirectory = join(kraterDirectory, "credentials");
    const outsideCredentials = join(outside, "credentials");
    const legacyMarker = join(credentialsDirectory, "credential-handle.json");
    const legacyBlob = join(credentialsDirectory, "api-key.dpapi");
    const outsideSentinel = join(outside, "outside-sentinel.txt");
    await mkdir(credentialsDirectory, { recursive: true });
    await mkdir(outsideCredentials);
    await writeFile(legacyMarker, "legacy-marker-must-remain");
    await writeFile(legacyBlob, "legacy-blob-must-remain");
    await writeFile(outsideSentinel, "outside-must-remain");
    let backendArgs: readonly string[] | undefined;
    let backendExecutable = "";
    let callCount = 0;
    const runner: SecretCommandRunner = async (executable, args, stdin) => {
      callCount += 1;
      if (stdin === undefined) return { ok: true, stdout: "" };
      backendExecutable = executable;
      backendArgs = args;
      expect(stdin).toBe(credentialValue);

      await rename(kraterDirectory, parkedDirectory);
      await rename(outside, kraterDirectory);
      try {
        const pathArgument = args.at(-1);
        if (pathArgument?.startsWith(cwd)) {
          await writeFile(pathArgument, `redirected-${credentialValue}`);
        }
        return { ok: false, stdout: "" };
      } finally {
        await rename(kraterDirectory, outside);
        await rename(parkedDirectory, kraterDirectory);
      }
    };

    const result = await storeCredential(cwd, credentialValue, {
      platform: "win32",
      runner,
    });

    expect(result).toMatchObject({
      stored: false,
      backend: "windows_dpapi",
    });
    expect(result).not.toHaveProperty("markerPath");
    expect(callCount).toBe(2);
    expect(backendExecutable).toBe(
      String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(backendArgs).toContain("-EncodedCommand");
    const backendScript = decodedPowerShellCommand(backendArgs ?? []);
    expect(backendScript).toContain(expectedWorkspaceAccount(cwd));
    expect(backendScript).toContain("[Microsoft.Win32.Registry]::CurrentUser");
    expect(backendScript).not.toMatch(
      /\[IO\.File\]|WriteAllBytes|api-key\.dpapi/,
    );
    expect(backendArgs?.join(" ")).not.toContain(cwd);
    expect(backendArgs?.join(" ")).not.toContain(outside);
    expect(backendArgs?.join(" ")).not.toContain(credentialValue);
    await expect(readFile(outsideSentinel, "utf8")).resolves.toBe(
      "outside-must-remain",
    );
    await expect(readdir(outsideCredentials)).resolves.toEqual([]);
    await expect(readFile(legacyMarker, "utf8")).resolves.toBe(
      "legacy-marker-must-remain",
    );
    await expect(readFile(legacyBlob, "utf8")).resolves.toBe(
      "legacy-blob-must-remain",
    );
  });

  it("cannot redirect a DPAPI read with an ancestor swap and restore", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const credentialValue = ["unit", "credential", "swap-read"].join("-");
    const kraterDirectory = join(cwd, ".krater");
    const parkedDirectory = join(cwd, ".krater-parked");
    const credentialsDirectory = join(kraterDirectory, "credentials");
    const outsideCredentials = join(outside, "credentials");
    const legacyBlob = join(credentialsDirectory, "api-key.dpapi");
    const outsideBlob = join(outsideCredentials, "api-key.dpapi");
    await mkdir(credentialsDirectory, { recursive: true });
    await mkdir(outsideCredentials);
    await writeFile(
      join(credentialsDirectory, "credential-handle.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        backend: "windows_dpapi",
        account: expectedWorkspaceAccount(cwd),
        createdAt: "2026-07-28T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(legacyBlob, "legacy-protected-bytes");
    await writeFile(outsideBlob, "outside-secret-must-not-be-read");
    let backendArgs: readonly string[] | undefined;
    const reader: SecretCommandReader = vi.fn((executable, args) => {
      expect(executable).toBe(
        String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      backendArgs = args;
      renameSync(kraterDirectory, parkedDirectory);
      renameSync(outside, kraterDirectory);
      try {
        const pathArgument = args.at(-1);
        return {
          ok: true,
          stdout: pathArgument?.startsWith(cwd)
            ? readFileSync(pathArgument, "utf8")
            : `${credentialValue}\n`,
        };
      } finally {
        renameSync(kraterDirectory, outside);
        renameSync(parkedDirectory, kraterDirectory);
      }
    });

    expect(readStoredCredentialSync(cwd, { platform: "win32", reader })).toBe(
      credentialValue,
    );
    expect(reader).toHaveBeenCalledOnce();
    expect(backendArgs).toContain("-EncodedCommand");
    const backendScript = decodedPowerShellCommand(backendArgs ?? []);
    expect(backendScript).toContain(expectedWorkspaceAccount(cwd));
    expect(backendScript).toContain("[Microsoft.Win32.Registry]::CurrentUser");
    expect(backendScript).not.toMatch(
      /\[IO\.File\]|ReadAllBytes|api-key\.dpapi/,
    );
    expect(backendArgs?.join(" ")).not.toContain(cwd);
    expect(backendArgs?.join(" ")).not.toContain(outside);
    await expect(readFile(outsideBlob, "utf8")).resolves.toBe(
      "outside-secret-must-not-be-read",
    );
    await expect(readFile(legacyBlob, "utf8")).resolves.toBe(
      "legacy-protected-bytes",
    );
  });

  it("fails closed when Secret Service is unavailable without touching the workspace", async () => {
    const cwd = await temporaryDirectory();
    const runner: SecretCommandRunner = async () => ({
      ok: false,
      stdout: "",
    });

    await expect(
      inspectCredentialStore({ platform: "linux", runner }),
    ).resolves.toMatchObject({
      available: false,
      backend: "linux_secret_service",
    });
    const result = await storeCredential(
      cwd,
      ["unit", "credential", "gamma"].join("-"),
      { platform: "linux", runner },
    );
    expect(result.stored).toBe(false);
    expect(result).not.toHaveProperty("markerPath");
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it("does not query stored credentials when an explicit environment value exists", async () => {
    const cwd = await temporaryDirectory();
    const resolver = vi.fn(() => ["stored", "value"].join("-"));
    const environmentValue = ["environment", "value"].join("-");

    const config = loadConfig(
      { cwd },
      { KRATER_API_KEY: environmentValue },
      { readStoredCredential: resolver },
    );

    expect(config.apiKey).toBe(environmentValue);
    expect(config.apiKeySource).toBe("environment");
    expect(resolver).not.toHaveBeenCalled();
  });
});
