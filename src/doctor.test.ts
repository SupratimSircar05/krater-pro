import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandProbe,
  doctorExitCode,
  isSupportedNodeVersion,
  renderDoctorReport,
  runDoctor,
} from "./doctor.js";
import { SETUP_REQUIRED_EXIT_CODE } from "./setup.js";
import type { NativeSandboxAdapter } from "./sandbox/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-doctor-"));
  temporaryPaths.push(path);
  return path;
}

function gitProbe(repository = true): CommandProbe {
  return async (_executable, args) => {
    if (args[0] === "--version") {
      return { ok: true, stdout: "git version 2.50.1\n" };
    }
    return { ok: true, stdout: repository ? "true\n" : "false\n" };
  };
}

function verifiedMacOsAdapter(): NativeSandboxAdapter {
  return {
    id: "test-macos-native",
    probe: async () => ({
      platform: "darwin",
      verification: "verified",
      availability: "available",
      expectedPrimitives: [
        "macos_sandbox_profile",
        "macos_process_limits",
      ],
      verifiedPrimitives: [
        "macos_sandbox_profile",
        "macos_process_limits",
      ],
      controls: {
        filesystemBoundary: true,
        processIsolation: true,
        networkDeny: true,
        networkAllowlist: false,
        cpuLimit: true,
        memoryLimit: true,
        wallTimeLimit: true,
        processCountLimit: true,
        outputLimit: true,
      },
      adapterId: "test-macos-native",
      supportsApprovedUncontainedExecution: false,
      reason: "Verified test containment with deny-only networking.",
      verifiedAt: "2026-07-28T00:00:00.000Z",
    }),
    run: async () => {
      throw new Error("not used");
    },
    cancel: async () => undefined,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("isSupportedNodeVersion", () => {
  it.each([
    ["20.19.0", true],
    ["20.18.9", false],
    ["21.7.0", false],
    ["22.11.0", false],
    ["22.12.0", true],
    ["24.5.0", true],
    ["not-a-version", false],
  ])("classifies Node %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});

describe("runDoctor", () => {
  it("reports setup_required without performing network verification", async () => {
    const cwd = await temporaryDirectory();

    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {},
      nodeVersion: "22.12.0",
      platform: "linux",
      architecture: "x64",
      probe: gitProbe(),
    });

    expect(report).toMatchObject({
      type: "doctor",
      status: "setup_required",
      ok: false,
      checks: {
        node: { status: "pass", supported: true },
        credential: {
          status: "warning",
          configured: false,
          source: "missing",
          verification: "not_attempted",
        },
        git: {
          status: "pass",
          available: true,
          repository: true,
        },
      },
    });
    expect(doctorExitCode(report)).toBe(SETUP_REQUIRED_EXIT_CODE);
    expect(report.actions).toContain(
      "Run `krater setup` to configure a Krater API key.",
    );
  });

  it("reports executable native controls and their deny-only limitation", async () => {
    const cwd = await temporaryDirectory();
    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {},
      nodeVersion: "22.12.0",
      platform: "darwin",
      architecture: "arm64",
      probe: gitProbe(),
      nativeSandboxAdapter: verifiedMacOsAdapter(),
    });

    expect(report.checks.sandbox).toMatchObject({
      status: "pass",
      verification: "verified",
      availability: "available",
      adapterId: "test-macos-native",
      controls: {
        filesystemBoundary: true,
        networkDeny: true,
        networkAllowlist: false,
        processCountLimit: true,
      },
    });
    expect(report.warnings).toContain(
      "Strict unattended commands use deny-all networking and a one-process ceiling; commands needing network access or subprocesses require an explicit attended approval.",
    );
    expect(renderDoctorReport(report)).toContain(
      "Verified test containment with deny-only networking.",
    );
  });

  it("reports a configured key by source without serializing its value", async () => {
    const cwd = await temporaryDirectory();
    const secret = "test_doctor_secret";
    const probeEnvironments: NodeJS.ProcessEnv[] = [];
    const probe: CommandProbe = async (_executable, args, _cwd, environment) => {
      probeEnvironments.push(environment);
      if (args[0] === "--version") {
        return { ok: true, stdout: "git version 2.50.1\n" };
      }
      return { ok: true, stdout: "false\n" };
    };

    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {
        KRATER_API_KEY: secret,
        KRATER_MODEL: "moonshotai/kimi-k3",
      },
      nodeVersion: "24.1.0",
      probe,
    });

    expect(report.status).toBe("ready");
    expect(report.ok).toBe(true);
    expect(report.checks.credential).toEqual({
      status: "pass",
      configured: true,
      source: "environment",
      verification: "not_attempted",
    });
    expect(report.checks.configuration).toMatchObject({
      endpointOrigin: "https://api.krater.ai",
      model: "moonshotai/kimi-k3",
      modelSource: "environment",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(renderDoctorReport(report)).not.toContain(secret);
    expect(doctorExitCode(report)).toBe(0);
    expect(probeEnvironments).not.toHaveLength(0);
    for (const environment of probeEnvironments) {
      expect(environment.KRATER_API_KEY).toBeUndefined();
    }
  });

  it("redacts malformed configuration values from diagnostics", async () => {
    const cwd = await temporaryDirectory();
    const sensitiveValue = "do-not-echo-this";

    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {
        KRATER_BASE_URL: `https://user:${sensitiveValue}@api.krater.ai/v1`,
      },
      nodeVersion: "22.12.0",
      probe: gitProbe(),
    });

    expect(report.status).toBe("issues");
    expect(report.checks.configuration).toEqual({
      status: "fail",
      loaded: false,
    });
    expect(JSON.stringify(report)).not.toContain(sensitiveValue);
    expect(doctorExitCode(report)).toBe(1);
  });

  it("warns when an existing Unix .env is broadly readable", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, ".env"), "KRATER_API_KEY=local-secret\n", {
      mode: 0o644,
    });

    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {},
      nodeVersion: "22.12.0",
      platform: "linux",
      probe: gitProbe(),
    });

    expect(report.status).toBe("ready");
    expect(report.checks.environmentFile).toMatchObject({
      status: "warning",
      permissions: "permissive",
      mode: "644",
    });
    expect(JSON.stringify(report)).not.toContain("local-secret");
  });

  it("labels authenticated model discovery as live only when explicitly requested", async () => {
    const cwd = await temporaryDirectory();
    const credentialValue = ["doctor", "credential", "live"].join("-");

    const offline = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: { KRATER_API_KEY: credentialValue },
      nodeVersion: "22.12.0",
      probe: gitProbe(),
      validator: async () => {
        throw new Error("must not run");
      },
    });
    expect(offline.scope).toBe("offline_local_preflight");
    expect(offline.checks.credential.verification).toBe("not_attempted");

    const live = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: { KRATER_API_KEY: credentialValue },
      nodeVersion: "22.12.0",
      probe: gitProbe(),
      live: true,
      validator: async ({ apiKey }) => {
        expect(apiKey).toBe(credentialValue);
        return { verified: true, modelCount: 11 };
      },
    });

    expect(live).toMatchObject({
      scope: "live_credential_verification",
      status: "ready",
      checks: {
        credential: {
          configured: true,
          verification: "verified",
          modelCount: 11,
        },
      },
    });
    expect(JSON.stringify(live)).not.toContain(credentialValue);
    expect(renderDoctorReport(live)).not.toContain(credentialValue);
  });

  it("fails closed when an explicitly requested live verification fails", async () => {
    const cwd = await temporaryDirectory();

    const report = await runDoctor({
      version: "0.1.0",
      overrides: { cwd },
      environment: {
        KRATER_API_KEY: ["doctor", "credential", "rejected"].join("-"),
      },
      nodeVersion: "22.12.0",
      probe: gitProbe(),
      live: true,
      validator: async () => ({ verified: false, modelCount: 0 }),
    });

    expect(report.status).toBe("issues");
    expect(report.ok).toBe(false);
    expect(report.checks.credential).toMatchObject({
      status: "fail",
      verification: "failed",
    });
    expect(doctorExitCode(report)).toBe(1);
  });
});
