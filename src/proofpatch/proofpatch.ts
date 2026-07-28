import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  ProofPatchConflictError,
  ProofPatchPublicationError,
  ProofPatchSimulatedCrashError,
  ProofPatchStateError,
} from "./errors.js";
import {
  type JournalChange,
  ProofPatchJournalStore,
  type ProofPatchJournal,
} from "./journal.js";
import {
  missingFileSnapshot,
  sameSnapshot,
  ScratchWorkspaceBackend,
  snapshotForContent,
} from "./scratch-backend.js";
import type {
  ExistingFileSnapshot,
  FileSnapshot,
  ProofPatchOperationPreview,
  ProofPatchPreview,
  ProofPatchPublishResult,
  ProofPatchStoreOptions,
  ProofPatchWorkspaceBackend,
  RecoveryResult,
  StageFileOptions,
} from "./types.js";

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneSnapshot<T extends FileSnapshot>(snapshot: T): T {
  return { ...snapshot };
}

function cloneOperation(
  operation: ProofPatchOperationPreview,
): ProofPatchOperationPreview {
  switch (operation.kind) {
    case "create":
      return {
        ...operation,
        before: cloneSnapshot(operation.before),
        after: cloneSnapshot(operation.after),
      };
    case "edit":
      return {
        ...operation,
        before: cloneSnapshot(operation.before),
        after: cloneSnapshot(operation.after),
      };
    case "delete":
      return {
        ...operation,
        before: cloneSnapshot(operation.before),
        after: cloneSnapshot(operation.after),
      };
    case "move":
      return {
        ...operation,
        beforeSource: cloneSnapshot(operation.beforeSource),
        beforeDestination: cloneSnapshot(operation.beforeDestination),
        afterSource: cloneSnapshot(operation.afterSource),
        afterDestination: cloneSnapshot(operation.afterDestination),
      };
  }
}

function assertExisting(
  snapshot: FileSnapshot,
  path: string,
): asserts snapshot is ExistingFileSnapshot {
  if (!snapshot.exists) {
    throw new ProofPatchStateError(`ProofPatch file does not exist: ${path}`);
  }
}

class WorkspaceOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

export class ProofPatchStore {
  readonly backend: ProofPatchWorkspaceBackend;
  readonly stateRoot: string;

  private readonly journals: ProofPatchJournalStore;
  private readonly failureInjector: ProofPatchStoreOptions["failureInjector"];
  private readonly queue = new WorkspaceOperationQueue();

  private constructor(
    backend: ProofPatchWorkspaceBackend,
    journals: ProofPatchJournalStore,
    failureInjector: ProofPatchStoreOptions["failureInjector"],
  ) {
    this.backend = backend;
    this.journals = journals;
    this.stateRoot = journals.stateRoot;
    this.failureInjector = failureInjector;
  }

  static async open(options: ProofPatchStoreOptions): Promise<ProofPatchStore> {
    if (!options.backend && !options.workspaceRoot) {
      throw new ProofPatchStateError(
        "ProofPatch requires either workspaceRoot or a workspace backend.",
      );
    }
    const backend =
      options.backend ??
      (await ScratchWorkspaceBackend.open(options.workspaceRoot!));
    if (
      options.backend &&
      options.workspaceRoot &&
      (await realpath(resolve(options.workspaceRoot))) !== backend.workspaceRoot
    ) {
      throw new ProofPatchStateError(
        "ProofPatch workspaceRoot does not match the supplied backend.",
      );
    }
    const journals = await ProofPatchJournalStore.open(options.stateRoot);
    if (journals.stateRoot === backend.workspaceRoot) {
      throw new ProofPatchStateError(
        "ProofPatch state root cannot be the workspace root.",
      );
    }
    return new ProofPatchStore(backend, journals, options.failureInjector);
  }

  async beginTransaction(): Promise<ProofPatchTransaction> {
    const transactionId = randomUUID();
    const now = new Date().toISOString();
    const journal: ProofPatchJournal = {
      version: 1,
      sequence: 0,
      transactionId,
      backend: this.backend.kind,
      workspaceRoot: this.backend.workspaceRoot,
      status: "staged",
      createdAt: now,
      updatedAt: now,
      operations: [],
      changes: [],
    };
    const directory = await this.journals.create(journal);
    return new ProofPatchTransaction(
      this.backend,
      this.journals,
      directory,
      journal,
      this.failureInjector,
      (action) => this.queue.run(action),
    );
  }

