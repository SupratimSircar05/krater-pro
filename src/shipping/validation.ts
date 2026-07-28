import {
  autopilotRecordDigest,
  verifyTaskPlan,
  type AutopilotDigest,
  type ExternalEffectRecovery,
  type TaskPlan,
} from "../autopilot/index.js";
import { isSha256Digest, redactText } from "../proofgraph/index.js";
import { ShippingValidationError } from "./errors.js";
import type {
  CloudflarePagesEffect,
  CloudflareWorkersEffect,
  GitHubPullRequestEffect,
  GitHubPushEffect,
  ProviderCompensationResult,
  ProviderMutationResult,
  ShippingCredentialHandle,
  ShippingEffect,
  ShippingInspection,
  ShippingProvider,
} from "./types.js";
import { SHIPPING_SCHEMA_VERSION } from "./types.js";

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CLOUDFLARE_ACCOUNT = /^[a-f0-9]{32}$/;
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HANDLE_ID =
  /^credential:(?:github|cloudflare):[a-z0-9][a-z0-9._/-]{2,96}$/;
const OPAQUE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/;
const SECRET_LIKE =
  /(?:\b(?:bearer|basic)\s+|-----BEGIN|(?:ghp|gho|ghu|ghs|ghr)_|(?:sk|kr|rk)[_-][A-Za-z0-9_-]{12,})/i;

function fail(message: string): never {
  throw new ShippingValidationError(message);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value))) {
    fail(`${field} is missing a required field.`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${field} contains an unsupported field.`);
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  maxLength = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function safeText(value: unknown, field: string, maxLength: number): string {
  const text = nonEmptyString(value, field, maxLength);
  if (SECRET_LIKE.test(text) || redactText(text) !== text) {
    fail(`${field} must not contain credentials or secret-like values.`);
  }
  return text;
}

function digest(value: unknown, field: string): AutopilotDigest {
  if (typeof value !== "string" || !isSha256Digest(value)) {
    fail(`${field} must be a SHA-256 digest.`);
  }
  return value as AutopilotDigest;
}

function nullableDigest(value: unknown, field: string): AutopilotDigest | null {
  return value === null ? null : digest(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be boolean.`);
  return value;
}

function githubName(value: unknown, field: string): string {
  const name = safeText(value, field, 100);
  if (!GITHUB_NAME.test(name) || name.includes("..")) {
    fail(`${field} is not a supported GitHub name.`);
  }
  return name;
}

function gitSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    fail(`${field} must be a full lowercase Git object ID.`);
  }
  return value;
}

function gitBranch(value: unknown, field: string): string {
  const branch = safeText(value, field, 240);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch === "HEAD" ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.split("/").some((part) => part.length === 0 || part.endsWith(".lock"))
  ) {
    fail(`${field} is not a supported exact branch name.`);
  }
  return branch;
}

function cloudflareName(value: unknown, field: string): string {
  const name = safeText(value, field, 63);
  if (!CLOUDFLARE_NAME.test(name)) {
    fail(`${field} is not a supported Cloudflare resource name.`);
  }
  return name;
}

function accountId(value: unknown): string {
  if (typeof value !== "string" || !CLOUDFLARE_ACCOUNT.test(value)) {
    fail("Cloudflare account ID must be 32 lowercase hexadecimal characters.");
  }
  return value;
}

function validateGitHubPush(value: Record<string, unknown>): GitHubPushEffect {
  exactKeys(
    value,
    [
      "kind",
      "owner",
      "repository",
      "branch",
      "sourceCommitSha",
      "sourceDigest",
      "expectedRemoteCommitSha",
    ],
    [],
    "GitHub push effect",
  );
  const expected = value.expectedRemoteCommitSha;
  if (expected !== null && (typeof expected !== "string" || !GIT_SHA.test(expected))) {
    fail("Expected GitHub remote commit must be null or a full object ID.");
  }
  return {
    kind: "github_push",
    owner: githubName(value.owner, "GitHub owner"),
    repository: githubName(value.repository, "GitHub repository"),
    branch: gitBranch(value.branch, "GitHub branch"),
    sourceCommitSha: gitSha(value.sourceCommitSha, "GitHub source commit"),
    sourceDigest: digest(value.sourceDigest, "GitHub source digest"),
    expectedRemoteCommitSha: expected as string | null,
  };
}

