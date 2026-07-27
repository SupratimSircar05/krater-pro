import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "./skills.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "# Instructions",
): Promise<void> {
  const directory = join(root, name);
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
  await writeFile(join(directory, "references", "python.md"), "# Python\n");
}

describe("SkillRegistry", () => {
  it("lists metadata without eagerly loading reference content", async () => {
    const workspace = await temporaryDirectory("krater-skill-workspace-");
    const builtIn = await temporaryDirectory("krater-skill-built-in-");
    await writeSkill(builtIn, "languages", "Language workflows", "SECRET_BODY");
    const registry = new SkillRegistry(workspace, builtIn);

    expect(await registry.list()).toEqual([
      {
        name: "languages",
        description: "Language workflows",
        source: "built-in",
      },
    ]);
    expect(await registry.listForModel()).not.toContain("SECRET_BODY");
  });

  it("loads the main instructions and a selected reference on demand", async () => {
    const workspace = await temporaryDirectory("krater-skill-workspace-");
    const builtIn = await temporaryDirectory("krater-skill-built-in-");
    await writeSkill(builtIn, "languages", "Language workflows");
    const registry = new SkillRegistry(workspace, builtIn);

    expect(await registry.load("languages")).toContain("# Instructions");
    expect(await registry.load("languages", "references/python.md")).toBe("# Python\n");
  });

  it("lets a workspace skill override a built-in skill with the same name", async () => {
    const workspace = await temporaryDirectory("krater-skill-workspace-");
    const builtIn = await temporaryDirectory("krater-skill-built-in-");
    await writeSkill(builtIn, "languages", "Built in");
    await writeSkill(join(workspace, ".krater", "skills"), "languages", "Workspace");
    const registry = new SkillRegistry(workspace, builtIn);

    expect(await registry.list()).toEqual([
      { name: "languages", description: "Workspace", source: "workspace" },
    ]);
  });

  it("rejects traversal and symlink escapes", async () => {
    const workspace = await temporaryDirectory("krater-skill-workspace-");
    const builtIn = await temporaryDirectory("krater-skill-built-in-");
    const outside = await temporaryDirectory("krater-skill-outside-");
    await writeSkill(builtIn, "languages", "Language workflows");
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(
      join(outside, "secret.md"),
      join(builtIn, "languages", "references", "escape.md"),
    );
    const registry = new SkillRegistry(workspace, builtIn);

    await expect(registry.load("languages", "../secret.md")).rejects.toThrow(
      /Skill resource/,
    );
    await expect(
      registry.load("languages", "references/escape.md"),
    ).rejects.toThrow(/outside/);
  });
});
