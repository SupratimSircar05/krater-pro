import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ProofPatchConflictError,
  ProofPatchStore,
  type ProofPatchPreview,
  type ProofPatchPublishResult,
} from "./proofpatch/index.js";
import {
  canonicalStringify,
  isSha256Digest,
  sha256Digest,
} from "./proofgraph/index.js";

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  ".krater",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const COPY_EXCLUDES = new Set([
  ".git",
  ".krater",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const MAX_SNAPSHOT_FILES = 100_000;

interface FileEntry {
  path: string;
  digest: `sha256:${string}`;
  size: number;
  mode: number;
}

export interface PreparedProofPatch {
  taskId: string;
  transactionId: string;
  baseWorkspaceDigest: string;
  finalWorkspaceDigest: string;
  changedPaths: string[];
  unsupportedPaths: string[];
  preview: ProofPatchPreview;
}

export interface ProofPatchBinding extends PreparedProofPatch {
  schemaVersion: 1;
  workspaceRoot: string;
  createdAt: string;
  status: "staged" | "published" | "rolled_back";
  publishedAt?: string;
  rolledBackAt?: string;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safeTaskId(taskId: string): string {
  const value = taskId.trim();
  if (
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      "Task ID must be 1-256 characters and contain no control characters.",
    );
  }
  return value;
}

function safeStageId(id: string): string {
  const value = id.trim();
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(
      "Staging ID must be a non-empty portable path segment.",
    );
  }
  return value;
}

function bindingName(taskId: string): string {
  return `${createHash("sha256").update(safeTaskId(taskId)).digest("hex")}.json`;
}

function protectedSecretPath(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (
    name === ".env" ||
    (name.startsWith(".env.") &&
      ![".env.example", ".env.sample", ".env.template"].includes(name))
  ) {
    return true;
  }
  if (
    [
      ".npmrc",
      ".pypirc",
      ".netrc",
      "credentials",
      "credentials.json",
      "id_rsa",
      "id_ed25519",
    ].includes(name)
  ) {
    return true;
  }
  return /\.(?:pem|p12|pfx|key)$/i.test(name);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function fileManifest(root: string): Promise<Map<string, FileEntry>> {
  const manifest = new Map<string, FileEntry>();
  const directories = [root];
  let visited = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      visited += 1;
      if (visited > MAX_SNAPSHOT_FILES) {
        throw new Error(
          `Workspace snapshot exceeds the ${MAX_SNAPSHOT_FILES}-entry safety limit.`,
        );
      }
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      const top = relativePath.split("/")[0]!;
      if (SNAPSHOT_EXCLUDES.has(top) || protectedSecretPath(relativePath)) {
        continue;
      }
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      if (!details.isFile()) continue;
      manifest.set(relativePath, {
        path: relativePath,
        digest: await sha256File(absolute),
        size: details.size,
        mode: details.mode & 0o777,
      });
    }
  }
  return manifest;
}

async function copyWorkspaceSnapshot(
  baseRoot: string,
  stageRoot: string,
): Promise<void> {
  await mkdir(stageRoot, { mode: 0o700 });
  const handle = await opendir(baseRoot);
  for await (const entry of handle) {
    if (
      COPY_EXCLUDES.has(entry.name) ||
      protectedSecretPath(entry.name)
    ) {
      continue;
    }
    const source = join(baseRoot, entry.name);
    const destination = join(stageRoot, entry.name);
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: (candidate) => {
        const relativePath = relative(baseRoot, candidate)
          .split(sep)
          .join("/");
        const top = relativePath.split("/")[0];
        return (
          !COPY_EXCLUDES.has(top) &&
          !protectedSecretPath(relativePath)
        );
      },
    });
  }
}

function workspaceDigest(manifest: ReadonlyMap<string, FileEntry>): string {
  return sha256Digest(
    canonicalStringify(
      [...manifest.values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => ({
          path: entry.path,
          digest: entry.digest,
          size: entry.size,
          mode: entry.mode,
        })),
    ),
  );
}

