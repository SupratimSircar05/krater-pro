import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { ProofPatchStateError } from "./errors.js";
import type {
  FileSnapshot,
  ProofPatchOperationPreview,
  ProofPatchStatus,
} from "./types.js";

export type JournalChangeState =
  | "pending"
  | "applying"
  | "applied"
  | "restored";

export interface JournalChange {
  path: string;
  before: FileSnapshot;
  after: FileSnapshot;
  stagedFile?: string;
  backupFile?: string;
  state: JournalChangeState;
}

export interface ProofPatchJournal {
  version: 1;
  sequence: number;
  transactionId: string;
  backend: string;
  workspaceRoot: string;
  status: ProofPatchStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  operations: ProofPatchOperationPreview[];
  changes: JournalChange[];
  lastError?: string;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function validTransactionId(value: string): boolean {
  return /^[a-f0-9-]{20,80}$/i.test(value);
}

function validBlobName(value: string): boolean {
  return /^[a-f0-9-]{20,80}\.(?:stage|backup)$/i.test(value);
}

function assertJournal(value: unknown, transactionId: string): ProofPatchJournal {
  if (!value || typeof value !== "object") {
    throw new ProofPatchStateError(`Invalid ProofPatch journal for ${transactionId}.`);
  }
  const journal = value as Partial<ProofPatchJournal>;
  if (
    journal.version !== 1 ||
    journal.transactionId !== transactionId ||
    !validTransactionId(journal.transactionId) ||
    typeof journal.sequence !== "number" ||
    !Number.isSafeInteger(journal.sequence) ||
    typeof journal.workspaceRoot !== "string" ||
    typeof journal.backend !== "string" ||
    typeof journal.status !== "string" ||
    !Array.isArray(journal.operations) ||
    !Array.isArray(journal.changes)
  ) {
    throw new ProofPatchStateError(`Invalid ProofPatch journal for ${transactionId}.`);
  }
  return journal as ProofPatchJournal;
}

export class ProofPatchJournalStore {
  readonly stateRoot: string;
  readonly transactionsRoot: string;

  private constructor(stateRoot: string, transactionsRoot: string) {
    this.stateRoot = stateRoot;
    this.transactionsRoot = transactionsRoot;
  }

  static async open(stateRoot: string): Promise<ProofPatchJournalStore> {
    const lexical = resolve(stateRoot);
    await mkdir(lexical, { recursive: true, mode: 0o700 });
    const details = await lstat(lexical);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new ProofPatchStateError(
        `ProofPatch state root is not a safe directory: ${stateRoot}`,
      );
    }
    const physical = await realpath(lexical);
    const transactions = resolve(physical, "transactions");
    await mkdir(transactions, { recursive: true, mode: 0o700 });
    const transactionDetails = await lstat(transactions);
    if (
      transactionDetails.isSymbolicLink() ||
      !transactionDetails.isDirectory()
    ) {
      throw new ProofPatchStateError(
        `ProofPatch transaction root is unsafe: ${transactions}`,
      );
    }
    return new ProofPatchJournalStore(physical, await realpath(transactions));
  }

  async create(journal: ProofPatchJournal): Promise<string> {
    if (!validTransactionId(journal.transactionId)) {
      throw new ProofPatchStateError("ProofPatch generated an invalid transaction ID.");
    }
    const directory = this.transactionDirectory(journal.transactionId);
    await mkdir(directory, { mode: 0o700 });
    await mkdir(resolve(directory, "staged"), { mode: 0o700 });
    await mkdir(resolve(directory, "backups"), { mode: 0o700 });
    await this.append(directory, journal);
    await this.syncDirectory(directory);
    await this.syncDirectory(this.transactionsRoot);
    return directory;
  }

  async persist(
    directory: string,
    journal: ProofPatchJournal,
  ): Promise<void> {
    this.assertTransactionDirectory(directory, journal.transactionId);
    journal.sequence += 1;
    journal.updatedAt = new Date().toISOString();
    await this.append(directory, journal);
  }

  async read(transactionId: string): Promise<{
    directory: string;
    journal: ProofPatchJournal;
  }> {
    const directory = this.transactionDirectory(transactionId);
    return {
      directory,
      journal: await this.readFromDirectory(directory, transactionId),
    };
  }

