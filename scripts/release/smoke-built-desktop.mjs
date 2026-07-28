#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function findRecursively(root, predicate) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(root, entry.name);
    if (predicate(path, entry)) return path;
    if (entry.isDirectory()) {
      const nested = await findRecursively(path, predicate);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function smokeCommand(platform, executable) {
  if (platform === "linux") {
    return {
      command: "xvfb-run",
      arguments: ["-a", executable, "--krater-smoke-test"],
    };
  }
  if (platform === "mac" || platform === "win") {
    return { command: executable, arguments: ["--krater-smoke-test"] };
  }
  throw new Error(`Unsupported desktop smoke platform: ${platform}`);
}

async function findExecutable(releaseRoot, platform) {
  if (platform === "mac") {
    return findRecursively(
      releaseRoot,
      (path, entry) =>
        entry.isFile() &&
        path.endsWith(
          join("Krater Pro.app", "Contents", "MacOS", "Krater Pro"),
        ),
    );
  }
  if (platform === "win") {
    return findRecursively(
      releaseRoot,
      (path, entry) =>
        entry.isFile() &&
        /win-unpacked[\\/]KraterPro\.exe$/iu.test(path),
    );
  }
  if (platform === "linux") {
    return findRecursively(
      releaseRoot,
      (path, entry) =>
        entry.isFile() &&
        /linux-unpacked[\\/]krater-pro$/u.test(path),
    );
  }
  throw new Error(`Unsupported desktop smoke platform: ${platform}`);
}

async function extractMacZip(releaseRoot) {
  const archive = await findRecursively(
    releaseRoot,
    (path, entry) => entry.isFile() && path.endsWith(".zip"),
  );
  if (!archive) return undefined;
  const extractionRoot = await mkdtemp(
    join(tmpdir(), "krater-desktop-release-unzip-"),
  );
  try {
    await execFileAsync(
      "/usr/bin/ditto",
      ["-x", "-k", archive, extractionRoot],
      {
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const executable = await findExecutable(extractionRoot, "mac");
    if (!executable) {
      throw new Error("The macOS ZIP did not contain Krater Pro.app.");
    }
    return { executable, extractionRoot };
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function smokeBuiltDesktop({
  platform,
  releaseRoot = "release",
}) {
  const absoluteRoot = resolve(releaseRoot);
  let extraction;
  let executable = await findExecutable(absoluteRoot, platform);
  if (!executable && platform === "mac") {
    extraction = await extractMacZip(absoluteRoot);
    executable = extraction?.executable;
  }
  if (!executable) {
    throw new Error(`No unpacked ${platform} executable was found.`);
  }
  const command = smokeCommand(platform, executable);
  const workspace = await mkdtemp(
    join(tmpdir(), "krater-desktop-release-smoke-"),
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      command.command,
      command.arguments,
      {
        cwd: absoluteRoot,
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          KRATER_API_KEY: "",
          KRATER_DESKTOP_WORKSPACE: workspace,
        },
      },
    );
    if (!stdout.includes("KRATER_DESKTOP_SMOKE_OK")) {
      throw new Error(
        `Packaged desktop smoke marker was missing. stderr: ${stderr.slice(0, 500)}`,
      );
    }
    process.stdout.write(stdout);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    if (extraction) {
      await rm(extraction.extractionRoot, { recursive: true, force: true });
    }
  }
}

function parseArguments(args) {
  const platformIndex = args.indexOf("--platform");
  const rootIndex = args.indexOf("--release-root");
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
  if (!platform) throw new Error("--platform is required.");
  return {
    platform,
    releaseRoot: rootIndex >= 0 ? args[rootIndex + 1] : "release",
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  smokeBuiltDesktop(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`Desktop launch smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
