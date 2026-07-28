import type { AutopilotDigest } from "../autopilot/index.js";
import { autopilotRecordDigest } from "../autopilot/index.js";
import {
  ShippingProviderInvariantError,
  type ShippingProviderOperation,
} from "./errors.js";
import {
  plainProviderObject,
  providerRequest,
  providerString,
  resolveProviderToken,
} from "./provider-http.js";
import type { GitHubProviderOptions } from "./provider-types.js";
import {
  SHIPPING_SCHEMA_VERSION,
  type GitHubPullRequestEffect,
  type GitHubPushEffect,
  type ProviderCompensationResult,
  type ProviderMutationResult,
  type ShippingCompensationRequest,
  type ShippingCredentialHandle,
  type ShippingInspection,
  type ShippingMutationRequest,
  type StructuredShippingExecutor,
} from "./types.js";
import { targetLocatorDigest } from "./validation.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
interface GitHubRefState {
  sha: string | null;
  digest: AutopilotDigest;
}

interface GitHubPullRequestState {
  number: number;
  state: "open" | "closed";
  headSha: string;
  baseSha: string;
  htmlUrl?: string;
}

interface PushCompensation {
  kind: "push";
  owner: string;
  repository: string;
  branch: string;
  pushedSha: string;
  priorSha: string | null;
}

interface PullRequestCompensation {
  kind: "pull_request";
  owner: string;
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
}

type GitHubCompensation = PushCompensation | PullRequestCompensation;

function githubUrl(
  pathSegments: readonly string[],
  query?: Readonly<Record<string, string>>,
): URL {
  const path = pathSegments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(`/${path}`, GITHUB_API);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

function githubHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "Krater-Pro-Structured-Shipping",
    ...extra,
  };
}

function evidenceId(prefix: string, value: unknown): string {
  return `${prefix}:${autopilotRecordDigest(value).slice("sha256:".length, 30)}`;
}

function receiptHandle(prefix: string, value: unknown): string {
  return `${prefix}:${autopilotRecordDigest(value).slice("sha256:".length)}`;
}

function encodeCompensation(
  prefix: "github-push" | "github-pr",
  value: GitHubCompensation,
  targetDigest: AutopilotDigest,
): string {
  const target = targetDigest.slice("sha256:".length);
  return value.kind === "push"
    ? `${prefix}:${target}:${value.priorSha ?? "none"}`
    : `${prefix}:${target}:${value.number}`;
}

function decodeCompensationPayload(
  value: string,
  prefix: "github-push" | "github-pr",
  expectedTargetDigest: AutopilotDigest,
): string {
  if (
    !value.startsWith(`${prefix}:`) ||
    value.length > 255 ||
    value.slice(prefix.length + 1).length === 0
  ) {
    throw new ShippingProviderInvariantError(
      "github",
      "github.compensate",
      "The GitHub recovery receipt does not match this operation.",
    );
  }
  const [target, payload, ...extra] = value
    .slice(prefix.length + 1)
    .split(":");
  if (
    extra.length > 0 ||
    target !== expectedTargetDigest.slice("sha256:".length) ||
    !payload
  ) {
    throw new ShippingProviderInvariantError(
      "github",
      "github.compensate",
      "The GitHub recovery receipt is not bound to this exact target.",
    );
  }
  return payload;
}

function validatePushCompensation(
  payload: string,
  effect: GitHubPushEffect,
): PushCompensation {
  const priorSha = payload === "none" ? null : payload;
  if (
    (priorSha !== null && !GIT_SHA.test(priorSha)) ||
    priorSha !== effect.expectedRemoteCommitSha
  ) {
    throw new ShippingProviderInvariantError(
      "github",
      "github.compensate",
      "The GitHub push recovery receipt targets a different ref.",
    );
  }
  return {
    kind: "push",
    owner: effect.owner,
    repository: effect.repository,
    branch: effect.branch,
    pushedSha: effect.sourceCommitSha,
    priorSha,
  };
}

