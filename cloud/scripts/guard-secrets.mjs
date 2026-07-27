import { lstat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cloudDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = path.resolve(cloudDirectory, "..");

const scanRoots = [
  "public",
  "functions",
  "lib",
  "config",
  "dist",
  "build",
  path.join(".wrangler", "tmp"),
  path.join(".wrangler", "deploy"),
  path.join(".wrangler", "pages"),
];

const configNames = new Set([
  ".dev.vars",
  ".env",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  "config.json",
  "config.jsonc",
  "config.toml",
  "config.yaml",
  "config.yml",
]);

const plausibleLiveKeyPatterns = [
  /\bkr_(?:live|prod)_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|rk)-(?:live-)?[A-Za-z0-9_-]{24,}\b/g,
];

const configDefinitionPattern =
  /(?:^|[\r\n,{])\s*["']?KRATER_API_KEY["']?\s*[:=]/m;

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
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/u, "").trim();
  }
  return value || undefined;
}

async function readConfiguredSecrets() {
  const candidates = new Set();
  if (process.env.KRATER_API_KEY) {
    candidates.add(process.env.KRATER_API_KEY);
  }

  try {
    const rootEnvironment = await readFile(
      path.join(repositoryDirectory, ".env"),
      "utf8",
    );
    const rootKey = parseDotEnvValue(rootEnvironment, "KRATER_API_KEY");
    if (rootKey) candidates.add(rootKey);
  } catch {
    // A root .env file is optional. Never log its contents or read error details.
  }

  return [...candidates]
    .filter((candidate) => candidate.length >= 8)
    .map((candidate) => Buffer.from(candidate));
}

async function collectFiles(target, collected) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch {
    return;
  }

  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    collected.add(target);
    return;
  }
  if (!metadata.isDirectory()) return;

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
    await collectFiles(path.join(target, entry.name), collected);
  }
}

function isConfigFile(file) {
  const relative = path.relative(cloudDirectory, file);
  const base = path.basename(file);
  return (
    configNames.has(base) ||
    base.startsWith(".dev.vars.") ||
    base.startsWith(".env.") ||
    relative === "config" ||
    relative.startsWith(`config${path.sep}`)
  );
}

const files = new Set();
for (const root of scanRoots) {
  await collectFiles(path.join(cloudDirectory, root), files);
}
for (const name of configNames) {
  await collectFiles(path.join(cloudDirectory, name), files);
}
try {
  const rootEntries = await readdir(cloudDirectory, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(cloudDirectory, entry.name);
    if (isConfigFile(candidate)) files.add(candidate);
  }
} catch {
  // The cloud directory always exists when this script runs.
}

const configuredSecrets = await readConfiguredSecrets();
const findings = new Set();

for (const file of files) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    findings.add(file);
    continue;
  }

  if (configuredSecrets.some((secret) => bytes.indexOf(secret) !== -1)) {
    findings.add(file);
  }

  const text = bytes.includes(0) ? "" : bytes.toString("utf8");
  if (
    plausibleLiveKeyPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })
  ) {
    findings.add(file);
  }

  if (isConfigFile(file) && configDefinitionPattern.test(text)) {
    findings.add(file);
  }
}

const relativeFindings = [...findings]
  .map((file) => path.relative(cloudDirectory, file))
  .sort();

if (relativeFindings.length > 0) {
  console.error(
    `Secret guard failed: ${relativeFindings.length} file(s) contain protected credential material or configuration.`,
  );
  for (const file of relativeFindings) console.error(file);
  process.exitCode = 1;
} else {
  console.log(`Secret guard passed: ${files.size} file(s), 0 findings.`);
}
