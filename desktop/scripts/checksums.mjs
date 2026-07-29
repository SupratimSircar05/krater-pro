import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const releaseExtensions = [".AppImage", ".deb", ".dmg", ".zip"];

export function isReleaseArtifact(name) {
  return releaseExtensions.some((extension) => name.endsWith(extension));
}

export async function createChecksums(directory) {
  const absoluteDirectory = resolve(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.isFile() && isReleaseArtifact(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (artifacts.length === 0) {
    throw new Error(`No desktop release artifacts found in ${absoluteDirectory}.`);
  }

  const lines = [];
  for (const name of artifacts) {
    const bytes = await readFile(join(absoluteDirectory, name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${digest}  ${basename(name)}`);
  }
  const output = `${lines.join("\n")}\n`;
  const outputPath = join(absoluteDirectory, "SHA256SUMS.txt");
  await writeFile(outputPath, output, { encoding: "utf8", mode: 0o644 });
  return { artifacts, output, outputPath };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await createChecksums(process.argv[2] ?? "release");
}
