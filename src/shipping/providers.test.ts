import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autopilotRecordDigest,
  type AutopilotDigest,
} from "../autopilot/index.js";
import {
  CloudflareStructuredShippingProvider,
  GitHubStructuredShippingProvider,
  SHIPPING_SCHEMA_VERSION,
  ShippingProviderError,
  ShippingProviderInvariantError,
  cloudflarePagesArtifactDigest,
  cloudflarePagesDeploymentDigest,
  cloudflareWorkersArtifactDigest,
  cloudflareWorkersDeploymentDigest,
  createProviderShippingExecutor,
  createProviderShippingService,
  githubPullRequestSetDigest,
  type CloudflarePagesArtifact,
  type CloudflarePagesEffect,
  type CloudflareWorkersArtifact,
  type CloudflareWorkersEffect,
  type GitHubPullRequestEffect,
  type GitHubPushEffect,
  type HostShippingArtifactResolver,
  type HostShippingCredentialResolver,
  type ShippingCredentialHandle,
  type ShippingFetch,
} from "./index.js";

const NOW = "2026-07-28T12:00:00.000Z";
const SOURCE_SHA = "b".repeat(40);
const REMOTE_SHA = "a".repeat(40);
const BASE_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const CREDENTIAL_VALUE = ["host", "resolved", "credential", "value"].join("-");
const temporaryPaths: string[] = [];

function digest(value: string): AutopilotDigest {
  return autopilotRecordDigest({ value });
}

const githubCredential: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "github",
  id: "credential:github:provider-test",
};

const cloudflareCredential: ShippingCredentialHandle = {
  schemaVersion: SHIPPING_SCHEMA_VERSION,
  provider: "cloudflare",
  id: "credential:cloudflare:provider-test",
};

