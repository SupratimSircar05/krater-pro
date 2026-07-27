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
const targetsMac =
  forwarded.includes("--mac") ||
  (!forwarded.includes("--win") &&
    !forwarded.includes("--linux") &&
    process.platform === "darwin");
const environment = { ...process.env };
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
