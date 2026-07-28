import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProofPatchConflictError,
  ProofPatchPathError,
  ProofPatchPublicationError,
  ProofPatchSimulatedCrashError,
  ProofPatchStateError,
  ProofPatchStore,
} from "./index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function fixture(): Promise<{
  root: string;
  stateRoot: string;
  store: ProofPatchStore;
}> {
  const root = await temporaryDirectory("krater-proofpatch-workspace-");
  const stateRoot = await temporaryDirectory("krater-proofpatch-state-");
  return {
    root,
    stateRoot,
    store: await ProofPatchStore.open({ workspaceRoot: root, stateRoot }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProofPatch staging and publication", () => {
  it("stages create, edit, delete, and move without touching the workspace", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "edit.txt"), "old edit\n", { mode: 0o640 });
    await writeFile(join(root, "delete.txt"), "old delete\n");
    await writeFile(join(root, "move.txt"), "move me\n", { mode: 0o600 });
    const transaction = await store.beginTransaction();

    await transaction.stageCreate("created.txt", Buffer.from([0, 1, 2, 255]), {
      mode: 0o604,
    });
    await transaction.stageEdit("edit.txt", "new edit\n");
    await transaction.stageDelete("delete.txt");
    await transaction.stageMove("move.txt", "moved.txt");

    await expect(readFile(join(root, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "old edit\n",
    );
    await expect(readFile(join(root, "delete.txt"), "utf8")).resolves.toBe(
      "old delete\n",
    );
    await expect(readFile(join(root, "move.txt"), "utf8")).resolves.toBe(
      "move me\n",
    );
    await expect(readFile(join(root, "moved.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const preview = transaction.preview();
    expect(preview).toMatchObject({
      transactionId: transaction.id,
      backend: "scratch",
      status: "staged",
      operations: [
        {
          kind: "create",
          path: "created.txt",
          before: { exists: false, digest: null },
          after: { exists: true, digest: expect.stringMatching(/^sha256:/) },
        },
        {
          kind: "edit",
          path: "edit.txt",
          before: { exists: true, digest: expect.stringMatching(/^sha256:/) },
          after: { exists: true, digest: expect.stringMatching(/^sha256:/) },
        },
        { kind: "delete", path: "delete.txt" },
        { kind: "move", from: "move.txt", to: "moved.txt" },
      ],
    });

    const published = await transaction.publish();

    expect(published.status).toBe("published");
    expect(published.publishedAt).toMatch(/T/);
    await expect(readFile(join(root, "created.txt"))).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "new edit\n",
    );
    await expect(readFile(join(root, "delete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "move.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "moved.txt"), "utf8")).resolves.toBe(
      "move me\n",
    );
    expect((await lstat(join(root, "created.txt"))).mode & 0o777).toBe(0o604);
    expect((await lstat(join(root, "edit.txt"))).mode & 0o777).toBe(0o640);
    expect((await lstat(join(root, "moved.txt"))).mode & 0o777).toBe(0o600);
  });

  it("refuses publication when an edited base digest changed", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "file.txt"), "base\n");
    const transaction = await store.beginTransaction();
    await transaction.stageEdit("file.txt", "agent\n");

    await writeFile(join(root, "file.txt"), "human\n");

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchConflictError,
    );
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe(
      "human\n",
    );
    expect(transaction.preview().status).toBe("staged");
  });

  it("refuses publication when a staged create now exists", async () => {
    const { root, store } = await fixture();
    const transaction = await store.beginTransaction();
    await transaction.stageCreate("new.txt", "agent\n");

    await writeFile(join(root, "new.txt"), "human\n");

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchConflictError,
    );
    await expect(readFile(join(root, "new.txt"), "utf8")).resolves.toBe(
      "human\n",
    );
  });

  it("refuses publication when only the base mode changed", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "script.sh"), "echo old\n", { mode: 0o600 });
    const transaction = await store.beginTransaction();
    await transaction.stageEdit("script.sh", "echo new\n");

    await chmod(join(root, "script.sh"), 0o700);

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchConflictError,
    );
    expect((await lstat(join(root, "script.sh"))).mode & 0o777).toBe(0o700);
  });

  it("can roll a completed publication back while its post-image still matches", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "edit.txt"), "before\n");
    await writeFile(join(root, "delete.txt"), "keep\n");
    await writeFile(join(root, "move.txt"), "source\n");
    const transaction = await store.beginTransaction();
    await transaction.stageCreate("create.txt", "created\n");
    await transaction.stageEdit("edit.txt", "after\n");
    await transaction.stageDelete("delete.txt");
    await transaction.stageMove("move.txt", "moved.txt");
    await transaction.publish();

    await transaction.rollback();

    expect(transaction.preview().status).toBe("rolled_back");
    await expect(readFile(join(root, "create.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readFile(join(root, "delete.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(readFile(join(root, "move.txt"), "utf8")).resolves.toBe(
      "source\n",
    );
    await expect(readFile(join(root, "moved.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not overwrite a human edit made after publication during rollback", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "file.txt"), "base\n");
    const transaction = await store.beginTransaction();
    await transaction.stageEdit("file.txt", "agent\n");
    await transaction.publish();
    await writeFile(join(root, "file.txt"), "human after publish\n");

    await expect(transaction.rollback()).rejects.toBeInstanceOf(
      ProofPatchConflictError,
    );
    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe(
      "human after publish\n",
    );
    expect(transaction.preview().status).toBe("recovery_failed");
  });
});

