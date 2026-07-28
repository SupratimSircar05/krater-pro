export type ProofPatchDigest = `sha256:${string}`;

export type ProofPatchStatus =
  | "staged"
  | "prepared"
  | "publishing"
  | "published"
  | "rolling_back"
  | "rolled_back"
  | "recovery_failed";

export interface MissingFileSnapshot {
  exists: false;
  digest: null;
  size: 0;
  mode: null;
}

export interface ExistingFileSnapshot {
  exists: true;
  digest: ProofPatchDigest;
  size: number;
  mode: number;
}

export type FileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

export interface CreateOperationPreview {
  kind: "create";
  path: string;
  before: MissingFileSnapshot;
  after: ExistingFileSnapshot;
}

export interface EditOperationPreview {
  kind: "edit";
  path: string;
  before: ExistingFileSnapshot;
  after: ExistingFileSnapshot;
}

export interface DeleteOperationPreview {
  kind: "delete";
  path: string;
  before: ExistingFileSnapshot;
  after: MissingFileSnapshot;
}

export interface MoveOperationPreview {
  kind: "move";
  from: string;
  to: string;
  beforeSource: ExistingFileSnapshot;
  beforeDestination: MissingFileSnapshot;
  afterSource: MissingFileSnapshot;
  afterDestination: ExistingFileSnapshot;
}

export type ProofPatchOperationPreview =
  | CreateOperationPreview
  | EditOperationPreview
  | DeleteOperationPreview
  | MoveOperationPreview;

export interface ProofPatchPreview {
  transactionId: string;
  backend: string;
  workspaceRoot: string;
  status: ProofPatchStatus;
  operations: ProofPatchOperationPreview[];
}

export interface ProofPatchPublishResult extends ProofPatchPreview {
  publishedAt: string;
}

export type ProofPatchFailurePoint =
  | "after-preparation"
  | "before-change"
  | "after-change"
  | "before-rollback"
  | "after-rollback-change";

export interface ProofPatchFailureContext {
  point: ProofPatchFailurePoint;
  transactionId: string;
  path?: string;
  changeIndex?: number;
}

export type ProofPatchFailureInjector = (
  context: ProofPatchFailureContext,
) => void | Promise<void>;

export interface ProofPatchStoreOptions {
  workspaceRoot?: string;
  stateRoot: string;
  backend?: ProofPatchWorkspaceBackend;
  failureInjector?: ProofPatchFailureInjector;
}

export interface StageFileOptions {
  mode?: number;
}

export interface RecoveryResult {
  transactionId: string;
  recovered: boolean;
  previousStatus: ProofPatchStatus;
  status: ProofPatchStatus;
  error?: string;
}

/**
 * The filesystem boundary used by ProofPatch. A future Git-worktree backend can
 * implement this interface without changing transaction or journal semantics.
 */
export interface ProofPatchWorkspaceBackend {
  readonly kind: string;
  readonly workspaceRoot: string;
  normalizePath(input: string): string;
  inspect(path: string): Promise<FileSnapshot>;
  readFile(path: string, expected: ExistingFileSnapshot): Promise<Buffer>;
  writeFile(
    path: string,
    content: Buffer,
    expected: FileSnapshot,
    mode: number,
  ): Promise<void>;
  removeFile(path: string, expected: ExistingFileSnapshot): Promise<void>;
}
