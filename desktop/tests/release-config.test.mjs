import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  createChecksums,
  isReleaseArtifact,
} from "../scripts/checksums.mjs";
import { expectedTag } from "../scripts/verify-release-tag.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("desktop release config covers every requested native format", async () => {
  const config = await readFile(
    join(repositoryRoot, "desktop", "electron-builder.yml"),
    "utf8",
  );
  for (const required of [
    "productName: Krater Pro",
    "version}-${arch}",
    "dmg",
    "zip",
    "nsis",
    "portable",
    "AppImage",
    "deb",
    "asar: true",
    "resetAdHocDarwinSignature: true",
    "runAsNode: false",
    "onlyLoadAppFromAsar: true",
    "grantFileProtocolExtraPrivileges: false",
    "afterPack: desktop/scripts/after-pack.mjs",
    "entitlements: desktop/entitlements.mac.plist",
    "entitlementsInherit: desktop/entitlements.mac.inherit.plist",
  ]) {
    assert.ok(config.includes(required), `missing desktop config: ${required}`);
  }

  const buildScript = await readFile(
    join(repositoryRoot, "desktop", "scripts", "build.mjs"),
    "utf8",
  );
  assert.match(buildScript, /!environment\.CSC_LINK/);
  assert.match(buildScript, /builderArguments\.push\("--config\.mac\.identity=-"\)/);

  const afterPack = await readFile(
    join(repositoryRoot, "desktop", "scripts", "after-pack.mjs"),
    "utf8",
  );
  assert.match(afterPack, /"\/usr\/bin\/xattr", \["-cr", appPath\]/);

  for (const entitlementFile of [
    "entitlements.mac.plist",
    "entitlements.mac.inherit.plist",
  ]) {
    const entitlements = await readFile(
      join(repositoryRoot, "desktop", entitlementFile),
      "utf8",
    );
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
    assert.match(
      entitlements,
      /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
    );
    assert.match(
      entitlements,
      /com\.apple\.security\.cs\.disable-library-validation/,
    );
  }
});

test("desktop shutdown exits after asynchronous loopback cleanup", async () => {
  const main = await readFile(
    join(repositoryRoot, "desktop", "main.mjs"),
    "utf8",
  );
  assert.match(
    main,
    /if \(quitting \|\| details\.reason === "clean-exit"\) return/,
  );
  assert.match(main, /app\.on\("before-quit", \(event\) => \{\s+quitting = true/);
  assert.match(
    main,
    /closeLocalServer\(\)\.finally\(\(\) => \{[\s\S]*app\.exit\(0\)/,
  );
});

test("write-capable release automation pins actions and isolates permission", async () => {
  const workflow = (
    await readFile(
      join(repositoryRoot, ".github", "workflows", "desktop-release.yml"),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(
    workflow,
    /release:[\s\S]*permissions:\n      contents: write/,
  );
  assert.equal(/uses:\s+[^@\s]+@v\d/.test(workflow), false);
  assert.equal(
    (workflow.match(/persist-credentials: false/g) ?? []).length,
    3,
  );
});

test("release tag must exactly match package version", () => {
  assert.equal(expectedTag("0.1.0"), "v0.1.0");
  assert.equal(expectedTag("1.2.3-rc.1"), "v1.2.3-rc.1");
  assert.throws(() => expectedTag("latest"), /not release-safe semver/);
});

test("checksums cover distributables and ignore build metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "krater-checksums-"));
  await writeFile(join(directory, "Krater-Pro-0.1.0-arm64.dmg"), "mac");
  await writeFile(join(directory, "Krater-Pro-0.1.0-x64.AppImage"), "linux");
  await writeFile(join(directory, "builder-debug.yml"), "ignored");
  const result = await createChecksums(directory);
  assert.deepEqual(result.artifacts, [
    "Krater-Pro-0.1.0-arm64.dmg",
    "Krater-Pro-0.1.0-x64.AppImage",
  ]);
  assert.equal(result.output.trim().split("\n").length, 2);
  assert.equal(isReleaseArtifact("Krater-Pro.exe"), true);
  assert.equal(isReleaseArtifact("latest.yml"), false);
});
