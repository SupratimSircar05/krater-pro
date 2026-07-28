import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  promptWithAmbiguityContext,
  resolveAmbiguityPreflight,
  runAmbiguityPreflight,
} from "./ambiguity-preflight.js";

const temporaryPaths: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "krater-ambiguity-"));
  temporaryPaths.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ambiguity preflight", () => {
  it("resolves a uniquely named repository target without interrupting", async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "parser.ts"), "export {};\n");
    await writeFile(join(root, "package.json"), "{}\n");

    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Repair `parser.ts` and run its tests.",
      mode: "ask",
    });

    expect(result.status).toBe("ready");
    expect(result.clarification).toBeUndefined();
    expect(result.assumptions).toEqual([
      expect.objectContaining({
        statement: "“parser.ts” refers to repository path “src/parser.ts”.",
        source: "repository",
        resolved: true,
      }),
    ]);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "package.json", kind: "manifest" }),
        expect.objectContaining({ path: "src/parser.ts", kind: "path" }),
      ]),
    );
  });

  it("asks one highest-value question when a named target has divergent matches", async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, "client"));
    await mkdir(join(root, "server"));
    await writeFile(join(root, "client", "config.ts"), "export {};\n");
    await writeFile(join(root, "server", "config.ts"), "export {};\n");

    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Update config.ts.",
      mode: "ask",
    });

    expect(result.status).toBe("clarification_required");
    expect(result.clarification?.question).toContain("config.ts");
    expect(result.clarification?.interpretations).toEqual([
      "client/config.ts",
      "server/config.ts",
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.interpretations.every((item) => !item.selected)).toBe(true);
  });

  it("prefers an exact workspace-root manifest under --assume=best", async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"root"}\n');
    await writeFile(
      join(root, "apps", "web", "package.json"),
      '{"name":"web"}\n',
    );
    await writeFile(
      join(root, "packages", "shared", "package.json"),
      '{"name":"shared"}\n',
    );

    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Update package.json scripts and run the relevant tests.",
      mode: "best",
    });

    expect(result.status).toBe("ready");
    expect(result.candidates[0]?.interpretations).toEqual([
      "package.json",
      "apps/web/package.json",
      "packages/shared/package.json",
    ]);
    expect(result.assumptions.at(-1)).toMatchObject({
      source: "agent",
      resolved: false,
      statement: expect.stringContaining("“package.json”"),
    });
    expect(
      result.interpretations.find((interpretation) => interpretation.selected)
        ?.description,
    ).toContain(" package.json");
  });

  it("does not interrupt when two repository paths resolve to the same target", async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "compat"));
    await writeFile(join(root, "src", "config.ts"), "export {};\n");
    await symlink(
      join(root, "src", "config.ts"),
      join(root, "compat", "config.ts"),
    );

    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Update config.ts.",
      mode: "ask",
    });

    expect(result.status).toBe("ready");
    expect(result.candidates).toEqual([]);
  });

  it("records a documented best-judgment selection instead of asking", async () => {
    const root = await temporaryWorkspace();

    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Use either SQLite or JSON.",
      mode: "best",
    });

    expect(result.status).toBe("ready");
    expect(result.assumptions).toEqual([
      expect.objectContaining({
        statement: expect.stringContaining("SQLite"),
        source: "agent",
        resolved: false,
      }),
    ]);
    expect(result.interpretations.filter((item) => item.selected)).toHaveLength(1);
    expect(promptWithAmbiguityContext(result)).toContain(
      "best-judgment assumption; verify during discovery",
    );
  });

  it("records an interactive answer and accepts numbered choices", async () => {
    const root = await temporaryWorkspace();
    const result = await runAmbiguityPreflight({
      cwd: root,
      request: "Use either SQLite or JSON.",
      mode: "ask",
    });

    const resolved = resolveAmbiguityPreflight(result, "2");

    expect(resolved.status).toBe("ready");
    expect(resolved.assumptions.at(-1)).toMatchObject({
      source: "user",
      resolved: true,
    });
    expect(resolved.assumptions.at(-1)?.statement).toContain("JSON");
    expect(
      resolved.interpretations.find((interpretation) => interpretation.selected)
        ?.description,
    ).toContain("JSON");

    const custom = resolveAmbiguityPreflight(result, "Use SQLite in production only");
    expect(
      custom.interpretations.find((interpretation) => interpretation.selected)
        ?.description,
    ).toContain("Use SQLite in production only");
  });

  it("bounds repository walking and rejects unsafe limits", async () => {
    const root = await temporaryWorkspace();
    await expect(
      runAmbiguityPreflight({
        cwd: root,
        request: "Update config.ts.",
        maxEntries: 0,
      }),
    ).rejects.toThrow(/between 1 and 20,000/);
  });
});
