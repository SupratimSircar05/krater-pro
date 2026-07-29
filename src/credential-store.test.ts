import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
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

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("credential store", () => {
  it("fails closed on unsupported platforms without launching a helper", async () => {
    const runner: SecretCommandRunner = vi.fn(async () => ({
      ok: true,
      stdout: "",
    }));
    const reader: SecretCommandReader = vi.fn(() => ({
      ok: true,
      stdout: "must-not-be-read",
    }));

    await expect(
      inspectCredentialStore({ platform: "win32", runner }),
    ).resolves.toEqual({
      available: false,
      reason: "No audited credential backend is implemented for win32.",
    });
    await expect(
      storeCredential("/unsupported", "not-a-real-secret", {
        platform: "win32",
        runner,
      }),
    ).resolves.toEqual({
      stored: false,
      reason: "No audited credential backend is implemented for win32.",
    });
    expect(
      readStoredCredentialSync("/unsupported", {
        platform: "win32",
        reader,
      }),
    ).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

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

  it("reports an indeterminate write timeout without a plaintext fallback", async () => {
    const cwd = await temporaryDirectory();
    const calls: Array<string | undefined> = [];
    const runner: SecretCommandRunner = async (_executable, _args, stdin) => {
      calls.push(stdin);
      return calls.length === 1
        ? { ok: true, stdout: "" }
        : { ok: false, stdout: "", failure: "timeout" };
    };

    await expect(
      storeCredential(cwd, "ephemeral-test-value", {
        platform: "darwin",
        runner,
      }),
    ).resolves.toEqual({
      stored: false,
      backend: "macos_keychain",
      reason:
        "The operating-system credential backend timed out. Krater could not confirm storage and will not fall back to plaintext automatically.",
    });
    expect(calls).toEqual([undefined, "ephemeral-test-value\n"]);
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
