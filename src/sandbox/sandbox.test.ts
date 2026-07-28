import { describe, expect, it, vi } from "vitest";
import {
  SandboxSupervisor,
  boundProcessOutput,
  sandboxRequestDigest,
  unverifiedPlatformCapabilities,
  validateSecureContainment,
} from "./index.js";
import type {
  NativeAdapterExecutionResult,
  NativeSandboxAdapter,
  PlatformCapabilityReport,
  SandboxExecutionRequest,
} from "./index.js";

const NOW = new Date("2026-07-28T10:00:00.000Z");

function request(
  overrides: Partial<SandboxExecutionRequest> = {},
): SandboxExecutionRequest {
  return {
    id: "execution-1",
    mode: "unattended",
    command: {
      kind: "command",
      executable: "/usr/bin/node",
      arguments: ["--test"],
      workingDirectory: "/staged/workspace",
      environmentKeys: ["PATH"],
      reason: "Run repository tests.",
    },
    resources: [
      {
        kind: "resource",
        access: "read_write",
        paths: ["/staged/workspace"],
        reason: "Test only the staged workspace.",
      },
    ],
    network: {
      kind: "network",
      policy: "deny",
      reason: "Tests do not require network access.",
    },
    limits: {
      cpuTimeMs: 5_000,
      memoryBytes: 256 * 1024 * 1024,
      wallTimeMs: 10_000,
      processCount: 16,
      outputBytes: 1_024,
    },
    ...overrides,
  };
}

function secureReport(
  overrides: Partial<PlatformCapabilityReport> = {},
): PlatformCapabilityReport {
  return {
    platform: "darwin",
    verification: "verified",
    availability: "available",
    expectedPrimitives: ["macos_sandbox_profile", "macos_process_limits"],
    verifiedPrimitives: ["macos_sandbox_profile", "macos_process_limits"],
    controls: {
      filesystemBoundary: true,
      processIsolation: true,
      networkDeny: true,
      networkAllowlist: true,
      cpuLimit: true,
      memoryLimit: true,
      wallTimeLimit: true,
      processCountLimit: true,
      outputLimit: true,
    },
    adapterId: "test-native",
    supportsApprovedUncontainedExecution: false,
    reason: "Verified by the test adapter.",
    verifiedAt: NOW.toISOString(),
    ...overrides,
  };
}

function result(
  overrides: Partial<NativeAdapterExecutionResult> = {},
): NativeAdapterExecutionResult {
  return {
    exitCode: 0,
    terminationReason: "exit",
    output: [{ stream: "stdout", data: "ok\n" }],
    outputBytesObserved: 3,
    resourceUsage: {
      cpuTimeMs: 10,
      peakMemoryBytes: 1_024,
      peakProcessCount: 1,
    },
    ...overrides,
  };
}

function adapter(options: {
  report?: PlatformCapabilityReport;
  run?: (
    input: Parameters<NativeSandboxAdapter["run"]>[0],
  ) => Promise<NativeAdapterExecutionResult>;
}) {
  const run = vi.fn(
    options.run ??
      (async () => result()),
  );
  const cancel = vi.fn(async () => undefined);
  const value: NativeSandboxAdapter = {
    id: "test-native",
    probe: vi.fn(async () => options.report ?? secureReport()),
    run,
    cancel,
  };
  return { value, run, cancel };
}

describe("platform containment contracts", () => {
  it.each([
    ["darwin", ["macos_sandbox_profile", "macos_process_limits"]],
    ["linux", ["linux_namespaces", "linux_seccomp", "linux_cgroups"]],
    ["win32", ["windows_restricted_token", "windows_job_object"]],
  ] as const)("does not infer secure %s containment from Node", (platform, primitives) => {
    const report = unverifiedPlatformCapabilities(platform);
    expect(report).toMatchObject({
      platform,
      verification: "unverified",
      availability: "unavailable",
      expectedPrimitives: primitives,
    });
    expect(Object.values(report.controls).every((value) => value === false)).toBe(
      true,
    );
  });

  it("requires all verified primitives and the requested network control", () => {
    const allowlist = request({
      network: {
        kind: "network",
        policy: "allowlist",
        destinations: [{ host: "registry.npmjs.org", ports: [443] }],
        reason: "Resolve one dependency.",
      },
    });
    const report = secureReport({
      controls: {
        ...secureReport().controls,
        networkAllowlist: false,
      },
    });
    expect(validateSecureContainment(report, allowlist)).toMatchObject({
      secure: false,
      missingControls: ["networkAllowlist"],
    });
    expect(
      validateSecureContainment(
        secureReport({ verifiedPrimitives: ["macos_sandbox_profile"] }),
        request(),
      ),
    ).toMatchObject({ secure: false });
  });

  it("rejects control characters in executable and resource paths", async () => {
    const supervisor = new SandboxSupervisor({ platform: "darwin" });
    await expect(
      supervisor.plan(
        request({
          command: {
            ...request().command,
            executable: "/usr/bin/node\n(allow default)",
          },
        }),
      ),
    ).rejects.toThrow(/exact absolute path/i);
  });
});

