import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOPILOT_SCHEMA_VERSION,
  autopilotRecordDigest,
  createTaskPlan,
  type AutopilotDigest,
  type TaskPlan,
} from "../autopilot/index.js";
import {
  FileShippingLedger,
  FileShippingRuntimeVault,
  InMemoryShippingLedger,
  InMemoryShippingRuntimeVault,
  SHIPPING_SCHEMA_VERSION,
  ShippingIdempotencyConflictError,
  ShippingReplayError,
  ShippingStateError,
  ShippingUnsupportedError,
  ShippingValidationError,
  StructuredShippingService,
  effectCapability,
  invalidateLeaseForDrift,
  targetLocatorDigest,
  validateCredentialHandle,
  type CloudflarePagesEffect,
  type CloudflareWorkersEffect,
  type GitHubPullRequestEffect,
  type GitHubPushEffect,
  type ShippingCredentialHandle,
  type ShippingEffect,
  type ShippingInspection,
  type StructuredShippingExecutor,
} from "./index.js";

const NOW = "2026-07-28T10:00:00.000Z";
const SOURCE_SHA = "b".repeat(40);
const REMOTE_SHA = "a".repeat(40);
const BASE_SHA = "c".repeat(40);
const IDEMPOTENCY = "host-idempotency-0123456789";
const COMPENSATION_IDEMPOTENCY = "host-compensate-0123456789";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function d(value: string): AutopilotDigest {
  return autopilotRecordDigest({ value });
}

const credential: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "github",
  id: "credential:github:primary",
  accountLabel: "Supratim",
};

const cloudflareCredential: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "cloudflare",
  id: "credential:cloudflare:production",
};

