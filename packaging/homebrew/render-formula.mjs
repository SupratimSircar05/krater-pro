#!/usr/bin/env node

import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultTemplatePath = resolve(
  scriptDirectory,
  "krater-pro.rb.template",
);

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseFormulaArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help" || option === "-h") {
      parsed.help = true;
      continue;
    }
    if (
      option !== "--version" &&
      option !== "--sha256" &&
      option !== "--url" &&
      option !== "--template" &&
      option !== "--output"
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = requireValue(args, index, option);
    index += 1;
    if (option === "--version") parsed.version = value;
    if (option === "--sha256") parsed.sha256 = value;
    if (option === "--url") parsed.url = value;
    if (option === "--template") parsed.template = value;
    if (option === "--output") parsed.output = value;
  }
  return parsed;
}

export function validateFormulaInputs({ version, sha256, url }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Version must be a semantic version.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) {
    throw new Error("SHA-256 must contain exactly 64 lowercase hex characters.");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Formula URL must be a valid HTTPS URL.");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "Formula URL must be HTTPS and contain no credentials, query, or fragment.",
    );
  }
}

export function renderFormula(template, inputs) {
  validateFormulaInputs(inputs);
  const replacements = {
    "{{VERSION}}": inputs.version,
    "{{SHA256}}": inputs.sha256,
    "{{URL}}": inputs.url,
  };
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    output = output.replaceAll(placeholder, value);
  }
  if (/\{\{[A-Z0-9_]+\}\}/.test(output)) {
    throw new Error("Formula template contains an unresolved placeholder.");
  }
  return output;
}

function usage() {
  return [
    "Render a release-specific Homebrew formula.",
    "",
    "Usage:",
    "  node packaging/homebrew/render-formula.mjs \\",
    "    --version 0.2.0 --sha256 <64 lowercase hex characters> \\",
    "    [--url https://...] [--output Formula/krater-pro.rb]",
    "",
    "Without --output, the formula is written to stdout.",
    "",
  ].join("\n");
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseFormulaArguments(args);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.version || !parsed.sha256) {
    throw new Error("--version and --sha256 are required.");
  }
  const url =
    parsed.url ??
    `https://github.com/SupratimSircar05/krater-pro/releases/download/v${parsed.version}/krater-pro-cli-${parsed.version}.tgz`;
  const templatePath = resolve(parsed.template ?? defaultTemplatePath);
  const template = await readFile(templatePath, "utf8");
  const formula = renderFormula(template, {
    version: parsed.version,
    sha256: parsed.sha256,
    url,
  });
  if (parsed.output) {
    const outputPath = resolve(parsed.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formula, {
      encoding: "utf8",
      mode: 0o644,
    });
  } else {
    process.stdout.write(formula);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Formula generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