function validateGitHubPullRequest(
  value: Record<string, unknown>,
): GitHubPullRequestEffect {
  exactKeys(
    value,
    [
      "kind",
      "owner",
      "repository",
      "headOwner",
      "headBranch",
      "headCommitSha",
      "baseBranch",
      "baseCommitSha",
      "sourceDigest",
      "title",
      "body",
      "draft",
      "expectedExistingPullRequestDigest",
    ],
    [],
    "GitHub pull request effect",
  );
  const title = safeText(value.title, "Pull request title", 256);
  if (typeof value.body !== "string" || value.body.length > 65_536) {
    fail("Pull request body must be a bounded string.");
  }
  if (SECRET_LIKE.test(value.body) || redactText(value.body) !== value.body) {
    fail("Pull request body must not contain credentials or secret-like values.");
  }
  return {
    kind: "github_pull_request",
    owner: githubName(value.owner, "GitHub owner"),
    repository: githubName(value.repository, "GitHub repository"),
    headOwner: githubName(value.headOwner, "GitHub head owner"),
    headBranch: gitBranch(value.headBranch, "GitHub head branch"),
    headCommitSha: gitSha(value.headCommitSha, "GitHub head commit"),
    baseBranch: gitBranch(value.baseBranch, "GitHub base branch"),
    baseCommitSha: gitSha(value.baseCommitSha, "GitHub base commit"),
    sourceDigest: digest(value.sourceDigest, "GitHub source digest"),
    title,
    body: value.body,
    draft: booleanValue(value.draft, "Pull request draft"),
    expectedExistingPullRequestDigest: nullableDigest(
      value.expectedExistingPullRequestDigest,
      "Expected pull request digest",
    ),
  };
}

function validateCloudflarePages(
  value: Record<string, unknown>,
): CloudflarePagesEffect {
  exactKeys(
    value,
    [
      "kind",
      "accountId",
      "projectName",
      "environment",
      "branch",
      "artifactDigest",
      "expectedCurrentDeploymentDigest",
    ],
    [],
    "Cloudflare Pages effect",
  );
  if (!["production", "preview"].includes(String(value.environment))) {
    fail("Cloudflare Pages environment must be production or preview.");
  }
  return {
    kind: "cloudflare_pages_deploy",
    accountId: accountId(value.accountId),
    projectName: cloudflareName(value.projectName, "Cloudflare Pages project"),
    environment: value.environment as "production" | "preview",
    branch: gitBranch(value.branch, "Cloudflare Pages branch"),
    artifactDigest: digest(value.artifactDigest, "Cloudflare Pages artifact"),
    expectedCurrentDeploymentDigest: nullableDigest(
      value.expectedCurrentDeploymentDigest,
      "Expected Cloudflare Pages deployment",
    ),
  };
}

function validateCloudflareWorkers(
  value: Record<string, unknown>,
): CloudflareWorkersEffect {
  exactKeys(
    value,
    [
      "kind",
      "accountId",
      "workerName",
      "environment",
      "artifactDigest",
      "expectedCurrentDeploymentDigest",
    ],
    [],
    "Cloudflare Workers effect",
  );
  return {
    kind: "cloudflare_workers_deploy",
    accountId: accountId(value.accountId),
    workerName: cloudflareName(value.workerName, "Cloudflare Worker"),
    environment: cloudflareName(value.environment, "Cloudflare environment"),
    artifactDigest: digest(value.artifactDigest, "Cloudflare Worker artifact"),
    expectedCurrentDeploymentDigest: nullableDigest(
      value.expectedCurrentDeploymentDigest,
      "Expected Cloudflare Worker deployment",
    ),
  };
}

export function validateShippingEffect(value: unknown): ShippingEffect {
  const object = plainObject(value, "Shipping effect");
  switch (object.kind) {
    case "github_push":
      return validateGitHubPush(object);
    case "github_pull_request":
      return validateGitHubPullRequest(object);
    case "cloudflare_pages_deploy":
      return validateCloudflarePages(object);
    case "cloudflare_workers_deploy":
      return validateCloudflareWorkers(object);
    default:
      fail("Shipping effect kind is unsupported.");
  }
}

export function effectProvider(effect: ShippingEffect): ShippingProvider {
  return effect.kind.startsWith("github_") ? "github" : "cloudflare";
}

