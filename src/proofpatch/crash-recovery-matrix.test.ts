import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProofPatchFailureContext,
  type ProofPatchFailurePoint,
  ProofPatchSimulatedCrashError,
  ProofPatchStore,
  type ProofPatchTransaction,
} from "./index.js";

const temporaryPaths: string[] = [];

const ALL_FAILURE_POINTS = [
  "after-preparation",
  "before-change",
  "after-change",
  "before-rollback",
  "after-rollback-change",
] as const satisfies readonly ProofPatchFailurePoint[];

type MissingFailurePoint = Exclude<
  ProofPatchFailurePoint,
  (typeof ALL_FAILURE_POINTS)[number]
>;
const allFailurePointsAreCovered: MissingFailurePoint extends never
  ? true
  : never = true;

const CHANGE_POSITIONS = [
  { index: 0, path: "created.txt", operation: "create" },
  { index: 1, path: "edited.txt", operation: "edit" },
  { index: 2, path: "deleted.txt", operation: "delete" },
  { index: 3, path: "renamed.txt", operation: "move destination (rename)" },
  { index: 4, path: "move-source.txt", operation: "move source (rename)" },
] as const;

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function createWorkspace(): Promise<{
  root: string;
  stateRoot: string;
}> {
  const root = await temporaryDirectory("krater-proofpatch-matrix-workspace-");
  const stateRoot = await temporaryDirectory("krater-proofpatch-matrix-state-");
  await writeFile(join(root, "edited.txt"), "edit:base\n", { mode: 0o640 });
  await writeFile(join(root, "deleted.txt"), "delete:base\n", { mode: 0o604 });
  await writeFile(join(root, "move-source.txt"), "move:base\n", {
    mode: 0o600,
  });
  return { root, stateRoot };
}

async function stageEveryOperation(
  transaction: ProofPatchTransaction,
): Promise<void> {
  await transaction.stageCreate("created.txt", "create:agent\n", {
    mode: 0o604,
  });
  await transaction.stageEdit("edited.txt", "edit:agent\n");
  await transaction.stageDelete("deleted.txt");
  await transaction.stageMove("move-source.txt", "renamed.txt");
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectMode(path: string, mode: number): Promise<void> {
  expect((await lstat(path)).mode & 0o777).toBe(mode);
}

/**
 * The journal applies changes in this exact order:
 * create, edit, delete, move destination, move source.
 *
 * `appliedPrefix` therefore also describes every durable intermediate state,
 * including the safe two-file state between the copy and removal halves of a
 * rename.
 */
async function expectAppliedPrefix(
  root: string,
  appliedPrefix: number,
): Promise<void> {
  if (appliedPrefix >= 1) {
    await expect(readFile(join(root, "created.txt"), "utf8")).resolves.toBe(
      "create:agent\n",
    );
    await expectMode(join(root, "created.txt"), 0o604);
  } else {
    await expectMissing(join(root, "created.txt"));
  }

  await expect(readFile(join(root, "edited.txt"), "utf8")).resolves.toBe(
    appliedPrefix >= 2 ? "edit:agent\n" : "edit:base\n",
  );
  await expectMode(join(root, "edited.txt"), 0o640);

  if (appliedPrefix >= 3) {
    await expectMissing(join(root, "deleted.txt"));
  } else {
    await expect(readFile(join(root, "deleted.txt"), "utf8")).resolves.toBe(
      "delete:base\n",
    );
    await expectMode(join(root, "deleted.txt"), 0o604);
  }

  if (appliedPrefix >= 4) {
    await expect(readFile(join(root, "renamed.txt"), "utf8")).resolves.toBe(
      "move:base\n",
    );
    await expectMode(join(root, "renamed.txt"), 0o600);
  } else {
    await expectMissing(join(root, "renamed.txt"));
  }

  if (appliedPrefix >= 5) {
    await expectMissing(join(root, "move-source.txt"));
  } else {
    await expect(
      readFile(join(root, "move-source.txt"), "utf8"),
    ).resolves.toBe("move:base\n");
    await expectMode(join(root, "move-source.txt"), 0o600);
  }
}

async function expectBaseWorkspace(root: string): Promise<void> {
  await expectAppliedPrefix(root, 0);
}

function crashAt(
  point: ProofPatchFailurePoint,
  changeIndex?: number,
): {
  failureInjector: (context: ProofPatchFailureContext) => void;
  observed: () => ProofPatchFailureContext | undefined;
} {
  let hit: ProofPatchFailureContext | undefined;
  return {
    failureInjector(context) {
      if (
        hit === undefined &&
        context.point === point &&
        (changeIndex === undefined || context.changeIndex === changeIndex)
      ) {
        hit = { ...context };
        throw new ProofPatchSimulatedCrashError(
          `Crash at ${point}${changeIndex === undefined ? "" : `:${changeIndex}`}`,
        );
      }
    },
    observed: () => hit,
  };
}

async function expectAutomaticRecovery(
  root: string,
  stateRoot: string,
  transactionId: string,
  previousStatus: "prepared" | "publishing" | "recovery_failed",
): Promise<void> {
  const restarted = await ProofPatchStore.open({
    workspaceRoot: root,
    stateRoot,
  });
  await expect(restarted.recoverIncompleteTransactions()).resolves.toEqual([
    {
      transactionId,
      recovered: true,
      previousStatus,
      status: "rolled_back",
    },
  ]);
  await expectBaseWorkspace(root);
  const reopened = await restarted.openTransaction(transactionId);
  expect(reopened.preview().status).toBe("rolled_back");
  await expect(restarted.recoverIncompleteTransactions()).resolves.toEqual([]);
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProofPatch exhaustive publication crash recovery", () => {
  it("keeps the matrix exhaustive when the declared fault-point union changes", () => {
    expect(allFailurePointsAreCovered).toBe(true);
    expect(ALL_FAILURE_POINTS).toEqual([
      "after-preparation",
      "before-change",
      "after-change",
      "before-rollback",
      "after-rollback-change",
    ]);
  });

  it("recovers every operation after a crash following durable preparation", async () => {
    const { root, stateRoot } = await createWorkspace();
    const crash = crashAt("after-preparation");
    const store = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
      failureInjector: crash.failureInjector,
    });
    const transaction = await store.beginTransaction();
    await stageEveryOperation(transaction);

    await expect(transaction.publish()).rejects.toBeInstanceOf(
      ProofPatchSimulatedCrashError,
    );
    expect(crash.observed()).toMatchObject({
      point: "after-preparation",
      transactionId: transaction.id,
    });
    expect(transaction.preview().status).toBe("prepared");
    await expectBaseWorkspace(root);

    await expectAutomaticRecovery(
      root,
      stateRoot,
      transaction.id,
      "prepared",
    );
  });

  it.each(CHANGE_POSITIONS)(
    "recovers a before-change crash at $operation index $index",
    async ({ index, path }) => {
      const { root, stateRoot } = await createWorkspace();
      const crash = crashAt("before-change", index);
      const store = await ProofPatchStore.open({
        workspaceRoot: root,
        stateRoot,
        failureInjector: crash.failureInjector,
      });
      const transaction = await store.beginTransaction();
      await stageEveryOperation(transaction);

      await expect(transaction.publish()).rejects.toBeInstanceOf(
        ProofPatchSimulatedCrashError,
      );
      expect(crash.observed()).toMatchObject({
        point: "before-change",
        path,
        changeIndex: index,
        transactionId: transaction.id,
      });
      expect(transaction.preview().status).toBe("publishing");
      await expectAppliedPrefix(root, index);

      await expectAutomaticRecovery(
        root,
        stateRoot,
        transaction.id,
        "publishing",
      );
    },
  );

  it.each(CHANGE_POSITIONS)(
    "recovers an after-change crash at $operation index $index",
    async ({ index, path }) => {
      const { root, stateRoot } = await createWorkspace();
      const crash = crashAt("after-change", index);
      const store = await ProofPatchStore.open({
        workspaceRoot: root,
        stateRoot,
        failureInjector: crash.failureInjector,
      });
      const transaction = await store.beginTransaction();
      await stageEveryOperation(transaction);

      await expect(transaction.publish()).rejects.toBeInstanceOf(
        ProofPatchSimulatedCrashError,
      );
      expect(crash.observed()).toMatchObject({
        point: "after-change",
        path,
        changeIndex: index,
        transactionId: transaction.id,
      });
      expect(transaction.preview().status).toBe("publishing");
      await expectAppliedPrefix(root, index + 1);

      await expectAutomaticRecovery(
        root,
        stateRoot,
        transaction.id,
        "publishing",
      );
    },
  );
});

