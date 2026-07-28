#!/usr/bin/env node

import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  assertSemver,
  digestFile,
  stableJson,
} from "./release-utils.mjs";

const artifactSuffixes = [
  ".AppImage",
  ".deb",
  ".dmg",
  ".exe",
  ".spdx.json",
  ".tgz",
  ".zip",
];

export function isManifestArtifact(name) {
  return (
    artifactSuffixes.some((suffix) => name.endsWith(suffix)) &&
    !name.endsWith(".asc")
  );
}
function parseArguments(args) {
  const parsed = { directory: "release-assets" };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      ![
        "--directory",
        "--version",
        "--repository",
        "--commit",
        "--ref",
        "--run-url",
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    index += 1;
    parsed[option.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    )] = value;
  }
  return parsed;
}

export async function createReleaseManifest({
  directory,
  version,
  repository,
  commit,
  ref,
  runUrl,
}) {
  assertSemver(version);
  if (!/^[a-f0-9]{40}$/i.test(commit ?? "")) {
    throw new Error("Release provenance requires a full 40-character commit.");
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(repository ?? "")) {
    throw new Error("Release repository must be a credential-free GitHub URL.");
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/u.test(
    runUrl ?? "",
  )) {
    throw new Error("Release run URL must identify a GitHub Actions run.");
  }
  const absoluteDirectory = resolve(directory);
  await mkdir(absoluteDirectory, { recursive: true });
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && isManifestArtifact(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new Error("No release artifacts were found.");
  }

  const artifacts = [];
  for (const name of names) {
    const path = join(absoluteDirectory, name);
    const metadata = await stat(path);
    artifacts.push({
      name: basename(name),
      sha256: await digestFile(path),
      size: metadata.size,
    });
  }
  const manifest = {
    schemaVersion: 1,
    product: "Krater Pro",
    version,
    source: { repository, commit: commit.toLowerCase(), ref },
    builder: {
      id: "https://github.com/actions/runner",
      run: runUrl,
      workflow:
        `${repository}/blob/${commit}/.github/workflows/desktop-release.yml`,
    },
    artifacts,
    statement:
      "This manifest records release subjects and builder identity. Verify the GitHub artifact attestations and detached checksum signature before trusting an artifact.",
  };
  const manifestName = `krater-pro-${version}.release-manifest.json`;
  const manifestPath = join(absoluteDirectory, manifestName);
  await writeFile(manifestPath, stableJson(manifest), {
    encoding: "utf8",
    mode: 0o644,
  });
  const allChecksums = [
    ...artifacts,
    {
      name: manifestName,
      sha256: await digestFile(manifestPath),
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
  const checksumText =
    `${allChecksums.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`;
  const checksumPath = join(absoluteDirectory, "SHA256SUMS.txt");
  await writeFile(checksumPath, checksumText, {
    encoding: "utf8",
    mode: 0o644,
  });
  return { artifacts, checksumPath, manifestPath };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  createReleaseManifest({
    ...options,
    repository:
      options.repository ??
      `https://github.com/${process.env.GITHUB_REPOSITORY ?? ""}`,
    commit: options.commit ?? process.env.GITHUB_SHA,
    ref: options.ref ?? process.env.GITHUB_REF,
    runUrl:
      options.runUrl ??
      `https://github.com/${process.env.GITHUB_REPOSITORY ?? ""}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`,
  }).catch((error) => {
    process.stderr.write(`Release manifest failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
