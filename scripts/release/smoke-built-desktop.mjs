#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DESKTOP_SMOKE_PROOF = ".krater-desktop-smoke.json";

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

export function smokeEnvironment({
  platform,
  workspace,
  environment = process.env,
}) {
  return {
    ...environment,
    KRATER_API_KEY: "",
    KRATER_DESKTOP_WORKSPACE: workspace,
    ...(platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
  };
}

export function validSmokeProof(proof, platform) {
  const expectedPlatform = {
    linux: "linux",
    mac: "darwin",
    win: "win32",
  }[platform];
  return (
    proof?.schemaVersion === 1 &&
    proof.platform === expectedPlatform &&
    ["arm64", "x64"].includes(proof.architecture) &&
    proof.renderer === true &&
    proof.commandGate === true &&
    proof.reopened === true
  );
}

function internalGateCommand(platform, executable) {
  const arguments_ = ["--krater-internal-command-gate"];
  return platform === "linux"
    ? { command: "xvfb-run", arguments: ["-a", executable, ...arguments_] }
    : { command: executable, arguments: arguments_ };
}

function runAsNodeProbeCommand(platform, executable) {
  const marker = "KRATER_UNSAFE_RUN_AS_NODE";
  const arguments_ = [
    "-e",
    `process.stdout.write("${marker}\\n")`,
    "--krater-internal-command-gate",
  ];
  return {
    marker,
    ...(platform === "linux"
      ? { command: "xvfb-run", arguments: ["-a", executable, ...arguments_] }
      : { command: executable, arguments: arguments_ }),
  };
}

async function assertDirectGateRejected({
  platform,
  executable,
  cwd,
  environment,
}) {
  const command = internalGateCommand(platform, executable);
  try {
    await execFileAsync(command.command, command.arguments, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: environment,
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (
      error.code === 126 &&
      output.includes(
        "Krater internal command gate refused an untrusted parent process.",
      )
    ) {
      return;
    }
    throw new Error(
      `Packaged command gate did not fail closed for a direct caller: ${output.slice(0, 500)}`,
      { cause: error },
    );
  }
  throw new Error("Packaged command gate accepted a direct external caller.");
}

async function assertRunAsNodeDisabled({
  platform,
  executable,
  cwd,
  environment,
}) {
  const command = runAsNodeProbeCommand(platform, executable);
  try {
    const result = await execFileAsync(command.command, command.arguments, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    throw new Error(
      result.stdout.includes(command.marker)
        ? "Packaged Electron still permits Run-as-Node."
        : "Packaged Electron did not fail closed under a Run-as-Node probe.",
    );
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (output.includes(command.marker)) {
      throw new Error("Packaged Electron still permits Run-as-Node.", {
        cause: error,
      });
    }
    if (
      error.code === 126 &&
      output.includes(
        "Krater internal command gate refused an untrusted parent process.",
      )
    ) {
      return;
    }
    throw error;
  }
}

async function findUnpackedExecutable(releaseRoot, platform) {
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
    (path, entry) =>
      entry.isFile() &&
      /^Krater-Pro-.+-(?:arm64|x64)\.zip$/iu.test(basename(path)),
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
    const executable = await findUnpackedExecutable(extractionRoot, "mac");
    if (!executable) {
      throw new Error("The macOS ZIP did not contain Krater Pro.app.");
    }
    return { archive, executable, extractionRoot };
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

async function findWindowsPortable(releaseRoot) {
  return findRecursively(
    releaseRoot,
    (path, entry) =>
      entry.isFile() &&
      /^Krater-Pro-Portable-.+\.exe$/iu.test(basename(path)),
  );
}

async function findLinuxAppImage(releaseRoot) {
  return findRecursively(
    releaseRoot,
    (path, entry) =>
      entry.isFile() &&
      /^Krater-Pro-.+-(?:arm64|x64)\.AppImage$/u.test(basename(path)),
  );
}

export async function resolveSmokeArtifacts({
  platform,
  releaseRoot,
  extractMacArchive = extractMacZip,
}) {
  const absoluteRoot = resolve(releaseRoot);
  if (platform === "mac") {
    const extraction = await extractMacArchive(absoluteRoot);
    if (!extraction?.archive || !extraction.executable) {
      throw new Error("No packaged macOS ZIP artifact was found.");
    }
    return {
      absoluteRoot,
      artifactPath: extraction.archive,
      boundaryExecutable: extraction.executable,
      launchExecutable: extraction.executable,
      extraction,
    };
  }
  if (platform === "win") {
    const [boundaryExecutable, launchExecutable] = await Promise.all([
      findUnpackedExecutable(absoluteRoot, platform),
      findWindowsPortable(absoluteRoot),
    ]);
    if (!boundaryExecutable) {
      throw new Error("No unpacked Windows executable was found for boundary probes.");
    }
    if (!launchExecutable) {
      throw new Error("No packaged Windows portable executable was found.");
    }
    return {
      absoluteRoot,
      artifactPath: launchExecutable,
      boundaryExecutable,
      launchExecutable,
      extraction: undefined,
    };
  }
  if (platform === "linux") {
    const [boundaryExecutable, launchExecutable] = await Promise.all([
      findUnpackedExecutable(absoluteRoot, platform),
      findLinuxAppImage(absoluteRoot),
    ]);
    if (!boundaryExecutable) {
      throw new Error("No unpacked Linux executable was found for boundary probes.");
    }
    if (!launchExecutable) {
      throw new Error("No packaged Linux AppImage was found.");
    }
    return {
      absoluteRoot,
      artifactPath: launchExecutable,
      boundaryExecutable,
      launchExecutable,
      extraction: undefined,
    };
  }
  throw new Error(`Unsupported desktop smoke platform: ${platform}`);
}

export async function smokeBuiltDesktop({
  platform,
  releaseRoot = "release",
}) {
  const {
    absoluteRoot,
    artifactPath,
    boundaryExecutable,
    launchExecutable,
    extraction,
  } = await resolveSmokeArtifacts({ platform, releaseRoot });
  const command = smokeCommand(platform, launchExecutable);
  const workspace = await mkdtemp(
    join(tmpdir(), "krater-desktop-release-smoke-"),
  );
  try {
    const environment = smokeEnvironment({ platform, workspace });
    await assertDirectGateRejected({
      platform,
      executable: boundaryExecutable,
      cwd: absoluteRoot,
      environment,
    });
    await assertRunAsNodeDisabled({
      platform,
      executable: boundaryExecutable,
      cwd: absoluteRoot,
      environment,
    });
    const { stdout, stderr } = await execFileAsync(
      command.command,
      command.arguments,
      {
        cwd: absoluteRoot,
        encoding: "utf8",
        timeout: platform === "win" ? 120_000 : 90_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        env: environment,
      },
    );
    let proof;
    try {
      proof = JSON.parse(
        await readFile(join(workspace, DESKTOP_SMOKE_PROOF), "utf8"),
      );
    } catch (error) {
      throw new Error(
        `Packaged desktop smoke proof was missing or invalid. stderr: ${stderr.slice(0, 500)}`,
        { cause: error },
      );
    }
    if (!validSmokeProof(proof, platform)) {
      throw new Error(
        `Packaged desktop smoke proof failed: ${JSON.stringify(proof)}`,
      );
    }
    process.stdout.write(stdout);
    process.stdout.write(
      `KRATER_DESKTOP_PROOF_OK ${proof.platform} ${proof.architecture}\n`,
    );
    process.stdout.write(
      `KRATER_DESKTOP_ARTIFACT_OK ${platform} ${basename(artifactPath)}\n`,
    );
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
