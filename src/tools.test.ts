import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeTool } from "./tools.js";
import { Workspace } from "./workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-tools-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tool argument validation", () => {
  it.each([7, -1, 1.5, Number.NaN])(
    "rejects hostile list depth %s at runtime",
    async (maxDepth) => {
      const workspace = new Workspace(await temporaryDirectory());
      const result = await executeTool(workspace, "list_files", { maxDepth });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/integer from 0 to 6/);
    },
  );

  it("rejects additional properties and incorrect optional types", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "note.txt"), "unchanged\n");
    const workspace = new Workspace(root);

    await expect(
      executeTool(workspace, "workspace_map", { unexpected: true }),
    ).resolves.toMatchObject({ ok: false, output: expect.stringContaining("Unknown") });
    await expect(
      executeTool(workspace, "search_files", {
        query: "unchanged",
        caseSensitive: "yes",
      }),
    ).resolves.toMatchObject({ ok: false, output: expect.stringContaining("boolean") });
    await expect(
      executeTool(workspace, "write_file", {
        path: "note.txt",
        content: "changed\n",
        surprise: true,
      }),
    ).resolves.toMatchObject({ ok: false, output: expect.stringContaining("surprise") });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("unchanged\n");
  });

  it("enforces integer line and timeout bounds rather than coercing values", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "note.txt"), "line\n");
    const workspace = new Workspace(root);

    await expect(
      executeTool(workspace, "read_file", { path: "note.txt", startLine: 0 }),
    ).resolves.toMatchObject({ ok: false, output: expect.stringContaining("integer") });
    await expect(
      executeTool(workspace, "run_command", {
        command: "true",
        timeoutMs: 999,
      }),
    ).resolves.toMatchObject({ ok: false, output: expect.stringContaining("1000") });
  });
});