  async openTransaction(transactionId: string): Promise<ProofPatchTransaction> {
    const { directory, journal } = await this.journals.read(transactionId);
    this.assertJournalWorkspace(journal);
    return new ProofPatchTransaction(
      this.backend,
      this.journals,
      directory,
      journal,
      this.failureInjector,
      (action) => this.queue.run(action),
    );
  }

  async recoverIncompleteTransactions(): Promise<RecoveryResult[]> {
    return this.queue.run(async () => {
      const results: RecoveryResult[] = [];
      for (const { directory, journal } of await this.journals.list()) {
        if (
          ![
            "prepared",
            "publishing",
            "rolling_back",
            "recovery_failed",
          ].includes(journal.status)
        ) {
          continue;
        }
        const previousStatus = journal.status;
        try {
          this.assertJournalWorkspace(journal);
          const transaction = new ProofPatchTransaction(
            this.backend,
            this.journals,
            directory,
            journal,
            undefined,
            async (action) => action(),
          );
          await transaction.rollbackWithoutQueue(false);
          results.push({
            transactionId: journal.transactionId,
            recovered: true,
            previousStatus,
            status: journal.status,
          });
        } catch (error) {
          results.push({
            transactionId: journal.transactionId,
            recovered: false,
            previousStatus,
            status: journal.status,
            error: errorMessage(error),
          });
        }
      }
      return results;
    });
  }

  private assertJournalWorkspace(journal: ProofPatchJournal): void {
    if (
      journal.workspaceRoot !== this.backend.workspaceRoot ||
      journal.backend !== this.backend.kind
    ) {
      throw new ProofPatchStateError(
        `ProofPatch transaction ${journal.transactionId} belongs to a different workspace backend.`,
      );
    }
  }
}

export class ProofPatchTransaction {
  readonly id: string;

  constructor(
    private readonly backend: ProofPatchWorkspaceBackend,
    private readonly journals: ProofPatchJournalStore,
    private readonly directory: string,
    private readonly journal: ProofPatchJournal,
    private readonly failureInjector: ProofPatchStoreOptions["failureInjector"],
    private readonly withQueue: <T>(action: () => Promise<T>) => Promise<T>,
  ) {
    this.id = journal.transactionId;
  }

  preview(): ProofPatchPreview {
    return {
      transactionId: this.id,
      backend: this.backend.kind,
      workspaceRoot: this.backend.workspaceRoot,
      status: this.journal.status,
      operations: this.journal.operations.map(cloneOperation),
    };
  }