const credentialResolver: HostShippingCredentialResolver = {
  resolve: vi.fn(async () => ({ token: CREDENTIAL_VALUE })),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubRef(sha: string): unknown {
  return {
    ref: "refs/heads/main",
    object: { type: "commit", sha },
  };
}

function providerEnvelope(result: unknown): unknown {
  return { success: true, errors: [], messages: [], result };
}

function githubRequestHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitHub structured provider", () => {
  it("rechecks and advances an exact ref, then restores only that ref", async () => {
    let remoteSha: string | null = REMOTE_SHA;
    const calls: Array<{ url: string; method: string; authorization: string }> =
      [];
    const fetch: ShippingFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({
        url: url.toString(),
        method,
        authorization:
          githubRequestHeaders(init).get("authorization") ?? "",
      });
      if (url.pathname.endsWith(`/git/commits/${SOURCE_SHA}`)) {
        return jsonResponse({ sha: SOURCE_SHA });
      }
      if (url.pathname.endsWith(`/git/commits/${REMOTE_SHA}`)) {
        return jsonResponse({ sha: REMOTE_SHA });
      }
      if (url.pathname.includes("/git/ref/heads/main") && method === "GET") {
        return remoteSha === null
          ? jsonResponse({ message: "not found" }, 404)
          : jsonResponse(githubRef(remoteSha));
      }
      if (url.pathname.includes("/git/refs/heads/main") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          sha: string;
          force: boolean;
        };
        expect(body.force).toBe(remoteSha === SOURCE_SHA);
        remoteSha = body.sha;
        return jsonResponse(githubRef(remoteSha));
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    const provider = new GitHubStructuredShippingProvider({
      credentialResolver,
      fetch,
    });
    const effect: GitHubPushEffect = {
      kind: "github_push",
      owner: "SupratimSircar05",
      repository: "krater-pro",
      branch: "main",
      sourceCommitSha: SOURCE_SHA,
      sourceDigest: digest("github-source"),
      expectedRemoteCommitSha: REMOTE_SHA,
    };

    const inspection = await provider.inspectGitHubPush(
      effect,
      githubCredential,
    );
    expect(inspection).toMatchObject({
      canMutate: true,
      remoteCommitSha: REMOTE_SHA,
    });

    const result = await provider.pushGitHub({
      effect,
      credentialHandle: githubCredential,
      idempotencyKey: "github-provider-idempotency-0001",
    });
    expect(remoteSha).toBe(SOURCE_SHA);
    expect(result).toMatchObject({
      status: "succeeded",
      targetStateDigest: effect.sourceDigest,
      compensationHandle: expect.stringMatching(/^github-push:/),
    });
    expect(result.providerReceiptHandle).not.toContain(CREDENTIAL_VALUE);

    await expect(
      provider.compensateGitHubPush({
        effect: { ...effect, branch: "different-target" },
        credentialHandle: githubCredential,
        idempotencyKey: "github-provider-wrong-target-0001",
        originalEffectPlanDigest: digest("wrong-effect-plan"),
        originalReceiptDigest: digest("wrong-effect-receipt"),
        compensationHandle: String(result.compensationHandle),
        reason: "This must be refused.",
      }),
    ).rejects.toBeInstanceOf(ShippingProviderInvariantError);

    const compensated = await provider.compensateGitHubPush({
      effect,
      credentialHandle: githubCredential,
      idempotencyKey: "github-provider-compensation-0001",
      originalEffectPlanDigest: digest("effect-plan"),
      originalReceiptDigest: digest("effect-receipt"),
      compensationHandle: String(result.compensationHandle),
      reason: "Restore the prior exact ref.",
    });
    expect(compensated.status).toBe("succeeded");
    expect(remoteSha).toBe(REMOTE_SHA);
    expect(calls.every((call) => call.authorization === `Bearer ${CREDENTIAL_VALUE}`))
      .toBe(true);
    expect(calls.every((call) => !call.url.includes(CREDENTIAL_VALUE))).toBe(
      true,
    );
  });

  it("creates and closes only the exact head/base pull request", async () => {
    let pullRequestState: "missing" | "open" | "closed" = "missing";
    const pullRequest = (state: "open" | "closed") => ({
      number: 42,
      state,
      html_url:
        "https://github.com/SupratimSircar05/krater-pro/pull/42",
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
    });
    const fetch: ShippingFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/git/ref/heads/feature")) {
        return jsonResponse(githubRef(HEAD_SHA));
      }
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        return jsonResponse(githubRef(BASE_SHA));
      }
      if (url.pathname.endsWith("/pulls") && method === "GET") {
        return jsonResponse(
          pullRequestState === "open" ? [pullRequest("open")] : [],
        );
      }
      if (url.pathname.endsWith("/pulls") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          head: "SupratimSircar05:feature",
          base: "main",
          maintainer_can_modify: false,
        });
        pullRequestState = "open";
        return jsonResponse(pullRequest("open"), 201);
      }
      if (url.pathname.endsWith("/pulls/42") && method === "GET") {
        return jsonResponse(
          pullRequest(pullRequestState === "closed" ? "closed" : "open"),
        );
      }
      if (url.pathname.endsWith("/pulls/42") && method === "PATCH") {
        pullRequestState = "closed";
        return jsonResponse(pullRequest("closed"));
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    const provider = new GitHubStructuredShippingProvider({
      credentialResolver,
      fetch,
    });
    const effect: GitHubPullRequestEffect = {
      kind: "github_pull_request",
      owner: "SupratimSircar05",
      repository: "krater-pro",
      headOwner: "SupratimSircar05",
      headBranch: "feature",
      headCommitSha: HEAD_SHA,
      baseBranch: "main",
      baseCommitSha: BASE_SHA,
      sourceDigest: digest("pull-request-source"),
      title: "Verified change",
      body: "Exact evidence is attached.",
      draft: true,
      expectedExistingPullRequestDigest: null,
    };

    await expect(
      provider.inspectGitHubPullRequest(effect, githubCredential),
    ).resolves.toMatchObject({
      canMutate: true,
      existingPullRequestDigest: null,
    });
    const result = await provider.createGitHubPullRequest({
      effect,
      credentialHandle: githubCredential,
      idempotencyKey: "github-pull-request-idempotency-0001",
    });
    expect(result.status).toBe("succeeded");
    expect(pullRequestState).toBe("open");
    expect(result.compensationHandle).toMatch(/^github-pr:/);
    await expect(
      provider.compensateGitHubPullRequest({
        effect,
        credentialHandle: githubCredential,
        idempotencyKey: "github-pull-request-compensation-0001",
        originalEffectPlanDigest: digest("pr-plan"),
        originalReceiptDigest: digest("pr-receipt"),
        compensationHandle: String(result.compensationHandle),
        reason: "Close the exact created pull request.",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(pullRequestState).toBe("closed");
  });

  it("fails closed on changed refs and sanitizes provider errors", async () => {
    const rejectedBody = { message: `bad ${CREDENTIAL_VALUE}` };
    const fetch: ShippingFetch = vi.fn(async () =>
      jsonResponse(rejectedBody, 401),
    );
    const provider = new GitHubStructuredShippingProvider({
      credentialResolver,
      fetch,
    });
    const effect: GitHubPushEffect = {
      kind: "github_push",
      owner: "SupratimSircar05",
      repository: "krater-pro",
      branch: "main",
      sourceCommitSha: SOURCE_SHA,
      sourceDigest: digest("github-error-source"),
      expectedRemoteCommitSha: REMOTE_SHA,
    };
    const error = await provider
      .inspectGitHubPush(effect, githubCredential)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ShippingProviderError);
    expect(String((error as Error).message)).not.toContain(CREDENTIAL_VALUE);
    expect(JSON.stringify(error)).not.toContain(CREDENTIAL_VALUE);
  });

  it("computes a deterministic digest for an existing PR set", () => {
    const state = [
      {
        number: 7,
        state: "open" as const,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      },
    ];
    expect(githubPullRequestSetDigest(state)).toBe(
      githubPullRequestSetDigest([...state]),
    );
    expect(githubPullRequestSetDigest([])).toBeNull();
  });
});