function taskPlan(effect: ShippingEffect, suffix = effect.kind): TaskPlan {
  const capability = effectCapability(effect);
  return createTaskPlan({
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    id: `plan-${suffix}`,
    taskId: `task-${suffix}`,
    revision: 1,
    status: "active",
    objective: "Ship the exact verified artifact.",
    steps: [
      {
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: `ship-${suffix}`,
        taskId: `task-${suffix}`,
        kind: "external_effect",
        title: "Ship verified result",
        description: "Apply one structured external effect.",
        status: "ready",
        dependsOnStepIds: [],
        proofObligationIds: [`proof-${suffix}`],
        allowedCapabilities: [capability],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proofObligations: [
      {
        schemaVersion: AUTOPILOT_SCHEMA_VERSION,
        id: `proof-${suffix}`,
        taskId: `task-${suffix}`,
        kind: "publication_precondition",
        statement: "The staged artifact passed its release checks.",
        required: true,
        minimumGrade: "tested",
        status: "satisfied",
        acceptanceCriterionIds: ["accept-release"],
        evidenceIds: [`evidence-${suffix}`],
        scopeDigests: [effectSubject(effect)],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdBy: "user",
    revisedBy: "user",
    createdAt: NOW,
    revisedAt: NOW,
    revisionReason: "Initial verified shipping plan.",
  });
}

function effectSubject(effect: ShippingEffect): AutopilotDigest {
  return effect.kind === "github_push" ||
    effect.kind === "github_pull_request"
    ? effect.sourceDigest
    : effect.artifactDigest;
}

function gitPush(branch = "main"): GitHubPushEffect {
  return {
    kind: "github_push",
    owner: "SupratimSircar05",
    repository: "krater-pro",
    branch,
    sourceCommitSha: SOURCE_SHA,
    sourceDigest: d(`source-${branch}`),
    expectedRemoteCommitSha: REMOTE_SHA,
  };
}

function pullRequest(): GitHubPullRequestEffect {
  return {
    kind: "github_pull_request",
    owner: "SupratimSircar05",
    repository: "krater-pro",
    headOwner: "SupratimSircar05",
    headBranch: "codex/verified-autopilot-1.0",
    headCommitSha: SOURCE_SHA,
    baseBranch: "main",
    baseCommitSha: BASE_SHA,
    sourceDigest: d("pull-request-source"),
    title: "Release verified autopilot",
    body: "This change is backed by the sealed release checks.",
    draft: true,
    expectedExistingPullRequestDigest: null,
  };
}

function pages(): CloudflarePagesEffect {
  return {
    kind: "cloudflare_pages_deploy",
    accountId: "a".repeat(32),
    projectName: "krater-pro",
    environment: "production",
    branch: "main",
    artifactDigest: d("pages-artifact"),
    expectedCurrentDeploymentDigest: null,
  };
}

function workers(): CloudflareWorkersEffect {
  return {
    kind: "cloudflare_workers_deploy",
    accountId: "a".repeat(32),
    workerName: "krater-pro-api",
    environment: "production",
    artifactDigest: d("worker-artifact"),
    expectedCurrentDeploymentDigest: null,
  };
}

function inspection(effect: ShippingEffect): ShippingInspection {
  const common = {
    schemaVersion: SHIPPING_SCHEMA_VERSION,
    effectKind: effect.kind,
    targetLocatorDigest: targetLocatorDigest(effect),
    currentStateDigest: d(`current-${effect.kind}`),
    evidenceIds: [`inspect-${effect.kind}`],
    canMutate: true,
  } as const;
  if (effect.kind === "github_push") {
    return { ...common, remoteCommitSha: effect.expectedRemoteCommitSha };
  }
  if (effect.kind === "github_pull_request") {
    return {
      ...common,
      existingPullRequestDigest: effect.expectedExistingPullRequestDigest,
    };
  }
  return {
    ...common,
    currentDeploymentDigest: effect.expectedCurrentDeploymentDigest,
  };
}

function executor(
  overrides: Partial<StructuredShippingExecutor> = {},
): {
  value: StructuredShippingExecutor;
  calls: Record<string, number>;
  mutations: Array<{ credentialId: string; idempotencyKey: string }>;
} {
  const calls: Record<string, number> = {};
  const mutations: Array<{
    credentialId: string;
    idempotencyKey: string;
  }> = [];
  const called = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const mutation = (
    name: string,
    request: {
      credentialHandle: ShippingCredentialHandle;
      idempotencyKey: string;
    },
  ) => {
    called(name);
    mutations.push({
      credentialId: request.credentialHandle.id,
      idempotencyKey: request.idempotencyKey,
    });
    return Promise.resolve({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded" as const,
      summary: "The provider confirmed the exact external effect.",
      targetStateDigest: d(`${name}-target`),
      evidenceIds: [`${name}-evidence`],
      providerReceiptHandle: `${name}:receipt`,
      compensationHandle: `${name}:compensation`,
    });
  };
  const compensation = (
    name: string,
    request: {
      credentialHandle: ShippingCredentialHandle;
      idempotencyKey: string;
    },
  ) => {
    called(name);
    mutations.push({
      credentialId: request.credentialHandle.id,
      idempotencyKey: request.idempotencyKey,
    });
    return Promise.resolve({
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded" as const,
      summary: "The provider confirmed the compensation.",
      targetStateDigest: d(`${name}-target`),
      evidenceIds: [`${name}-evidence`],
      providerReceiptHandle: `${name}:receipt`,
    });
  };
  const value: StructuredShippingExecutor = {
    inspectGitHubPush: async (effect) => {
      called("inspectGitHubPush");
      return inspection(effect);
    },
    pushGitHub: (request) => mutation("pushGitHub", request),
    compensateGitHubPush: (request) =>
      compensation("compensateGitHubPush", request),
    inspectGitHubPullRequest: async (effect) => {
      called("inspectGitHubPullRequest");
      return inspection(effect);
    },
    createGitHubPullRequest: (request) =>
      mutation("createGitHubPullRequest", request),
    compensateGitHubPullRequest: (request) =>
      compensation("compensateGitHubPullRequest", request),
    inspectCloudflarePages: async (effect) => {
      called("inspectCloudflarePages");
      return inspection(effect);
    },
    deployCloudflarePages: (request) =>
      mutation("deployCloudflarePages", request),
    compensateCloudflarePages: (request) =>
      compensation("compensateCloudflarePages", request),
    inspectCloudflareWorkers: async (effect) => {
      called("inspectCloudflareWorkers");
      return inspection(effect);
    },
    deployCloudflareWorkers: (request) =>
      mutation("deployCloudflareWorkers", request),
    compensateCloudflareWorkers: (request) =>
      compensation("compensateCloudflareWorkers", request),
    ...overrides,
  };
  return { value, calls, mutations };
}

function service(
  adapter: StructuredShippingExecutor,
  ledger = new InMemoryShippingLedger(),
  vault = new InMemoryShippingRuntimeVault(),
) {
  let id = 0;
  return new StructuredShippingService({
    executor: adapter,
    ledger,
    vault,
    allowVolatileState: true,
    now: () => new Date(NOW),
    createId: () => `shipping-id-${++id}`,
  });
}

function confirmed(challengeDigest: AutopilotDigest) {
  return {
    schemaVersion: SHIPPING_SCHEMA_VERSION,
    challengeDigest,
    decision: "confirmed" as const,
    confirmedBy: "user" as const,
    confirmedAt: NOW,
  };
}

function leaseContext() {
  return {
    environmentDigest: d("environment"),
    policyDigest: d("policy"),
    toolchainDigest: d("toolchain"),
    issuedBy: "blind_verifier" as const,
    ttlMs: 60_000,
  };
}

async function prepare(
  shipping: StructuredShippingService,
  effect: ShippingEffect,
  key = IDEMPOTENCY,
) {
  const plan = taskPlan(effect);
  return shipping.prepare({
    taskPlan: plan,
    stepId: plan.steps[0].id,
    effect,
    credentialHandle:
      effect.kind.startsWith("github_") ? credential : cloudflareCredential,
    idempotencyKey: key,
  });
}

describe("structured shipping adapters", () => {
  it("ships a GitHub push once and returns only digested public receipts", async () => {
    const adapter = executor();
    const shipping = service(adapter.value);
    const effect = gitPush();
    const preflight = await prepare(shipping, effect);

    const serializedPreflight = JSON.stringify(preflight);
    expect(serializedPreflight).not.toContain(IDEMPOTENCY);
    expect(serializedPreflight).not.toContain(credential.id);
    expect(preflight.effectPlan).toMatchObject({
      kind: "git_push",
      requiredCapability: "github.push",
      approvalRequired: true,
    });

    const request = {
      preflight,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(preflight.challenge.digest),
      lease: leaseContext(),
    };
    const result = await shipping.execute(request);

    expect(result.receipt.status).toBe("succeeded");
    expect(result.proofLease).toMatchObject({
      subjectDigest: effect.sourceDigest,
      planDigest: preflight.taskPlan.digest,
    });
    expect(result.compensationAvailable).toBe(true);
    expect(adapter.calls.pushGitHub).toBe(1);
    expect(adapter.calls.inspectGitHubPush).toBe(2);
    expect(adapter.mutations).toContainEqual({
      credentialId: credential.id,
      idempotencyKey: IDEMPOTENCY,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(IDEMPOTENCY);
    expect(serialized).not.toContain("pushGitHub:receipt");
    expect(serialized).not.toContain("pushGitHub:compensation");

    await expect(shipping.execute(request)).rejects.toBeInstanceOf(
      ShippingReplayError,
    );
    expect(adapter.calls.pushGitHub).toBe(1);
  });

  it.each([
    ["GitHub pull request", pullRequest(), "createGitHubPullRequest"],
    ["Cloudflare Pages", pages(), "deployCloudflarePages"],
    ["Cloudflare Workers", workers(), "deployCloudflareWorkers"],
  ] as const)(
    "supports exact %s preflight, confirmation, mutation, and lease issuance",
    async (_label, effect, mutationName) => {
      const adapter = executor();
      const shipping = service(adapter.value);
      const preflight = await prepare(shipping, effect);
      const result = await shipping.execute({
        preflight,
        credentialHandle:
          effect.kind.startsWith("github_")
            ? credential
            : cloudflareCredential,
        idempotencyKey: IDEMPOTENCY,
        confirmation: confirmed(preflight.challenge.digest),
        lease: leaseContext(),
      });

      expect(result.receipt.status).toBe("succeeded");
      expect(result.proofLease?.subjectDigest).toBe(effectSubject(effect));
      expect(adapter.calls[mutationName]).toBe(1);
    },
  );

  it("re-inspects after confirmation and refuses a stale GitHub target", async () => {
    let inspections = 0;
    let mutations = 0;
    const base = executor();
    base.value.inspectGitHubPush = async (effect) => {
      inspections += 1;
      const value = inspection(effect);
      if (inspections === 2) {
        return {
          ...value,
          remoteCommitSha: "d".repeat(40),
          currentStateDigest: d("changed-remotely"),
          evidenceIds: ["inspect-remote-change"],
        };
      }
      return value;
    };
    base.value.pushGitHub = async (request) => {
      mutations += 1;
      return executor().value.pushGitHub!(request);
    };
    const shipping = service(base.value);
    const preflight = await prepare(shipping, gitPush());
    const result = await shipping.execute({
      preflight,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(preflight.challenge.digest),
      lease: leaseContext(),
    });

    expect(result.receipt.status).toBe("refused");
    expect(result.receipt.summary).toMatch(/revalidated/i);
    expect(mutations).toBe(0);
  });

  it("rejects expired, mismatched, and extended confirmation records", async () => {
    const adapter = executor();
    const shipping = service(adapter.value);
    const preflight = await prepare(shipping, gitPush());
    const base = {
      preflight,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      lease: leaseContext(),
    };

    await expect(
      shipping.execute({
        ...base,
        confirmation: {
          ...confirmed(d("different-challenge")),
        },
      }),
    ).rejects.toMatchObject({ code: "shipping_confirmation_invalid" });
    await expect(
      shipping.execute({
        ...base,
        confirmation: {
          ...confirmed(preflight.challenge.digest),
          confirmedAt: "2026-07-29T10:00:00.000Z",
        },
      }),
    ).rejects.toMatchObject({ code: "shipping_confirmation_invalid" });
    await expect(
      shipping.execute({
        ...base,
        confirmation: {
          ...confirmed(preflight.challenge.digest),
          credentialValue: "must-not-be-accepted",
        } as never,
      }),
    ).rejects.toMatchObject({ code: "shipping_confirmation_invalid" });
    expect(adapter.calls.pushGitHub ?? 0).toBe(0);
  });

  it("turns malformed provider output into a redacted failure without a lease", async () => {
    const leakedValue = "ghp_abcdefghijklmnopqrstuvwx";
    const adapter = executor({
      pushGitHub: async () =>
        ({
          schemaVersion: SHIPPING_SCHEMA_VERSION,
          status: "succeeded",
          summary: "Provider success.",
          targetStateDigest: d("target"),
          evidenceIds: ["provider-evidence"],
          providerReceiptHandle: "provider:receipt",
          compensationHandle: "provider:compensation",
          token: leakedValue,
        }) as never,
    });
    const shipping = service(adapter.value);
    const preflight = await prepare(shipping, gitPush());
    const result = await shipping.execute({
      preflight,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(preflight.challenge.digest),
      lease: leaseContext(),
    });

    expect(result.receipt.status).toBe("failed");
    expect(result.proofLease).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(leakedValue);
  });

  it("fails preflight for target substitution and missing structured recovery", async () => {
    const substituted = executor({
      inspectCloudflarePages: async (effect) => ({
        ...inspection(effect),
        targetLocatorDigest: d("different-target"),
      }),
    });
    await expect(
      prepare(service(substituted.value), pages()),
    ).rejects.toBeInstanceOf(ShippingValidationError);

    const unsupported = executor();
    unsupported.value.compensateCloudflareWorkers = undefined;
    await expect(
      prepare(service(unsupported.value), workers()),
    ).rejects.toBeInstanceOf(ShippingUnsupportedError);
  });

  it("rejects an idempotency value rebound to a different operation", async () => {
    const adapter = executor();
    const ledger = new InMemoryShippingLedger();
    const vault = new InMemoryShippingRuntimeVault();
    const shipping = service(adapter.value, ledger, vault);
    const first = await prepare(shipping, gitPush("main"));
    await shipping.execute({
      preflight: first,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(first.challenge.digest),
      lease: leaseContext(),
    });

    const second = await prepare(
      shipping,
      gitPush("release/1.0"),
      IDEMPOTENCY,
    );
    await expect(
      shipping.execute({
        preflight: second,
        credentialHandle: credential,
        idempotencyKey: IDEMPOTENCY,
        confirmation: confirmed(second.challenge.digest),
        lease: leaseContext(),
      }),
    ).rejects.toBeInstanceOf(ShippingIdempotencyConflictError);
  });

  it("uses a second one-time receipt to compensate and invalidate the lease", async () => {
    const adapter = executor();
    const shipping = service(adapter.value);
    const preflight = await prepare(shipping, pages());
    const shipped = await shipping.execute({
      preflight,
      credentialHandle: cloudflareCredential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(preflight.challenge.digest),
      lease: leaseContext(),
    });
    expect(shipped.proofLease).toBeDefined();

    const compensation = await shipping.prepareCompensation({
      preflight,
      receipt: shipped.receipt,
      credentialHandle: cloudflareCredential,
      idempotencyKey: COMPENSATION_IDEMPOTENCY,
      reason: "The canary contradicted the release invariant.",
    });
    const request = {
      originalPreflight: preflight,
      compensation,
      credentialHandle: cloudflareCredential,
      idempotencyKey: COMPENSATION_IDEMPOTENCY,
      confirmation: confirmed(compensation.challenge.digest),
      proofLease: shipped.proofLease,
    };
    const recovered = await shipping.compensate(request);

    expect(recovered.receipt.status).toBe("compensated");
    expect(recovered.receipt.compensationReceiptDigest).toMatch(/^sha256:/);
    expect(recovered.proofLeaseInvalidation).toMatchObject({
      reason: "manual",
      leaseDigest: shipped.proofLease?.digest,
    });
    expect(adapter.calls.compensateCloudflarePages).toBe(1);
    expect(JSON.stringify(recovered)).not.toContain(
      "deployCloudflarePages:compensation",
    );

    await expect(shipping.compensate(request)).rejects.toBeInstanceOf(
      ShippingReplayError,
    );
    expect(adapter.calls.compensateCloudflarePages).toBe(1);
  });

  it("requires durable state unless volatile execution is explicitly enabled", () => {
    expect(
      () =>
        new StructuredShippingService({
          executor: executor().value,
          ledger: new InMemoryShippingLedger(),
          vault: new InMemoryShippingRuntimeVault(),
        }),
    ).toThrow(ShippingStateError);
  });

  it("rejects credential-shaped fields and secret-like handle values", () => {
    const leaked = {
      ...credential,
      token: "ghp_abcdefghijklmnopqrstuvwx",
    };
    expect(() => validateCredentialHandle(leaked)).toThrow(
      ShippingValidationError,
    );
    expect(() =>
      validateCredentialHandle({
        ...credential,
        id: "credential:github:ghp_abcdefghijklmnopqrstuvwx",
      }),
    ).toThrow(ShippingValidationError);
  });
});

describe("persistent shipping ledger and Proof Lease drift", () => {
  it("persists a digest-only replay barrier across service instances", async () => {
    const rawDirectory = await mkdtemp(join(tmpdir(), "krater-shipping-"));
    temporaryDirectories.push(rawDirectory);
    const directory = await realpath(rawDirectory);
    const file = join(directory, "ledger.json");
    const claim = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      idempotencyKeyDigest: d("key"),
      operationDigest: d("operation"),
      effectPlanDigest: d("effect"),
      confirmationDigest: d("confirmation"),
      operation: "execute" as const,
      state: "reserved" as const,
      reservedAt: NOW,
    };
    await new FileShippingLedger(file).reserve(claim);
    await expect(
      new FileShippingLedger(file).reserve(claim),
    ).rejects.toBeInstanceOf(ShippingReplayError);
    const persisted = await readFile(file, "utf8");
    expect(persisted).toContain(claim.idempotencyKeyDigest);
    expect(persisted).not.toContain(IDEMPOTENCY);
  });

  it("refuses to read a shipping ledger through a symbolic link", async () => {
    if (process.platform === "win32") return;
    const rawDirectory = await mkdtemp(join(tmpdir(), "krater-shipping-link-"));
    const outside = await mkdtemp(join(tmpdir(), "krater-shipping-outside-"));
    temporaryDirectories.push(rawDirectory, outside);
    const directory = await realpath(rawDirectory);
    const outsideFile = join(outside, "ledger.json");
    const original = `${JSON.stringify({ schemaVersion: 1, claims: {} })}\n`;
    await writeFile(outsideFile, original, { mode: 0o600 });
    const file = join(directory, "ledger.json");
    await symlink(outsideFile, file);
    const claim = {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      idempotencyKeyDigest: d("symlink-key"),
      operationDigest: d("symlink-operation"),
      effectPlanDigest: d("symlink-effect"),
      confirmationDigest: d("symlink-confirmation"),
      operation: "execute" as const,
      state: "reserved" as const,
      reservedAt: NOW,
    };

    await expect(
      new FileShippingLedger(file).reserve(claim),
    ).rejects.toBeInstanceOf(ShippingStateError);
    expect(await readFile(outsideFile, "utf8")).toBe(original);
  });

  it("persists only opaque compensation handles in a permission-restricted vault", async () => {
    const rawDirectory = await mkdtemp(join(tmpdir(), "krater-vault-"));
    temporaryDirectories.push(rawDirectory);
    const directory = await realpath(rawDirectory);
    const file = join(directory, "vault.json");
    const vault = new FileShippingRuntimeVault(file);
    const effectPlanDigest = d("effect-plan");
    const receiptDigest = d("receipt");

    await vault.putCompensationHandle(
      effectPlanDigest,
      receiptDigest,
      "provider:compensation-reference",
    );
    expect(
      await new FileShippingRuntimeVault(file).getCompensationHandle(
        effectPlanDigest,
        receiptDigest,
      ),
    ).toBe("provider:compensation-reference");
    await expect(
      vault.putCompensationHandle(
        effectPlanDigest,
        receiptDigest,
        "ghp_abcdefghijklmnopqrstuvwx",
      ),
    ).rejects.toBeInstanceOf(ShippingStateError);
  });

  it("invalidates exact Proof Lease drift and ignores unchanged bindings", async () => {
    const shipping = service(executor().value);
    const preflight = await prepare(shipping, gitPush());
    const shipped = await shipping.execute({
      preflight,
      credentialHandle: credential,
      idempotencyKey: IDEMPOTENCY,
      confirmation: confirmed(preflight.challenge.digest),
      lease: leaseContext(),
    });
    const lease = shipped.proofLease!;
    const unchanged = {
      lease,
      currentPlanDigest: lease.planDigest,
      currentSubjectDigest: lease.subjectDigest,
      currentEnvironmentDigest: lease.environmentDigest,
      currentPolicyDigest: lease.policyDigest,
      currentToolchainDigest: lease.toolchainDigest,
      observedAt: NOW,
    };
    expect(invalidateLeaseForDrift(unchanged)).toBeUndefined();
    expect(
      invalidateLeaseForDrift(
        { ...unchanged, currentSubjectDigest: d("new-subject") },
        { createId: () => "lease-invalidation" },
      ),
    ).toMatchObject({
      reason: "subject_changed",
      causedByDigest: d("new-subject"),
      invalidatedAt: NOW,
    });
  });
});
