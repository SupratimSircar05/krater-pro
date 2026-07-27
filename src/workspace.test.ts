import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "./workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix = "krater-workspace-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Workspace file operations", () => {
  it("lists files deterministically, respects depth, and omits ignored directory contents", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "package"), { recursive: true });
    await writeFile(join(root, "README.md"), "read me");
    await writeFile(join(root, "src", "a.ts"), "export {}");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export {}");
    await writeFile(join(root, "node_modules", "package", "index.js"), "ignored");
    const workspace = new Workspace(root);

    const listed = await workspace.listFiles(".", 1);

    expect(listed.split("\n")).toEqual([
      "node_modules/",
      "README.md",
      "src/",
      "src/a.ts",
      "src/nested/",
    ]);
    expect(listed).not.toContain("node_modules/package");
    expect(listed).not.toContain("deep.ts");
  });

  it("caps broad listings before they can allocate unbounded output", async () => {
    const root = await temporaryDirectory();
    for (let start = 0; start < 600; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          writeFile(
            join(
              root,
              `${String(start + offset).padStart(4, "0")}-${"x".repeat(220)}.txt`,
            ),
            "",
          ),
        ),
      );
    }
    const workspace = new Workspace(root);

    const listed = await workspace.listFiles(".", 0);

    expect(listed).toContain("listing truncated");
    expect(listed.length).toBeLessThan(121_000);
  });

  it("defensively rejects out-of-schema traversal depths", async () => {
    const workspace = new Workspace(await temporaryDirectory());
    await expect(workspace.listFiles(".", 7)).rejects.toThrow(
      /integer from 0 to 6/,
    );
  });

  it("reads bounded line ranges with stable line numbers", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "notes.txt"), "alpha\nbeta\ngamma\n");
    const workspace = new Workspace(root);

    await expect(workspace.readFile("notes.txt", 2, 3)).resolves.toBe(
      "    2 | beta\n    3 | gamma",
    );
    await expect(workspace.readFile("notes.txt", 3, 2)).rejects.toThrow(
      /endLine must be greater/,
    );
  });

  it("searches text literally, supports case sensitivity, and skips ignored trees", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "src", "one.ts"), "Needle here\nneedle again\n");
    await writeFile(join(root, "src", "two.ts"), "nothing to see\n");
    await writeFile(
      join(root, "node_modules", "dependency", "index.js"),
      "Needle must be ignored\n",
    );
    const workspace = new Workspace(root);

    expect(await workspace.searchFiles("needle")).toBe(
      "src/one.ts:1: Needle here\nsrc/one.ts:2: needle again",
    );
    expect(await workspace.searchFiles("Needle", ".", true)).toBe(
      "src/one.ts:1: Needle here",
    );
    await expect(workspace.searchFiles("")).rejects.toThrow(/cannot be empty/);
  });

  it("builds a compact project map without indexing dependency contents or secrets", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"example"}');
    await writeFile(join(root, "src", "main.ts"), "export {}");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=secret");
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "ignored");
    const workspace = new Workspace(root);

    const map = await workspace.projectMap();
    expect(map).toContain("package.json");
    expect(map).toContain(".ts: 1");
    expect(map).not.toContain("index.js");
    expect(map).not.toContain(".env");
    expect(map).not.toContain("secret");
  });

  it("creates parent directories and performs exact replacements safely", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);

    await expect(
      workspace.writeTextFile("generated/note.txt", "red red blue"),
    ).resolves.toBe("Wrote 12 bytes to generated/note.txt.");
    await expect(
      workspace.replaceInFile("generated/note.txt", "red", "green"),
    ).rejects.toThrow(/occurs 2 times/);
    expect(await readFile(join(root, "generated", "note.txt"), "utf8")).toBe(
      "red red blue",
    );

    await expect(
      workspace.replaceInFile("generated/note.txt", "red", "green", true),
    ).resolves.toBe("Replaced 2 occurrence(s) in generated/note.txt.");
    expect(await readFile(join(root, "generated", "note.txt"), "utf8")).toBe(
      "green green blue",
    );
    expect(
      (await readdir(join(root, "generated"))).some((name) =>
        name.includes(".krater-"),
      ),
    ).toBe(false);
  });

  it("publishes replacements atomically while preserving executable mode", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "script.sh");
    await writeFile(path, "#!/bin/sh\necho before\n");
    await chmod(path, 0o755);
    const workspace = new Workspace(root);

    await workspace.replaceInFile("script.sh", "before", "after");

    expect(await readFile(path, "utf8")).toContain("echo after");
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect((await readdir(root)).filter((name) => name.includes(".krater-"))).toEqual(
      [],
    );
  });

  it("rejects lexical traversal, absolute paths, and symlinks escaping the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("krater-outside-");
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(outside, join(root, "escape"));
    const workspace = new Workspace(root);

    await expect(workspace.readFile("../outside.txt")).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(workspace.readFile(join(outside, "secret.txt"))).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(workspace.listFiles("escape")).rejects.toThrow(
      /resolves outside the workspace/,
    );
    await expect(workspace.readFile("escape/secret.txt")).rejects.toThrow(
      /resolves outside the workspace/,
    );
    await expect(
      workspace.searchFiles("secret", "escape"),
    ).rejects.toThrow(/resolves outside the workspace/);
    await expect(
      workspace.writeTextFile("escape/new.txt", "must not escape"),
    ).rejects.toThrow(/resolves outside the workspace/);
    await expect(workspace.writeTextFile("../new.txt", "must not escape")).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects binary files", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "binary.dat"), Buffer.from([65, 0, 66]));
    const workspace = new Workspace(root);

    await expect(workspace.readFile("binary.dat")).rejects.toThrow(/Binary file/);
    await expect(workspace.searchFiles("A")).resolves.toBe("No matches found.");
    await expect(
      workspace.replaceInFile("binary.dat", "A", "changed"),
    ).rejects.toThrow(/Binary file cannot be edited/);
  });

  it("rejects oversized, invalid UTF-8, and non-file replacement targets", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "large.txt"), "x".repeat(1_000_001));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const workspace = new Workspace(root);

    await expect(
      workspace.replaceInFile("large.txt", "x", "y"),
    ).rejects.toThrow(/too large to edit safely/);
    await expect(
      workspace.replaceInFile("invalid.txt", "x", "y"),
    ).rejects.toThrow(/not valid UTF-8/);
    await expect(
      workspace.replaceInFile("directory", "x", "y"),
    ).rejects.toThrow(/Not a file/);
  });

  it("does not expose or mutate secret files through workspace tools", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".env"), "KRATER_API_KEY=kr_do_not_expose\n");
    await writeFile(join(root, ".env.local"), "OTHER_SECRET=also_private\n");
    await writeFile(join(root, ".env.example"), "KRATER_API_KEY=example_only\n");
    const workspace = new Workspace(root);

    const listed = await workspace.listFiles();
    expect(listed).toContain(".env [protected]");
    expect(listed).toContain(".env.local [protected]");
    expect(listed).toContain(".env.example");

    await expect(workspace.readFile(".env")).rejects.toThrow(/secret or internal file/);
    await expect(workspace.writeTextFile(".env", "replacement")).rejects.toThrow(
      /secret or internal file/,
    );
    await expect(
      workspace.replaceInFile(".env.local", "also_private", "changed"),
    ).rejects.toThrow(/secret or internal file/);
    await expect(workspace.searchFiles("kr_do_not_expose")).resolves.toBe(
      "No matches found.",
    );
    await expect(workspace.readFile(".env.example")).resolves.toContain(
      "KRATER_API_KEY=example_only",
    );
  });

  it("rejects in-workspace symlink aliases to protected files and directories", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".env"), "KRATER_API_KEY=must_stay_private\n");
    await writeFile(join(root, ".git", "config"), "private git config\n");
    await symlink(".env", join(root, "safe-looking.txt"));
    await symlink(".git", join(root, "safe-looking-dir"));
    const workspace = new Workspace(root);

    await expect(workspace.readFile("safe-looking.txt")).rejects.toThrow(
      /symbolic-link paths/i,
    );
    await expect(
      workspace.searchFiles("must_stay_private", "safe-looking.txt"),
    ).rejects.toThrow(/symbolic-link paths/i);
    await expect(
      workspace.writeTextFile("safe-looking.txt", "replacement"),
    ).rejects.toThrow(/symbolic-link paths/i);
    await expect(
      workspace.replaceInFile("safe-looking.txt", "private", "public"),
    ).rejects.toThrow(/symbolic-link paths/i);
    await expect(
      workspace.writeTextFile("safe-looking-dir/new-config", "replacement"),
    ).rejects.toThrow(/symbolic-link paths/i);
    expect(await readFile(join(root, ".env"), "utf8")).toContain(
      "must_stay_private",
    );
  });

  it("treats every .git path segment case-insensitively", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".GIT"), { recursive: true });
    await writeFile(join(root, ".GIT", "config"), "private git config\n");
    const workspace = new Workspace(root);

    await expect(workspace.readFile(".GIT/config")).rejects.toThrow(
      /secret or internal file/,
    );
    await expect(workspace.writeTextFile(".GIT/new", "private")).rejects.toThrow(
      /secret or internal file/,
    );
  });
});

