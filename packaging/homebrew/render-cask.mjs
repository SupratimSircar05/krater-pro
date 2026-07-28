#!/usr/bin/env node

import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultTemplatePath = resolve(
  scriptDirectory,
  "krater-pro-app.rb.template",
);

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseCaskArguments(args) {
  const parsed = {};
  const supported = new Set([
    "--version",
    "--arm64-sha256",
    "--x64-sha256",
    "--template",
    "--output",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help" || option === "-h") {
      parsed.help = true;
      continue;
    }
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = requireValue(args, index, option);
    index += 1;
    if (option === "--version") parsed.version = value;
    if (option === "--arm64-sha256") parsed.arm64Sha256 = value;
    if (option === "--x64-sha256") parsed.x64Sha256 = value;
    if (option === "--template") parsed.template = value;
    if (option === "--output") parsed.output = value;
  }
  return parsed;
}

export function validateCaskInputs({
  version,
  arm64Sha256,
  x64Sha256,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Version must be a semantic version.");
  }
  for (const [label, checksum] of [
    ["ARM64 SHA-256", arm64Sha256],
    ["x64 SHA-256", x64Sha256],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) {
      throw new Error(`${label} must contain exactly 64 lowercase hex characters.`);
    }
  }
}

export function renderCask(template, inputs) {
  validateCaskInputs(inputs);
  const replacements = {
    "{{VERSION}}": inputs.version,
    "{{ARM64_SHA256}}": inputs.arm64Sha256,
    "{{X64_SHA256}}": inputs.x64Sha256,
  };
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    output = output.replaceAll(placeholder, value);
  }
  if (/\{\{[A-Z0-9_]+\}\}/.test(output)) {
    throw new Error("Cask template contains an unresolved placeholder.");
  }
  return output;
}

function usage() {
  return [
    "Render a release-specific Krater Pro desktop cask.",
    "",
    "Usage:",
    "  node packaging/homebrew/render-cask.mjs \\",
    "    --version 1.0.0 --arm64-sha256 <sha256> --x64-sha256 <sha256> \\",
    "    [--output Casks/krater-pro-app.rb]",
    "",
  ].join("\n");
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseCaskArguments(args);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.version || !parsed.arm64Sha256 || !parsed.x64Sha256) {
    throw new Error(
      "--version, --arm64-sha256, and --x64-sha256 are required.",
    );
  }
  const template = await readFile(
    resolve(parsed.template ?? defaultTemplatePath),
    "utf8",
  );
  const cask = renderCask(template, parsed);
  if (parsed.output) {
    const outputPath = resolve(parsed.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, cask, {
      encoding: "utf8",
      mode: 0o644,
    });
  } else {
    process.stdout.write(cask);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Cask generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
