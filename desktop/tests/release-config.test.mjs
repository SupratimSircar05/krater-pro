import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createChecksums, isReleaseArtifact } from "../scripts/checksums.mjs";
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
    "desktopName: krater-pro",
    "version}-${arch}",
    "dmg",
    "zip",
    "nsis",
    "portable",
    "AppImage",
    "deb",
    "icon.ico",
    "asar: true",
    "resetAdHocDarwinSignature: true",
    "runAsNode: false",
    "onlyLoadAppFromAsar: true",
    "grantFileProtocolExtraPrivileges: false",
    "afterPack: desktop/scripts/after-pack.mjs",
    "desktop/command-gate-parent.mjs",
    "entitlements: desktop/entitlements.mac.plist",
    "entitlementsInherit: desktop/entitlements.mac.inherit.plist",
    "maintainer: Supratim Sircar <supratimsircar@users.noreply.github.com>",
    "syncDesktopName: true",
  ]) {
    assert.ok(config.includes(required), `missing desktop config: ${required}`);
  }

  const buildScript = await readFile(
    join(repositoryRoot, "desktop", "scripts", "build.mjs"),
    "utf8",
  );
  assert.match(buildScript, /!environment\.CSC_LINK/);
  assert.match(buildScript, /delete environment\.CSC_LINK/);
  assert.match(buildScript, /delete environment\.CSC_KEY_PASSWORD/);
  for (const notaryVariable of [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]) {
    assert.match(
      buildScript,
      new RegExp(`delete environment\\.${notaryVariable}`),
      `candidate builds must discard ${notaryVariable}`,
    );
  }
  assert.match(
    buildScript,
    /builderArguments\.push\("--config\.mac\.identity=-"\)/,
  );
  assert.match(buildScript, /KRATER_RELEASE_MODE === "stable"/);
  assert.match(buildScript, /"--config\.mac\.notarize=true"/);
  for (const alias of [
    "-w",
    "-wm",
    "--win",
    "--win=portable",
    "--windows=nsis",
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "desktop", "scripts", "build.mjs"), alias],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          KRATER_RELEASE_MODE: "stable",
          CSC_LINK: "",
          CSC_KEY_PASSWORD: "",
        },
      },
    );
    assert.notEqual(result.status, 0, `${alias} must validate Windows signing`);
    assert.match(result.stderr, /CSC_LINK/);
  }

  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageManifest.os, undefined);
  assert.equal(
    packageManifest.scripts["desktop:dist:win"],
    "npm run desktop:prepare && node desktop/scripts/build.mjs --win",
  );

  const afterPack = await readFile(
    join(repositoryRoot, "desktop", "scripts", "after-pack.mjs"),
    "utf8",
  );
  assert.match(afterPack, /"\/usr\/bin\/xattr", \["-cr", appPath\]/);

  const bootstrap = await readFile(
    join(repositoryRoot, "desktop", "bootstrap.mjs"),
    "utf8",
  );
  assert.match(bootstrap, /assertTrustedCommandGateParent/);
  assert.match(bootstrap, /command gate refused an untrusted parent process/);
  assert.doesNotMatch(bootstrap, /Windows support has been removed/);

  const cli = await readFile(join(repositoryRoot, "src", "cli.ts"), "utf8");
  assert.doesNotMatch(cli, /Windows support has been removed/);

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
  assert.match(
    main,
    /app\.on\("before-quit", \(event\) => \{\s+quitting = true/,
  );
  assert.match(
    main,
    /closeLocalServer\(\)\.finally\(\(\) => \{[\s\S]*app\.exit\(0\)/,
  );
  assert.match(
    main,
    /startServer\(config, \{ evidenceMode: true \}\)/,
    "desktop must use the same evidence-native staged agent runtime as krater web",
  );
  assert.match(main, /KRATER_DESKTOP_REOPEN_OK/);
  assert.match(main, /localServer\.createLaunchUrl/);
  assert.match(main, /reopenMainWindow\(\{ showWhenReady: false \}\)/);
  assert.match(main, /smokeTestActive = options\.smokeTest/);
  assert.match(
    main,
    /shouldQuitWhenAllWindowsClosed\(process\.platform, smokeTestActive\)/,
  );
  assert.match(main, /if \(!smokeTestActive\) \{\s+dialog\.showErrorBox/);
  assert.match(main, /app\.on\("activate", \(\) => \{\s+reopenMainWindow\(\)/);
});

test("write-capable release automation pins actions and isolates permission", async () => {
  const workflow = (
    await readFile(
      join(repositoryRoot, ".github", "workflows", "desktop-release.yml"),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*permissions:\n      contents: write/);
  assert.match(
    workflow,
    /- name: Select ephemeral Apple key path\n\s+if: github\.event_name == 'push' && matrix\.platform == 'mac'/,
    "candidate builds must not opt into notarization without stable-release credentials",
  );
  assert.match(
    workflow,
    /assemble:\n[\s\S]*?if: >-\n\s+always\(\) &&\n\s+needs\.validate\.result == 'success' &&\n\s+needs\.cli\.result == 'success' &&\n\s+needs\.desktop\.result == 'success'/,
    "candidate receipt assembly must explicitly tolerate the skipped stable-release authorization job",
  );
  assert.equal(/uses:\s+[^@\s]+@v\d/.test(workflow), false);
  assert.doesNotMatch(workflow, /macos-14/);
  assert.ok((workflow.match(/persist-credentials: false/g) ?? []).length >= 5);
  for (const required of [
    "os: macos-15\n",
    "macos-15-intel",
    "windows-2022",
    "ubuntu-22.04",
    "node-version: 22.23.1",
    "NPM_VERSION: 11.16.0",
    "NODE_OPTIONS: --max-old-space-size=6144",
    'npm install --global "npm@${{ env.NPM_VERSION }}"',
    "NODE_OPTIONS: --max-old-space-size=6144",
    "release:cli",
    "smoke-built-desktop.mjs",
    "smoke-workspace-command.mjs",
    "src/command-gate.test.ts",
    "src/credential-store.launch.test.ts",
    "src/credential-store.windows-launch.test.ts",
    "src/windows-system-executable.test.ts",
    "desktop:dist:win",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "HAS_WINDOWS_SIGNING",
    "Verify Windows Authenticode signatures",
    '"release" "win-unpacked"',
    "Test-Path -LiteralPath $innerExecutable -PathType Leaf",
    "validate-release-environment.mjs",
    "create-release-manifest.mjs",
    "sign-release-artifacts.mjs",
    "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
    "HOMEBREW_TAP_TOKEN",
    "production-release",
  ]) {
    assert.ok(workflow.includes(required), `missing release gate: ${required}`);
  }
  assert.doesNotMatch(
    workflow,
    /echo\s+["']?\$\{\{\s*secrets\./,
    "release workflow must never print a secret expression",
  );
});

test("pull-request CI exercises macOS, Windows, and Linux command boundaries", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /macos-14/);
  for (const required of [
    "native-boundary:",
    "os: macos-15\n",
    "windows-2022",
    "ubuntu-22.04",
    "platform: win",
    "platform: linux",
    "xvfb-run -a npm run desktop:start -- --krater-smoke-test",
    "NODE_OPTIONS: --max-old-space-size=6144",
    'npm install --global "npm@${{ env.NPM_VERSION }}"',
    "npm run build",
    "src/command-gate.test.ts",
    "src/credential-store.launch.test.ts",
    "src/credential-store.windows-launch.test.ts",
    "src/windows-system-executable.test.ts",
    "src/workspace.command-security.test.ts",
    "desktop/tests/command-gate-parent.test.mjs",
    "smoke-workspace-command.mjs",
    "npm run desktop:start -- --krater-smoke-test",
    "KRATER_DESKTOP_WORKSPACE",
  ]) {
    assert.ok(
      workflow.includes(required),
      `missing PR boundary gate: ${required}`,
    );
  }
  assert.ok(
    workflow.indexOf("npm run build") <
      workflow.indexOf("npm test -- --testTimeout=120000 --hookTimeout=30000"),
    "the production shell must be built before server tests execute",
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
  await writeFile(join(directory, "Krater-Pro-0.1.0-x64.exe"), "windows");
  await writeFile(join(directory, "Krater-Pro-0.1.0-x86_64.AppImage"), "linux");
  await writeFile(join(directory, "builder-debug.yml"), "ignored");
  const result = await createChecksums(directory);
  assert.deepEqual(result.artifacts, [
    "Krater-Pro-0.1.0-arm64.dmg",
    "Krater-Pro-0.1.0-x64.exe",
    "Krater-Pro-0.1.0-x86_64.AppImage",
  ]);
  assert.equal(result.output.trim().split("\n").length, 3);
  assert.equal(isReleaseArtifact("Krater-Pro.exe"), true);
  assert.equal(isReleaseArtifact("latest.yml"), false);
});
