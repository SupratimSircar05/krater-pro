import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  releasePackageManifest,
  releaseShrinkwrap,
} from "./build-cli-artifact.mjs";
import {
  addElectronPackage,
  npmInvocation,
} from "./create-sbom.mjs";
import {
  createReleaseManifest,
  isManifestArtifact,
} from "./create-release-manifest.mjs";
import {
  normalizeSpdx,
  sha256,
  stableJson,
} from "./release-utils.mjs";
import { signingPlan } from "./sign-release-artifacts.mjs";
import {
  resolveSmokeArtifacts,
  smokeCommand,
  smokeEnvironment,
  validSmokeProof,
} from "./smoke-built-desktop.mjs";
import {
  stableRequirements,
  validateReleaseEnvironment,
} from "./validate-release-environment.mjs";

describe("release automation", () => {
  it("removes development and workspace mutation hooks from the CLI archive", () => {
    const manifest = releasePackageManifest({
      name: "krater-pro",
      version: "0.1.0",
      private: true,
      workspaces: ["web"],
      scripts: { prepack: "danger", start: "node dist/cli.js" },
      files: ["dist"],
      dependencies: { commander: "14.0.0" },
      devDependencies: { electron: "43.2.0" },
    });
    expect(manifest).toMatchObject({
      private: false,
      scripts: {},
      files: ["dist", "npm-shrinkwrap.json"],
      dependencies: { commander: "14.0.0" },
    });
    expect(manifest).not.toHaveProperty("workspaces");
    expect(manifest).not.toHaveProperty("devDependencies");

    const lock = releaseShrinkwrap({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { commander: "14.0.0" },
          devDependencies: { electron: "43.2.0" },
          workspaces: ["web"],
        },
      },
    });
    expect(lock.packages[""].dependencies).toEqual({
      commander: "14.0.0",
    });
    expect(lock.packages[""]).not.toHaveProperty("devDependencies");
    expect(lock.packages[""]).not.toHaveProperty("workspaces");
  });

  it("normalizes volatile SPDX fields from a fixed source epoch", () => {
    const document = {
      spdxVersion: "SPDX-2.3",
      creationInfo: {
        created: "2099-01-01T00:00:00.000Z",
        creators: ["Tool: npm/11"],
      },
      documentNamespace: "urn:uuid:random",
      packages: [
        { SPDXID: "SPDXRef-z" },
        { SPDXID: "SPDXRef-a" },
      ],
      relationships: [],
    };
    const first = normalizeSpdx(document, {
      namespaceDigest: "a".repeat(64),
      sourceDateEpoch: "0",
      profile: "cli",
    });
    const second = normalizeSpdx(document, {
      namespaceDigest: "a".repeat(64),
      sourceDateEpoch: "0",
      profile: "cli",
    });
    expect(stableJson(first)).toBe(stableJson(second));
    expect(first.creationInfo.created).toBe("1970-01-01T00:00:00.000Z");
    expect(first.documentNamespace).not.toContain("random");
    expect(first.packages.map(({ SPDXID }) => SPDXID)).toEqual([
      "SPDXRef-a",
      "SPDXRef-z",
    ]);
  });

  it("adds the packaged Electron runtime to the desktop dependency SBOM", () => {
    const document = {
      packages: [{ name: "krater-pro", SPDXID: "SPDXRef-root" }],
      relationships: [],
    };
    addElectronPackage(document, {
      name: "krater-pro",
      devDependencies: { electron: "43.2.0" },
    });
    expect(document.packages).toContainEqual(
      expect.objectContaining({
        name: "electron",
        versionInfo: "43.2.0",
      }),
    );
    expect(document.relationships).toContainEqual(
      expect.objectContaining({
        spdxElementId: "SPDXRef-root",
        relationshipType: "DEPENDS_ON",
      }),
    );
  });

  it("runs npm command shims through cmd.exe on Windows", () => {
    expect(
      npmInvocation(["ci", "--omit=dev"], {
        platform: "win32",
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
    ).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/s",
        "/c",
        "npm.cmd",
        "ci",
        "--omit=dev",
      ],
    });
    expect(
      npmInvocation(["sbom"], {
        platform: "linux",
        environment: {},
      }),
    ).toEqual({
      executable: "npm",
      arguments: ["sbom"],
    });
  });

  it("creates sorted checksums and source-bound release metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "krater-release-manifest-"));
    await writeFile(join(directory, "z.zip"), "zip");
    await writeFile(join(directory, "a.tgz"), "cli");
    await writeFile(join(directory, "ignored.txt"), "ignore");
    const result = await createReleaseManifest({
      directory,
      version: "0.1.0",
      repository: "https://github.com/SupratimSircar05/krater-pro",
      commit: "a".repeat(40),
      ref: "refs/tags/v0.1.0",
      runUrl:
        "https://github.com/SupratimSircar05/krater-pro/actions/runs/123",
    });
    const checksums = await readFile(result.checksumPath, "utf8");
    const lines = checksums.trim().split("\n");
    expect(lines.map((line) => line.slice(66))).toEqual([
      "a.tgz",
      "krater-pro-0.1.0.release-manifest.json",
      "z.zip",
    ]);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.source.commit).toBe("a".repeat(40));
    expect(manifest.artifacts).toHaveLength(2);
    expect(lines[0]).toBe(`${sha256("cli")}  a.tgz`);
  });

  it("recognizes only intentional release artifact suffixes", () => {
    expect(isManifestArtifact("krater-pro-cli-0.1.0.tgz")).toBe(true);
    expect(isManifestArtifact("Krater-Pro-0.1.0-x64.AppImage")).toBe(true);
    expect(isManifestArtifact("builder-debug.yml")).toBe(false);
    expect(isManifestArtifact("SHA256SUMS.txt.asc")).toBe(false);
  });

  it("fails stable signing closed and never places a passphrase in arguments", () => {
    expect(() =>
      signingPlan({
        required: true,
        directory: "/release",
      }),
    ).toThrow(/requires/);
    const plan = signingPlan({
      required: true,
      directory: "/release",
      keyId: "0123456789ABCDEF",
      passphrase: "private",
    });
    expect(plan.status).toBe("configured");
    expect(plan.commands.flatMap(({ arguments: args }) => args)).not.toContain(
      "private",
    );
    expect(plan.commands[0].arguments).toContain("--passphrase-fd");
  });

  it("requires every platform credential only for stable builds", () => {
    expect(
      validateReleaseEnvironment({
        platform: "mac",
        stable: false,
        environment: {},
      }),
    ).toEqual({ stable: false, missing: [] });
    expect(() =>
      validateReleaseEnvironment({
        platform: "mac",
        stable: true,
        environment: {},
      }),
    ).toThrow(stableRequirements.mac[0]);
    const environment = Object.fromEntries(
      stableRequirements.mac.map((name) => [name, "configured"]),
    );
    expect(
      validateReleaseEnvironment({
        platform: "mac",
        stable: true,
        environment,
      }),
    ).toEqual({ stable: true, missing: [] });
  });

  it("uses a real virtual display only for Linux launch smoke", () => {
    expect(smokeCommand("linux", "/app/krater-pro")).toEqual({
      command: "xvfb-run",
      arguments: ["-a", "/app/krater-pro", "--krater-smoke-test"],
    });
    expect(smokeCommand("mac", "/app/Krater Pro")).toEqual({
      command: "/app/Krater Pro",
      arguments: ["--krater-smoke-test"],
    });
    expect(
      smokeEnvironment({
        platform: "linux",
        workspace: "/tmp/krater",
        environment: { SOURCE_DATE_EPOCH: "0" },
      }),
    ).toEqual({
      APPIMAGE_EXTRACT_AND_RUN: "1",
      KRATER_API_KEY: "",
      KRATER_DESKTOP_WORKSPACE: "/tmp/krater",
      SOURCE_DATE_EPOCH: "0",
    });
    expect(
      smokeEnvironment({
        platform: "win",
        workspace: "C:\\Temp\\krater",
        environment: {},
      }),
    ).not.toHaveProperty("APPIMAGE_EXTRACT_AND_RUN");
    expect(
      validSmokeProof(
        {
          architecture: "x64",
          commandGate: true,
          platform: "win32",
          renderer: true,
          reopened: true,
          schemaVersion: 1,
        },
        "win",
      ),
    ).toBe(true);
    expect(
      validSmokeProof(
        {
          architecture: "x64",
          commandGate: true,
          platform: "win32",
          renderer: true,
          reopened: false,
          schemaVersion: 1,
        },
        "win",
      ),
    ).toBe(false);
  });

  it("launches distributed macOS ZIP, Windows portable, and Linux AppImage artifacts", async () => {
    const releaseRoot = await mkdtemp(join(tmpdir(), "krater-native-smoke-"));
    try {
      const unpackedWindows = join(
        releaseRoot,
        "win-unpacked",
        "KraterPro.exe",
      );
      const portableWindows = join(
        releaseRoot,
        "Krater-Pro-Portable-0.1.0-x64.exe",
      );
      await mkdir(join(releaseRoot, "win-unpacked"), { recursive: true });
      await writeFile(unpackedWindows, "unpacked");
      await writeFile(portableWindows, "portable");

      await expect(
        resolveSmokeArtifacts({ platform: "win", releaseRoot }),
      ).resolves.toMatchObject({
        artifactPath: portableWindows,
        boundaryExecutable: unpackedWindows,
        launchExecutable: portableWindows,
      });

      const macArchive = join(releaseRoot, "Krater-Pro-0.1.0-arm64.zip");
      const extractedMac = join(
        releaseRoot,
        "extracted",
        "Krater Pro.app",
        "Contents",
        "MacOS",
        "Krater Pro",
      );
      let extractedFrom;
      await expect(
        resolveSmokeArtifacts({
          platform: "mac",
          releaseRoot,
          extractMacArchive: async (root) => {
            extractedFrom = root;
            return {
              archive: macArchive,
              executable: extractedMac,
              extractionRoot: join(releaseRoot, "extracted"),
            };
          },
        }),
      ).resolves.toMatchObject({
        artifactPath: macArchive,
        boundaryExecutable: extractedMac,
        launchExecutable: extractedMac,
      });
      expect(extractedFrom).toBe(releaseRoot);

      const unpackedLinux = join(
        releaseRoot,
        "linux-unpacked",
        "krater-pro",
      );
      const appImage = join(
        releaseRoot,
        "Krater-Pro-0.1.0-x64.AppImage",
      );
      await mkdir(join(releaseRoot, "linux-unpacked"), { recursive: true });
      await writeFile(unpackedLinux, "unpacked");
      await writeFile(appImage, "appimage");
      await expect(
        resolveSmokeArtifacts({ platform: "linux", releaseRoot }),
      ).resolves.toMatchObject({
        artifactPath: appImage,
        boundaryExecutable: unpackedLinux,
        launchExecutable: appImage,
      });
    } finally {
      await rm(releaseRoot, { recursive: true, force: true });
    }
  });
});