export function validateCredentialHandle(
  value: unknown,
  expectedProvider?: ShippingProvider,
): ShippingCredentialHandle {
  const object = plainObject(value, "Credential handle");
  exactKeys(
    object,
    ["schemaVersion", "provider", "id"],
    ["accountLabel"],
    "Credential handle",
  );
  if (object.schemaVersion !== SHIPPING_SCHEMA_VERSION) {
    fail("Credential handle schema version is unsupported.");
  }
  if (!["github", "cloudflare"].includes(String(object.provider))) {
    fail("Credential handle provider is unsupported.");
  }
  if (expectedProvider && object.provider !== expectedProvider) {
    fail("Credential handle provider does not match the shipping effect.");
  }
  if (
    typeof object.id !== "string" ||
    !HANDLE_ID.test(object.id) ||
    !object.id.startsWith(`credential:${String(object.provider)}:`) ||
    SECRET_LIKE.test(object.id)
  ) {
    fail("Credential handle ID is invalid or resembles a credential value.");
  }
  const accountLabel =
    object.accountLabel === undefined
      ? undefined
      : safeText(object.accountLabel, "Credential account label", 128);
  return {
    schemaVersion: SHIPPING_SCHEMA_VERSION,
    provider: object.provider as ShippingProvider,
    id: object.id,
    ...(accountLabel ? { accountLabel } : {}),
  };
}

export function validateIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    /\s/.test(value)
  ) {
    fail("A bounded host-side idempotency value is required.");
  }
  return value;
}

export function credentialBindingDigest(
  value: ShippingCredentialHandle,
): AutopilotDigest {
  return autopilotRecordDigest({
    schemaVersion: value.schemaVersion,
    provider: value.provider,
    id: value.id,
  });
}

export function targetLocatorDigest(effect: ShippingEffect): AutopilotDigest {
  switch (effect.kind) {
    case "github_push":
      return autopilotRecordDigest({
        provider: "github",
        owner: effect.owner,
        repository: effect.repository,
        branch: effect.branch,
      });
    case "github_pull_request":
      return autopilotRecordDigest({
        provider: "github",
        owner: effect.owner,
        repository: effect.repository,
        headOwner: effect.headOwner,
        headBranch: effect.headBranch,
        baseBranch: effect.baseBranch,
      });
    case "cloudflare_pages_deploy":
      return autopilotRecordDigest({
        provider: "cloudflare",
        accountId: effect.accountId,
        resource: "pages",
        projectName: effect.projectName,
        environment: effect.environment,
        branch: effect.branch,
      });
    case "cloudflare_workers_deploy":
      return autopilotRecordDigest({
        provider: "cloudflare",
        accountId: effect.accountId,
        resource: "workers",
        workerName: effect.workerName,
        environment: effect.environment,
      });
  }
}

export function effectSubjectDigest(effect: ShippingEffect): AutopilotDigest {
  return effect.kind === "github_push" ||
    effect.kind === "github_pull_request"
    ? effect.sourceDigest
    : effect.artifactDigest;
}

export function effectCapability(effect: ShippingEffect): string {
  switch (effect.kind) {
    case "github_push":
      return "github.push";
    case "github_pull_request":
      return "github.pull_request.create";
    case "cloudflare_pages_deploy":
      return "cloudflare.pages.deploy";
    case "cloudflare_workers_deploy":
      return "cloudflare.workers.deploy";
  }
}

export function effectRecovery(
  effect: ShippingEffect,
): ExternalEffectRecovery {
  return {
    mode: "compensating",
    description:
      effect.kind === "github_pull_request"
        ? "Close the exact created pull request if its state still matches the provider receipt."
        : effect.kind === "github_push"
          ? "Apply a structured compensating Git operation only if the remote head still matches the pushed result."
          : "Restore the provider's prior deployment only if the active deployment still matches the receipt.",
    requiredCapability: `${effectCapability(effect)}.compensate`,
  };
}

export function effectSummary(effect: ShippingEffect): string {
  switch (effect.kind) {
    case "github_push":
      return `Push ${effect.sourceCommitSha.slice(0, 12)} to ${effect.owner}/${effect.repository}:${effect.branch}.`;
    case "github_pull_request":
      return `Create ${effect.draft ? "draft " : ""}pull request ${effect.owner}/${effect.repository}:${effect.headBranch} → ${effect.baseBranch}.`;
    case "cloudflare_pages_deploy":
      return `Deploy artifact to Cloudflare Pages ${effect.projectName} (${effect.environment}).`;
    case "cloudflare_workers_deploy":
      return `Deploy artifact to Cloudflare Worker ${effect.workerName} (${effect.environment}).`;
  }
}