describe("Workspace command execution", () => {
  it.each([
    "rm -rf /",
    "sudo rm -rf ~",
    "rm -rf $HOME",
    "mkfs /dev/example",
    "shutdown -h now",
    "reboot",
    "diskutil eraseDisk APFS Krater disk0",
    "git reset --hard",
    "git clean -fd",
  ])("blocks known destructive command: %s", async (command) => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);

    await expect(workspace.runCommand(command)).rejects.toThrow(
      /blocked because it can irreversibly destroy data/,
    );
  });

  it("runs a harmless command from the workspace and captures its result", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);

    const result = await workspace.runCommand(
      'node -e "process.stdout.write(process.cwd())"',
      5_000,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    });
    expect(result.stdout).toBe(workspace.root);
  });

  it("blocks direct shell reads of protected secret files", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".env"), "KRATER_API_KEY=kr_do_not_expose\n");
    const workspace = new Workspace(root);

    await expect(workspace.runCommand("cat .env")).rejects.toThrow(
      /attempts to read a protected secret file/,
    );
    await expect(workspace.runCommand("rg KRATER_API_KEY .env")).rejects.toThrow(
      /attempts to read a protected secret file/,
    );
  });

  it("does not forward provider credentials to model-requested commands", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);
    const previous = process.env.KRATER_API_KEY;
    process.env.KRATER_API_KEY = "kr_must_not_reach_child";
    try {
      const result = await workspace.runCommand(
        'node -e "process.stdout.write(process.env.KRATER_API_KEY ?? \\"missing\\")"',
        5_000,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("missing");
    } finally {
      if (previous === undefined) delete process.env.KRATER_API_KEY;
      else process.env.KRATER_API_KEY = previous;
    }
  });

  it("terminates a running process group when the task is cancelled", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);
    const controller = new AbortController();
    const started = Date.now();
    const running = workspace.runCommand(
      'node -e "setInterval(() => {}, 1000)"',
      60_000,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 80);

    await expect(running).rejects.toThrow(/cancelled/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("Workspace Git inspection", () => {
  it("excludes protected file contents from unstaged and staged diffs", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "safe.txt"), "safe before\n");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=secret_before\n");
    await writeFile(join(root, "identity.pem"), "PRIVATE_KEY_BEFORE\n");
    const workspace = new Workspace(root);

    await workspace.runCommand("git init -q");
    await workspace.runCommand("git add -f safe.txt .env identity.pem");
    await workspace.runCommand(
      "git -c user.name=Krater -c user.email=krater@example.invalid commit -qm initial",
    );

    await writeFile(join(root, "safe.txt"), "safe after\n");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=secret_unstaged\n");
    await writeFile(join(root, "identity.pem"), "PRIVATE_KEY_UNSTAGED\n");

    const unstaged = await workspace.gitDiff();
    expect(unstaged).toContain("safe after");
    expect(unstaged).not.toContain("secret_");
    expect(unstaged).not.toContain("PRIVATE_KEY");
    expect(unstaged).not.toContain(".env");
    expect(unstaged).not.toContain("identity.pem");

    await workspace.runCommand("git add -f safe.txt .env identity.pem");
    const staged = await workspace.gitDiff(true);
    expect(staged).toContain("safe after");
    expect(staged).not.toContain("secret_");
    expect(staged).not.toContain("PRIVATE_KEY");
    expect(staged).not.toContain(".env");
    expect(staged).not.toContain("identity.pem");
  });

  it("does not execute repository fsmonitor or textconv helpers", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "sample.payload"), "before\n");
    await writeFile(join(root, ".gitattributes"), "*.payload diff=evil\n");
    await writeFile(
      join(root, "evil-helper.sh"),
      "#!/bin/sh\ntouch helper-executed\ncat \"$1\" 2>/dev/null || true\n",
    );
    await chmod(join(root, "evil-helper.sh"), 0o755);
    const workspace = new Workspace(root);

    await workspace.runCommand("git init -q");
    await workspace.runCommand("git add .gitattributes sample.payload evil-helper.sh");
    await workspace.runCommand(
      "git -c user.name=Krater -c user.email=krater@example.invalid commit -qm initial",
    );
    await workspace.runCommand(
      "git config diff.evil.textconv ./evil-helper.sh && git config core.fsmonitor ./evil-helper.sh",
    );
    await writeFile(join(root, "sample.payload"), "after\n");

    const status = await workspace.gitStatus();
    const diff = await workspace.gitDiff();

    expect(status).toContain("sample.payload");
    expect(diff).toContain("after");
    await expect(readFile(join(root, "helper-executed"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