describe("ProofPatch exhaustive rollback crash recovery", () => {
  it("preserves a completed publication when crashing before rollback and accepts a retry after restart", async () => {
    const { root, stateRoot } = await createWorkspace();
    const crash = crashAt("before-rollback");
    const store = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
      failureInjector: crash.failureInjector,
    });
    const transaction = await store.beginTransaction();
    await stageEveryOperation(transaction);
    await transaction.publish();

    await expect(transaction.rollback()).rejects.toBeInstanceOf(
      ProofPatchSimulatedCrashError,
    );
    expect(crash.observed()).toMatchObject({
      point: "before-rollback",
      transactionId: transaction.id,
    });
    expect(transaction.preview().status).toBe("published");
    await expectAppliedPrefix(root, CHANGE_POSITIONS.length);

    const restarted = await ProofPatchStore.open({
      workspaceRoot: root,
      stateRoot,
    });
    await expect(restarted.recoverIncompleteTransactions()).resolves.toEqual([]);
    const reopened = await restarted.openTransaction(transaction.id);
    await reopened.rollback();
    expect(reopened.preview().status).toBe("rolled_back");
    await expectBaseWorkspace(root);
  });

  it.each([...CHANGE_POSITIONS].reverse())(
    "recovers an after-rollback-change crash at $operation index $index",
    async ({ index, path }) => {
      const { root, stateRoot } = await createWorkspace();
      const crash = crashAt("after-rollback-change", index);
      const store = await ProofPatchStore.open({
        workspaceRoot: root,
        stateRoot,
        failureInjector: crash.failureInjector,
      });
      const transaction = await store.beginTransaction();
      await stageEveryOperation(transaction);
      await transaction.publish();

      await expect(transaction.rollback()).rejects.toBeInstanceOf(
        ProofPatchSimulatedCrashError,
      );
      expect(crash.observed()).toMatchObject({
        point: "after-rollback-change",
        path,
        changeIndex: index,
        transactionId: transaction.id,
      });
      expect(transaction.preview().status).toBe("recovery_failed");
      await expectAppliedPrefix(root, index);

      await expectAutomaticRecovery(
        root,
        stateRoot,
        transaction.id,
        "recovery_failed",
      );
    },
  );
});