describe("fail-closed supervisor", () => {
  it("refuses unattended commands when no native adapter verifies containment", async () => {
    const supervisor = new SandboxSupervisor({
      platform: "darwin",
      now: () => NOW,
    });
    const receipt = await supervisor.execute(request());
    expect(receipt).toMatchObject({
      status: "refused",
      containment: "none",
      exitCode: null,
    });
    expect(receipt.reason).toMatch(/unattended execution is fail-closed/i);
  });

  it("requests exact approval for attended fallback without executing", async () => {
    const native = adapter({
      report: secureReport({
        availability: "unavailable",
        controls: unverifiedPlatformCapabilities("darwin").controls,
        supportsApprovedUncontainedExecution: true,
        reason: "Sandbox profiles are disabled by local policy.",
      }),
    });
    const supervisor = new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    });
    const receipt = await supervisor.execute(request({ mode: "attended" }));
    expect(receipt.status).toBe("approval_required");
    expect(receipt.requestDigest).toBe(
      sandboxRequestDigest(request({ mode: "attended" })),
    );
    expect(native.run).not.toHaveBeenCalled();
  });

  it("binds fallback approval to the exact request and expiry", async () => {
    const native = adapter({
      report: secureReport({
        availability: "unavailable",
        controls: unverifiedPlatformCapabilities("darwin").controls,
        supportsApprovedUncontainedExecution: true,
        reason: "Secure containment is unavailable.",
      }),
    });
    const supervisor = new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    });
    const base = request({ mode: "attended" });
    const approved = {
      ...base,
      approval: {
        requestDigest: sandboxRequestDigest(base),
        issuedBy: "user" as const,
        issuedAt: "2026-07-28T09:59:00.000Z",
        expiresAt: "2026-07-28T10:01:00.000Z",
      },
    };

    const receipt = await supervisor.execute(approved);
    expect(receipt).toMatchObject({
      status: "completed",
      containment: "approved_uncontained",
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ containment: "approved_uncontained" }),
    );

    const changed = {
      ...approved,
      command: { ...approved.command, arguments: ["deploy"] },
    };
    expect((await supervisor.execute(changed)).status).toBe("approval_required");
    expect(native.run).toHaveBeenCalledTimes(1);
  });

  it("uses the verified native adapter and passes every limit", async () => {
    const native = adapter({});
    const supervisor = new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    });
    const input = request();
    const receipt = await supervisor.execute(input);
    expect(receipt).toMatchObject({
      status: "completed",
      containment: "secure",
      output: { stdout: "ok\n", truncated: false },
      resourceUsage: { peakProcessCount: 1 },
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: input.limits,
        network: input.network,
        resources: input.resources,
      }),
    );
  });

  it("bounds adapter output and reports the output limit", async () => {
    const native = adapter({
      run: async () =>
        result({
          terminationReason: "output_limit",
          exitCode: null,
          output: [
            { stream: "stdout", data: "1234" },
            { stream: "stderr", data: "5678" },
          ],
          outputBytesObserved: 100,
        }),
    });
    const supervisor = new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    });
    const receipt = await supervisor.execute(
      request({ limits: { ...request().limits, outputBytes: 5 } }),
    );
    expect(receipt.status).toBe("resource_limited");
    expect(receipt.output).toMatchObject({
      stdout: "1234",
      stderr: "5",
      capturedBytes: 5,
      observedBytes: 100,
      truncated: true,
    });
  });

  it("cancels a native run when the wall-time budget expires", async () => {
    const native = adapter({
      run: async () =>
        new Promise<NativeAdapterExecutionResult>(() => {
          // Intentionally unresolved: the supervisor must cancel it.
        }),
    });
    const supervisor = new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
    });
    const receipt = await supervisor.execute(
      request({ limits: { ...request().limits, wallTimeMs: 5 } }),
    );
    expect(receipt).toMatchObject({
      status: "timed_out",
      terminationReason: "wall_time",
    });
    expect(native.cancel).toHaveBeenCalledWith("execution-1", "wall_time");
  });

  it("returns an adapter error receipt rather than claiming execution passed", async () => {
    const native = adapter({
      run: async () => {
        throw new Error("native setup rejected");
      },
    });
    const receipt = await new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    }).execute(request());
    expect(receipt).toMatchObject({
      status: "adapter_error",
      containment: "secure",
      reason: "native setup rejected",
    });
  });

  it("redacts marked and conventional secret arguments from receipts", async () => {
    const native = adapter({});
    const receipt = await new SandboxSupervisor({
      adapter: native.value,
      platform: "darwin",
      now: () => NOW,
    }).execute(
      request({
        command: {
          ...request().command,
          arguments: [
            "--token",
            "top-secret",
            "--label",
            "private-label",
            "--api-key=kr_abcdefghijklmnopqrstuvwxyz",
          ],
          sensitiveArgumentIndexes: [3],
        },
      }),
    );
    expect(receipt.command.arguments).toEqual([
      "--token",
      "[REDACTED]",
      "--label",
      "[REDACTED]",
      "--api-key=[REDACTED]",
    ]);
    expect(JSON.stringify(receipt)).not.toContain("top-secret");
    expect(JSON.stringify(receipt)).not.toContain("private-label");
    expect(JSON.stringify(receipt)).not.toContain(
      "kr_abcdefghijklmnopqrstuvwxyz",
    );
  });
});

describe("bounded output", () => {
  it("preserves stream attribution while enforcing a combined byte ceiling", () => {
    const output = boundProcessOutput(
      [
        { stream: "stderr", data: "err:" },
        { stream: "stdout", data: "hello" },
      ],
      6,
    );
    expect(output).toMatchObject({
      stderr: "err:",
      stdout: "he",
      capturedBytes: 6,
      observedBytes: 9,
      truncated: true,
    });
  });
});
