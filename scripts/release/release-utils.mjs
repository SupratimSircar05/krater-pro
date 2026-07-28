import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function stableJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

export function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error(`Version "${version ?? ""}" is not release-safe semver.`);
  }
  return version;
}

export function assertSafeRelativePath(candidate) {
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.startsWith("\\") ||
    candidate.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error(`Unsafe release path: ${candidate ?? ""}`);
  }
  return candidate;
}

export function releaseDate(sourceDateEpoch) {
  if (!/^\d+$/.test(String(sourceDateEpoch ?? ""))) {
    throw new Error(
      "SOURCE_DATE_EPOCH must be an integer Unix timestamp for reproducible metadata.",
    );
  }
  const date = new Date(Number(sourceDateEpoch) * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported date range.");
  }
  return date.toISOString();
}

export async function gitSourceDateEpoch(repositoryRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%ct"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  const epoch = stdout.trim();
  releaseDate(epoch);
  return epoch;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function normalizeSpdx(
  document,
  {
    namespaceDigest,
    sourceDateEpoch,
    repository =
      "https://github.com/SupratimSircar05/krater-pro",
    profile,
  },
) {
  if (document?.spdxVersion !== "SPDX-2.3") {
    throw new Error("Expected an SPDX 2.3 document from npm sbom.");
  }
  const normalized = structuredClone(document);
  normalized.creationInfo = {
    ...normalized.creationInfo,
    created: releaseDate(sourceDateEpoch),
  };
  normalized.documentNamespace =
    `${repository}/spdx/${profile}/${namespaceDigest}`;
  normalized.comment =
    profile === "desktop"
      ? "Dependency SBOM for the packaged Krater Pro application. Electron is added explicitly; platform frameworks and operating-system components are outside this npm dependency inventory."
      : "Dependency SBOM for the immutable Krater Pro CLI release archive.";
  normalized.packages = [...(normalized.packages ?? [])].sort((left, right) =>
    String(left.SPDXID).localeCompare(String(right.SPDXID)),
  );
  normalized.relationships = [...(normalized.relationships ?? [])].sort(
    (left, right) =>
      [
        left.spdxElementId,
        left.relationshipType,
        left.relatedSpdxElement,
      ]
        .join("\0")
        .localeCompare(
          [
            right.spdxElementId,
            right.relationshipType,
            right.relatedSpdxElement,
          ].join("\0"),
        ),
  );
  return normalized;
}

export async function digestFile(path) {
  return sha256(await readFile(path));
}
