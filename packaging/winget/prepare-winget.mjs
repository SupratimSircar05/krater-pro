#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSemver } from "../../scripts/release/release-utils.mjs";
import {
  packageIdentifier,
  releaseRepository,
  renderWingetManifests,
  windowsInstallerName,
  windowsInstallerUrl,
} from "./render-manifests.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const receiptSizeLimit = 64 * 1024;

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

async function readRegularFile(path, maximumBytes) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Expected a regular release file: ${basename(path)}`);
    }
    if (maximumBytes !== undefined && metadata.size > maximumBytes) {
      throw new Error(`Release metadata is too large: ${basename(path)}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function digestRegularFile(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Expected a regular release file: ${basename(path)}`);
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function requireText(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new Error(`Invalid Authenticode receipt field: ${field}`);
  }
  return value;
}

function requireThumbprint(value, field) {
  requireText(value, field);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value)) {
    throw new Error(`Invalid Authenticode certificate thumbprint: ${field}`);
  }
  return value;
}

export function validateAuthenticodeReceipt(receipt, { version, sha256 }) {
  const artifact = windowsInstallerName(version);
  if (receipt?.schemaVersion !== 1) {
    throw new Error("Unsupported Authenticode receipt schema.");
  }
  if (receipt.product !== "Krater Pro") {
    throw new Error("Authenticode receipt identifies another product.");
  }
  if (receipt.version !== version || receipt.artifact !== artifact) {
    throw new Error("Authenticode receipt does not match the WinGet release.");
  }
  if (receipt.sha256 !== sha256) {
    throw new Error("Authenticode receipt does not match the installer bytes.");
  }
  if (
    receipt.source?.repository !== releaseRepository ||
    receipt.source?.ref !== `refs/tags/v${version}`
  ) {
    throw new Error("Authenticode receipt is not bound to the release tag.");
  }
  if (receipt.authenticode?.status !== "Valid") {
    throw new Error("WinGet packaging requires a valid Authenticode signature.");
  }
  requireText(receipt.authenticode.signerSubject, "signerSubject");
  requireThumbprint(
    receipt.authenticode.signerThumbprint,
    "signerThumbprint",
  );
  requireText(
    receipt.authenticode.timestampSignerSubject,
    "timestampSignerSubject",
  );
  requireThumbprint(
    receipt.authenticode.timestampSignerThumbprint,
    "timestampSignerThumbprint",
  );
  return receipt;
}

async function readTemplates() {
  const names = {
    version: `${packageIdentifier}.yaml.template`,
    installer: `${packageIdentifier}.installer.yaml.template`,
    locale: `${packageIdentifier}.locale.en-US.yaml.template`,
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(names).map(async ([kind, name]) => [
        kind,
        await readFile(join(scriptDirectory, name), "utf8"),
      ]),
    ),
  );
}

async function writeExclusive(path, contents) {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

export async function prepareWinget({ assets, output, version }) {
  assertSemver(version);
  const absoluteAssets = resolve(assets);
  const absoluteOutput = resolve(output);
  const installerName = windowsInstallerName(version);
  const receiptName = `krater-pro-windows-${version}.authenticode.json`;
  const installerSha256 = await digestRegularFile(
    join(absoluteAssets, installerName),
  );
  const receiptBytes = await readRegularFile(
    join(absoluteAssets, receiptName),
    receiptSizeLimit,
  );
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("Authenticode receipt is not valid JSON.");
  }
  validateAuthenticodeReceipt(receipt, {
    version,
    sha256: installerSha256,
  });

  const manifests = renderWingetManifests(await readTemplates(), {
    version,
    installerSha256,
  });
  await mkdir(absoluteOutput, { recursive: true });
  const paths = [];
  for (const [name, contents] of Object.entries(manifests).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const path = join(absoluteOutput, name);
    await writeExclusive(path, contents);
    paths.push(path);
  }
  return {
    installerName,
    installerSha256,
    installerUrl: windowsInstallerUrl(version),
    paths,
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  prepareWinget(options)
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            packageIdentifier,
            version: options.version,
            installerUrl: result.installerUrl,
            installerSha256: result.installerSha256,
            manifests: result.paths.map((path) => basename(path)),
          },
          null,
          2,
        )}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`WinGet preparation failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
