import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function expectedTag(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Package version "${version}" is not release-safe semver.`);
  }
  return `v${version}`;
}

export async function verifyReleaseTag(
  tag = process.env.GITHUB_REF_NAME,
  packagePath = joinPackagePath(),
) {
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const expected = expectedTag(manifest.version);
  if (tag !== expected) {
    throw new Error(
      `Release tag "${tag ?? ""}" does not match package version "${manifest.version}". Expected "${expected}".`,
    );
  }
  return expected;
}

function joinPackagePath() {
  return resolve(repositoryRoot, "package.json");
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await verifyReleaseTag();
}