export function effectPlanKind(
  effect: ShippingEffect,
): "git_push" | "pull_request" | "deployment" {
  if (effect.kind === "github_push") return "git_push";
  if (effect.kind === "github_pull_request") return "pull_request";
  return "deployment";
}

export function effectTargetKind(
  effect: ShippingEffect,
): "repository" | "environment" {
  return effectProvider(effect) === "github" ? "repository" : "environment";
}

export function effectAllowedDomains(effect: ShippingEffect): string[] {
  return effectProvider(effect) === "github"
    ? ["api.github.com", "github.com"]
    : ["api.cloudflare.com"];
}

export function effectTargetDisplayName(effect: ShippingEffect): string {
  switch (effect.kind) {
    case "github_push":
      return `${effect.owner}/${effect.repository}:${effect.branch}`;
    case "github_pull_request":
      return `${effect.owner}/${effect.repository}:${effect.headBranch}→${effect.baseBranch}`;
    case "cloudflare_pages_deploy":
      return `Pages/${effect.projectName}/${effect.environment}`;
    case "cloudflare_workers_deploy":
      return `Workers/${effect.workerName}/${effect.environment}`;
  }
}

export function validateTaskPlanForShipping(
  taskPlan: TaskPlan,
  stepId: string,
  requiredCapability: string,
): { preconditionIds: string[]; evidenceIds: string[] } {
  const verified = verifyTaskPlan(taskPlan);
  if (!verified.valid) fail("Task plan failed structural or digest verification.");
  if (!["approved", "active", "completed"].includes(taskPlan.status)) {
    fail("Task plan must be approved before shipping.");
  }
  const step = taskPlan.steps.find((candidate) => candidate.id === stepId);
  if (!step) fail("Shipping step does not exist in the task plan.");
  if (!["publish", "external_effect"].includes(step.kind)) {
    fail("Shipping step must be a publish or external-effect step.");
  }
  if (!["ready", "running", "completed"].includes(step.status)) {
    fail("Shipping step is not ready for execution.");
  }
  if (!step.allowedCapabilities.includes(requiredCapability)) {
    fail("Shipping step does not grant the exact required capability.");
  }
  if (step.proofObligationIds.length === 0) {
    fail("Shipping requires at least one precondition proof obligation.");
  }
  const byId = new Map(
    taskPlan.proofObligations.map((obligation) => [obligation.id, obligation]),
  );
  const evidenceIds = new Set<string>();
  for (const obligationId of step.proofObligationIds) {
    const obligation = byId.get(obligationId);
    if (!obligation) fail("Shipping step references a missing proof obligation.");
    if (!["satisfied", "waived"].includes(obligation.status)) {
      fail("A shipping proof obligation is not satisfied or explicitly waived.");
    }
    obligation.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId));
    if (obligation.waiver) {
      evidenceIds.add(`approval:${obligation.waiver.approvalReceiptDigest}`);
    }
  }
  return {
    preconditionIds: [...step.proofObligationIds],
    evidenceIds: [...evidenceIds],
  };
}

function validateEvidenceIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(item),
    ) ||
    new Set(value).size !== value.length
  ) {
    fail("Provider evidence IDs must be a non-empty unique string array.");
  }
  return [...value] as string[];
}

