import type {
  AutopilotDigest,
  ExternalEffectPlan,
  ExternalEffectReceipt,
  ProofLease,
  ProofLeaseInvalidation,
  TaskPlan,
} from "../autopilot/index.js";

export const SHIPPING_SCHEMA_VERSION = 1 as const;

export type ShippingProvider = "github" | "cloudflare";

/**
 * A host-owned credential reference. Implementations resolve this handle in an
 * OS credential store; credential values never cross the shipping boundary.
 */
export interface ShippingCredentialHandle {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  provider: ShippingProvider;
  id: string;
  accountLabel?: string;
}

export interface GitHubPushEffect {
  kind: "github_push";
  owner: string;
  repository: string;
  branch: string;
  sourceCommitSha: string;
  sourceDigest: AutopilotDigest;
  /**
   * The exact head observed by the caller. Null means the branch must not
   * exist. Force pushes and branch deletion are intentionally unsupported.
   */
  expectedRemoteCommitSha: string | null;
}

export interface GitHubPullRequestEffect {
  kind: "github_pull_request";
  owner: string;
  repository: string;
  headOwner: string;
  headBranch: string;
  headCommitSha: string;
  baseBranch: string;
  baseCommitSha: string;
  sourceDigest: AutopilotDigest;
  title: string;
  body: string;
  draft: boolean;
  /**
   * Prevents accidental duplicate PR creation. Null means no open PR may
   * already exist for this exact head/base pair.
   */
  expectedExistingPullRequestDigest: AutopilotDigest | null;
}

export interface CloudflarePagesEffect {
  kind: "cloudflare_pages_deploy";
  accountId: string;
  projectName: string;
  environment: "production" | "preview";
  branch: string;
  artifactDigest: AutopilotDigest;
  expectedCurrentDeploymentDigest: AutopilotDigest | null;
}

export interface CloudflareWorkersEffect {
  kind: "cloudflare_workers_deploy";
  accountId: string;
  workerName: string;
  environment: string;
  artifactDigest: AutopilotDigest;
  expectedCurrentDeploymentDigest: AutopilotDigest | null;
}

export type ShippingEffect =
  | GitHubPushEffect
  | GitHubPullRequestEffect
  | CloudflarePagesEffect
  | CloudflareWorkersEffect;

export interface ShippingInspection {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  effectKind: ShippingEffect["kind"];
  targetLocatorDigest: AutopilotDigest;
  currentStateDigest: AutopilotDigest;
  evidenceIds: string[];
  canMutate: boolean;
  denialReason?: string;
  /**
   * Exact, kind-specific values used for optimistic concurrency checks.
   */
  remoteCommitSha?: string | null;
  existingPullRequestDigest?: AutopilotDigest | null;
  currentDeploymentDigest?: AutopilotDigest | null;
}

export interface ProviderMutationResult {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  status: "succeeded" | "partially_succeeded" | "failed";
  summary: string;
  targetStateDigest: AutopilotDigest;
  evidenceIds: string[];
  /**
   * An opaque receipt reference resolved and retained by the host. It is
   * digested before any durable evidence is produced.
   */
  providerReceiptHandle: string;
  /**
   * Optional opaque handle used by a typed compensation operation.
   */
  compensationHandle?: string;
}

export interface ProviderCompensationResult {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  status: "succeeded" | "partially_succeeded" | "failed";
  summary: string;
  targetStateDigest: AutopilotDigest;
  evidenceIds: string[];
  providerReceiptHandle: string;
}

export interface ShippingMutationRequest<T extends ShippingEffect = ShippingEffect> {
  effect: T;
  credentialHandle: ShippingCredentialHandle;
  /**
   * Host-held provider idempotency value. It is never persisted or included in
   * plans, receipts, errors, or exported evidence.
   */
  idempotencyKey: string;
}

export interface ShippingCompensationRequest<
  T extends ShippingEffect = ShippingEffect,
> extends ShippingMutationRequest<T> {
  originalEffectPlanDigest: AutopilotDigest;
  originalReceiptDigest: AutopilotDigest;
  compensationHandle: string;
  reason: string;
}

/**
 * A deliberately narrow executor contract. There is no `run`, `shell`, URL,
 * method, or arbitrary API payload escape hatch.
 */