  async list(): Promise<
    Array<{ directory: string; journal: ProofPatchJournal }>
  > {
    const entries = await readdir(this.transactionsRoot, {
      withFileTypes: true,
    });
    const journals: Array<{
      directory: string;
      journal: ProofPatchJournal;
    }> = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !validTransactionId(entry.name)
      ) {
        continue;
      }
      const directory = this.transactionDirectory(entry.name);
      journals.push({
        directory,
        journal: await this.readFromDirectory(directory, entry.name),
      });
    }
    return journals.sort((left, right) =>
      left.journal.createdAt.localeCompare(right.journal.createdAt),
    );
  }

  async writeBlob(
    directory: string,
    area: "staged" | "backups",
    name: string,
    content: Buffer,
  ): Promise<void> {
    if (!validBlobName(name)) {
      throw new ProofPatchStateError(`Invalid ProofPatch blob name: ${name}`);
    }
    const areaPath = await this.safeArea(directory, area);
    const path = resolve(areaPath, name);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(areaPath);
  }

  async readBlob(
    directory: string,
    area: "staged" | "backups",
    name: string,
  ): Promise<Buffer> {
    if (!validBlobName(name)) {
      throw new ProofPatchStateError(`Invalid ProofPatch blob name: ${name}`);
    }
    const areaPath = await this.safeArea(directory, area);
    const path = resolve(areaPath, name);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.nlink > 1) {
        throw new ProofPatchStateError(
          `ProofPatch state blob is not a private regular file: ${name}`,
        );
      }
      const physical = await realpath(path);
      if (!within(areaPath, physical)) {
        throw new ProofPatchStateError(
          `ProofPatch state blob escapes its transaction: ${name}`,
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private transactionDirectory(transactionId: string): string {
    if (!validTransactionId(transactionId)) {
      throw new ProofPatchStateError(
        `Invalid ProofPatch transaction ID: ${transactionId}`,
      );
    }
    const directory = resolve(this.transactionsRoot, transactionId);
    if (!within(this.transactionsRoot, directory)) {
      throw new ProofPatchStateError("ProofPatch transaction path escaped its state root.");
    }
    return directory;
  }

  private assertTransactionDirectory(
    directory: string,
    transactionId: string,
  ): void {
    if (
      directory !== this.transactionDirectory(transactionId) ||
      !within(this.transactionsRoot, directory)
    ) {
      throw new ProofPatchStateError(
        `ProofPatch transaction directory mismatch: ${transactionId}`,
      );
    }
  }

  private async safeArea(
    directory: string,
    area: "staged" | "backups",
  ): Promise<string> {
    const path = resolve(directory, area);
    if (
      !within(this.transactionsRoot, directory) ||
      !within(directory, path) ||
      basename(path) !== area
    ) {
      throw new ProofPatchStateError("ProofPatch state area escaped its transaction.");
    }
    const details = await lstat(path);
    const physical = await realpath(path);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      physical !== path
    ) {
      throw new ProofPatchStateError(
        "ProofPatch state area is not a private transaction directory.",
      );
    }
    return physical;
  }

  private async append(
    directory: string,
    journal: ProofPatchJournal,
  ): Promise<void> {
    this.assertTransactionDirectory(directory, journal.transactionId);
    await this.verifyTransactionDirectory(directory, journal.transactionId);
    const path = resolve(directory, "journal.jsonl");
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.nlink > 1) {
        throw new ProofPatchStateError(
          `ProofPatch journal is not a private regular file: ${journal.transactionId}`,
        );
      }
      await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readFromDirectory(
    directory: string,
    transactionId: string,
  ): Promise<ProofPatchJournal> {
    this.assertTransactionDirectory(directory, transactionId);
    await this.verifyTransactionDirectory(directory, transactionId);

    const path = resolve(directory, "journal.jsonl");
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let raw: string;
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.nlink > 1) {
        throw new ProofPatchStateError(
          `ProofPatch journal is not a private regular file: ${transactionId}`,
        );
      }
      const physical = await realpath(path);
      if (!within(directory, physical)) {
        throw new ProofPatchStateError(
          `ProofPatch journal escaped its transaction: ${transactionId}`,
        );
      }
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = raw.split("\n");
    if (!raw.endsWith("\n")) lines.pop();
    const complete = lines.filter((line) => line.trim());
    if (complete.length === 0) {
      throw new ProofPatchStateError(
        `ProofPatch transaction journal is empty: ${transactionId}`,
      );
    }

    let latest: ProofPatchJournal | undefined;
    let previousSequence = -1;
    for (const line of complete) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new ProofPatchStateError(
          `ProofPatch transaction journal is corrupt: ${transactionId}`,
          { cause: error },
        );
      }
      const journal = assertJournal(parsed, transactionId);
      if (journal.sequence <= previousSequence) {
        throw new ProofPatchStateError(
          `ProofPatch journal sequence is not monotonic: ${transactionId}`,
        );
      }
      previousSequence = journal.sequence;
      latest = journal;
    }
    return latest!;
  }

  private async verifyTransactionDirectory(
    directory: string,
    transactionId: string,
  ): Promise<void> {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new ProofPatchStateError(
        `ProofPatch transaction directory is unsafe: ${transactionId}`,
      );
    }
    const physical = await realpath(directory);
    if (physical !== directory || !within(this.transactionsRoot, physical)) {
      throw new ProofPatchStateError(
        `ProofPatch transaction directory escaped its state root: ${transactionId}`,
      );
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is unsupported on Windows and some filesystems.
    }
  }
}
