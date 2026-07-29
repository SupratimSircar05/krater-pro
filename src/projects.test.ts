import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalAbsolutePath, ProjectRegistry } from "./projects.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const physicalPath = await realpath(path);
  temporaryPaths.push(physicalPath);
  return physicalPath;
}

async function fakeGit(
  _workspaceRoot: string,
  behavior: "success" | "failure" | "hang" = "success",
): Promise<string> {
  const toolsRoot = await temporaryDirectory("krater-git-tool-");
  return writeFakeGitAt(toolsRoot, behavior);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeFakeGitAt(
  root: string,
  behavior: "success" | "failure" | "hang" = "success",
): Promise<string> {
  const scriptPath = join(root, `fake-git-${behavior}.cjs`);
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
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
${behaviorSource}
`,
  );
  const executable =
    process.platform === "win32"
      ? join(root, `fake-git-${behavior}.cmd`)
      : join(root, `fake-git-${behavior}.sh`);
  await writeFile(
    executable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
  );
  await chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ProjectRegistry", () => {
  it("canonicalizes Windows drive, UNC, and extended-length paths", () => {
    const longTail = Array.from(
      { length: 32 },
      (_, index) => `Long Segment ${index}`,
    ).join("\\");
    const extendedLongPath = `\\\\?\\C:\\${longTail}`;
    expect(extendedLongPath.length).toBeGreaterThan(260);
    expect(
      canonicalAbsolutePath(
        String.raw`c:/Client Work/ಕನ್ನಡ/../Résumé Project`,
        win32,
      ),
    ).toBe(String.raw`C:\Client Work\Résumé Project`);
    expect(
      canonicalAbsolutePath(
        String.raw`\\Build-Server\Projects$\Client Work\ಕನ್ನಡ`,
        win32,
      ),
    ).toBe(String.raw`\\Build-Server\Projects$\Client Work\ಕನ್ನಡ`);
    expect(
      canonicalAbsolutePath(
        String.raw`\\?\c:\Client Work\Résumé Project`,
        win32,
      ),
    ).toBe(String.raw`C:\Client Work\Résumé Project`);
    expect(
      canonicalAbsolutePath(
        String.raw`\\?\UNC\Build-Server\Projects$\Client Work\ಕನ್ನಡ`,
        win32,
      ),
    ).toBe(String.raw`\\Build-Server\Projects$\Client Work\ಕನ್ನಡ`);
    expect(
      canonicalAbsolutePath(
        String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\Project`,
        win32,
      ),
    ).toBe(
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\Project`,
    );
    expect(canonicalAbsolutePath(extendedLongPath, win32)).toBe(
      extendedLongPath.slice(4),
    );
  });

  it.each([
    String.raw`\\.\pipe\krater`,
    String.raw`\\server\..\project`,
    String.raw`\\server\share\safe:stream`,
    String.raw`\\?\UNC\server\share\CON`,
    String.raw`\\?\UNC\server\share\..\other-share`,
    String.raw`\\server`,
  ])("rejects unsafe Windows local path %s", (path) => {
    expect(() => canonicalAbsolutePath(path, win32)).toThrow(
      /unsafe|unsupported|traverse/i,
    );
  });

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

  it("confines local projects to canonical host-authorized roots", async () => {
    const root = await temporaryDirectory("krater-authorized-root-");
    const outside = await temporaryDirectory("krater-unauthorized-root-");
    const unicodeProject = join(outside, "ಕನ್ನಡ", "Résumé Project");
    await mkdir(unicodeProject, { recursive: true });
    const link = join(root, "outside-link");
    await symlink(outside, link, "dir");
    const registry = new ProjectRegistry(root, {
      localProjectRoots: [root],
    });

    await expect(registry.addLocal(outside)).rejects.toThrow(
      /authorized local project root/i,
    );
    await expect(registry.addLocal(link)).rejects.toThrow(
      /authorized local project root/i,
    );
    await expect(registry.addLocal(`${root}\noutside`)).rejects.toThrow(
      /control characters/i,
    );
    await expect(registry.addLocal(`/${"a".repeat(4_097)}`)).rejects.toThrow(
      /non-empty path without control characters/i,
    );

    const expandedRegistry = new ProjectRegistry(root, {
      localProjectRoots: [root, outside],
    });
    await expect(expandedRegistry.addLocal(unicodeProject)).resolves.toMatchObject({
      path: unicodeProject,
      name: "resume-project",
    });
    await expect(expandedRegistry.addLocal(link)).resolves.toMatchObject({
      path: outside,
    });
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

  it("requires a stable absolute host-selected Git executable", async () => {
    const root = await temporaryDirectory("krater-git-identity-");
    expect(
      () => new ProjectRegistry(root, { gitExecutable: "git" }),
    ).toThrow(/safe absolute path/i);

    const workspaceExecutable = await writeFakeGitAt(root);
    expect(
      () =>
        new ProjectRegistry(root, {
          gitExecutable: workspaceExecutable,
        }),
    ).toThrow(/outside writable workspace roots/i);

    const executable = await fakeGit(root);
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });
    await rename(executable, `${executable}.original`);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    await expect(
      registry.cloneGitHub("https://github.com/owner/repo"),
    ).rejects.toThrow(/trusted Git executable changed or disappeared/i);
    await expect(
      stat(join(root, ".krater", "projects")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an in-place rewrite of the pinned Git executable", async () => {
    const root = await temporaryDirectory("krater-git-rewrite-");
    const executable = await fakeGit(root);
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });
    const before = await stat(executable);
    await writeFile(executable, Buffer.alloc(before.size, 0x41));
    const after = await stat(executable);

    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(
      registry.cloneGitHub("https://github.com/owner/repo"),
    ).rejects.toThrow(/trusted Git executable changed or disappeared/i);
    await expect(
      stat(join(root, ".krater", "projects")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the launch workspace identity before scratch and clone mutations", async () => {
    const parent = await temporaryDirectory("krater-root-swap-");
    const root = join(parent, "workspace");
    const displaced = join(parent, "workspace-original");
    await mkdir(root);
    const executable = await fakeGit(root);
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });

    await rename(root, displaced);
    await mkdir(root);

    await expect(registry.createScratch()).rejects.toThrow(
      /launch workspace.*changed/i,
    );
    await expect(
      registry.cloneGitHub("https://github.com/owner/repo"),
    ).rejects.toThrow(/launch workspace.*changed/i);
    await expect(stat(join(root, ".krater"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds the internal .krater ancestor across scratch mutations", async () => {
    const root = await temporaryDirectory("krater-internal-swap-");
    const executable = await fakeGit(root);
    const registry = new ProjectRegistry(root, {
      gitExecutable: executable,
    });
    await registry.createScratch("first");
    const kraterRoot = join(root, ".krater");
    const displaced = join(root, ".krater-original");
    await rename(kraterRoot, displaced);
    await mkdir(kraterRoot);

    await expect(registry.createScratch("second")).rejects.toThrow(
      /internal project directory changed/i,
    );
    await expect(
      registry.cloneGitHub("https://github.com/owner/repo"),
    ).rejects.toThrow(/internal project directory changed/i);
    await expect(stat(join(kraterRoot, "scratch"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(kraterRoot, "projects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
