import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  SETUP_REQUIRED_EXIT_CODE,
  isSetupRequiredError,
  renderSetupResult,
  setupWorkspace,
} from "./setup.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(sourceRoot);
const cliPath = join(sourceRoot, "cli.ts");
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-setup-"));
  temporaryPaths.push(path);
  return path;
}

function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        cwd: projectRoot,
        env: {
          PATH: process.env.PATH,
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("setupWorkspace", () => {
  it("does not mutate a missing configuration in noninteractive inspection", async () => {
    const cwd = await temporaryDirectory();

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
    });

    expect(result).toMatchObject({
      type: "setup_required",
      status: "setup_required",
      credential: {
        configured: false,
        source: "missing",
        verification: "not_attempted",
      },
      environmentFile: {
        exists: false,
        created: false,
      },
    });
    await expect(readFile(join(cwd, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates only an owner-private, empty-key template when explicitly requested", async () => {
    const cwd = await temporaryDirectory();

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      createEnvironmentFile: true,
    });
    const contents = await readFile(join(cwd, ".env"), "utf8");
    const fileMode = (await stat(join(cwd, ".env"))).mode & 0o777;

    expect(result.environmentFile).toMatchObject({
      exists: true,
      created: true,
    });
    expect(contents).toContain("KRATER_API_KEY=\n");
    expect(contents).toContain("KRATER_MODEL=auto");
    expect(contents).not.toMatch(/kr_live_[A-Za-z0-9]/);
    if (process.platform !== "win32") expect(fileMode).toBe(0o600);
  });

  it("uses exclusive create and preserves an existing keyless environment file", async () => {
    const cwd = await temporaryDirectory();
    const original = "# Existing workspace settings\nKRATER_MODEL=auto\n";
    await writeFile(join(cwd, ".env"), original, { mode: 0o600 });

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      createEnvironmentFile: true,
    });

    expect(result.environmentFile).toMatchObject({
      exists: true,
      created: false,
      updated: false,
    });
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("never overwrites or serializes an existing credential", async () => {
    const cwd = await temporaryDirectory();
    const secret = "test_secret_that_must_not_leak";
    const original = `KRATER_API_KEY=${secret}\nKRATER_MODEL=auto\n`;
    await writeFile(join(cwd, ".env"), original, {
      encoding: "utf8",
      mode: 0o600,
    });

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      createEnvironmentFile: true,
    });

    expect(result.status).toBe("ready");
    expect(result.environmentFile.created).toBe(false);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(renderSetupResult(result)).not.toContain(secret);
  });

  it("recognizes only the missing-credential error contract", () => {
    expect(
      isSetupRequiredError(
        new Error(
          "Krater API key not found. Pass --api-key, set KRATER_API_KEY, or add it to .env.",
        ),
      ),
    ).toBe(true);
    expect(isSetupRequiredError(new Error("provider unavailable"))).toBe(false);
  });

  it("validates an injected credential before owner-only environment fallback", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["setup", "credential", "verified"].join("-");
    const validator = vi.fn(async (input: { apiKey: string }) => {
      expect(input.apiKey).toBe(credentialValue);
      return { verified: true, modelCount: 7 };
    });

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      credential: credentialValue,
      validateCredential: true,
      persistence: "environment_file",
      validator,
    });

    expect(result).toMatchObject({
      mode: "authenticated_setup",
      status: "ready",
      credential: {
        source: ".env",
        verification: "verified",
        modelCount: 7,
        persisted: true,
        persistence: "environment_file",
      },
      environmentFile: {
        exists: true,
        created: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
    expect(renderSetupResult(result)).not.toContain(credentialValue);
    expect(await readFile(join(cwd, ".env"), "utf8")).toContain(
      credentialValue,
    );
    if (process.platform !== "win32") {
      expect((await stat(join(cwd, ".env"))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses to replace an existing environment credential", async () => {
    const cwd = await temporaryDirectory();
    const previous = "setup-credential-previous";
    const replacement = "setup-credential-replacement";
    await writeFile(
      join(cwd, ".env"),
      [
        "# Preserve this comment",
        `KRATER_API_KEY=${previous}`,
        "KRATER_MODEL=auto",
        "KEEP_SETTING=yes",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    await expect(
      setupWorkspace({
        overrides: { cwd },
        environment: {},
        credential: replacement,
        validateCredential: true,
        persistence: "environment_file",
        validator: async () => ({ verified: true, modelCount: 3 }),
      }),
    ).rejects.toThrow(/already exists.*edit KRATER_API_KEY.*manually/i);
    const contents = await readFile(join(cwd, ".env"), "utf8");
    expect(contents).toContain("# Preserve this comment");
    expect(contents).toContain("KEEP_SETTING=yes");
    expect(contents).toContain(previous);
    expect(contents).not.toContain(replacement);
  });

  it("refuses to persist through a symlinked environment file", async () => {
    if (process.platform === "win32") return;
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideEnvironment = join(outside, ".env");
    const original = "KRATER_MODEL=auto\nKEEP_SETTING=yes\n";
    await writeFile(outsideEnvironment, original, { mode: 0o600 });
    await symlink(outsideEnvironment, join(cwd, ".env"));

    await expect(
      setupWorkspace({
        overrides: { cwd },
        environment: {},
        credential: "setup-credential-symlink",
        validateCredential: true,
        persistence: "environment_file",
        validator: async () => ({ verified: true, modelCount: 2 }),
      }),
    ).rejects.toThrow(/not a regular file/);
    expect(await readFile(outsideEnvironment, "utf8")).toBe(original);
  });

  it("does not persist a credential when authenticated discovery fails", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["setup", "credential", "rejected"].join("-");

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      credential: credentialValue,
      validateCredential: true,
      persistence: "environment_file",
      validator: async () => ({ verified: false, modelCount: 0 }),
    });

    expect(result.status).toBe("verification_failed");
    expect(result.credential).toMatchObject({
      verification: "failed",
      persisted: false,
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
    await expect(readFile(join(cwd, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates before sending a credential to the OS store", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["setup", "credential", "keychain"].join("-");
    const sequence: string[] = [];

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      credential: credentialValue,
      validateCredential: true,
      persistence: "credential_store",
      validator: async () => {
        sequence.push("validate");
        return { verified: true, modelCount: 5 };
      },
      credentialStore: {
        platform: "darwin",
        runner: async (_executable, args, stdin) => {
          sequence.push(stdin === undefined ? "probe" : "store");
          expect(args.join(" ")).not.toContain(credentialValue);
          return { ok: true, stdout: "" };
        },
      },
    });

    expect(sequence).toEqual(["validate", "probe", "store"]);
    expect(result).toMatchObject({
      status: "ready",
      credential: {
        source: "credential_store",
        verification: "verified",
        persisted: true,
        backend: "macos_keychain",
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
  });

  it("validates a noninteractive environment credential without persistence", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["setup", "environment", "ephemeral"].join("-");

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: { KRATER_API_KEY: credentialValue },
      validateCredential: true,
      persistence: "none",
      validator: async () => ({ verified: true, modelCount: 3 }),
    });

    expect(result).toMatchObject({
      status: "ready",
      credential: {
        source: "environment",
        verification: "verified",
        persisted: false,
        persistence: "none",
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
    await expect(readFile(join(cwd, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists the selected trust dial only after credential validation", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["setup", "preferences", "verified"].join("-");

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      credential: credentialValue,
      validateCredential: true,
      persistence: "none",
      defaultAssurance: "high",
      validator: async () => ({ verified: true, modelCount: 4 }),
    });

    expect(result.preferences).toMatchObject({
      defaultAssurance: "high",
      source: "workspace_preferences",
      persisted: true,
    });
    expect(loadConfig({ cwd }, {})).toMatchObject({
      defaultAssurance: "high",
      defaultAssuranceSource: "workspace_preferences",
    });
    expect(
      await readFile(join(cwd, ".krater", "preferences.json"), "utf8"),
    ).not.toContain(credentialValue);
  });

  it("does not persist trust preferences when credential validation fails", async () => {
    const cwd = await temporaryDirectory();

    const result = await setupWorkspace({
      overrides: { cwd },
      environment: {},
      credential: "setup-preferences-rejected",
      validateCredential: true,
      persistence: "none",
      defaultAssurance: "fast",
      validator: async () => ({ verified: false, modelCount: 0 }),
    });

    expect(result.status).toBe("verification_failed");
    await expect(
      readFile(join(cwd, ".krater", "preferences.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("setup CLI", () => {
  it("is noninteractive, mutation-free, and machine-readable by default", async () => {
    const cwd = await temporaryDirectory();

    const result = await runCli(["--cwd", cwd, "--json", "setup"]);

    expect(result.code).toBe(SETUP_REQUIRED_EXIT_CODE);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "setup_required",
      status: "setup_required",
      environmentFile: { exists: false, created: false },
    });
    await expect(readFile(join(cwd, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("selects an explicit existing initial project without mutating it", async () => {
    const launch = await temporaryDirectory();
    const project = await temporaryDirectory();

    const result = await runCli([
      "--cwd",
      launch,
      "--json",
      "setup",
      "--project",
      project,
      "--default-assurance",
      "high",
    ]);

    expect(result.code).toBe(SETUP_REQUIRED_EXIT_CODE);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cwd: await realpath(project),
      project: {
        path: await realpath(project),
        selected: true,
      },
      preferences: {
        defaultAssurance: "high",
        persisted: false,
      },
    });
    await expect(
      readFile(join(project, ".krater", "preferences.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns setup_required before creating task state when a key is missing", async () => {
    const cwd = await temporaryDirectory();

    const result = await runCli([
      "--cwd",
      cwd,
      "--json",
      "Review this repository",
    ]);

    expect(result.code).toBe(SETUP_REQUIRED_EXIT_CODE);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "setup_required",
      status: "setup_required",
    });
    await expect(
      readFile(join(cwd, ".krater", "proofgraph", "events.ndjson"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs doctor --json without echoing a configured environment key", async () => {
    const cwd = await temporaryDirectory();
    const secret = "test_cli_doctor_secret";

    const result = await runCli(
      ["--cwd", cwd, "doctor", "--json"],
      { KRATER_API_KEY: secret },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(secret);
    const report = JSON.parse(result.stdout) as {
      checks: {
        sandbox: {
          verification: string;
          availability: string;
        };
      };
    };
    expect(report).toMatchObject({
      type: "doctor",
      scope: "offline_local_preflight",
      status: "ready",
      checks: {
        credential: {
          configured: true,
          source: "environment",
          verification: "not_attempted",
        },
        evidenceStorage: {
          verification: "not_attempted",
        },
        completions: {
          ready: true,
        },
      },
    });
    expect(["verified", "unverified"]).toContain(
      report.checks.sandbox.verification,
    );
    expect(report.checks.sandbox.availability).toBe(
      report.checks.sandbox.verification === "verified"
        ? "available"
        : "unavailable",
    );
  });
});
