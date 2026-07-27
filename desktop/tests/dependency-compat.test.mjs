import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);

function loadMatcher(path) {
  const imported = require(path);
  return typeof imported === "function" ? imported : imported.minimatch;
}

test("fixed brace expansion supports legacy callable and modern named APIs", () => {
  const braceExpansion = require(
    join(repositoryRoot, "node_modules", "brace-expansion"),
  );
  assert.equal(typeof braceExpansion, "function");
  assert.equal(typeof braceExpansion.expand, "function");
  assert.deepEqual(braceExpansion("{a,b}.js"), ["a.js", "b.js"]);
  assert.deepEqual(braceExpansion.expand("{1..3}"), ["1", "2", "3"]);
  assert.equal(braceExpansion.EXPANSION_MAX, 100_000);
  assert.equal(braceExpansion.EXPANSION_MAX_LENGTH, 4_000_000);
});

test("minimatch 3, 5, 9, and 10 retain brace glob compatibility", () => {
  const installations = [
    "node_modules/@electron/asar/node_modules/minimatch",
    "node_modules/filelist/node_modules/minimatch",
    "node_modules/@electron/universal/node_modules/minimatch",
    "node_modules/minimatch",
  ];
  for (const installation of installations) {
    const matcher = loadMatcher(join(repositoryRoot, installation));
    assert.equal(
      matcher("a.js", "{a,b}.js"),
      true,
      `brace matching failed for ${installation}`,
    );
    assert.equal(matcher("c.js", "{a,b}.js"), false);
  }
});

test("@electron/asar packs brace-matched files with the fixed dependency", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "krater-asar-"));
  const source = join(temporaryDirectory, "source");
  const archive = join(temporaryDirectory, "fixture.asar");
  await mkdir(source);
  await Promise.all([
    writeFile(join(source, "a.js"), "export const a = 1;\n"),
    writeFile(join(source, "b.js"), "export const b = 2;\n"),
    writeFile(join(source, "keep.txt"), "inside\n"),
  ]);
  const asar = require("@electron/asar");
  await asar.createPackageWithOptions(source, archive, {
    unpack: "{a,b}.js",
  });
  assert.equal(existsSync(archive), true);
  assert.equal(existsSync(`${archive}.unpacked/a.js`), true);
  assert.equal(existsSync(`${archive}.unpacked/b.js`), true);
  assert.equal(asar.extractFile(archive, "keep.txt").toString(), "inside\n");
});
