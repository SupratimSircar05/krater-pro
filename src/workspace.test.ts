import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./workspace.js";
import {
  platformContainmentPrimitives,
  type NativeSandboxAdapter,
} from "./sandbox/index.js";

const temporaryPaths: string[] = [];
const execFileAsync = promisify(execFile);

async function rewriteOpenFileInPlace(handle: FileHandle) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size < 1n) {
    throw new Error("The rewrite fixture requires a non-empty regular file.");
  }
  const original = Buffer.alloc(1);
  const read = await handle.read(original, 0, original.length, 0);
  if (read.bytesRead !== original.length) {
    throw new Error("The rewrite fixture could not read the opened file.");
  }
  const replacement = Buffer.from([(original[0] ?? 0) ^ 0xff]);
  const written = await handle.write(replacement, 0, replacement.length, 0);
  if (written.bytesWritten !== replacement.length) {
    throw new Error("The rewrite fixture could not update the opened file.");
  }
  await handle.sync();
  return { before, after: await handle.stat({ bigint: true }) };
}

async function temporaryDirectory(prefix = "krater-workspace-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function verifiedTestAdapter(
  run: NativeSandboxAdapter["run"],
): NativeSandboxAdapter {
  const primitives = platformContainmentPrimitives(process.platform);
  return {
    id: "verified-workspace-test",
    probe: async () => ({
      platform:
        process.platform === "darwin" ||
        process.platform === "linux" ||
        process.platform === "win32"
          ? process.platform
          : "unsupported",
      verification: "verified",
      availability: "available",
      expectedPrimitives: primitives,
      verifiedPrimitives: primitives,
      controls: {
        filesystemBoundary: true,
        processIsolation: true,
        networkDeny: true,
        networkAllowlist: false,
        cpuLimit: true,
        memoryLimit: true,
        wallTimeLimit: true,
        processCountLimit: true,
        outputLimit: true,
      },
      adapterId: "verified-workspace-test",
      supportsApprovedUncontainedExecution: false,
      reason: "Verified fixture adapter.",
      verifiedAt: "2026-07-28T00:00:00.000Z",
    }),
    run,
    cancel: async () => undefined,
  };
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

  it("returns a bounded structured IDE tree without secrets or symlinks", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("krater-tree-outside-");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "export {}");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export {}");
    await writeFile(join(root, ".env"), "TOKEN=private");
    await writeFile(join(outside, "outside.txt"), "private");
    await symlink(outside, join(root, "escape"));
    const workspace = new Workspace(root);

    const tree = await workspace.tree(".", 1);

    expect(tree.path).toBe(".");
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((entry) => entry.path)).toEqual([
      "node_modules",
      "src",
      "src/nested",
      "src/main.ts",
    ]);
    expect(tree.entries.find((entry) => entry.path === "node_modules")).toMatchObject({
      type: "directory",
      ignored: true,
    });
    expect(tree.entries.map((entry) => entry.path)).not.toContain(".env");
    expect(tree.entries.map((entry) => entry.path)).not.toContain("escape");
    expect(tree.entries.map((entry) => entry.path)).not.toContain(
      "src/nested/deep.ts",
    );
  });

  it("treats Krater control data and hard-linked aliases as protected", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".krater", "scratch", "other"), { recursive: true });
    await writeFile(
      join(root, ".krater", "scratch", "other", "private.txt"),
      "cross-project secret\n",
    );
    await writeFile(join(root, ".env"), "TOKEN=hard-link-secret\n");
    await link(join(root, ".env"), join(root, "safe.txt"));
    const workspace = new Workspace(root);

    const tree = await workspace.tree(".", 3);
    expect(tree.entries.map((entry) => entry.path)).not.toContain(".krater");
    expect(tree.entries.map((entry) => entry.path)).not.toContain("safe.txt");
    await expect(
      workspace.readTextDocument(".krater/scratch/other/private.txt"),
    ).rejects.toThrow(/secret or internal/);
    await expect(
      workspace.saveTextDocument(
        ".krater/scratch/other/private.txt",
        "overwrite\n",
        null,
      ),
    ).rejects.toThrow(/secret or internal/);
    await expect(workspace.readTextDocument("safe.txt")).rejects.toThrow(
      /Hard-linked/,
    );
    await expect(workspace.readFile("safe.txt")).rejects.toThrow(/Hard-linked/);
    await expect(
      workspace.saveTextDocument("safe.txt", "overwrite\n", null),
    ).rejects.toThrow(/Hard-linked/);
  });

  it("reads and saves editor documents with optimistic conflict protection", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "note.txt");
    await writeFile(path, "first\n");
    const workspace = new Workspace(root);

    const opened = await workspace.readTextDocument("note.txt");
    expect(opened).toMatchObject({
      path: "note.txt",
      content: "first\n",
      size: 6,
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const saved = await workspace.saveTextDocument(
      "note.txt",
      "second\n",
      opened.revision,
    );
    expect(saved.content).toBe("second\n");
    expect(saved.revision).not.toBe(opened.revision);

    await writeFile(path, "external change\n");
    await expect(
      workspace.saveTextDocument("note.txt", "stale overwrite\n", saved.revision),
    ).rejects.toMatchObject({ code: "WORKSPACE_REVISION_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe("external change\n");

    await expect(
      workspace.saveTextDocument("created.txt", "new\n", null),
    ).resolves.toMatchObject({ path: "created.txt", content: "new\n" });
    await expect(
      workspace.saveTextDocument("created.txt", "overwrite\n", null),
    ).rejects.toMatchObject({ code: "WORKSPACE_REVISION_CONFLICT" });
  });

  it("serializes concurrent revisions across Workspace instances", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "shared.txt"), "base\n");
    const firstWorkspace = new Workspace(root);
    const secondWorkspace = new Workspace(root);
    const opened = await firstWorkspace.readTextDocument("shared.txt");

    const existingResults = await Promise.allSettled([
      firstWorkspace.saveTextDocument(
        "shared.txt",
        "first writer\n",
        opened.revision,
      ),
      secondWorkspace.saveTextDocument(
        "shared.txt",
        "second writer\n",
        opened.revision,
      ),
    ]);
    expect(existingResults.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(existingResults.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      existingResults.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "WORKSPACE_REVISION_CONFLICT" },
    });

    const newResults = await Promise.allSettled([
      firstWorkspace.saveTextDocument("new-shared.txt", "one\n", null),
      secondWorkspace.saveTextDocument("new-shared.txt", "two\n", null),
    ]);
    expect(newResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(newResults.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("applies editor size, encoding, secret, and symlink boundaries", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("krater-editor-outside-");
    await writeFile(join(root, ".env"), "TOKEN=private");
    await writeFile(join(root, "large.txt"), "x".repeat(1_000_001));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(outside, "outside.txt"), "private");
    await symlink(join(outside, "outside.txt"), join(root, "alias.txt"));
    const workspace = new Workspace(root);

    await expect(workspace.readTextDocument(".env")).rejects.toThrow(
      /secret or internal/,
    );
    await expect(workspace.readTextDocument("alias.txt")).rejects.toThrow(
      /symbolic-link|resolves outside/,
    );
    await expect(workspace.readTextDocument("large.txt")).rejects.toThrow(
      /Maximum editor size/,
    );
    await expect(workspace.readTextDocument("invalid.txt")).rejects.toThrow(
      /valid UTF-8/,
    );
    await expect(
      workspace.saveTextDocument("huge.txt", "x".repeat(1_000_001), null),
    ).rejects.toThrow(/Maximum editor size/);
    await expect(
      workspace.saveTextDocument(".env", "replacement", null),
    ).rejects.toThrow(/secret or internal/);
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

  it("bounds search output and marks truncated matching lines explicitly", async () => {
    const root = await temporaryDirectory();
    const matchingLine = `needle ${"x".repeat(5_000)}`;
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(
          join(root, `match-${String(index).padStart(2, "0")}.txt`),
          matchingLine,
        ),
      ),
    );
    const workspace = new Workspace(root);

    const result = await workspace.searchFiles("needle");

    expect(result.length).toBeLessThanOrEqual(120_000);
    expect(result).toContain("[matching line truncated]");
    expect(result).toContain(
      "(Search output truncated at its 120000-character limit.)",
    );
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

  it("rejects an overflow-sized replacement before constructing its output", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "many.txt");
    const original = "a".repeat(1_000);
    await writeFile(path, original);
    const workspace = new Workspace(root);

    await expect(
      workspace.replaceInFile(
        "many.txt",
        "a",
        "🙂".repeat(250_000),
        true,
      ),
    ).rejects.toThrow(/would make many\.txt too large/);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("does not swallow a post-save parent identity failure as an fsync limitation", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);
    const internals = workspace as unknown as {
      verifiedDirectoryIdentity(directory: string): Promise<{
        dev: number;
        ino: number;
        physical: string;
      }>;
    };
    const verifyIdentity = internals.verifiedDirectoryIdentity.bind(workspace);
    let identityChecks = 0;
    vi.spyOn(internals, "verifiedDirectoryIdentity").mockImplementation(
      async (directory) => {
        const identity = await verifyIdentity(directory);
        identityChecks += 1;
        return identityChecks === 3
          ? { ...identity, ino: identity.ino + 1 }
          : identity;
      },
    );

    await expect(
      workspace.writeTextFile("identity.txt", "saved"),
    ).rejects.toThrow(/Parent directory changed after saving identity\.txt/);
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
    await expect(workspace.readFile("line\nbreak.txt")).rejects.toThrow(
      /forbidden control character/,
    );
    await expect(workspace.readFile(`/${"x".repeat(4_097)}`)).rejects.toThrow(
      /Path is too long/,
    );
    await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reconstructs valid nested paths with spaces and Unicode segments", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "Design Notes", "ಕನ್ನಡ");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "résumé.txt"), "safe unicode path\n");
    const workspace = new Workspace(root);

    await expect(
      workspace.readTextDocument("Design Notes/ಕನ್ನಡ/résumé.txt"),
    ).resolves.toMatchObject({
      path: "Design Notes/ಕನ್ನಡ/résumé.txt",
      content: "safe unicode path\n",
    });
    await expect(
      workspace.readTextDocument(
        join(workspace.root, "Design Notes", "ಕನ್ನಡ", "résumé.txt"),
      ),
    ).resolves.toMatchObject({
      path: "Design Notes/ಕನ್ನಡ/résumé.txt",
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
  it("fails closed when unattended native containment is unavailable", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root, { nativeSandboxAdapter: null });

    await expect(
      workspace.runCommand(
        'node -e "require(\\"node:fs\\").writeFileSync(\\"escaped.txt\\", \\"no\\")"',
        5_000,
        undefined,
        { authorization: "verified_unattended" },
      ),
    ).rejects.toThrow(/Unattended command refused by native containment/);
    await expect(stat(join(root, "escaped.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds unattended execution to staged resources, denies secrets/network, and labels the receipt", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".env"), "HOST_ONLY=value\n");
    const run = vi.fn<NativeSandboxAdapter["run"]>(async () => ({
      exitCode: 0,
      terminationReason: "exit",
      output: [{ stream: "stdout", data: "verified\n" }],
      outputBytesObserved: 9,
      resourceUsage: { peakProcessCount: 1 },
    }));
    const workspace = new Workspace(root, {
      nativeSandboxAdapter: verifiedTestAdapter(run),
    });

    const result = await workspace.runCommand(
      "print -r -- verified",
      5_000,
      undefined,
      { authorization: "verified_unattended" },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "verified\n",
      execution: {
        authorization: "verified_unattended",
        containment: "verified_native",
        adapterId: "verified-workspace-test",
        effectiveProcessLimit: 1,
      },
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        containment: "secure",
        network: expect.objectContaining({ policy: "deny" }),
        limits: expect.objectContaining({ processCount: 1 }),
        resources: expect.arrayContaining([
          expect.objectContaining({
            access: "read_write",
            paths: [workspace.root],
          }),
          expect.objectContaining({
            access: "deny",
            paths: expect.arrayContaining([join(workspace.root, ".env")]),
          }),
        ]),
      }),
    );
  });

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
    expect(result.execution.authorization).toBe("host_direct");
  });

  it.runIf(process.platform !== "win32")(
    "does not trust relative, workspace, or arbitrary absolute PATH entries for its gate or Git",
    async () => {
      const root = await temporaryDirectory("krater-host-path-");
      const outsideTools = await temporaryDirectory("krater-host-tools-");
      const fakeCat = join(root, "cat");
      const fakeGit = join(outsideTools, "git");
      const catMarker = join(root, "cat-helper-ran");
      const gitMarker = join(root, "git-helper-ran");
      await writeFile(
        fakeCat,
        `#!/bin/sh\n: > ${JSON.stringify(catMarker)}\n/bin/cat "$@"\n`,
      );
      await writeFile(
        fakeGit,
        `#!/bin/sh\n: > ${JSON.stringify(gitMarker)}\nexit 99\n`,
      );
      await chmod(fakeCat, 0o755);
      await chmod(fakeGit, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${outsideTools}:.:${root}:${previousPath ?? ""}`;
      try {
        const workspace = new Workspace(root);
        await expect(
          workspace.runCommand("printf TRUSTED_BOOTSTRAP"),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "TRUSTED_BOOTSTRAP",
        });
        await expect(workspace.gitStatus()).rejects.toThrow(
          /repository boundaries|not a git repository|workspace is not a repository/i,
        );
        await expect(stat(catMarker)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
    15_000,
  );

  it("preserves script sequencing while commands receive EOF on stdin", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);

    const result = await workspace.runCommand(
      "read value\ncat\necho SHOULD_RUN",
      5_000,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "SHOULD_RUN\n",
      stderr: "",
      timedOut: false,
    });
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

  it("blocks direct Git metadata reads without blocking normal Git commands", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".gitignore"), "dist\n");
    const workspace = new Workspace(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });

    for (const command of [
      "cat .git/config",
      "rg url .GIT/config",
      'node -e "require(\\"node:fs\\").readFileSync(\\".git/config\\")"',
      "sort .git/config",
      "find .git -type f",
      "cat .gitconfig",
      "cat .git-credentials",
    ]) {
      await expect(workspace.runCommand(command, 5_000)).rejects.toThrow(
        /attempts to read a protected secret file/,
      );
    }

    await expect(workspace.runCommand("git status --short", 5_000)).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    await expect(workspace.runCommand("cat .gitignore", 5_000)).resolves.toMatchObject({
      exitCode: 0,
      stdout: "dist\n",
    });
  });

  it("redacts credentials in Git-style URLs from stdout and stderr", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://remote-user:remote-secret-123@github.com/acme/project.git",
      ],
      { cwd: root },
    );

    const remotes = await workspace.runCommand("git remote -v", 5_000);
    expect(remotes.exitCode).toBe(0);
    expect(remotes.stdout).toContain(
      "https://[REDACTED]@github.com/acme/project.git",
    );
    expect(remotes.stdout).not.toMatch(/remote-user|remote-secret-123/);

    const emitted = await workspace.runCommand(
      "node -e " +
        JSON.stringify(
          'process.stdout.write("https://github.com/acme/project.git?token=query-secret&ref=main");' +
            'process.stderr.write("ssh://deploy:stderr-secret@git.example.com/acme/project.git");',
        ),
      5_000,
    );
    expect(emitted.stdout).toBe(
      "https://github.com/acme/project.git?token=[REDACTED]&ref=main",
    );
    expect(emitted.stderr).toBe(
      "ssh://[REDACTED]@git.example.com/acme/project.git",
    );
    expect(`${emitted.stdout}${emitted.stderr}`).not.toMatch(
      /query-secret|deploy|stderr-secret/,
    );
  });

  it("allows direct reads of only the exact environment example filenames", async () => {
    const root = await temporaryDirectory();
    const workspace = new Workspace(root);
    for (const name of [".env.example", ".env.sample", ".env.template"]) {
      await writeFile(join(root, name), `${name}=placeholder\n`);
      await expect(workspace.runCommand(`cat ${name}`, 5_000)).resolves.toMatchObject({
        exitCode: 0,
        stdout: `${name}=placeholder\n`,
      });
    }
    await writeFile(join(root, ".env.example.backup"), "SECRET=private\n");
    await expect(
      workspace.runCommand("cat .env.example.backup", 5_000),
    ).rejects.toThrow(/attempts to read a protected secret file/);
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

  it("confines macOS command writes and indirect secret reads", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("krater-command-outside-");
    const outsideFile = join(outside, "must-remain.txt");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=sandbox_secret\n");
    await writeFile(
      join(root, ".env.example"),
      "KRATER_API_KEY=example_placeholder\n",
    );
    await writeFile(outsideFile, "outside\n");
    const workspace = new Workspace(root);
    const script = [
      'const fs = require("node:fs");',
      'let value = "";',
      'try { value = fs.readFileSync(".env", "utf8"); }',
      'catch { value = "READ_BLOCKED"; }',
      'let example = "";',
      'try { example = fs.readFileSync(".env.example", "utf8").trim(); }',
      'catch { example = "EXAMPLE_BLOCKED"; }',
      'let outsideValue = "";',
      `try { outsideValue = fs.readFileSync(${JSON.stringify(outsideFile)}, "utf8"); }`,
      'catch { outsideValue = "OUTSIDE_READ_BLOCKED"; }',
      `try { fs.unlinkSync(${JSON.stringify(outsideFile)}); } catch {}`,
      'process.stdout.write([value, example, outsideValue].join("|"));',
    ].join(" ");

    const result = await workspace.runCommand(
      `node -e ${JSON.stringify(script)}`,
      5_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "READ_BLOCKED|KRATER_API_KEY=example_placeholder|OUTSIDE_READ_BLOCKED",
    );
    expect(result.stdout).not.toContain("sandbox_secret");
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });

  it("blocks mixed-case protected filenames in the macOS command sandbox", async () => {
    if (process.platform !== "darwin") return;
    const root = await temporaryDirectory();
    await writeFile(join(root, ".ENV"), "UPPER_ENV=private\n");
    await mkdir(join(root, ".KRATER"));
    await writeFile(join(root, ".KRATER", "session.json"), "internal\n");
    await writeFile(join(root, "ID_RSA"), "private-key\n");
    await writeFile(join(root, "SECRET.PEM"), "private-pem\n");
    await writeFile(join(root, ".Env.Example"), "EXAMPLE=placeholder\n");
    const workspace = new Workspace(root);
    const script = [
      'const fs = require("node:fs");',
      'const read = (path) => {',
      'try { return fs.readFileSync(path, "utf8").trim(); }',
      'catch { return "BLOCKED"; }',
      "};",
      'process.stdout.write([".ENV", ".KRATER/session.json", "ID_RSA", "SECRET.PEM", ".Env.Example"].map(read).join("|"));',
    ].join(" ");

    const result = await workspace.runCommand(
      `node -e ${JSON.stringify(script)}`,
      5_000,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "BLOCKED|BLOCKED|BLOCKED|BLOCKED|EXAMPLE=placeholder",
    });
    expect(result.stdout).not.toMatch(/private|internal/);
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
  it("rejects a configured Git executable contained in the writable workspace", async () => {
    const root = await temporaryDirectory("krater-workspace-git-");
    const executable = join(
      root,
      process.platform === "win32" ? "git.cmd" : "git",
    );
    await writeFile(
      executable,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    await chmod(executable, 0o755);

    expect(() => new Workspace(root, { gitExecutable: executable })).toThrow(
      /outside writable workspace roots/i,
    );
  });

  it("rejects an in-place rewrite of its pinned Git executable", async () => {
    const root = await temporaryDirectory("krater-workspace-git-rewrite-");
    const tools = await temporaryDirectory("krater-workspace-tools-");
    const executable = join(
      tools,
      process.platform === "win32" ? "git.cmd" : "git",
    );
    await writeFile(
      executable,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    await chmod(executable, 0o755);
    const workspace = new Workspace(root, { gitExecutable: executable });
    await mkdir(join(root, ".git"));
    const handle = await open(
      executable,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    let mutation: Awaited<ReturnType<typeof rewriteOpenFileInPlace>>;
    try {
      mutation = await rewriteOpenFileInPlace(handle);
    } finally {
      await handle.close();
    }
    const { before, after } = mutation;
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(workspace.gitStatus()).rejects.toThrow(
      /trusted Git executable changed or disappeared/i,
    );
  });

  it("excludes protected file contents from unstaged and staged diffs", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "safe.txt"), "safe before\n");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=secret_before\n");
    await writeFile(join(root, "identity.pem"), "PRIVATE_KEY_BEFORE\n");
    const workspace = new Workspace(root);

    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "-f", "safe.txt", ".env", "identity.pem"], {
      cwd: root,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Krater",
        "-c",
        "user.email=krater@example.invalid",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root },
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

    await execFileAsync("git", ["add", "-f", "safe.txt", ".env", "identity.pem"], {
      cwd: root,
    });
    const staged = await workspace.gitDiff(true);
    expect(staged).toContain("safe after");
    expect(staged).not.toContain("secret_");
    expect(staged).not.toContain("PRIVATE_KEY");
    expect(staged).not.toContain(".env");
    expect(staged).not.toContain("identity.pem");
  });

  it("returns structured status while omitting protected paths", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "safe.txt"), "safe\n");
    await writeFile(join(root, ".env"), "TOKEN=private\n");
    const workspace = new Workspace(root);

    await workspace.runCommand("git init -q");
    const snapshot = await workspace.gitStatusSnapshot();

    expect(snapshot.clean).toBe(false);
    expect(snapshot.entries).toEqual([
      {
        index: "?",
        workingTree: "?",
        path: "safe.txt",
      },
    ]);
    expect(snapshot.status).toContain("safe.txt");
    expect(snapshot.status).not.toContain(".env");
    expect(await workspace.gitStatus()).toBe(snapshot.status);
  });

  it("omits protected rename and copy pairs from staged diffs", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".env"), "KRATER_API_KEY=rename_secret\n");
    const workspace = new Workspace(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "-f", ".env"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Krater",
        "-c",
        "user.email=krater@example.invalid",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root },
    );

    await execFileAsync("git", ["mv", ".env", "safe-renamed.txt"], { cwd: root });
    expect(await workspace.gitDiff(true)).toBe("No diff.");
    await execFileAsync("git", ["mv", "safe-renamed.txt", ".env"], { cwd: root });

    await copyFile(join(root, ".env"), join(root, "safe-copied.txt"));
    await execFileAsync("git", ["add", "safe-copied.txt"], { cwd: root });
    const copied = await workspace.gitDiff(true);
    expect(copied).toBe("No diff.");
    expect(copied).not.toContain("rename_secret");
  });

  it("pins Git inspection to the selected workspace despite core.worktree", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("krater-git-worktree-outside-");
    await writeFile(join(root, "safe.txt"), "root before\n");
    await writeFile(join(outside, "safe.txt"), "outside secret\n");
    const workspace = new Workspace(root);
    await workspace.runCommand("git init -q");
    await workspace.runCommand("git add safe.txt");
    await workspace.runCommand(
      "git -c user.name=Krater -c user.email=krater@example.invalid commit -qm initial",
    );
    await workspace.runCommand(
      `git config core.worktree ${JSON.stringify(outside)}`,
    );
    await writeFile(join(root, "safe.txt"), "root after\n");

    const snapshot = await workspace.gitStatusSnapshot();
    const diff = await workspace.gitDiff();
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({ path: "safe.txt" }),
    );
    expect(diff).toContain("root after");
    expect(diff).not.toContain("outside secret");
  });

  it("returns a bounded preview instead of losing source control on a large diff", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "large.txt"), `${"a".repeat(140_000)}\n`);
    const workspace = new Workspace(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "large.txt"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Krater",
        "-c",
        "user.email=krater@example.invalid",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root },
    );
    await writeFile(join(root, "large.txt"), `${"b".repeat(140_000)}\n`);

    const diff = await workspace.gitDiff();

    expect(diff).toContain("diff preview truncated");
    expect(diff.length).toBeLessThan(121_000);
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