  async stageCreate(
    path: string,
    content: string | Buffer,
    options: StageFileOptions = {},
  ): Promise<void> {
    await this.assertCanStage();
    const normalized = this.safeTarget(path);
    this.assertUnused(normalized);
    const before = await this.backend.inspect(normalized);
    if (before.exists) {
      throw new ProofPatchStateError(
        `ProofPatch cannot create an existing file: ${normalized}`,
      );
    }
    const data = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content);
    const after = snapshotForContent(data, options.mode ?? 0o644);
    const stagedFile = `${randomUUID()}.stage`;
    await this.journals.writeBlob(
      this.directory,
      "staged",
      stagedFile,
      data,
    );
    this.journal.operations.push({
      kind: "create",
      path: normalized,
      before,
      after,
    });
    this.journal.changes.push({
      path: normalized,
      before,
      after,
      stagedFile,
      state: "pending",
    });
    await this.journals.persist(this.directory, this.journal);
  }

  async stageEdit(
    path: string,
    content: string | Buffer,
    options: StageFileOptions = {},
  ): Promise<void> {
    await this.assertCanStage();
    const normalized = this.safeTarget(path);
    this.assertUnused(normalized);
    const before = await this.backend.inspect(normalized);
    assertExisting(before, normalized);
    const data = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content);
    const after = snapshotForContent(data, options.mode ?? before.mode);
    const stagedFile = `${randomUUID()}.stage`;
    await this.journals.writeBlob(
      this.directory,
      "staged",
      stagedFile,
      data,
    );
    this.journal.operations.push({
      kind: "edit",
      path: normalized,
      before,
      after,
    });
    this.journal.changes.push({
      path: normalized,
      before,
      after,
      stagedFile,
      state: "pending",
    });
    await this.journals.persist(this.directory, this.journal);
  }

  async stageDelete(path: string): Promise<void> {
    await this.assertCanStage();
    const normalized = this.safeTarget(path);
    this.assertUnused(normalized);
    const before = await this.backend.inspect(normalized);
    assertExisting(before, normalized);
    const after = missingFileSnapshot();
    this.journal.operations.push({
      kind: "delete",
      path: normalized,
      before,
      after,
    });
    this.journal.changes.push({
      path: normalized,
      before,
      after,
      state: "pending",
    });
    await this.journals.persist(this.directory, this.journal);
  }

  async stageMove(from: string, to: string): Promise<void> {
    await this.assertCanStage();
    const source = this.safeTarget(from);
    const destination = this.safeTarget(to);
    if (source === destination) {
      throw new ProofPatchStateError("ProofPatch move source and destination must differ.");
    }
    this.assertUnused(source);
    this.assertUnused(destination);
    const beforeSource = await this.backend.inspect(source);
    assertExisting(beforeSource, source);
    const beforeDestination = await this.backend.inspect(destination);
    if (beforeDestination.exists) {
      throw new ProofPatchStateError(
        `ProofPatch move destination already exists: ${destination}`,
      );
    }
    const content = await this.backend.readFile(source, beforeSource);
    const afterSource = missingFileSnapshot();
    const afterDestination = snapshotForContent(content, beforeSource.mode);
    const stagedFile = `${randomUUID()}.stage`;
    await this.journals.writeBlob(
      this.directory,
      "staged",
      stagedFile,
      content,
    );
    this.journal.operations.push({
      kind: "move",
      from: source,
      to: destination,
      beforeSource,
      beforeDestination,
      afterSource,
      afterDestination,
    });
    this.journal.changes.push(
      {
        path: destination,
        before: beforeDestination,
        after: afterDestination,
        stagedFile,
        state: "pending",
      },
      {
        path: source,
        before: beforeSource,
        after: afterSource,
        state: "pending",
      },
    );
    await this.journals.persist(this.directory, this.journal);
  }

  async publish(): Promise<ProofPatchPublishResult> {
    return this.withQueue(async () => {
      if (this.journal.status !== "staged") {
        throw new ProofPatchStateError(
          `ProofPatch transaction ${this.id} cannot publish from ${this.journal.status}.`,
        );
      }
      await this.validateBases();
      try {
        await this.prepareBackups();
        await this.inject("after-preparation");
        this.journal.status = "publishing";
        await this.journals.persist(this.directory, this.journal);

        for (const [index, change] of this.journal.changes.entries()) {
          await this.applyChange(change, index);
        }
        this.journal.status = "published";
        this.journal.publishedAt = new Date().toISOString();
        this.journal.lastError = undefined;
        await this.journals.persist(this.directory, this.journal);
        return {
          ...this.preview(),
          publishedAt: this.journal.publishedAt,
        };
      } catch (error) {
        if (error instanceof ProofPatchSimulatedCrashError) throw error;
        let rollbackCause: unknown;
        try {
          await this.rollbackWithoutQueue(true);
        } catch (rollbackError) {
          rollbackCause = rollbackError;
        }
        throw new ProofPatchPublicationError(error, rollbackCause);
      }
    });
  }

  async rollback(): Promise<void> {
    return this.withQueue(() => this.rollbackWithoutQueue(true));
  }

  async rollbackWithoutQueue(injectFailures: boolean): Promise<void> {
    if (this.journal.status === "rolled_back") return;
    if (this.journal.status === "staged") {
      for (const change of this.journal.changes) change.state = "restored";
      this.journal.status = "rolled_back";
      await this.journals.persist(this.directory, this.journal);
      return;
    }
    if (injectFailures) await this.inject("before-rollback");
    this.journal.status = "rolling_back";
    await this.journals.persist(this.directory, this.journal);

    try {
      for (
        let index = this.journal.changes.length - 1;
        index >= 0;
        index -= 1
      ) {
        const change = this.journal.changes[index];
        await this.restoreChange(change);
        change.state = "restored";
        await this.journals.persist(this.directory, this.journal);
        if (injectFailures) {
          await this.inject("after-rollback-change", change.path, index);
        }
      }
      this.journal.status = "rolled_back";
      this.journal.lastError = undefined;
      await this.journals.persist(this.directory, this.journal);
    } catch (error) {
      this.journal.status = "recovery_failed";
      this.journal.lastError = errorMessage(error);
      await this.journals.persist(this.directory, this.journal).catch(() => undefined);
      throw error;
    }
  }

  private async assertCanStage(): Promise<void> {
    if (this.journal.status !== "staged") {
      throw new ProofPatchStateError(
        `ProofPatch transaction ${this.id} cannot be changed from ${this.journal.status}.`,
      );
    }
  }

  private safeTarget(input: string): string {
    const normalized = this.backend.normalizePath(input);
    const absolute = resolve(
      this.backend.workspaceRoot,
      ...normalized.split("/"),
    );
    const relativeState = relative(this.journals.stateRoot, absolute);
    if (
      within(this.journals.stateRoot, absolute) ||
      (!relativeState.startsWith("..") && relativeState !== "")
    ) {
      throw new ProofPatchStateError(
        `ProofPatch cannot target its state storage: ${normalized}`,
      );
    }
    return normalized;
  }

  private assertUnused(path: string): void {
    if (this.journal.changes.some((change) => change.path === path)) {
      throw new ProofPatchStateError(
        `ProofPatch path already has a staged operation: ${path}`,
      );
    }
  }

  private async validateBases(): Promise<void> {
    for (const change of this.journal.changes) {
      const current = await this.backend.inspect(change.path);
      if (!sameSnapshot(current, change.before)) {
        throw new ProofPatchConflictError(change.path);
      }
    }
  }

  private async prepareBackups(): Promise<void> {
    for (const change of this.journal.changes) {
      if (!change.before.exists || change.backupFile) continue;
      const content = await this.backend.readFile(change.path, change.before);
      const backupFile = `${randomUUID()}.backup`;
      await this.journals.writeBlob(
        this.directory,
        "backups",
        backupFile,
        content,
      );
      change.backupFile = backupFile;
    }
    this.journal.status = "prepared";
    await this.journals.persist(this.directory, this.journal);
  }

  private async applyChange(
    change: JournalChange,
    index: number,
  ): Promise<void> {
    const current = await this.backend.inspect(change.path);
    if (!sameSnapshot(current, change.before)) {
      throw new ProofPatchConflictError(change.path);
    }
    change.state = "applying";
    await this.journals.persist(this.directory, this.journal);
    await this.inject("before-change", change.path, index);

    if (change.after.exists) {
      if (!change.stagedFile) {
        throw new ProofPatchStateError(
          `ProofPatch staged content is missing for ${change.path}.`,
        );
      }
      const content = await this.journals.readBlob(
        this.directory,
        "staged",
        change.stagedFile,
      );
      const stagedSnapshot = snapshotForContent(content, change.after.mode);
      if (!sameSnapshot(stagedSnapshot, change.after)) {
        throw new ProofPatchStateError(
          `ProofPatch staged content failed verification: ${change.path}`,
        );
      }
      await this.backend.writeFile(
        change.path,
        content,
        change.before,
        change.after.mode,
      );
    } else {
      assertExisting(change.before, change.path);
      await this.backend.removeFile(change.path, change.before);
    }

    await this.inject("after-change", change.path, index);
    change.state = "applied";
    await this.journals.persist(this.directory, this.journal);
  }

  private async restoreChange(change: JournalChange): Promise<void> {
    const current = await this.backend.inspect(change.path);
    if (change.state === "restored") {
      if (!sameSnapshot(current, change.before)) {
        throw new ProofPatchConflictError(
          change.path,
          `ProofPatch rollback was changed externally: ${change.path}`,
        );
      }
      return;
    }
    if (change.state === "pending") {
      if (!sameSnapshot(current, change.before)) {
        throw new ProofPatchConflictError(
          change.path,
          `ProofPatch refuses to overwrite an external change during rollback: ${change.path}`,
        );
      }
      return;
    }
    if (sameSnapshot(current, change.before)) return;
    if (!sameSnapshot(current, change.after)) {
      throw new ProofPatchConflictError(
        change.path,
        `ProofPatch refuses to overwrite an unknown state during rollback: ${change.path}`,
      );
    }

    if (change.before.exists) {
      if (!change.backupFile) {
        throw new ProofPatchStateError(
          `ProofPatch backup is missing for ${change.path}.`,
        );
      }
      const content = await this.journals.readBlob(
        this.directory,
        "backups",
        change.backupFile,
      );
      const backupSnapshot = snapshotForContent(content, change.before.mode);
      if (!sameSnapshot(backupSnapshot, change.before)) {
        throw new ProofPatchStateError(
          `ProofPatch backup failed verification: ${change.path}`,
        );
      }
      await this.backend.writeFile(
        change.path,
        content,
        current,
        change.before.mode,
      );
    } else {
      assertExisting(current, change.path);
      await this.backend.removeFile(change.path, current);
    }
  }

  private async inject(
    point: Parameters<NonNullable<typeof this.failureInjector>>[0]["point"],
    path?: string,
    changeIndex?: number,
  ): Promise<void> {
    await this.failureInjector?.({
      point,
      transactionId: this.id,
      path,
      changeIndex,
    });
  }
}
