#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export async function scaffoldTap(output) {
  if (!output) throw new Error("A tap output directory is required.");
  const absoluteOutput = resolve(output);
  const templateRoot = join(scriptDirectory, "tap-template");
  await mkdir(absoluteOutput, { recursive: true });
  await Promise.all([
    mkdir(join(absoluteOutput, "Formula"), { recursive: true }),
    mkdir(join(absoluteOutput, "Casks"), { recursive: true }),
    mkdir(join(absoluteOutput, ".krater-pro"), { recursive: true }),
  ]);
  await cp(templateRoot, absoluteOutput, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  const readmeTemplate = await readFile(
    join(absoluteOutput, "README.md.template"),
    "utf8",
  );
  await writeFile(
    join(absoluteOutput, "README.md"),
    readmeTemplate.replaceAll("{{TAP_REPOSITORY}}", "SupratimSircar05/homebrew-tap"),
    "utf8",
  );
  await rm(join(absoluteOutput, "README.md.template"));
  return absoluteOutput;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  scaffoldTap(output).catch((error) => {
    process.stderr.write(`Tap scaffold failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