export interface StructuredShippingExecutor {
  inspectGitHubPush?(
    effect: GitHubPushEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection>;
  pushGitHub?(
    request: ShippingMutationRequest<GitHubPushEffect>,
  ): Promise<ProviderMutationResult>;
  compensateGitHubPush?(
    request: ShippingCompensationRequest<GitHubPushEffect>,
  ): Promise<ProviderCompensationResult>;

  inspectGitHubPullRequest?(
    effect: GitHubPullRequestEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection>;
  createGitHubPullRequest?(
    request: ShippingMutationRequest<GitHubPullRequestEffect>,
  ): Promise<ProviderMutationResult>;
  compensateGitHubPullRequest?(
    request: ShippingCompensationRequest<GitHubPullRequestEffect>,
  ): Promise<ProviderCompensationResult>;

  inspectCloudflarePages?(
    effect: CloudflarePagesEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection>;
  deployCloudflarePages?(
    request: ShippingMutationRequest<CloudflarePagesEffect>,
  ): Promise<ProviderMutationResult>;
  compensateCloudflarePages?(
    request: ShippingCompensationRequest<CloudflarePagesEffect>,
  ): Promise<ProviderCompensationResult>;

  inspectCloudflareWorkers?(
    effect: CloudflareWorkersEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection>;
  deployCloudflareWorkers?(
    request: ShippingMutationRequest<CloudflareWorkersEffect>,
  ): Promise<ProviderMutationResult>;
  compensateCloudflareWorkers?(
    request: ShippingCompensationRequest<CloudflareWorkersEffect>,
  ): Promise<ProviderCompensationResult>;
}

export interface ShippingConfirmationChallenge {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  id: string;
  operation: "execute" | "compensate";
  effectPlanDigest: AutopilotDigest;
  operationDigest: AutopilotDigest;
  credentialBindingDigest: AutopilotDigest;
  summary: string;
  createdAt: string;
  expiresAt: string;
  digest: AutopilotDigest;
}

export interface ShippingConfirmation {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  challengeDigest: AutopilotDigest;
  decision: "confirmed";
  confirmedBy: "user";
  confirmedAt: string;
}

export interface VerifyShippingAuthorizationInput {
  preflight: ShippingPreflight;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  confirmation: ShippingConfirmation;
}

/**
 * Safe, durable proof that a user confirmed the exact preflight. This record
 * contains only digests and never authorizes a different effect, credential
 * binding, or idempotency value.
 */
export interface ShippingAuthorization {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  effectPlanDigest: AutopilotDigest;
  operationDigest: AutopilotDigest;
  challengeDigest: AutopilotDigest;
  credentialBindingDigest: AutopilotDigest;
  idempotencyKeyDigest: AutopilotDigest;
  approvalReceiptDigest: AutopilotDigest;
  confirmedAt: string;
  digest: AutopilotDigest;
}

export interface ShippingPreflight {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  taskPlan: TaskPlan;
  effect: ShippingEffect;
  effectDigest: AutopilotDigest;
  effectPlan: ExternalEffectPlan;
  inspection: ShippingInspection;
  inspectionDigest: AutopilotDigest;
  credentialBindingDigest: AutopilotDigest;
  challenge: ShippingConfirmationChallenge;
  digest: AutopilotDigest;
}

export interface ShippingLeaseContext {
  environmentDigest: AutopilotDigest;
  policyDigest: AutopilotDigest;
  toolchainDigest: AutopilotDigest;
  issuedBy: ProofLease["issuedBy"];
  ttlMs: number;
}

export interface PrepareShippingInput {
  taskPlan: TaskPlan;
  stepId: string;
  effect: ShippingEffect;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  expiresInMs?: number;
}

export interface ExecuteShippingInput {
  preflight: ShippingPreflight;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  confirmation: ShippingConfirmation;
  lease: ShippingLeaseContext;
}

export interface ShippingExecutionResult {
  receipt: ExternalEffectReceipt;
  proofLease?: ProofLease;
  compensationAvailable: boolean;
}

export interface CompensationPreflight {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  originalPreflightDigest: AutopilotDigest;
  originalReceipt: ExternalEffectReceipt;
  originalReceiptDigest: AutopilotDigest;
  credentialBindingDigest: AutopilotDigest;
  reason: string;
  challenge: ShippingConfirmationChallenge;
  digest: AutopilotDigest;
}

export interface PrepareCompensationInput {
  preflight: ShippingPreflight;
  receipt: ExternalEffectReceipt;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  reason: string;
  expiresInMs?: number;
}

export interface ExecuteCompensationInput {
  originalPreflight: ShippingPreflight;
  compensation: CompensationPreflight;
  credentialHandle: ShippingCredentialHandle;
  idempotencyKey: string;
  confirmation: ShippingConfirmation;
  proofLease?: ProofLease;
}

export interface ShippingCompensationResult {
  receipt: ExternalEffectReceipt;
  proofLeaseInvalidation?: ProofLeaseInvalidation;
}

export type ShippingAttemptState = "reserved" | "completed";

export interface ShippingAttemptClaim {
  schemaVersion: typeof SHIPPING_SCHEMA_VERSION;
  idempotencyKeyDigest: AutopilotDigest;
  operationDigest: AutopilotDigest;
  effectPlanDigest: AutopilotDigest;
  confirmationDigest: AutopilotDigest;
  operation: "execute" | "compensate";
  state: ShippingAttemptState;
  reservedAt: string;
  completedAt?: string;
  receiptDigest?: AutopilotDigest;
}

export interface ShippingAttemptLedger {
  readonly durability: "memory" | "persistent";
  reserve(claim: ShippingAttemptClaim): Promise<void>;
  complete(
    idempotencyKeyDigest: AutopilotDigest,
    operationDigest: AutopilotDigest,
    receiptDigest: AutopilotDigest,
    completedAt: string,
  ): Promise<void>;
}

export interface ShippingRuntimeVault {
  readonly durability: "memory" | "persistent";
  putCompensationHandle(
    effectPlanDigest: AutopilotDigest,
    receiptDigest: AutopilotDigest,
    handle: string,
  ): Promise<void>;
  getCompensationHandle(
    effectPlanDigest: AutopilotDigest,
    receiptDigest: AutopilotDigest,
  ): Promise<string | undefined>;
}

export interface StructuredShippingServiceOptions {
  executor: StructuredShippingExecutor;
  ledger: ShippingAttemptLedger;
  vault: ShippingRuntimeVault;
  allowVolatileState?: boolean;
  now?: () => Date;
  createId?: () => string;
}

export interface LeaseDriftInput {
  lease: ProofLease;
  currentPlanDigest: AutopilotDigest;
  currentSubjectDigest: AutopilotDigest;
  currentEnvironmentDigest: AutopilotDigest;
  currentPolicyDigest: AutopilotDigest;
  currentToolchainDigest: AutopilotDigest;
  observedAt?: string;
  details?: string;
}
