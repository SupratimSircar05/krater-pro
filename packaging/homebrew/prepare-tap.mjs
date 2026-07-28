#!/usr/bin/env node

import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderCask } from "./render-cask.mjs";
import { renderFormula } from "./render-formula.mjs";
import {
  assertSemver,
  digestFile,
  stableJson,
} from "../../scripts/release/release-utils.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!["--assets", "--output", "--version"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    parsed[option.slice(2)] = value;
    index += 1;
  }
  for (const required of ["assets", "output", "version"]) {
    if (!parsed[required]) throw new Error(`--${required} is required.`);
  }
  return parsed;
}
export function parseChecksumManifest(text) {
  const entries = new Map();
  for (const [index, line] of text.trim().split(/\r?\n/u).entries()) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    if (!match) {
      throw new Error(`Invalid SHA256SUMS line ${index + 1}.`);
    }
    if (entries.has(match[2])) {
      throw new Error(`Duplicate checksum entry: ${match[2]}`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function verifiedAsset(assets, checksums, name) {
  const expected = checksums.get(name);
  if (!expected) throw new Error(`SHA256SUMS.txt does not cover ${name}.`);
  const path = join(assets, name);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Release asset is not a file: ${name}`);
  const observed = await digestFile(path);
  if (observed !== expected) {
    throw new Error(`Release asset checksum mismatch: ${name}`);
  }
  return observed;
}

export async function prepareTap({ assets, output, version }) {
  assertSemver(version);
  const absoluteAssets = resolve(assets);
  const absoluteOutput = resolve(output);
  const checksumText = await readFile(
    join(absoluteAssets, "SHA256SUMS.txt"),
    "utf8",
  );
  const checksums = parseChecksumManifest(checksumText);
  const names = {
    cli: `krater-pro-cli-${version}.tgz`,
    armDmg: `Krater-Pro-${version}-arm64.dmg`,
    x64Dmg: `Krater-Pro-${version}-x64.dmg`,
  };
  const [cliSha256, arm64Sha256, x64Sha256] = await Promise.all([
    verifiedAsset(absoluteAssets, checksums, names.cli),
    verifiedAsset(absoluteAssets, checksums, names.armDmg),
    verifiedAsset(absoluteAssets, checksums, names.x64Dmg),
  ]);
  const [formulaTemplate, caskTemplate] = await Promise.all([
    readFile(join(scriptDirectory, "krater-pro.rb.template"), "utf8"),
    readFile(join(scriptDirectory, "krater-pro-app.rb.template"), "utf8"),
  ]);
  const releaseUrl =
    `https://github.com/SupratimSircar05/krater-pro/releases/download/v${version}/${names.cli}`;
  const formula = renderFormula(formulaTemplate, {
    version,
    sha256: cliSha256,
    url: releaseUrl,
  });
  const cask = renderCask(caskTemplate, {
    version,
    arm64Sha256,
    x64Sha256,
  });
  const formulaPath = join(absoluteOutput, "Formula", "krater-pro.rb");
  const caskPath = join(absoluteOutput, "Casks", "krater-pro-app.rb");
  const metadataPath = join(
    absoluteOutput,
    ".krater-pro",
    `release-${version}.json`,
  );
  const bodyPath = join(absoluteOutput, ".krater-pro", "pr-body.md");
  await Promise.all([
    mkdir(dirname(formulaPath), { recursive: true }),
    mkdir(dirname(caskPath), { recursive: true }),
    mkdir(dirname(metadataPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(formulaPath, formula, { encoding: "utf8", mode: 0o644 }),
    writeFile(caskPath, cask, { encoding: "utf8", mode: 0o644 }),
    writeFile(
      metadataPath,
      stableJson({
        schemaVersion: 1,
        product: "Krater Pro",
        version,
        sourceTag: `v${version}`,
        assets: {
          [names.cli]: cliSha256,
          [names.armDmg]: arm64Sha256,
          [names.x64Dmg]: x64Sha256,
        },
      }),
      { encoding: "utf8", mode: 0o644 },
    ),
    writeFile(
      bodyPath,
      [
        `Update Krater Pro CLI and desktop cask to ${version}.`,
        "",
        "Generated from checksum-verified artifacts built by the protected Krater Pro release workflow.",
        "",
        "Required tap checks:",
        "",
        "- `brew audit --strict Formula/krater-pro.rb`",
        "- clean formula install and `brew test krater-pro` on macOS ARM64, macOS Intel, and Linux x64",
        "- `brew audit --cask --strict Casks/krater-pro-app.rb`",
        "- notarization and launch checks for both macOS DMGs",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o644 },
    ),
  ]);
  return {
    formulaPath,
    caskPath,
    metadataPath,
    bodyPath,
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  prepareTap(options).catch((error) => {
    process.stderr.write(`Tap preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