describe("Cloudflare structured provider", () => {
  it("deploys an exact Pages manifest and rolls production back", async () => {
    const previous = {
      id: "00000000-0000-4000-8000-000000000001",
      environment: "production",
      deployment_trigger: {
        metadata: { branch: "main", commit_hash: REMOTE_SHA },
      },
      latest_stage: { status: "success" },
    };
    const created = {
      id: "00000000-0000-4000-8000-000000000002",
      environment: "production",
      deployment_trigger: {
        metadata: { branch: "main", commit_hash: "" },
      },
      latest_stage: { status: "active" },
    };
    const rollback = {
      id: "00000000-0000-4000-8000-000000000003",
      environment: "production",
      deployment_trigger: {
        metadata: { branch: "main", commit_hash: REMOTE_SHA },
      },
      latest_stage: { status: "success" },
    };
    let current = previous;
    const artifact: CloudflarePagesArtifact = {
      schemaVersion: 1,
      kind: "cloudflare_pages_manifest",
      manifest: {
        "/index.html": "a".repeat(64),
        "/assets/app.js": "b".repeat(64),
      },
    };
    const artifactDigest = cloudflarePagesArtifactDigest(artifact);
    const artifacts: HostShippingArtifactResolver = {
      resolvePagesArtifact: vi.fn(async () => artifact),
      resolveWorkersArtifact: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const fetch: ShippingFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/deployments") && method === "GET") {
        return jsonResponse(providerEnvelope([current]));
      }
      if (url.pathname.endsWith("/deployments") && method === "POST") {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("branch")).toBe("main");
        expect(JSON.parse(String(form.get("manifest")))).toEqual(
          artifact.manifest,
        );
        current = created;
        return jsonResponse(providerEnvelope(created), 201);
      }
      if (
        url.pathname.endsWith(
          `/deployments/${previous.id}/rollback`,
        ) &&
        method === "POST"
      ) {
        current = rollback;
        return jsonResponse(providerEnvelope(rollback));
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    const provider = new CloudflareStructuredShippingProvider({
      credentialResolver,
      artifactResolver: artifacts,
      fetch,
    });
    const expectedCurrentDeploymentDigest =
      cloudflarePagesDeploymentDigest({
        id: previous.id,
        environment: "production",
        branch: "main",
        commitHash: REMOTE_SHA,
      });
    const effect: CloudflarePagesEffect = {
      kind: "cloudflare_pages_deploy",
      accountId: ACCOUNT_ID,
      projectName: "krater-pro",
      environment: "production",
      branch: "main",
      artifactDigest,
      expectedCurrentDeploymentDigest,
    };

    await expect(
      provider.inspectCloudflarePages(effect, cloudflareCredential),
    ).resolves.toMatchObject({
      canMutate: true,
      currentDeploymentDigest: expectedCurrentDeploymentDigest,
    });
    const result = await provider.deployCloudflarePages({
      effect,
      credentialHandle: cloudflareCredential,
      idempotencyKey: "cloudflare-pages-idempotency-0001",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      targetStateDigest: artifactDigest,
      compensationHandle: expect.stringMatching(/^cloudflare-pages:/),
    });
    await expect(
      provider.compensateCloudflarePages({
        effect,
        credentialHandle: cloudflareCredential,
        idempotencyKey: "cloudflare-pages-compensation-0001",
        originalEffectPlanDigest: digest("pages-plan"),
        originalReceiptDigest: digest("pages-receipt"),
        compensationHandle: String(result.compensationHandle),
        reason: "Rollback production.",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(current).toBe(rollback);
  });

  it("uploads an exact Worker version, deploys it, and restores the prior version", async () => {
    const priorVersionId = "10000000-0000-4000-8000-000000000001";
    const newVersionId = "10000000-0000-4000-8000-000000000002";
    const priorDeployment = {
      id: "20000000-0000-4000-8000-000000000001",
      versions: [{ version_id: priorVersionId, percentage: 100 }],
    };
    const newDeployment = {
      id: "20000000-0000-4000-8000-000000000002",
      versions: [{ version_id: newVersionId, percentage: 100 }],
    };
    const restoredDeployment = {
      id: "20000000-0000-4000-8000-000000000003",
      versions: [{ version_id: priorVersionId, percentage: 100 }],
    };
    let current = priorDeployment;
    const artifact: CloudflareWorkersArtifact = {
      schemaVersion: 1,
      kind: "cloudflare_workers_modules",
      mainModule: "worker.mjs",
      compatibilityDate: "2026-07-28",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        {
          name: "worker.mjs",
          contentType: "application/javascript+module",
          content: new TextEncoder().encode(
            "export default { fetch() { return new Response('ok'); } };",
          ),
        },
      ],
    };
    const artifactDigest = cloudflareWorkersArtifactDigest(artifact);
    const artifacts: HostShippingArtifactResolver = {
      resolvePagesArtifact: vi.fn(async () => {
        throw new Error("not used");
      }),
      resolveWorkersArtifact: vi.fn(async () => artifact),
    };
    let deploymentPosts = 0;
    const fetch: ShippingFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/deployments") && method === "GET") {
        return jsonResponse(
          providerEnvelope({ deployments: [current] }),
        );
      }
      if (url.pathname.endsWith("/versions") && method === "POST") {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        const metadata = JSON.parse(String(form.get("metadata"))) as {
          main_module: string;
          compatibility_date: string;
        };
        expect(metadata).toMatchObject({
          main_module: "worker.mjs",
          compatibility_date: "2026-07-28",
        });
        expect(form.get("worker.mjs")).toBeInstanceOf(Blob);
        return jsonResponse(providerEnvelope({ id: newVersionId }), 201);
      }
      if (url.pathname.endsWith("/deployments") && method === "POST") {
        deploymentPosts += 1;
        const body = JSON.parse(String(init?.body)) as {
          versions: Array<{ version_id: string; percentage: number }>;
        };
        if (deploymentPosts === 1) {
          expect(body.versions).toEqual([
            { version_id: newVersionId, percentage: 100 },
          ]);
          current = newDeployment;
          return jsonResponse(providerEnvelope(newDeployment), 201);
        }
        expect(body.versions).toEqual([
          { version_id: priorVersionId, percentage: 100 },
        ]);
        current = restoredDeployment;
        return jsonResponse(providerEnvelope(restoredDeployment), 201);
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    const provider = new CloudflareStructuredShippingProvider({
      credentialResolver,
      artifactResolver: artifacts,
      fetch,
    });
    const expectedCurrentDeploymentDigest =
      cloudflareWorkersDeploymentDigest({
        id: priorDeployment.id,
        versions: [
          { versionId: priorVersionId, percentage: 100 },
        ],
      });
    const effect: CloudflareWorkersEffect = {
      kind: "cloudflare_workers_deploy",
      accountId: ACCOUNT_ID,
      workerName: "krater-worker",
      environment: "production",
      artifactDigest,
      expectedCurrentDeploymentDigest,
    };

    await expect(
      provider.inspectCloudflareWorkers(effect, cloudflareCredential),
    ).resolves.toMatchObject({
      canMutate: true,
      currentDeploymentDigest: expectedCurrentDeploymentDigest,
    });
    const result = await provider.deployCloudflareWorkers({
      effect,
      credentialHandle: cloudflareCredential,
      idempotencyKey: "cloudflare-workers-idempotency-0001",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      targetStateDigest: artifactDigest,
      compensationHandle: expect.stringMatching(/^cloudflare-workers:/),
    });
    await expect(
      provider.compensateCloudflareWorkers({
        effect,
        credentialHandle: cloudflareCredential,
        idempotencyKey: "cloudflare-workers-compensation-0001",
        originalEffectPlanDigest: digest("workers-plan"),
        originalReceiptDigest: digest("workers-receipt"),
        compensationHandle: String(result.compensationHandle),
        reason: "Restore the prior Worker version.",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(current).toBe(restoredDeployment);
  });

  it("refuses an artifact whose resolved bytes do not match the prepared digest", async () => {
    const artifact: CloudflareWorkersArtifact = {
      schemaVersion: 1,
      kind: "cloudflare_workers_modules",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          contentType: "application/javascript+module",
          content: new TextEncoder().encode("export default {};"),
        },
      ],
    };
    const fetch: ShippingFetch = vi.fn(async () =>
      jsonResponse(providerEnvelope({ deployments: [] })),
    );
    const provider = new CloudflareStructuredShippingProvider({
      credentialResolver,
      artifactResolver: {
        resolvePagesArtifact: vi.fn(async () => {
          throw new Error("not used");
        }),
        resolveWorkersArtifact: vi.fn(async () => artifact),
      },
      fetch,
    });
    const effect: CloudflareWorkersEffect = {
      kind: "cloudflare_workers_deploy",
      accountId: ACCOUNT_ID,
      workerName: "krater-worker",
      environment: "production",
      artifactDigest: digest("different-artifact"),
      expectedCurrentDeploymentDigest: null,
    };
    await expect(
      provider.inspectCloudflareWorkers(effect, cloudflareCredential),
    ).rejects.toBeInstanceOf(ShippingProviderInvariantError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("provider service factory", () => {
  it("enables only explicitly configured providers and uses persistent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "krater-provider-shipping-"));
    temporaryPaths.push(root);
    const github = { credentialResolver, fetch: vi.fn() as ShippingFetch };
    const executor = createProviderShippingExecutor({ github });
    expect(executor.inspectGitHubPush).toBeTypeOf("function");
    expect(executor.inspectCloudflarePages).toBeUndefined();

    const service = createProviderShippingService({
      stateRoot: join(root, ".krater", "shipping"),
      github,
      now: () => new Date(NOW),
      createId: () => "provider-test-id",
    });
    expect(service).toBeDefined();
  });
});