async function ensurePrivateStateRoot(workspaceRoot: string): Promise<string> {
  const state = join(workspaceRoot, ".krater");
  try {
    const details = await lstat(state);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Krater state path is unsafe: ${state}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(state, { mode: 0o700 });
  }
  const physical = await realpath(state);
  if (!within(workspaceRoot, physical)) {
    throw new Error("Krater state directory escaped the selected workspace.");
  }
  return physical;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalStringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function verifiedBindingDirectory(
  workspaceRoot: string,
  create: boolean,
): Promise<string> {
  const state = create
    ? await ensurePrivateStateRoot(workspaceRoot)
    : await realpath(join(workspaceRoot, ".krater"));
  let current = state;
  for (const segment of ["proofpatch", "bindings"]) {
    current = join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`ProofPatch state directory is unsafe: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`ProofPatch state directory is unsafe: ${current}`);
      }
    }
    const physical = await realpath(current);
    if (physical !== current || !within(state, physical)) {
      throw new Error("ProofPatch binding directory escaped private state.");
    }
  }
  return current;
}

function parseBinding(
  value: unknown,
  taskId: string,
  workspaceRoot: string,
): ProofPatchBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ProofPatch binding is malformed.");
  }
  const binding = value as Partial<ProofPatchBinding>;
  if (
    binding.schemaVersion !== 1 ||
    binding.taskId !== taskId ||
    typeof binding.transactionId !== "string" ||
    binding.workspaceRoot !== workspaceRoot ||
    !isSha256Digest(binding.baseWorkspaceDigest ?? "") ||
    !isSha256Digest(binding.finalWorkspaceDigest ?? "") ||
    !Array.isArray(binding.changedPaths) ||
    !Array.isArray(binding.unsupportedPaths) ||
    !binding.changedPaths.every((path) => typeof path === "string") ||
    !binding.unsupportedPaths.every((path) => typeof path === "string") ||
    !binding.preview ||
    binding.preview.transactionId !== binding.transactionId ||
    binding.preview.workspaceRoot !== workspaceRoot ||
    !["staged", "published", "rolled_back"].includes(binding.status ?? "")
  ) {
    throw new Error("ProofPatch binding is malformed or belongs to another task.");
  }
  return binding as ProofPatchBinding;
}

export async function loadProofPatchBinding(
  workspaceRoot: string,
  taskId: string,
): Promise<ProofPatchBinding> {
  const root = await realpath(resolve(workspaceRoot));
  const directory = await verifiedBindingDirectory(root, false);
  const path = join(directory, bindingName(safeTaskId(taskId)));
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink > 1) {
      throw new Error("ProofPatch binding is not a private regular file.");
    }
    return parseBinding(
      JSON.parse(await handle.readFile("utf8")),
      taskId,
      root,
    );
  } finally {
    await handle.close();
  }
}

async function saveBinding(binding: ProofPatchBinding): Promise<void> {
  const directory = await verifiedBindingDirectory(
    binding.workspaceRoot,
    true,
  );
  await atomicJson(
    join(directory, bindingName(binding.taskId)),
    binding,
  );
}

export class StagedTaskWorkspace {
  readonly baseRoot: string;
  readonly stageRoot: string;
  readonly readOnlyDependencyRoots: string[];
  readonly initialWorkspaceDigest: string;

  private prepared = false;
  private discarded = false;
  private readonly baseManifest: Map<string, FileEntry>;

  private constructor(options: {
    baseRoot: string;
    stageRoot: string;
    readOnlyDependencyRoots: string[];
    baseManifest: Map<string, FileEntry>;
  }) {
    this.baseRoot = options.baseRoot;
    this.stageRoot = options.stageRoot;
    this.readOnlyDependencyRoots = options.readOnlyDependencyRoots;
    this.baseManifest = options.baseManifest;
    this.initialWorkspaceDigest = workspaceDigest(options.baseManifest);
  }

  static async create(
    workspaceRoot: string,
    id = randomUUID(),
  ): Promise<StagedTaskWorkspace> {
    const baseRoot = await realpath(resolve(workspaceRoot));
    const state = await ensurePrivateStateRoot(baseRoot);
    const stagingParent = join(state, "staging", safeStageId(id));
    const stageRoot = join(stagingParent, "workspace");
    await mkdir(stagingParent, { recursive: true, mode: 0o700 });
    const baseManifest = await fileManifest(baseRoot);
    try {
      await copyWorkspaceSnapshot(baseRoot, stageRoot);
    } catch (error) {
      await rm(stagingParent, { recursive: true, force: true });
      throw error;
    }
    const dependencyRoots = ["node_modules", ".venv", "venv"]
      .map((name) => join(baseRoot, name))
      .filter((path) => existsSync(path));
    return new StagedTaskWorkspace({
      baseRoot,
      stageRoot: await realpath(stageRoot),
      readOnlyDependencyRoots: dependencyRoots,
      baseManifest,
    });
  }

  async prepareProofPatch(taskId: string): Promise<PreparedProofPatch> {
    if (this.discarded) throw new Error("Staged workspace was already discarded.");
    if (this.prepared) throw new Error("Staged workspace was already prepared.");
    const finalManifest = await fileManifest(this.stageRoot);
    const baseWorkspaceDigest = this.initialWorkspaceDigest;
    const finalWorkspaceDigest = workspaceDigest(finalManifest);
    const removed = [...this.baseManifest.values()].filter(
      (entry) => !finalManifest.has(entry.path),
    );
    const created = [...finalManifest.values()].filter(
      (entry) => !this.baseManifest.has(entry.path),
    );
    const edited = [...finalManifest.values()].filter((entry) => {
      const before = this.baseManifest.get(entry.path);
      return (
        before !== undefined &&
        (before.digest !== entry.digest || before.mode !== entry.mode)
      );
    });
    const unsupportedPaths: string[] = [];
    const store = await ProofPatchStore.open({
      workspaceRoot: this.baseRoot,
      stateRoot: join(this.baseRoot, ".krater", "proofpatch"),
    });
    const transaction = await store.beginTransaction();

    const unmatchedCreated = new Set(created.map((entry) => entry.path));
    const unmatchedRemoved = new Set(removed.map((entry) => entry.path));
    for (const source of removed) {
      const candidates = created.filter(
        (destination) =>
          unmatchedCreated.has(destination.path) &&
          destination.digest === source.digest &&
          destination.mode === source.mode,
      );
      if (candidates.length !== 1) continue;
      const destination = candidates[0]!;
      if (!existsSync(dirname(join(this.baseRoot, destination.path)))) {
        unsupportedPaths.push(destination.path);
        continue;
      }
      await transaction.stageMove(source.path, destination.path);
      unmatchedRemoved.delete(source.path);
      unmatchedCreated.delete(destination.path);
    }

    for (const entry of removed) {
      if (unmatchedRemoved.has(entry.path)) {
        await transaction.stageDelete(entry.path);
      }
    }
    for (const entry of created) {
      if (!unmatchedCreated.has(entry.path)) continue;
      const parent = dirname(join(this.baseRoot, entry.path));
      if (!existsSync(parent)) {
        unsupportedPaths.push(entry.path);
        continue;
      }
      await transaction.stageCreate(
        entry.path,
        await readFile(join(this.stageRoot, entry.path)),
        { mode: entry.mode },
      );
    }
    for (const entry of edited) {
      await transaction.stageEdit(
        entry.path,
        await readFile(join(this.stageRoot, entry.path)),
        { mode: entry.mode },
      );
    }

    const preview = transaction.preview();
    const changedPaths = preview.operations
      .flatMap((operation) =>
        operation.kind === "move"
          ? [operation.from, operation.to]
          : [operation.path],
      )
      .sort();
    const binding: ProofPatchBinding = {
      schemaVersion: 1,
      taskId: safeTaskId(taskId),
      transactionId: transaction.id,
      workspaceRoot: this.baseRoot,
      baseWorkspaceDigest,
      finalWorkspaceDigest,
      changedPaths,
      unsupportedPaths: [...new Set(unsupportedPaths)].sort(),
      preview,
      createdAt: new Date().toISOString(),
      status: "staged",
    };
    await saveBinding(binding);
    this.prepared = true;
    await this.removeStage();
    return binding;
  }

  async discard(): Promise<void> {
    if (this.discarded || this.prepared) return;
    this.discarded = true;
    await this.removeStage();
  }

  private async removeStage(): Promise<void> {
    const parent = dirname(this.stageRoot);
    const stateStaging = join(this.baseRoot, ".krater", "staging");
    if (!within(stateStaging, parent)) {
      throw new Error("Refusing to remove an invalid staging path.");
    }
    await rm(parent, { recursive: true, force: true });
  }
}

export async function publishBoundProofPatch(
  workspaceRoot: string,
  taskId: string,
): Promise<{
  binding: ProofPatchBinding;
  result: ProofPatchPublishResult;
}> {
  const binding = await loadProofPatchBinding(workspaceRoot, taskId);
  if (binding.status !== "staged") {
    throw new Error(
      `ProofPatch transaction is ${binding.status}, not staged.`,
    );
  }
  if (binding.unsupportedPaths.length) {
    throw new Error(
      `ProofPatch cannot publish paths whose parent directories do not exist: ${binding.unsupportedPaths.join(", ")}`,
    );
  }
  const store = await ProofPatchStore.open({
    workspaceRoot: binding.workspaceRoot,
    stateRoot: join(binding.workspaceRoot, ".krater", "proofpatch"),
  });
  const currentWorkspaceDigest = workspaceDigest(
    await fileManifest(binding.workspaceRoot),
  );
  if (currentWorkspaceDigest !== binding.baseWorkspaceDigest) {
    throw new ProofPatchConflictError(
      ".",
      "The workspace changed after staging; the complete base digest no longer matches.",
    );
  }
  const transaction = await store.openTransaction(binding.transactionId);
  const transactionPreview = transaction.preview();
  if (
    canonicalStringify(transactionPreview) !==
    canonicalStringify(binding.preview)
  ) {
    throw new Error(
      "ProofPatch binding does not match its durable transaction journal.",
    );
  }
  const result = await transaction.publish();
  const publishedWorkspaceDigest = workspaceDigest(
    await fileManifest(binding.workspaceRoot),
  );
  if (publishedWorkspaceDigest !== binding.finalWorkspaceDigest) {
    await transaction.rollback();
    throw new ProofPatchConflictError(
      ".",
      "Published workspace digest did not match the reviewed staged workspace; ProofPatch rolled the transaction back.",
    );
  }
  const updated: ProofPatchBinding = {
    ...binding,
    status: "published",
    publishedAt: result.publishedAt,
    preview: result,
  };
  await saveBinding(updated);
  return { binding: updated, result };
}

/**
 * Discard a transaction only while it is still staged. This deliberately
 * refuses published transactions; cancellation must never become an implicit
 * rollback of user-visible workspace changes.
 */
export async function discardStagedProofPatch(
  workspaceRoot: string,
  taskId: string,
): Promise<ProofPatchBinding> {
  const binding = await loadProofPatchBinding(workspaceRoot, taskId);
  if (binding.status === "rolled_back" && !binding.publishedAt) return binding;
  if (binding.status === "published" || binding.publishedAt) {
    throw new Error(
      `ProofPatch for task ${taskId} was published and cannot be discarded by cancellation. Roll it back explicitly first.`,
    );
  }
  if (binding.status !== "staged") {
    throw new Error(
      `ProofPatch transaction is ${binding.status}, not staged.`,
    );
  }
  const store = await ProofPatchStore.open({
    workspaceRoot: binding.workspaceRoot,
    stateRoot: join(binding.workspaceRoot, ".krater", "proofpatch"),
  });
  const transaction = await store.openTransaction(binding.transactionId);
  if (transaction.preview().status !== "staged") {
    throw new Error(
      "ProofPatch journal is no longer staged; cancellation refused.",
    );
  }
  await transaction.rollback();
  const updated: ProofPatchBinding = {
    ...binding,
    status: "rolled_back",
    rolledBackAt: new Date().toISOString(),
  };
  await saveBinding(updated);
  return updated;
}

export async function rollbackBoundProofPatch(
  workspaceRoot: string,
  taskId: string,
): Promise<ProofPatchBinding> {
  const binding = await loadProofPatchBinding(workspaceRoot, taskId);
  if (binding.status === "rolled_back") return binding;
  const store = await ProofPatchStore.open({
    workspaceRoot: binding.workspaceRoot,
    stateRoot: join(binding.workspaceRoot, ".krater", "proofpatch"),
  });
  const transaction = await store.openTransaction(binding.transactionId);
  await transaction.rollback();
  const updated: ProofPatchBinding = {
    ...binding,
    status: "rolled_back",
    rolledBackAt: new Date().toISOString(),
  };
  await saveBinding(updated);
  return updated;
}
