import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../scripts/release/release-utils.mjs";
import {
  prepareWinget,
  validateAuthenticodeReceipt,
} from "./prepare-winget.mjs";
import {
  packageIdentifier,
  renderWingetManifests,
  windowsInstallerName,
  windowsInstallerUrl,
} from "./render-manifests.mjs";

const temporaryRoots = [];
const version = "1.0.0";
const installer = "signed installer bytes";
const installerSha256 = sha256(installer);

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    product: "Krater Pro",
    version,
    artifact: windowsInstallerName(version),
    sha256: installerSha256,
    source: {
      repository: "https://github.com/SupratimSircar05/krater-pro",
      ref: `refs/tags/v${version}`,
    },
    authenticode: {
      status: "Valid",
      signerSubject: "CN=Krater Pro release signer",
      signerThumbprint: "a".repeat(40),
      timestampSignerSubject: "CN=Trusted timestamp authority",
      timestampSignerThumbprint: "b".repeat(40),
    },
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "krater-winget-"));
  temporaryRoots.push(root);
  const assets = join(root, "assets");
  const output = join(root, "output");
  await mkdir(assets);
  await writeFile(join(assets, windowsInstallerName(version)), installer);
  await writeFile(
    join(assets, `krater-pro-windows-${version}.authenticode.json`),
    `${JSON.stringify(validReceipt())}\n`,
  );
  return { assets, output };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("WinGet manifest preparation", () => {
  it("binds every manifest to the exact tagged installer URL, version, and digest", async () => {
    const { assets, output } = await fixture();
    const result = await prepareWinget({ assets, output, version });
    expect(result.installerName).toBe(windowsInstallerName(version));
    expect(result.installerUrl).toBe(windowsInstallerUrl(version));
    expect(result.installerSha256).toBe(installerSha256);
    expect(result.paths.map((path) => path.split("/").at(-1)).sort()).toEqual([
      `${packageIdentifier}.installer.yaml`,
      `${packageIdentifier}.locale.en-US.yaml`,
      `${packageIdentifier}.yaml`,
    ]);

    const installerManifest = await readFile(
      join(output, `${packageIdentifier}.installer.yaml`),
      "utf8",
    );
    expect(installerManifest).toContain(`PackageVersion: "${version}"`);
    expect(installerManifest).toContain(
      `InstallerUrl: "${windowsInstallerUrl(version)}"`,
    );
    expect(installerManifest).toContain(
      `InstallerSha256: "${installerSha256}"`,
    );
    expect(installerManifest).toContain("InstallerType: nullsoft");
    expect(installerManifest).toContain("Scope: user");
    expect(installerManifest).toContain("ManifestVersion: 1.12.0");

    const localeManifest = await readFile(
      join(output, `${packageIdentifier}.locale.en-US.yaml`),
      "utf8",
    );
    expect(localeManifest).toContain(`/blob/v${version}/LICENSE`);
    expect(localeManifest).toContain(`/releases/tag/v${version}`);
  });

  it("fails closed when installer bytes, release identity, or signature evidence diverges", async () => {
    const { assets, output } = await fixture();
    await writeFile(join(assets, windowsInstallerName(version)), "tampered");
    await expect(prepareWinget({ assets, output, version })).rejects.toThrow(
      /does not match the installer bytes/,
    );

    for (const receipt of [
      validReceipt({ version: "1.0.1" }),
      validReceipt({
        source: {
          repository: "https://github.com/example/fork",
          ref: `refs/tags/v${version}`,
        },
      }),
      validReceipt({
        authenticode: {
          ...validReceipt().authenticode,
          status: "NotSigned",
        },
      }),
      validReceipt({
        authenticode: {
          ...validReceipt().authenticode,
          timestampSignerThumbprint: "",
        },
      }),
    ]) {
      expect(() =>
        validateAuthenticodeReceipt(receipt, {
          version,
          sha256: installerSha256,
        }),
      ).toThrow();
    }
  });

  it("rejects unsafe renderer inputs and refuses to overwrite manifests", async () => {
    expect(() =>
      renderWingetManifests(
        {
          version: "{{VERSION}}",
          installer: "{{INSTALLER_SHA256}} {{INSTALLER_URL}}",
          locale: "{{VERSION}}",
        },
        { version: "1.0.0\nInjected: true", installerSha256 },
      ),
    ).toThrow(/release-safe semver/);
    expect(() =>
      renderWingetManifests(
        {
          version: "{{UNKNOWN_TOKEN}}",
          installer: "{{INSTALLER_SHA256}}",
          locale: "{{VERSION}}",
        },
        { version, installerSha256 },
      ),
    ).toThrow(/Unresolved/);

    const { assets, output } = await fixture();
    await prepareWinget({ assets, output, version });
    await expect(prepareWinget({ assets, output, version })).rejects.toThrow(
      /EEXIST/,
    );
  });
});
