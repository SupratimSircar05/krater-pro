#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const excludedDirectories = new Set([
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

const localSecretFiles = new Set([
  ".dev.vars",
  ".env",
]);

const plausibleLiveKeyPatterns = [
  /\bkr_(?:live|prod)_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|rk)-(?:live-)?[A-Za-z0-9_-]{24,}\b/g,
];

function parseDotEnvValue(source, name) {
  const line = source
    .split(/\r?\n/u)
    .find((candidate) =>
      new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "u").test(candidate),
    );
  if (!line) return undefined;

  const equals = line.indexOf("=");
  let value = line.slice(equals + 1).trim();
  if (
    value.length >= 2
    && (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/u, "").trim();
  }
  return value || undefined;
}

async function readConfiguredSecrets() {
  const candidates = new Set();
  if (process.env.KRATER_API_KEY) candidates.add(process.env.KRATER_API_KEY);

  try {
    const source = await readFile(
      path.join(repositoryDirectory, ".env"),
      "utf8",
    );
    const key = parseDotEnvValue(source, "KRATER_API_KEY");
    if (key) candidates.add(key);
  } catch {
    // Local configuration is optional. Never print its contents or read errors.
  }

  return [...candidates]
    .filter((candidate) => candidate.length >= 8)
    .map((candidate) => Buffer.from(candidate));
}

async function collectFiles(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(target, files);
    } else if (
      entry.isFile()
      && !localSecretFiles.has(entry.name)
      && !entry.name.startsWith(".env.")
      && !entry.name.startsWith(".dev.vars.")
    ) {
      files.push(target);
    }
  }
}

const files = [];
await collectFiles(repositoryDirectory, files);

const configuredSecrets = await readConfiguredSecrets();
const findings = [];

for (const file of files) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch {
    findings.push(file);
    continue;
  }
  if (!metadata.isFile()) continue;

  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    findings.push(file);
    continue;
  }

  if (configuredSecrets.some((secret) => bytes.indexOf(secret) !== -1)) {
    findings.push(file);
    continue;
  }

  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (
    plausibleLiveKeyPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })
  ) {
    findings.push(file);
  }
}

if (findings.length > 0) {
  console.error(
    `Repository secret guard failed: ${findings.length} file(s) contain protected credential material.`,
  );
  for (const file of findings) {
    console.error(path.relative(repositoryDirectory, file));
  }
  process.exitCode = 1;
} else {
  console.log(
    `Repository secret guard passed: ${files.length} file(s), 0 findings.`,
  );
}