function validatePullRequestCompensation(
  payload: string,
  effect: GitHubPullRequestEffect,
): PullRequestCompensation {
  const number = Number(payload);
  if (!/^[1-9]\d{0,9}$/.test(payload) || !Number.isSafeInteger(number)) {
    throw new ShippingProviderInvariantError(
      "github",
      "github.compensate",
      "The GitHub pull-request recovery receipt targets a different change.",
    );
  }
  return {
    kind: "pull_request",
    owner: effect.owner,
    repository: effect.repository,
    number,
    headSha: effect.headCommitSha,
    baseSha: effect.baseCommitSha,
  };
}

export function githubBranchStateDigest(input: {
  owner: string;
  repository: string;
  branch: string;
  sha: string | null;
}): AutopilotDigest {
  return autopilotRecordDigest({
    provider: "github",
    resource: "branch",
    ...input,
  });
}

export function githubPullRequestSetDigest(
  pullRequests: readonly GitHubPullRequestState[],
): AutopilotDigest | null {
  if (pullRequests.length === 0) return null;
  return autopilotRecordDigest(
    [...pullRequests]
      .map(({ number, state, headSha, baseSha }) => ({
        number,
        state,
        headSha,
        baseSha,
      }))
      .sort((left, right) => left.number - right.number),
  );
}

function parseRefSha(
  body: unknown,
  operation: ShippingProviderOperation,
): string {
  const object = plainProviderObject(body, "github", operation, "reference");
  const target = plainProviderObject(
    object.object,
    "github",
    operation,
    "reference target",
  );
  return providerString(
    target.sha,
    "github",
    operation,
    "reference commit",
    GIT_SHA,
  );
}

function parsePullRequest(
  body: unknown,
  operation: ShippingProviderOperation,
): GitHubPullRequestState {
  const object = plainProviderObject(body, "github", operation, "pull request");
  const head = plainProviderObject(
    object.head,
    "github",
    operation,
    "pull request head",
  );
  const base = plainProviderObject(
    object.base,
    "github",
    operation,
    "pull request base",
  );
  if (!Number.isSafeInteger(object.number) || Number(object.number) <= 0) {
    throw new ShippingProviderInvariantError(
      "github",
      operation,
      "The provider returned an invalid pull request number.",
    );
  }
  if (!["open", "closed"].includes(String(object.state))) {
    throw new ShippingProviderInvariantError(
      "github",
      operation,
      "The provider returned an invalid pull request state.",
    );
  }
  const htmlUrl =
    typeof object.html_url === "string" &&
    object.html_url.startsWith("https://github.com/") &&
    object.html_url.length <= 512
      ? object.html_url
      : undefined;
  return {
    number: Number(object.number),
    state: object.state as "open" | "closed",
    headSha: providerString(
      head.sha,
      "github",
      operation,
      "pull request head commit",
      GIT_SHA,
    ),
    baseSha: providerString(
      base.sha,
      "github",
      operation,
      "pull request base commit",
      GIT_SHA,
    ),
    ...(htmlUrl ? { htmlUrl } : {}),
  };
}

export class GitHubStructuredShippingProvider {
  readonly #options: GitHubProviderOptions;

  constructor(options: GitHubProviderOptions) {
    this.#options = options;
  }

