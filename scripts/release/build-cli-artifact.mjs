#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertSafeRelativePath,
  assertSemver,
  gitSourceDateEpoch,
  normalizeSpdx,
  sha256,
  stableJson,
} from "./release-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "../..");

function parseArguments(args) {
  const parsed = {
    output: "release/cli",
    repositoryRoot: defaultRepositoryRoot,
    verifyReproducible: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--verify-reproducible") {
      parsed.verifyReproducible = true;
      continue;
    }
    if (!["--output", "--repository-root", "--source-date-epoch"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    index += 1;
    if (option === "--output") parsed.output = value;
    if (option === "--repository-root") parsed.repositoryRoot = value;
    if (option === "--source-date-epoch") parsed.sourceDateEpoch = value;
  }
  return parsed;
}

export function releasePackageManifest(manifest) {
  const output = structuredClone(manifest);
  delete output.devDependencies;
  delete output.workspaces;
  output.scripts = {};
  output.private = false;
  output.files = [
    ...new Set([...(output.files ?? []), "npm-shrinkwrap.json"]),
  ];
  return output;
}

export function releaseShrinkwrap(lockfile) {
  const output = structuredClone(lockfile);
  const root = output.packages?.[""];
  if (!root) throw new Error("package-lock.json is missing its root package.");
  delete root.devDependencies;
  delete root.workspaces;
  return output;
}

async function runNpm(arguments_, options = {}) {
  const executable =
    process.platform === "win32"
      ? process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
      : "npm";
  const invocationArguments =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", ...arguments_]
      : arguments_;
  return execFileAsync(executable, invocationArguments, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
}

async function listPackFiles(repositoryRoot) {
  const { stdout } = await runNpm(
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: repositoryRoot },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("npm pack did not return exactly one package.");
  }
  return result[0].files.map(({ path }) => assertSafeRelativePath(path));
}

async function copyPackFiles(repositoryRoot, stagingRoot, files) {
  for (const relativePath of files) {
    const source = join(repositoryRoot, relativePath);
    const target = join(stagingRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function packOnce(stagingRoot, destination) {
  await mkdir(destination, { recursive: true });
  const { stdout } = await runNpm(
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    { cwd: stagingRoot },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("npm pack did not produce exactly one CLI archive.");
  }
  return join(destination, basename(result[0].filename));
}

export async function buildCliArtifact({
  repositoryRoot = defaultRepositoryRoot,
  outputDirectory = "release/cli",
  sourceDateEpoch,
  verifyReproducible = false,
} = {}) {
  const absoluteRoot = resolve(repositoryRoot);
  const absoluteOutput = resolve(absoluteRoot, outputDirectory);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "krater-cli-release-"));
  try {
    const [manifest, lockfile, packFiles] = await Promise.all([
      readFile(join(absoluteRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(absoluteRoot, "package-lock.json"), "utf8").then(JSON.parse),
      listPackFiles(absoluteRoot),
    ]);
    const version = assertSemver(manifest.version);
    const epoch =
      sourceDateEpoch ??
      process.env.SOURCE_DATE_EPOCH ??
      (await gitSourceDateEpoch(absoluteRoot));
    const stagingRoot = join(temporaryRoot, "package-source");
    await mkdir(stagingRoot, { recursive: true });
    await copyPackFiles(absoluteRoot, stagingRoot, packFiles);

    const packagedManifest = releasePackageManifest(manifest);
    const shrinkwrap = releaseShrinkwrap(lockfile);
    const manifestText = stableJson(packagedManifest);
    const shrinkwrapText = stableJson(shrinkwrap);
    await Promise.all([
      writeFile(join(stagingRoot, "package.json"), manifestText, "utf8"),
      writeFile(
        join(stagingRoot, "npm-shrinkwrap.json"),
        shrinkwrapText,
        "utf8",
      ),
    ]);

    await runNpm(
      [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: stagingRoot },
    );
    // The source lockfile contains workspaces used to build the web bundle.
    // The published CLI manifest deliberately has no workspaces and includes
    // the already-built assets, so remove those now-extraneous packages before
    // generating the production-only SBOM.
    await runNpm(
      [
        "prune",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: stagingRoot },
    );
    const { stdout: rawSbom } = await runNpm(
      ["sbom", "--omit=dev", "--sbom-format=spdx"],
      { cwd: stagingRoot },
    );
    const namespaceDigest = sha256(`${manifestText}\0${shrinkwrapText}`);
    const sbom = normalizeSpdx(JSON.parse(rawSbom), {
      namespaceDigest,
      sourceDateEpoch: epoch,
      profile: "cli",
    });
    await rm(join(stagingRoot, "node_modules"), {
      recursive: true,
      force: true,
    });

    const firstArchive = await packOnce(stagingRoot, join(temporaryRoot, "one"));
    if (verifyReproducible) {
      const secondArchive = await packOnce(
        stagingRoot,
        join(temporaryRoot, "two"),
      );
      const [firstBytes, secondBytes] = await Promise.all([
        readFile(firstArchive),
        readFile(secondArchive),
      ]);
      if (!firstBytes.equals(secondBytes)) {
        throw new Error(
          "CLI archive reproducibility check failed: identical staged inputs produced different bytes.",
        );
      }
    }

    await mkdir(absoluteOutput, { recursive: true });
    const archiveName = `krater-pro-cli-${version}.tgz`;
    const archivePath = join(absoluteOutput, archiveName);
    const sbomPath = join(
      absoluteOutput,
      `krater-pro-cli-${version}.spdx.json`,
    );
    await rename(firstArchive, archivePath);
    await writeFile(sbomPath, stableJson(sbom), {
      encoding: "utf8",
      mode: 0o644,
    });
    const archiveDigest = sha256(await readFile(archivePath));
    const result = {
      archive: archivePath,
      archiveName,
      archiveSha256: archiveDigest,
      sbom: sbomPath,
      sourceDateEpoch: String(epoch),
      version,
    };
    process.stdout.write(`${stableJson(result)}`);
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  buildCliArtifact({
    repositoryRoot: options.repositoryRoot,
    outputDirectory: options.output,
    sourceDateEpoch: options.sourceDateEpoch,
    verifyReproducible: options.verifyReproducible,
  }).catch((error) => {
    process.stderr.write(`CLI release build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