export function validateInspection(
  value: ShippingInspection,
  effect: ShippingEffect,
): ShippingInspection {
  const object = plainObject(value, "Shipping inspection");
  exactKeys(
    object,
    [
      "schemaVersion",
      "effectKind",
      "targetLocatorDigest",
      "currentStateDigest",
      "evidenceIds",
      "canMutate",
    ],
    [
      "denialReason",
      "remoteCommitSha",
      "existingPullRequestDigest",
      "currentDeploymentDigest",
    ],
    "Shipping inspection",
  );
  if (
    object.schemaVersion !== SHIPPING_SCHEMA_VERSION ||
    object.effectKind !== effect.kind
  ) {
    fail("Shipping inspection does not match the requested effect.");
  }
  if (digest(object.targetLocatorDigest, "Inspection target") !== targetLocatorDigest(effect)) {
    fail("Shipping inspection resolved a different target.");
  }
  const canMutate = booleanValue(object.canMutate, "Inspection permission");
  if (!canMutate) fail("Shipping provider denied the exact requested mutation.");

  const inspection: ShippingInspection = {
    schemaVersion: SHIPPING_SCHEMA_VERSION,
    effectKind: effect.kind,
    targetLocatorDigest: object.targetLocatorDigest as AutopilotDigest,
    currentStateDigest: digest(object.currentStateDigest, "Inspection state"),
    evidenceIds: validateEvidenceIds(object.evidenceIds),
    canMutate,
    ...(object.denialReason !== undefined
      ? { denialReason: safeText(object.denialReason, "Inspection denial", 512) }
      : {}),
  };

  if (effect.kind === "github_push") {
    const remote = object.remoteCommitSha;
    if (remote !== null && (typeof remote !== "string" || !GIT_SHA.test(remote))) {
      fail("Inspection remote commit is invalid.");
    }
    if (remote !== effect.expectedRemoteCommitSha) {
      fail("GitHub branch changed after the requested effect was prepared.");
    }
    inspection.remoteCommitSha = remote as string | null;
  } else if (effect.kind === "github_pull_request") {
    const existing = object.existingPullRequestDigest;
    const normalized =
      existing === null
        ? null
        : digest(existing, "Inspection pull request");
    if (normalized !== effect.expectedExistingPullRequestDigest) {
      fail("GitHub pull request state changed after the effect was prepared.");
    }
    inspection.existingPullRequestDigest = normalized;
  } else {
    const current = object.currentDeploymentDigest;
    const normalized =
      current === null
        ? null
        : digest(current, "Inspection deployment");
    if (normalized !== effect.expectedCurrentDeploymentDigest) {
      fail("Cloudflare deployment state changed after the effect was prepared.");
    }
    inspection.currentDeploymentDigest = normalized;
  }
  return inspection;
}

export function validateOpaqueHandle(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_HANDLE.test(value) ||
    SECRET_LIKE.test(value) ||
    redactText(value) !== value
  ) {
    fail(`${field} is not a safe opaque host handle.`);
  }
  return value;
}

function validateResultBase(
  value: ProviderMutationResult | ProviderCompensationResult,
): ProviderMutationResult | ProviderCompensationResult {
  if (value.schemaVersion !== SHIPPING_SCHEMA_VERSION) {
    fail("Provider result schema version is unsupported.");
  }
  if (!["succeeded", "partially_succeeded", "failed"].includes(value.status)) {
    fail("Provider result status is unsupported.");
  }
  const summary = safeText(value.summary, "Provider result summary", 1024);
  const targetStateDigest = digest(
    value.targetStateDigest,
    "Provider target state",
  );
  const evidenceIds = validateEvidenceIds(value.evidenceIds);
  const providerReceiptHandle = validateOpaqueHandle(
    value.providerReceiptHandle,
    "Provider receipt handle",
  );
  return {
    ...value,
    summary,
    targetStateDigest,
    evidenceIds,
    providerReceiptHandle,
  };
}

export function validateMutationResult(
  value: ProviderMutationResult,
): ProviderMutationResult {
  exactKeys(
    plainObject(value, "Provider mutation result"),
    [
      "schemaVersion",
      "status",
      "summary",
      "targetStateDigest",
      "evidenceIds",
      "providerReceiptHandle",
    ],
    ["compensationHandle"],
    "Provider mutation result",
  );
  const normalized = validateResultBase(value) as ProviderMutationResult;
  return {
    ...normalized,
    ...(value.compensationHandle
      ? {
          compensationHandle: validateOpaqueHandle(
            value.compensationHandle,
            "Provider compensation handle",
          ),
        }
      : {}),
  };
}

export function validateCompensationResult(
  value: ProviderCompensationResult,
): ProviderCompensationResult {
  exactKeys(
    plainObject(value, "Provider compensation result"),
    [
      "schemaVersion",
      "status",
      "summary",
      "targetStateDigest",
      "evidenceIds",
      "providerReceiptHandle",
    ],
    [],
    "Provider compensation result",
  );
  const normalized = validateResultBase(value);
  const {
    schemaVersion,
    status,
    summary,
    targetStateDigest,
    evidenceIds,
    providerReceiptHandle,
  } = normalized;
  return {
    schemaVersion,
    status,
    summary,
    targetStateDigest,
    evidenceIds,
    providerReceiptHandle,
  };
}
