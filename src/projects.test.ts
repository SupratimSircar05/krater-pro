import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRegistry } from "./projects.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const physicalPath = await realpath(path);
  temporaryPaths.push(physicalPath);
  return physicalPath;
}

async function fakeGit(
  root: string,
  behavior: "success" | "failure" | "hang" = "success",
): Promise<string> {
  const path = join(root, `fake-git-${behavior}.cjs`);
  const behaviorSource =
    behavior === "success"
      ? `
const target = process.argv.at(-1);
fs.writeFileSync(path.join(target, "invocation.json"), JSON.stringify({
  args: process.argv.slice(2),
  env: {
    terminalPrompt: process.env.GIT_TERMINAL_PROMPT,
    noSystemConfig: process.env.GIT_CONFIG_NOSYSTEM,
    globalConfig: process.env.GIT_CONFIG_GLOBAL,
    home: process.env.HOME
  }
}));`
      : behavior === "failure"
        ? `
process.stderr.write("unsafe failure ".repeat(500));
process.exit(9);`
        : `
setInterval(() => {}, 1_000);`;

  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
${behaviorSource}
`,
  );
  await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ProjectRegistry", () => {
  it("starts at the initial directory and registers/selects existing absolute directories", async () => {
    const root = await temporaryDirectory("krater-projects-");
    const second = join(root, "Second Project");
    await mkdir(second);

    const registry = new ProjectRegistry(root);
    const initial = registry.current();
    expect(initial).toMatchObject({
      kind: "local",
      path: root,
      name: expect.stringMatching(/^[a-z0-9-]+$/),
    });
    expect(registry.list()).toEqual([initial]);

    const added = await registry.addLocal(second);
    expect(added).toMatchObject({
      kind: "local",
      path: second,
      name: "second-project",
    });
    expect(registry.current()).toEqual(added);
    expect(registry.select(initial.id)).toEqual(initial);
    expect(await registry.addLocal(second)).toEqual(added);
    expect(registry.list()).toHaveLength(2);

    const mutableCopy = registry.list()[0]!;
    mutableCopy.name = "tampered";
    expect(registry.list()[0]!.name).not.toBe("tampered");

    await expect(registry.addLocal("relative/path")).rejects.toThrow(
      /must be absolute/i,
    );
    await expect(registry.addLocal(join(root, "missing"))).rejects.toThrow(
      /existing directory/i,
    );
    expect(() => registry.select("unknown")).toThrow(/not registered/i);
  });

  it("creates uniquely named persistent scratch directories without touching skills", async () => {
    const root = await temporaryDirectory("krater-scratch-");
    const skillFile = join(root, ".krater", "skills", "typescript", "SKILL.md");
    await mkdir(join(root, ".krater", "skills", "typescript"), {
      recursive: true,
    });
    await writeFile(skillFile, "keep me");

    const registry = new ProjectRegistry(root);
    const first = await registry.createScratch("../../Fancy Project");
    const second = await registry.createScratch("../../Fancy Project");
    const scratchRoot = join(root, ".krater", "scratch");

    for (const project of [first, second]) {
      expect(project.kind).toBe("scratch");
      expect(project.name).toMatch(/^fancy-project-[a-zA-Z0-9]+$/);
      expect(relative(scratchRoot, project.path)).not.toMatch(/^\.\./);
      expect((await stat(project.path)).isDirectory()).toBe(true);
    }
    expect(first.path).not.toBe(second.path);
    expect(await readFile(skillFile, "utf8")).toBe("keep me");
  });

  it("clones only canonical public GitHub HTTPS URLs with isolated noninteractive Git", async () => {
    const root = await temporaryDirectory("krater-clone-");
    const executable = await fakeGit(root);
    const skillFile = join(root, ".krater", "skills", "python", "SKILL.md");
    await mkdir(join(root, ".krater", "skills", "python"), {
      recursive: true,
    });
    await writeFile(skillFile, "keep me too");

    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });
    const project = await registry.cloneGitHub(
      "https://github.com/Anthropics/claude-code.git",
    );

    expect(project).toMatchObject({
      kind: "github",
      name: expect.stringMatching(/^claude-code-[a-zA-Z0-9]+$/),
      source: "https://github.com/Anthropics/claude-code.git",
    });
    expect(relative(join(root, ".krater", "projects"), project.path)).not.toMatch(
      /^\.\./,
    );

    const invocation = JSON.parse(
      await readFile(join(project.path, "invocation.json"), "utf8"),
    ) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(invocation.args).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "http.followRedirects=initial",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--",
      "https://github.com/Anthropics/claude-code.git",
      project.path,
    ]);
    expect(invocation.env).toMatchObject({
      terminalPrompt: "0",
      noSystemConfig: "1",
      home: join(root, ".krater", "git-home"),
    });
    expect(invocation.env.globalConfig).toMatch(/(?:\/dev\/null|NUL)/);
    expect(await readFile(skillFile, "utf8")).toBe("keep me too");
  });

  it.each([
    "http://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "https://github.example/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "https://user@github.com/owner/repo",
    "https://github.com/owner/repo?ref=main",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner/repo/extra",
    "https://github.com/owner/repo/",
    "https://github.com/%2e%2e/repo",
    "https://github.com/--upload-pack/repo",
    " https://github.com/owner/repo",
  ])("rejects unsafe clone source %s", async (source) => {
    const root = await temporaryDirectory("krater-reject-");
    const executable = await fakeGit(root);
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });

    await expect(registry.cloneGitHub(source)).rejects.toThrow(
      /only public https:\/\/github\.com/i,
    );
    expect(registry.list()).toHaveLength(1);
  });

  it("bounds failed clone output and removes only its unregistered partial directory", async () => {
    const root = await temporaryDirectory("krater-failure-");
    const executable = await fakeGit(root, "failure");
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
      maxCloneOutputBytes: 128,
    });

    let failure: Error | undefined;
    try {
      await registry.cloneGitHub("https://github.com/owner/repo");
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("exit 9");
    expect(failure?.message).toContain("[output truncated]");
    expect(failure?.message.length).toBeLessThan(300);
    expect(registry.list()).toHaveLength(1);
  });

  it("supports timeout and AbortSignal cancellation", async () => {
    const root = await temporaryDirectory("krater-cancel-");
    const executable = await fakeGit(root, "hang");
    const timedRegistry = new ProjectRegistry(root, {
      gitExecutable: executable,
      cloneTimeoutMs: 40,
    });

    await expect(
      timedRegistry.cloneGitHub("https://github.com/owner/slow-repo"),
    ).rejects.toThrow(/timed out/i);

    const controller = new AbortController();
    controller.abort();
    await expect(
      timedRegistry.cloneGitHub(
        "https://github.com/owner/cancelled-repo",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