  async #request(input: {
    operation: ShippingProviderOperation;
    token: string;
    url: URL;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    acceptedStatuses?: readonly number[];
  }) {
    return providerRequest({
      provider: "github",
      operation: input.operation,
      fetch: this.#options.fetch,
      timeoutMs: this.#options.requestTimeoutMs,
      url: input.url,
      token: input.token,
      method: input.method,
      headers: githubHeaders(
        input.body === undefined
          ? {}
          : { "content-type": "application/json" },
      ),
      ...(input.body === undefined
        ? {}
        : { body: JSON.stringify(input.body) }),
      acceptedStatuses: input.acceptedStatuses,
    });
  }

  async #ref(
    token: string,
    owner: string,
    repository: string,
    branch: string,
    operation: ShippingProviderOperation,
  ): Promise<GitHubRefState> {
    const response = await this.#request({
      operation,
      token,
      url: githubUrl([
        "repos",
        owner,
        repository,
        "git",
        "ref",
        "heads",
        ...branch.split("/"),
      ]),
      acceptedStatuses: [200, 404],
    });
    const sha = response.status === 404 ? null : parseRefSha(response.body, operation);
    return {
      sha,
      digest: githubBranchStateDigest({
        owner,
        repository,
        branch,
        sha,
      }),
    };
  }

  async #assertCommitExists(
    token: string,
    owner: string,
    repository: string,
    sha: string,
    operation: ShippingProviderOperation,
  ): Promise<void> {
    const response = await this.#request({
      operation,
      token,
      url: githubUrl(["repos", owner, repository, "git", "commits", sha]),
    });
    const object = plainProviderObject(
      response.body,
      "github",
      operation,
      "commit",
    );
    const returnedSha = providerString(
      object.sha,
      "github",
      operation,
      "commit identifier",
      GIT_SHA,
    );
    if (returnedSha !== sha) {
      throw new ShippingProviderInvariantError(
        "github",
        operation,
        "GitHub resolved the source commit to a different object.",
      );
    }
  }

  async #matchingPullRequests(
    token: string,
    effect: GitHubPullRequestEffect,
    operation: ShippingProviderOperation,
  ): Promise<GitHubPullRequestState[]> {
    const response = await this.#request({
      operation,
      token,
      url: githubUrl(
        ["repos", effect.owner, effect.repository, "pulls"],
        {
          state: "open",
          head: `${effect.headOwner}:${effect.headBranch}`,
          base: effect.baseBranch,
          per_page: "100",
        },
      ),
    });
    if (!Array.isArray(response.body)) {
      throw new ShippingProviderInvariantError(
        "github",
        operation,
        "GitHub returned a malformed pull-request list.",
      );
    }
    return response.body.map((item) => parsePullRequest(item, operation));
  }

  async #inspectPullRequestState(
    effect: GitHubPullRequestEffect,
    token: string,
    operation: ShippingProviderOperation,
  ): Promise<{
    head: GitHubRefState;
    base: GitHubRefState;
    pullRequests: GitHubPullRequestState[];
    existingDigest: AutopilotDigest | null;
  }> {
    const [head, base, pullRequests] = await Promise.all([
      this.#ref(
        token,
        effect.headOwner,
        effect.repository,
        effect.headBranch,
        operation,
      ),
      this.#ref(
        token,
        effect.owner,
        effect.repository,
        effect.baseBranch,
        operation,
      ),
      this.#matchingPullRequests(token, effect, operation),
    ]);
    if (head.sha !== effect.headCommitSha || base.sha !== effect.baseCommitSha) {
      throw new ShippingProviderInvariantError(
        "github",
        operation,
        "The pull-request head or base changed from the exact prepared commit.",
      );
    }
    return {
      head,
      base,
      pullRequests,
      existingDigest: githubPullRequestSetDigest(pullRequests),
    };
  }

  async inspectGitHubPush(
    effect: GitHubPushEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection> {
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      credentialHandle,
    );
    const [branch] = await Promise.all([
      this.#ref(
        token,
        effect.owner,
        effect.repository,
        effect.branch,
        "github.inspect",
      ),
      this.#assertCommitExists(
        token,
        effect.owner,
        effect.repository,
        effect.sourceCommitSha,
        "github.inspect",
      ),
    ]);
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectKind: effect.kind,
      targetLocatorDigest: targetLocatorDigest(effect),
      currentStateDigest: branch.digest,
      evidenceIds: [
        evidenceId("github:branch-inspection", {
          target: targetLocatorDigest(effect),
          sha: branch.sha,
        }),
      ],
      canMutate: branch.sha === effect.expectedRemoteCommitSha,
      ...(branch.sha === effect.expectedRemoteCommitSha
        ? {}
        : {
            denialReason:
              "The GitHub branch no longer matches the prepared head.",
          }),
      remoteCommitSha: branch.sha,
    };
  }

  async pushGitHub(
    request: ShippingMutationRequest<GitHubPushEffect>,
  ): Promise<ProviderMutationResult> {
    const { effect } = request;
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const [before] = await Promise.all([
      this.#ref(
        token,
        effect.owner,
        effect.repository,
        effect.branch,
        "github.push",
      ),
      this.#assertCommitExists(
        token,
        effect.owner,
        effect.repository,
        effect.sourceCommitSha,
        "github.push",
      ),
    ]);
    if (before.sha !== effect.expectedRemoteCommitSha) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.push",
        "The GitHub branch changed after preflight; the push was refused.",
      );
    }
    if (before.sha === effect.sourceCommitSha) {
      return {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "succeeded",
        summary: "The exact GitHub branch already referenced the source commit.",
        targetStateDigest: effect.sourceDigest,
        evidenceIds: [
          evidenceId("github:push-already-current", {
            target: targetLocatorDigest(effect),
            sha: before.sha,
          }),
        ],
        providerReceiptHandle: receiptHandle("github:push", {
          target: targetLocatorDigest(effect),
          sha: before.sha,
          state: "already_current",
        }),
      };
    }

    const response =
      before.sha === null
        ? await this.#request({
            operation: "github.push",
            token,
            url: githubUrl([
              "repos",
              effect.owner,
              effect.repository,
              "git",
              "refs",
            ]),
            method: "POST",
            body: {
              ref: `refs/heads/${effect.branch}`,
              sha: effect.sourceCommitSha,
            },
            acceptedStatuses: [201],
          })
        : await this.#request({
            operation: "github.push",
            token,
            url: githubUrl([
              "repos",
              effect.owner,
              effect.repository,
              "git",
              "refs",
              "heads",
              ...effect.branch.split("/"),
            ]),
            method: "PATCH",
            body: { sha: effect.sourceCommitSha, force: false },
          });
    if (parseRefSha(response.body, "github.push") !== effect.sourceCommitSha) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.push",
        "GitHub did not confirm the exact pushed commit.",
      );
    }
    const after = await this.#ref(
      token,
      effect.owner,
      effect.repository,
      effect.branch,
      "github.push",
    );
    if (after.sha !== effect.sourceCommitSha) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.push",
        "The GitHub branch changed before the push could be reconciled.",
      );
    }
    const compensation: PushCompensation = {
      kind: "push",
      owner: effect.owner,
      repository: effect.repository,
      branch: effect.branch,
      pushedSha: effect.sourceCommitSha,
      priorSha: before.sha,
    };
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary: `GitHub confirmed ${effect.branch} at ${effect.sourceCommitSha.slice(0, 12)}.`,
      targetStateDigest: effect.sourceDigest,
      evidenceIds: [
        evidenceId("github:push-reconciled", {
          target: targetLocatorDigest(effect),
          before: before.sha,
          after: after.sha,
        }),
      ],
      providerReceiptHandle: receiptHandle("github:push", {
        target: targetLocatorDigest(effect),
        before: before.sha,
        after: after.sha,
      }),
      compensationHandle: encodeCompensation(
        "github-push",
        compensation,
        targetLocatorDigest(effect),
      ),
    };
  }

  async compensateGitHubPush(
    request: ShippingCompensationRequest<GitHubPushEffect>,
  ): Promise<ProviderCompensationResult> {
    const effect = request.effect;
    const recovery = validatePushCompensation(
      decodeCompensationPayload(
        request.compensationHandle,
        "github-push",
        targetLocatorDigest(effect),
      ),
      effect,
    );
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const current = await this.#ref(
      token,
      effect.owner,
      effect.repository,
      effect.branch,
      "github.compensate",
    );
    if (current.sha !== recovery.pushedSha) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.compensate",
        "The GitHub branch changed after shipping; compensation was refused.",
      );
    }
    if (recovery.priorSha === null) {
      await this.#request({
        operation: "github.compensate",
        token,
        url: githubUrl([
          "repos",
          effect.owner,
          effect.repository,
          "git",
          "refs",
          "heads",
          ...effect.branch.split("/"),
        ]),
        method: "DELETE",
        acceptedStatuses: [204],
      });
    } else {
      await this.#assertCommitExists(
        token,
        effect.owner,
        effect.repository,
        recovery.priorSha,
        "github.compensate",
      );
      const restored = await this.#request({
        operation: "github.compensate",
        token,
        url: githubUrl([
          "repos",
          effect.owner,
          effect.repository,
          "git",
          "refs",
          "heads",
          ...effect.branch.split("/"),
        ]),
        method: "PATCH",
        body: { sha: recovery.priorSha, force: true },
      });
      if (parseRefSha(restored.body, "github.compensate") !== recovery.priorSha) {
        throw new ShippingProviderInvariantError(
          "github",
          "github.compensate",
          "GitHub did not confirm the restored branch head.",
        );
      }
    }
    const after = await this.#ref(
      token,
      effect.owner,
      effect.repository,
      effect.branch,
      "github.compensate",
    );
    if (after.sha !== recovery.priorSha) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.compensate",
        "The GitHub compensation did not restore the exact prior ref.",
      );
    }
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary:
        recovery.priorSha === null
          ? "The exact branch created by Krater was removed."
          : `The exact prior GitHub head ${recovery.priorSha.slice(0, 12)} was restored.`,
      targetStateDigest: after.digest,
      evidenceIds: [
        evidenceId("github:push-compensated", {
          target: targetLocatorDigest(effect),
          restored: after.sha,
        }),
      ],
      providerReceiptHandle: receiptHandle("github:push-compensation", {
        target: targetLocatorDigest(effect),
        restored: after.sha,
      }),
    };
  }

  async inspectGitHubPullRequest(
    effect: GitHubPullRequestEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection> {
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      credentialHandle,
    );
    const state = await this.#inspectPullRequestState(
      effect,
      token,
      "github.inspect",
    );
    const exactState =
      state.existingDigest === effect.expectedExistingPullRequestDigest;
    const noDuplicate = state.pullRequests.length === 0;
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectKind: effect.kind,
      targetLocatorDigest: targetLocatorDigest(effect),
      currentStateDigest: autopilotRecordDigest({
        head: state.head.sha,
        base: state.base.sha,
        existingPullRequests: state.existingDigest,
      }),
      evidenceIds: [
        evidenceId("github:pull-request-inspection", {
          target: targetLocatorDigest(effect),
          head: state.head.sha,
          base: state.base.sha,
          existing: state.existingDigest,
        }),
      ],
      canMutate: exactState && noDuplicate,
      ...(!exactState || !noDuplicate
        ? {
            denialReason: !noDuplicate
              ? "An open pull request already exists for the exact head and base."
              : "The pull-request state changed after it was prepared.",
          }
        : {}),
      existingPullRequestDigest: state.existingDigest,
    };
  }

  async createGitHubPullRequest(
    request: ShippingMutationRequest<GitHubPullRequestEffect>,
  ): Promise<ProviderMutationResult> {
    const effect = request.effect;
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const before = await this.#inspectPullRequestState(
      effect,
      token,
      "github.pull_request.create",
    );
    if (
      before.existingDigest !== effect.expectedExistingPullRequestDigest ||
      before.pullRequests.length !== 0
    ) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.pull_request.create",
        "The exact pull-request state changed or a duplicate now exists.",
      );
    }
    const response = await this.#request({
      operation: "github.pull_request.create",
      token,
      url: githubUrl(["repos", effect.owner, effect.repository, "pulls"]),
      method: "POST",
      body: {
        title: effect.title,
        body: effect.body,
        head: `${effect.headOwner}:${effect.headBranch}`,
        base: effect.baseBranch,
        draft: effect.draft,
        maintainer_can_modify: false,
      },
      acceptedStatuses: [201],
    });
    const created = parsePullRequest(
      response.body,
      "github.pull_request.create",
    );
    const exact =
      created.state === "open" &&
      created.headSha === effect.headCommitSha &&
      created.baseSha === effect.baseCommitSha;
    const compensation: PullRequestCompensation = {
      kind: "pull_request",
      owner: effect.owner,
      repository: effect.repository,
      number: created.number,
      headSha: created.headSha,
      baseSha: created.baseSha,
    };
    const stateDigest = autopilotRecordDigest({
      provider: "github",
      resource: "pull_request",
      owner: effect.owner,
      repository: effect.repository,
      ...created,
    });
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: exact ? "succeeded" : "partially_succeeded",
      summary: exact
        ? `GitHub created pull request #${created.number} for the exact prepared commits.`
        : `GitHub created pull request #${created.number}, but its commits did not match the prepared state.`,
      targetStateDigest: stateDigest,
      evidenceIds: [
        evidenceId("github:pull-request-created", {
          target: targetLocatorDigest(effect),
          number: created.number,
          head: created.headSha,
          base: created.baseSha,
          exact,
        }),
      ],
      providerReceiptHandle: receiptHandle("github:pull-request", {
        target: targetLocatorDigest(effect),
        number: created.number,
        stateDigest,
      }),
      compensationHandle: encodeCompensation(
        "github-pr",
        compensation,
        targetLocatorDigest(effect),
      ),
    };
  }

  async compensateGitHubPullRequest(
    request: ShippingCompensationRequest<GitHubPullRequestEffect>,
  ): Promise<ProviderCompensationResult> {
    const effect = request.effect;
    const recovery = validatePullRequestCompensation(
      decodeCompensationPayload(
        request.compensationHandle,
        "github-pr",
        targetLocatorDigest(effect),
      ),
      effect,
    );
    const token = await resolveProviderToken(
      "github",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const url = githubUrl([
      "repos",
      effect.owner,
      effect.repository,
      "pulls",
      String(recovery.number),
    ]);
    const currentResponse = await this.#request({
      operation: "github.compensate",
      token,
      url,
    });
    const current = parsePullRequest(
      currentResponse.body,
      "github.compensate",
    );
    if (
      current.state !== "open" ||
      current.headSha !== recovery.headSha ||
      current.baseSha !== recovery.baseSha
    ) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.compensate",
        "The pull request changed after shipping; compensation was refused.",
      );
    }
    const closedResponse = await this.#request({
      operation: "github.compensate",
      token,
      url,
      method: "PATCH",
      body: { state: "closed" },
    });
    const closed = parsePullRequest(
      closedResponse.body,
      "github.compensate",
    );
    if (
      closed.state !== "closed" ||
      closed.headSha !== recovery.headSha ||
      closed.baseSha !== recovery.baseSha
    ) {
      throw new ShippingProviderInvariantError(
        "github",
        "github.compensate",
        "GitHub did not confirm closure of the exact pull request.",
      );
    }
    const stateDigest = autopilotRecordDigest({
      provider: "github",
      resource: "pull_request",
      owner: effect.owner,
      repository: effect.repository,
      ...closed,
    });
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary: `GitHub closed the exact pull request #${closed.number}.`,
      targetStateDigest: stateDigest,
      evidenceIds: [
        evidenceId("github:pull-request-compensated", {
          target: targetLocatorDigest(effect),
          number: closed.number,
          state: closed.state,
        }),
      ],
      providerReceiptHandle: receiptHandle(
        "github:pull-request-compensation",
        {
          target: targetLocatorDigest(effect),
          number: closed.number,
          stateDigest,
        },
      ),
    };
  }

  executor(): StructuredShippingExecutor {
    return {
      inspectGitHubPush: this.inspectGitHubPush.bind(this),
      pushGitHub: this.pushGitHub.bind(this),
      compensateGitHubPush: this.compensateGitHubPush.bind(this),
      inspectGitHubPullRequest: this.inspectGitHubPullRequest.bind(this),
      createGitHubPullRequest: this.createGitHubPullRequest.bind(this),
      compensateGitHubPullRequest:
        this.compensateGitHubPullRequest.bind(this),
    };
  }
}
