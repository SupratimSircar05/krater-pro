import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  type SecretCommandReader,
  type SecretCommandRunner,
  credentialMarkerPath,
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

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("credential store", () => {
  it("passes a macOS credential only through stdin and records a non-secret handle", async () => {
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
      now: () => "2026-07-28T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      stored: true,
      backend: "macos_keychain",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.at(-1)).toBe("-w");
    expect(calls[1]?.stdin).toBe(`${credentialValue}\n`);
    for (const call of calls) {
      expect(call.executable).not.toContain(credentialValue);
      expect(call.args.join(" ")).not.toContain(credentialValue);
    }
    const markerPath = credentialMarkerPath(cwd);
    const marker = await readFile(markerPath, "utf8");
    expect(marker).not.toContain(credentialValue);
    expect(marker).toContain("macos_keychain");
    if (process.platform !== "win32") {
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("resolves a marker through a host command without putting the value in arguments", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["unit", "credential", "beta"].join("-");
    await storeCredential(cwd, credentialValue, {
      platform: "darwin",
      runner: async () => ({ ok: true, stdout: "" }),
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const reader: SecretCommandReader = vi.fn((_executable, args) => {
      expect(args.join(" ")).not.toContain(credentialValue);
      return { ok: true, stdout: `${credentialValue}\n` };
    });

    expect(readStoredCredentialSync(cwd, { reader })).toBe(credentialValue);
    expect(reader).toHaveBeenCalledOnce();

    const config = loadConfig(
      { cwd },
      {},
      {
        readStoredCredential: (workspace) =>
          readStoredCredentialSync(workspace, { reader }),
      },
    );
    expect(config.apiKey).toBe(credentialValue);
    expect(config.apiKeySource).toBe("credential_store");
  });

  it("fails closed when Secret Service is unavailable", async () => {
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
    await expect(readFile(credentialMarkerPath(cwd), "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
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
