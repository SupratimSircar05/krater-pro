import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofPatchConflictError } from "./proofpatch/index.js";
import {
  ProofPatchSimulatedCrashError,
  ProofPatchStore,
} from "./proofpatch/index.js";
import {
  discardStagedProofPatch,
  loadProofPatchBinding,
  publishBoundProofPatch,
  rollbackBoundProofPatch,
  StagedTaskWorkspace,
} from "./staging-workspace.js";

const temporaryPaths: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "krater-staging-workspace-"));
  temporaryPaths.push(root);
  return root;
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("StagedTaskWorkspace", () => {
  it("rejects staging identifiers that could escape the private staging root", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "source.txt"), "base\n");

    await expect(
      StagedTaskWorkspace.create(root, "../escaped"),
    ).rejects.toThrow("Staging ID");
    await expectMissing(join(root, ".krater", "escaped"));
  });

  it("discards only staged bindings and never treats cancellation as rollback", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "source.txt"), "before\n");

    const staged = await StagedTaskWorkspace.create(root, "cancel-staged");
    await writeFile(join(staged.stageRoot, "source.txt"), "after\n");
    await staged.prepareProofPatch("task-cancel-staged");

    const discarded = await discardStagedProofPatch(
      root,
      "task-cancel-staged",
    );
    expect(discarded.status).toBe("rolled_back");
    expect(discarded).not.toHaveProperty("publishedAt");
    await expect(readFile(join(root, "source.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(
      discardStagedProofPatch(root, "task-cancel-staged"),
    ).resolves.toMatchObject({ status: "rolled_back" });

    const publishedStage = await StagedTaskWorkspace.create(
      root,
      "cancel-published",
    );
    await writeFile(join(publishedStage.stageRoot, "source.txt"), "published\n");
    await publishedStage.prepareProofPatch("task-cancel-published");
    await publishBoundProofPatch(root, "task-cancel-published");

    await expect(
      discardStagedProofPatch(root, "task-cancel-published"),
    ).rejects.toThrow(/published.*cannot be discarded/i);
    await expect(readFile(join(root, "source.txt"), "utf8")).resolves.toBe(
      "published\n",
    );
  });

  it("isolates edits and persists a complete binding before atomic publish and rollback", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "edit.txt"), "before edit\n", { mode: 0o640 });
    await writeFile(join(root, "delete.txt"), "delete me\n");
    await writeFile(join(root, "move.txt"), "move me\n", { mode: 0o600 });

    const staged = await StagedTaskWorkspace.create(root, "all-operations");
    await writeFile(join(staged.stageRoot, "edit.txt"), "after edit\n");
    await writeFile(join(staged.stageRoot, "create.txt"), "created\n", {
      mode: 0o604,
    });
    await unlink(join(staged.stageRoot, "delete.txt"));
    await rename(
      join(staged.stageRoot, "move.txt"),
      join(staged.stageRoot, "moved.txt"),
    );

    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "before edit\n",
    );
    await expect(readFile(join(root, "delete.txt"), "utf8")).resolves.toBe(
      "delete me\n",
    );
    await expect(readFile(join(root, "move.txt"), "utf8")).resolves.toBe(
      "move me\n",
    );
    await expectMissing(join(root, "create.txt"));
    await expectMissing(join(root, "moved.txt"));

    const prepared = await staged.prepareProofPatch("task-all-operations");

    expect(prepared.baseWorkspaceDigest).toBe(staged.initialWorkspaceDigest);
    expect(prepared.finalWorkspaceDigest).not.toBe(
      prepared.baseWorkspaceDigest,
    );
    expect(prepared.unsupportedPaths).toEqual([]);
    expect(prepared.changedPaths).toEqual([
      "create.txt",
      "delete.txt",
      "edit.txt",
      "move.txt",
      "moved.txt",
    ]);
    expect(prepared.preview.operations.map((operation) => operation.kind)).toEqual(
      ["move", "delete", "create", "edit"],
    );
    await expectMissing(staged.stageRoot);

    const persisted = await loadProofPatchBinding(
      root,
      "task-all-operations",
    );
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      taskId: "task-all-operations",
      transactionId: prepared.transactionId,
      workspaceRoot: staged.baseRoot,
      status: "staged",
      changedPaths: prepared.changedPaths,
      unsupportedPaths: [],
    });

    const published = await publishBoundProofPatch(
      root,
      "task-all-operations",
    );
    expect(published.binding.status).toBe("published");
    expect(published.binding.publishedAt).toMatch(/T/);
    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "after edit\n",
    );
    await expect(readFile(join(root, "create.txt"), "utf8")).resolves.toBe(
      "created\n",
    );
    await expectMissing(join(root, "delete.txt"));
    await expectMissing(join(root, "move.txt"));
    await expect(readFile(join(root, "moved.txt"), "utf8")).resolves.toBe(
      "move me\n",
    );

    const rolledBack = await rollbackBoundProofPatch(
      root,
      "task-all-operations",
    );
    expect(rolledBack.status).toBe("rolled_back");
    expect(rolledBack.rolledBackAt).toMatch(/T/);
    await expect(readFile(join(root, "edit.txt"), "utf8")).resolves.toBe(
      "before edit\n",
    );
    await expectMissing(join(root, "create.txt"));
    await expect(readFile(join(root, "delete.txt"), "utf8")).resolves.toBe(
      "delete me\n",
    );
    await expect(readFile(join(root, "move.txt"), "utf8")).resolves.toBe(
      "move me\n",
    );
    await expectMissing(join(root, "moved.txt"));
  });

  it("keeps secrets, private state, and dependencies out of staging and publication", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".env"), "KRATER_API_KEY=top-secret-value\n");
    await writeFile(join(root, ".env.example"), "KRATER_API_KEY=\n");
    await writeFile(join(root, ".npmrc"), "//registry/:_authToken=private\n");
    await writeFile(join(root, "credentials.json"), '{"token":"private"}\n');
    await writeFile(join(root, "client.pem"), "private certificate material\n");
    await mkdir(join(root, ".krater"), { mode: 0o700 });
    await writeFile(join(root, ".krater", "private.txt"), "private state\n");
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".git", "config"),
      "https://user:private-token@example.test/repository.git\n",
    );
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "fixture", "index.js"),
      "module.exports = 'base dependency';\n",
    );

    const staged = await StagedTaskWorkspace.create(root, "protected-content");

    expect(staged.readOnlyDependencyRoots).toEqual([
      join(staged.baseRoot, "node_modules"),
    ]);
    await expectMissing(join(staged.stageRoot, ".env"));
    await expectMissing(join(staged.stageRoot, ".npmrc"));
    await expectMissing(join(staged.stageRoot, "credentials.json"));
    await expectMissing(join(staged.stageRoot, "client.pem"));
    await expect(readFile(join(staged.stageRoot, ".env.example"), "utf8")).resolves
      .toBe("KRATER_API_KEY=\n");
    await expectMissing(join(staged.stageRoot, ".krater"));
    await expectMissing(join(staged.stageRoot, ".git"));
    await expectMissing(join(staged.stageRoot, "node_modules"));

    await writeFile(join(staged.stageRoot, "source.ts"), "export const value = 2;\n");
    await writeFile(join(staged.stageRoot, ".env"), "KRATER_API_KEY=leaked\n");
    await mkdir(join(staged.stageRoot, ".krater"));
    await writeFile(
      join(staged.stageRoot, ".krater", "generated.txt"),
      "generated state\n",
    );
    await mkdir(join(staged.stageRoot, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      join(staged.stageRoot, "node_modules", "fixture", "index.js"),
      "module.exports = 'agent dependency';\n",
    );

    const prepared = await staged.prepareProofPatch("task-protected-content");
    expect(prepared.changedPaths).toEqual(["source.ts"]);
    expect(prepared.unsupportedPaths).toEqual([]);
    expect(JSON.stringify(prepared)).not.toContain("top-secret-value");
    expect(JSON.stringify(prepared)).not.toContain("leaked");

    const published = await publishBoundProofPatch(
      root,
      "task-protected-content",
    );
    expect(published.binding.status).toBe("published");
    await expect(readFile(join(root, "source.ts"), "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
    await expect(readFile(join(root, ".env"), "utf8")).resolves.toBe(
      "KRATER_API_KEY=top-secret-value\n",
    );
    await expect(readFile(join(root, ".krater", "private.txt"), "utf8")).resolves
      .toBe("private state\n");
    await expectMissing(join(root, ".krater", "generated.txt"));
    await expect(
      readFile(join(root, "node_modules", "fixture", "index.js"), "utf8"),
    ).resolves.toBe("module.exports = 'base dependency';\n");
  });

  it("detects a concurrent base edit and never overwrites it", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "shared.txt"), "base\n");
    const staged = await StagedTaskWorkspace.create(root, "digest-conflict");
    await writeFile(join(staged.stageRoot, "shared.txt"), "agent\n");
    await staged.prepareProofPatch("task-digest-conflict");

    await writeFile(join(root, "shared.txt"), "human\n");

    await expect(
      publishBoundProofPatch(root, "task-digest-conflict"),
    ).rejects.toBeInstanceOf(ProofPatchConflictError);
    await expect(readFile(join(root, "shared.txt"), "utf8")).resolves.toBe(
      "human\n",
    );
    await expect(
      loadProofPatchBinding(root, "task-digest-conflict"),
    ).resolves.toMatchObject({ status: "staged" });
  });

  it("rejects publication when any source path changed after the snapshot", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "changed.txt"), "base\n");
    await writeFile(join(root, "unrelated.txt"), "base unrelated\n");
    const staged = await StagedTaskWorkspace.create(root, "whole-digest-conflict");
    await writeFile(join(staged.stageRoot, "changed.txt"), "agent\n");
    await staged.prepareProofPatch("task-whole-digest-conflict");

    await writeFile(join(root, "unrelated.txt"), "human unrelated\n");

    await expect(
      publishBoundProofPatch(root, "task-whole-digest-conflict"),
    ).rejects.toBeInstanceOf(ProofPatchConflictError);
    await expect(readFile(join(root, "changed.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    await expect(readFile(join(root, "unrelated.txt"), "utf8")).resolves.toBe(
      "human unrelated\n",
    );
  });

  it("does not recover another task's in-flight transaction while preparing", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "crashed.txt"), "base\n");
    await writeFile(join(root, "other.txt"), "base\n");
    const staged = await StagedTaskWorkspace.create(root, "parallel-prepare");
    await writeFile(join(staged.stageRoot, "other.txt"), "other agent\n");

    let crashed = false;
    const store = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot: join(root, ".krater", "proofpatch"),
      failureInjector(context) {
        if (!crashed && context.point === "after-change") {
          crashed = true;
          throw new ProofPatchSimulatedCrashError();
        }
      },
    });
    const transaction = await store.beginTransaction();
    await transaction.stageEdit("crashed.txt", "partially published\n");
    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchSimulatedCrashError,
    );

    await staged.prepareProofPatch("task-parallel-prepare");

    await expect(readFile(join(root, "crashed.txt"), "utf8")).resolves.toBe(
      "partially published\n",
    );
    expect(
      (await store.openTransaction(transaction.id)).preview().status,
    ).toBe("publishing");
  });

  it("records new-parent paths as unsupported and refuses the whole publication", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "supported.txt"), "base\n");
    const staged = await StagedTaskWorkspace.create(root, "new-parent");
    await writeFile(join(staged.stageRoot, "supported.txt"), "agent\n");
    await mkdir(join(staged.stageRoot, "new-directory"));
    await writeFile(
      join(staged.stageRoot, "new-directory", "nested.txt"),
      "nested\n",
    );

    const prepared = await staged.prepareProofPatch("task-new-parent");

    expect(prepared.changedPaths).toEqual(["supported.txt"]);
    expect(prepared.unsupportedPaths).toEqual([
      "new-directory/nested.txt",
    ]);
    await expect(
      publishBoundProofPatch(root, "task-new-parent"),
    ).rejects.toThrow(
      "ProofPatch cannot publish paths whose parent directories do not exist",
    );
    await expect(readFile(join(root, "supported.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    await expectMissing(join(root, "new-directory"));

    const rolledBack = await rollbackBoundProofPatch(root, "task-new-parent");
    expect(rolledBack.status).toBe("rolled_back");
  });
});
