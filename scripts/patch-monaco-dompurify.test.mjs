import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchMonacoDomPurify } from "./patch-monaco-dompurify.mjs";

const temporaryPaths = [];

async function fixture(monacoDependency = "3.4.8", domPurifyVersion = "3.4.12") {
  const root = await mkdtemp(join(tmpdir(), "krater-monaco-patch-"));
  temporaryPaths.push(root);
  const monaco = join(root, "node_modules", "monaco-editor");
  const domPurify = join(root, "node_modules", "dompurify");
  await Promise.all([
    mkdir(monaco, { recursive: true }),
    mkdir(domPurify, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(monaco, "package.json"),
      JSON.stringify({
        name: "monaco-editor",
        version: "0.56.0",
        dependencies: { marked: "14.0.0", dompurify: monacoDependency },
      }),
    ),
    writeFile(
      join(domPurify, "package.json"),
      JSON.stringify({
        name: "dompurify",
        version: domPurifyVersion,
      }),
    ),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Monaco DOMPurify metadata patch", () => {
  it("reconciles the exact published declaration with the secure lock override", async () => {
    const root = await fixture();
    expect(await patchMonacoDomPurify(root)).toMatchObject({ changed: true });
    const monaco = JSON.parse(
      await readFile(
        join(root, "node_modules", "monaco-editor", "package.json"),
        "utf8",
      ),
    );
    expect(monaco.dependencies.dompurify).toBe("3.4.12");
    expect(await patchMonacoDomPurify(root)).toMatchObject({ changed: false });
  });

  it("fails closed for an unverified installed DOMPurify version", async () => {
    const root = await fixture("3.4.8", "3.4.11");
    await expect(patchMonacoDomPurify(root)).rejects.toThrow(
      /must be 3.4.12/,
    );
  });

  it("fails closed when Monaco changes its declaration", async () => {
    const root = await fixture("^3.4.8");
    await expect(patchMonacoDomPurify(root)).rejects.toThrow(
      /unexpected Monaco DOMPurify declaration/,
    );
  });
});
