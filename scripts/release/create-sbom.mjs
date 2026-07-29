#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  gitSourceDateEpoch,
  normalizeSpdx,
  sha256,
  stableJson,
} from "./release-utils.mjs";
import {
  releasePackageManifest,
  releaseShrinkwrap,
} from "./build-cli-artifact.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function parseArguments(args) {
  const parsed = { profile: "desktop" };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!["--output", "--profile", "--source-date-epoch"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    index += 1;
    if (option === "--output") parsed.output = value;
    if (option === "--profile") parsed.profile = value;
    if (option === "--source-date-epoch") parsed.sourceDateEpoch = value;
  }
  if (!parsed.output) throw new Error("--output is required.");
  if (parsed.profile !== "desktop") {
    throw new Error("Only the desktop SBOM profile is supported here.");
  }
  return parsed;
}

export function addElectronPackage(document, manifest) {
  const electronVersion = String(
    manifest.devDependencies?.electron ?? "",
  ).replace(/^[^\d]*/u, "");
  if (!/^\d+\.\d+\.\d+/.test(electronVersion)) {
    throw new Error("package.json must pin a release-safe Electron version.");
  }
  const packageId = `SPDXRef-Package-electron-${electronVersion}`;
  if (!document.packages.some(({ SPDXID }) => SPDXID === packageId)) {
    document.packages.push({
      name: "electron",
      SPDXID: packageId,
      versionInfo: electronVersion,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseDeclared: "MIT",
      primaryPackagePurpose: "APPLICATION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/electron@${electronVersion}`,
        },
      ],
    });
    const root = document.packages.find(({ name }) => name === manifest.name);
    if (root) {
      document.relationships ??= [];
      document.relationships.push({
        spdxElementId: root.SPDXID,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: packageId,
      });
    }
  }
  return document;
}

export function npmInvocation(arguments_) {
  return {
    executable: "npm",
    arguments: arguments_,
  };
}

async function executeNpm(arguments_, options) {
  const invocation = npmInvocation(arguments_);
  return execFileAsync(
    invocation.executable,
    invocation.arguments,
    options,
  );
}

export async function createDesktopSbom({
  output,
  sourceDateEpoch,
} = {}) {
  if (!output) throw new Error("An SBOM output path is required.");
  const manifestText = await readFile(
    resolve(repositoryRoot, "package.json"),
    "utf8",
  );
  const lockText = await readFile(
    resolve(repositoryRoot, "package-lock.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestText);
  const packagedManifest = releasePackageManifest(manifest);
  const shrinkwrap = releaseShrinkwrap(JSON.parse(lockText));
  const packagedManifestText = stableJson(packagedManifest);
  const shrinkwrapText = stableJson(shrinkwrap);
  const stagingRoot = await mkdtemp(join(tmpdir(), "krater-desktop-sbom-"));
  let stdout;
  try {
    await Promise.all([
      writeFile(join(stagingRoot, "package.json"), packagedManifestText),
      writeFile(join(stagingRoot, "npm-shrinkwrap.json"), shrinkwrapText),
    ]);
    await executeNpm(
      [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: stagingRoot,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    ({ stdout } = await executeNpm(
      ["sbom", "--omit=dev", "--sbom-format=spdx"],
      {
        cwd: stagingRoot,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    ));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const withElectron = addElectronPackage(JSON.parse(stdout), manifest);
  const epoch =
    sourceDateEpoch ??
    process.env.SOURCE_DATE_EPOCH ??
    (await gitSourceDateEpoch(repositoryRoot));
  const normalized = normalizeSpdx(withElectron, {
    namespaceDigest: sha256(
      `${packagedManifestText}\0${shrinkwrapText}\0electron:${manifest.devDependencies.electron}`,
    ),
    sourceDateEpoch: epoch,
    profile: "desktop",
  });
  await writeFile(resolve(output), stableJson(normalized), {
    encoding: "utf8",
    mode: 0o644,
  });
  return normalized;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  createDesktopSbom(options).catch((error) => {
    process.stderr.write(`SBOM generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
