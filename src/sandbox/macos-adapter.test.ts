import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostNativeSandboxAdapter,
  MacOsSandboxAdapter,
  SandboxSupervisor,
} from "./index.js";
import type { SandboxExecutionRequest } from "./index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "krater-sandbox-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function request(
  workingDirectory: string,
  executable: string,
  arguments_: readonly string[],
  overrides: Partial<SandboxExecutionRequest> = {},
): SandboxExecutionRequest {
  return {
    id: `sandbox-${Math.random()}`,
    mode: "unattended",
    command: {
      kind: "command",
      executable,
      arguments: arguments_,
      workingDirectory,
      reason: "Exercise the native sandbox adapter.",
    },
    resources: [
      {
        kind: "resource",
        access: "read_write",
        paths: [workingDirectory],
        reason: "Use only the disposable staged workspace.",
      },
    ],
    network: {
      kind: "network",
      policy: "deny",
      reason: "The fixture requires no network.",
    },
    limits: {
      cpuTimeMs: 5_000,
      memoryBytes: 512 * 1024 * 1024,
      wallTimeMs: 2_000,
      processCount: 8,
      outputBytes: 4_096,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("host adapter selection", () => {
  it("never substitutes the macOS adapter for Linux or Windows", () => {
    expect(createHostNativeSandboxAdapter("linux")).toBeUndefined();
    expect(createHostNativeSandboxAdapter("win32")).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")(
    "passes host-vetted environment into the native adapter factory",
    async () => {
      const directory = await temporaryDirectory();
      const adapter = createHostNativeSandboxAdapter("darwin", {
        environment: { KRATER_FIXTURE_VALUE: "factory-value" },
      });
      const receipt = await new SandboxSupervisor({
        adapter,
        platform: "darwin",
      }).execute({
        ...request(directory, "/bin/zsh", [
          "-f",
          "-c",
          'print -rn -- "$KRATER_FIXTURE_VALUE"',
        ]),
        command: {
          ...request(directory, "/bin/zsh", []).command,
          arguments: [
            "-f",
            "-c",
            'print -rn -- "$KRATER_FIXTURE_VALUE"',
          ],
          environmentKeys: ["KRATER_FIXTURE_VALUE"],
        },
      });

      expect(receipt).toMatchObject({
        status: "completed",
        output: { stdout: "factory-value" },
      });
    },
  );
});

describe.runIf(process.platform === "darwin")(
  "verified macOS native adapter",
  () => {
    it("probes executable controls without claiming network allowlists", async () => {
      const report = await new MacOsSandboxAdapter().probe("darwin");
      expect(report).toMatchObject({
        platform: "darwin",
        verification: "verified",
        availability: "available",
        verifiedPrimitives: [
          "macos_sandbox_profile",
          "macos_process_limits",
        ],
        controls: {
          filesystemBoundary: true,
          networkDeny: true,
          networkAllowlist: false,
          cpuLimit: true,
          memoryLimit: true,
          wallTimeLimit: true,
          processCountLimit: true,
          outputLimit: true,
        },
        supportsApprovedUncontainedExecution: false,
      });
    });

    it("executes an exact command inside the staged resource", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(request(directory, "/bin/echo", ["verified"]));

      expect(receipt).toMatchObject({
        status: "completed",
        containment: "secure",
        exitCode: 0,
        output: { stdout: "verified\n", truncated: false },
        resourceUsage: { peakProcessCount: 1 },
      });
    });

    it("permits writes only through the declared staged resource", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/zsh", [
          "-f",
          "-c",
          "print -r -- staged > output.txt",
        ]),
      );

      expect(receipt.status).toBe("completed");
      expect(await readFile(join(directory, "output.txt"), "utf8")).toBe(
        "staged\n",
      );
    });

    it("denies writes outside declared resources", async () => {
      const directory = await temporaryDirectory();
      const blockedDirectory = await temporaryDirectory();
      const blockedFile = join(blockedDirectory, "escape.txt");
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/zsh", [
          "-f",
          "-c",
          'print -r -- escaped > "$1"',
          "krater-fixture",
          blockedFile,
        ]),
      );

      expect(receipt.status).toBe("failed");
      await expect(access(blockedFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("lets an exact deny override a broader readable resource", async () => {
      const directory = await temporaryDirectory();
      const protectedFile = join(directory, ".env");
      await writeFile(protectedFile, "must-stay-host-side\n");
      const input = request(directory, "/bin/cat", [protectedFile]);
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute({
        ...input,
        resources: [
          ...input.resources,
          {
            kind: "resource",
            access: "deny",
            paths: [protectedFile],
            reason: "Keep protected project data host-side.",
          },
        ],
      });

      expect(receipt.status).toBe("failed");
      expect(receipt.output.stdout).toBe("");
      expect(JSON.stringify(receipt)).not.toContain("must-stay-host-side");
    });

    it("refuses secrets in argv because process listings can expose them", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/echo", ["--token", "do-not-copy"], {
          command: {
            ...request(directory, "/bin/echo", []).command,
            arguments: ["--token", "do-not-copy"],
          },
        }),
      );

      expect(receipt).toMatchObject({
        status: "adapter_error",
        reason:
          "Sensitive values cannot be placed in process arguments; use a host-side credential handle.",
      });
      expect(JSON.stringify(receipt)).not.toContain("do-not-copy");
    });

    it("denies reads outside declared resources", async () => {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, "inside.txt"), "inside");
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(request(directory, "/bin/cat", ["/etc/hosts"]));

      expect(receipt.status).toBe("failed");
      expect(receipt.exitCode).not.toBe(0);
      expect(receipt.output.stdout).toBe("");
    });

    it("refuses an exact-host allowlist rather than approximating it", async () => {
      const directory = await temporaryDirectory();
      const input = request(directory, "/bin/echo", ["no"], {
        network: {
          kind: "network",
          policy: "allowlist",
          destinations: [{ host: "registry.npmjs.org", ports: [443] }],
          reason: "Try one exact registry.",
        },
      });
      const plan = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).plan(input);

      expect(plan.decision).toBe("refused");
      expect(plan.capabilityReport.controls.networkAllowlist).toBe(false);
      if (plan.decision === "refused") {
        expect(plan.reason).toMatch(/networkAllowlist/);
      }
    });

    it("enforces the stricter one-process ceiling by denying forks", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/zsh", [
          "-f",
          "-c",
          "/bin/zsh -f -c 'exit 0' & wait",
        ]),
      );

      expect(receipt.status).toBe("failed");
      expect(receipt.exitCode).not.toBe(0);
      expect(receipt.output.stderr).toMatch(/fork failed|not permitted/i);
    });

    it("makes CPU and address-space ceilings non-raiseable by the target", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/zsh", [
          "-f",
          "-c",
          "limit cputime unlimited || exit 41; " +
            "limit addressspace unlimited || exit 42",
        ]),
      );

      expect(receipt.status).toBe("failed");
      expect([41, 42]).toContain(receipt.exitCode);
      expect(receipt.output.stderr).toMatch(/hard limit|operation not permitted/i);
    });

    it("terminates on the combined output byte ceiling", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/usr/bin/yes", [], {
          limits: {
            ...request(directory, "/usr/bin/yes", []).limits,
            outputBytes: 128,
          },
        }),
      );

      expect(receipt).toMatchObject({
        status: "resource_limited",
        terminationReason: "output_limit",
        output: {
          capturedBytes: 128,
          truncated: true,
        },
      });
      expect(receipt.output.observedBytes).toBeGreaterThan(128);
    });

    it("enforces the kernel CPU ceiling", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/zsh", ["-f", "-c", "while true; do :; done"], {
          limits: {
            ...request(directory, "/bin/zsh", []).limits,
            cpuTimeMs: 1,
            wallTimeMs: 2_000,
          },
        }),
      );

      expect(receipt).toMatchObject({
        status: "resource_limited",
        terminationReason: "cpu_limit",
      });
    });

    it("terminates the isolated process group at the wall-time ceiling", async () => {
      const directory = await temporaryDirectory();
      const receipt = await new SandboxSupervisor({
        adapter: new MacOsSandboxAdapter(),
        platform: "darwin",
      }).execute(
        request(directory, "/bin/sleep", ["10"], {
          limits: {
            ...request(directory, "/bin/sleep", ["10"]).limits,
            wallTimeMs: 30,
          },
        }),
      );

      expect(receipt).toMatchObject({
        status: "timed_out",
        terminationReason: "wall_time",
      });
    });
  },
);
