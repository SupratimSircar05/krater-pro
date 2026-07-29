import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseEnvironment } from "../../scripts/release/validate-release-environment.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = resolve(
  repositoryRoot,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const forwarded = process.argv.slice(2);
const shortTargetFlags = forwarded
  .filter((argument) => /^-[mwl]+$/u.test(argument))
  .join("");
const explicitlyTargetsWindows =
  shortTargetFlags.includes("w") ||
  forwarded.includes("--win") ||
  forwarded.includes("--windows") ||
  forwarded.some(
    (argument) =>
      argument.startsWith("--win=") || argument.startsWith("--windows="),
  );
const explicitlyTargetsMac =
  shortTargetFlags.includes("m") || forwarded.includes("--mac");
const explicitlyTargetsLinux =
  shortTargetFlags.includes("l") || forwarded.includes("--linux");
const targetsMac =
  explicitlyTargetsMac ||
  (!explicitlyTargetsWindows &&
    !explicitlyTargetsLinux &&
    process.platform === "darwin");
const targetsWindows =
  explicitlyTargetsWindows ||
  (!explicitlyTargetsMac &&
    !explicitlyTargetsLinux &&
    process.platform === "win32");
const environment = { ...process.env };
// GitHub expressions materialize unavailable secrets as empty strings. An
// empty CSC_LINK is not equivalent to an unset value in electron-builder: it
// is resolved as the project directory and fails with "not a file" before
// candidate ad-hoc signing can begin.
if (!environment.CSC_LINK?.trim()) delete environment.CSC_LINK;
if (!environment.CSC_KEY_PASSWORD?.trim()) {
  delete environment.CSC_KEY_PASSWORD;
}
const stableRelease = environment.KRATER_RELEASE_MODE === "stable";
// Candidate builds must never inherit partial notarization state from the
// runner. electron-builder treats APPLE_API_KEY alone as an instruction to
// notarize, even when the build explicitly uses an ad-hoc identity.
if (!stableRelease || !targetsMac) {
  delete environment.APPLE_API_KEY;
  delete environment.APPLE_API_KEY_ID;
  delete environment.APPLE_API_ISSUER;
}
if (stableRelease && targetsMac) {
  validateReleaseEnvironment({
    platform: "mac",
    stable: true,
    environment,
  });
}
if (stableRelease && targetsWindows) {
  validateReleaseEnvironment({
    platform: "win",
    stable: true,
    environment,
  });
}
const localMacStage =
  targetsMac &&
  process.platform === "darwin" &&
  environment.GITHUB_ACTIONS !== "true"
    ? await mkdtemp(join(tmpdir(), "krater-pro-desktop-release-"))
    : undefined;

const builderArguments = [
  cliPath,
  "--config",
  "desktop/electron-builder.yml",
  "--publish",
  "never",
  ...forwarded,
];
// Flipping Electron fuses invalidates the framework's upstream linker
// signature on Apple silicon. When no private signing certificate is supplied,
// ask electron-builder to perform a full, post-fuse ad-hoc signing pass. If
// CSC_LINK/CSC_NAME exists, normal certificate discovery and signing wins.
if (targetsMac && !environment.CSC_LINK && !environment.CSC_NAME) {
  builderArguments.push("--config.mac.identity=-");
}
if (stableRelease && targetsMac) {
  builderArguments.push("--config.mac.notarize=true");
}
if (localMacStage) {
  // Documents can be backed by a macOS File Provider that re-adds Finder
  // metadata immediately after xattr removal. codesign rejects that metadata.
  // Build/sign in the OS temp volume, then copy only flat DMG/ZIP artifacts.
  builderArguments.push(
    `--config.directories.output=${localMacStage}`,
  );
}

const child = spawn(
  process.execPath,
  builderArguments,
  {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  },
);

const result = await new Promise((resolveResult, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    resolveResult({ code, signal });
  });
});

if (result.signal) {
  process.kill(process.pid, result.signal);
} else if (result.code === 0 && localMacStage) {
  const releaseDirectory = join(repositoryRoot, "release");
  await mkdir(releaseDirectory, { recursive: true });
  const entries = await readdir(localMacStage, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isFile() &&
      [".dmg", ".zip"].some((extension) => entry.name.endsWith(extension))
    ) {
      await copyFile(
        join(localMacStage, entry.name),
        join(releaseDirectory, entry.name),
      );
    }
  }
  process.stdout.write(
    `Local signed build directory: ${localMacStage}\n`,
  );
} else {
  process.exitCode = result.code ?? 1;
}