describe("ProofPatch failure recovery", () => {
  it("automatically rolls back all applied changes after an ordinary failure", async () => {
    const root = await temporaryDirectory("krater-proofpatch-workspace-");
    const stateRoot = await temporaryDirectory("krater-proofpatch-state-");
    await writeFile(join(root, "first.txt"), "first base\n");
    await writeFile(join(root, "second.txt"), "second base\n");
    let failed = false;
    const store = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
      failureInjector(context) {
        if (!failed && context.point === "after-change") {
          failed = true;
          throw new Error("injected publication failure");
        }
      },
    });
    const transaction = await store.beginTransaction();
    await transaction.stageEdit("first.txt", "first changed\n");
    await transaction.stageEdit("second.txt", "second changed\n");

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchPublicationError,
    );

    expect(transaction.preview().status).toBe("rolled_back");
    await expect(readFile(join(root, "first.txt"), "utf8")).resolves.toBe(
      "first base\n",
    );
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe(
      "second base\n",
    );
  });

  it("recovers a simulated process crash from the durable journal and backups", async () => {
    const root = await temporaryDirectory("krater-proofpatch-workspace-");
    const stateRoot = await temporaryDirectory("krater-proofpatch-state-");
    await writeFile(join(root, "first.txt"), "first base\n");
    await writeFile(join(root, "second.txt"), "second base\n");
    let crashed = false;
    const crashingStore = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
      failureInjector(context) {
        if (!crashed && context.point === "after-change") {
          crashed = true;
          throw new ProofPatchSimulatedCrashError();
        }
      },
    });
    const transaction = await crashingStore.beginTransaction();
    await transaction.stageEdit("first.txt", "first changed\n");
    await transaction.stageEdit("second.txt", "second changed\n");

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchSimulatedCrashError,
    );
    await expect(readFile(join(root, "first.txt"), "utf8")).resolves.toBe(
      "first changed\n",
    );
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe(
      "second base\n",
    );
    expect(transaction.preview().status).toBe("publishing");

    const restartedStore = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
    });
    const recovery = await restartedStore.recoverIncompleteTransactions();

    expect(recovery).toEqual([
      expect.objectContaining({
        transactionId: transaction.id,
        recovered: true,
        previousStatus: "publishing",
        status: "rolled_back",
      }),
    ]);
    await expect(readFile(join(root, "first.txt"), "utf8")).resolves.toBe(
      "first base\n",
    );
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe(
      "second base\n",
    );
    const reopened = await restartedStore.openTransaction(transaction.id);
    expect(reopened.preview().status).toBe("rolled_back");
    await expect(
      restartedStore.recoverIncompleteTransactions(),
    ).resolves.toEqual([]);
  });
});

describe("ProofPatch path confinement", () => {
  it.each([
    "../outside.txt",
    "nested/../../outside.txt",
    "/tmp/absolute.txt",
    "C:\\Windows\\system.ini",
    ".git/config",
    ".krater/events.jsonl",
    ".env",
    ".env.local",
  ])("rejects protected or escaping target %s", async (path) => {
    const { store } = await fixture();
    const transaction = await store.beginTransaction();
    await expect(transaction.stageCreate(path, "blocked\n")).rejects.toBeInstanceOf(
      ProofPatchPathError,
    );
  });

  it("rejects symbolic-link leaves and symbolic-link parent escapes", async () => {
    const { root, store } = await fixture();
    const outside = await temporaryDirectory("krater-proofpatch-outside-");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
    await symlink(outside, join(root, "escape"));
    const transaction = await store.beginTransaction();

    await expect(transaction.stageEdit("leaf.txt", "overwrite\n")).rejects.toBeInstanceOf(
      ProofPatchPathError,
    );
    await expect(
      transaction.stageEdit("escape/secret.txt", "overwrite\n"),
    ).rejects.toBeInstanceOf(ProofPatchPathError);
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe(
      "secret\n",
    );
  });

  it("rejects hard-linked files both while staging and before publishing", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "original.txt"), "shared\n");
    await link(join(root, "original.txt"), join(root, "alias.txt"));
    const transaction = await store.beginTransaction();
    await expect(
      transaction.stageEdit("alias.txt", "overwrite\n"),
    ).rejects.toBeInstanceOf(ProofPatchPathError);

    await rm(join(root, "alias.txt"));
    const second = await store.beginTransaction();
    await second.stageEdit("original.txt", "agent\n");
    const outside = await temporaryDirectory("krater-proofpatch-outside-");
    await link(join(root, "original.txt"), join(outside, "other-link.txt"));

    await expect(second.publish()).rejects.toBeInstanceOf(ProofPatchPathError);
    await expect(readFile(join(outside, "other-link.txt"), "utf8")).resolves.toBe(
      "shared\n",
    );
  });

  it("rejects a missing parent rather than creating directories implicitly", async () => {
    const { store } = await fixture();
    const transaction = await store.beginTransaction();
    await expect(
      transaction.stageCreate("missing/child.txt", "content\n"),
    ).rejects.toBeInstanceOf(ProofPatchPathError);
  });

  it("keeps a state root inside the workspace outside the mutable target set", async () => {
    const root = await temporaryDirectory("krater-proofpatch-workspace-");
    const stateRoot = join(root, "proof-state");
    await mkdir(stateRoot);
    const store = await ProofPatchStore.open({ workspaceRoot: root, stateRoot });
    const transaction = await store.beginTransaction();

    await expect(
      transaction.stageCreate("proof-state/attack.txt", "blocked\n"),
    ).rejects.toBeInstanceOf(ProofPatchStateError);
  });
});
