import { createHash } from "node:crypto";
import {
  autopilotRecordDigest,
  type AutopilotDigest,
} from "../autopilot/index.js";
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
import type {
  CloudflarePagesArtifact,
  CloudflareProviderOptions,
  CloudflareWorkerModule,
  CloudflareWorkersArtifact,
} from "./provider-types.js";
import {
  SHIPPING_SCHEMA_VERSION,
  type CloudflarePagesEffect,
  type CloudflareWorkersEffect,
  type ProviderCompensationResult,
  type ProviderMutationResult,
  type ShippingCompensationRequest,
  type ShippingCredentialHandle,
  type ShippingInspection,
  type ShippingMutationRequest,
  type StructuredShippingExecutor,
} from "./types.js";
import { targetLocatorDigest } from "./validation.js";

const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const CONTENT_HASH = /^[a-f0-9]{32,128}$/;
const MAX_PAGES_FILES = 20_000;
const MAX_WORKER_MODULES = 1_000;
const MAX_WORKER_MODULE_BYTES = 25 * 1024 * 1024;
const MAX_WORKER_TOTAL_BYTES = 50 * 1024 * 1024;

interface PagesDeployment {
  id: string;
  environment: "production" | "preview";
  branch: string;
  commitHash: string;
  stageStatus: string;
}

interface WorkerDeploymentVersion {
  versionId: string;
  percentage: number;
}

interface WorkerDeployment {
  id: string;
  versions: WorkerDeploymentVersion[];
}

interface PagesCompensation {
  kind: "pages";
  accountId: string;
  projectName: string;
  environment: "production" | "preview";
  branch: string;
  createdDeploymentId: string;
  priorDeploymentId: string | null;
}

interface WorkersCompensation {
  kind: "workers";
  accountId: string;
  workerName: string;
  environment: "production";
  createdDeploymentId: string;
  priorVersionId: string;
}

type CloudflareCompensation = PagesCompensation | WorkersCompensation;

function cloudflareUrl(pathSegments: readonly string[]): URL {
  return new URL(
    `/${["client", "v4", ...pathSegments]
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`,
    "https://api.cloudflare.com",
  );
}

function evidenceId(prefix: string, value: unknown): string {
  return `${prefix}:${autopilotRecordDigest(value).slice("sha256:".length, 30)}`;
}

function receiptHandle(prefix: string, value: unknown): string {
  return `${prefix}:${autopilotRecordDigest(value).slice("sha256:".length)}`;
}

function encodeCompensation(
  prefix: "cloudflare-pages" | "cloudflare-workers",
  value: CloudflareCompensation,
  targetDigest: AutopilotDigest,
): string {
  const target = targetDigest.slice("sha256:".length);
  return value.kind === "pages"
    ? `${prefix}:${target}:${value.createdDeploymentId}:${value.priorDeploymentId ?? "none"}`
    : `${prefix}:${target}:${value.createdDeploymentId}:${value.priorVersionId}`;
}

function decodeCompensationPayload(
  value: string,
  prefix: "cloudflare-pages" | "cloudflare-workers",
  expectedTargetDigest: AutopilotDigest,
): [string, string] {
  if (!value.startsWith(`${prefix}:`) || value.length > 255) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.inspect",
      "The Cloudflare recovery receipt does not match this operation.",
    );
  }
  const parts = value.slice(prefix.length + 1).split(":");
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0) ||
    parts[0] !== expectedTargetDigest.slice("sha256:".length)
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.inspect",
      "The Cloudflare recovery receipt is malformed.",
    );
  }
  return parts.slice(1) as [string, string];
}

function envelopeResult(
  body: unknown,
  operation: ShippingProviderOperation,
): unknown {
  const envelope = plainProviderObject(
    body,
    "cloudflare",
    operation,
    "response envelope",
  );
  if (envelope.success !== true || !("result" in envelope)) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      operation,
      "Cloudflare did not confirm a successful structured response.",
    );
  }
  return envelope.result;
}

function safeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === "..") &&
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

function sortedManifest(
  manifest: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function cloudflarePagesArtifactDigest(
  artifact: CloudflarePagesArtifact,
): AutopilotDigest {
  return autopilotRecordDigest({
    schemaVersion: artifact.schemaVersion,
    kind: artifact.kind,
    manifest: sortedManifest(artifact.manifest),
  });
}

function moduleContentDigest(module: CloudflareWorkerModule): string {
  return createHash("sha256").update(module.content).digest("hex");
}

export function cloudflareWorkersArtifactDigest(
  artifact: CloudflareWorkersArtifact,
): AutopilotDigest {
  return autopilotRecordDigest({
    schemaVersion: artifact.schemaVersion,
    kind: artifact.kind,
    mainModule: artifact.mainModule,
    compatibilityDate: artifact.compatibilityDate ?? null,
    compatibilityFlags: [...(artifact.compatibilityFlags ?? [])],
    modules: [...artifact.modules]
      .map((module) => ({
        name: module.name,
        contentType: module.contentType,
        contentDigest: moduleContentDigest(module),
        size: module.content.byteLength,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

function validatePagesArtifact(
  artifact: CloudflarePagesArtifact,
  expectedDigest: AutopilotDigest,
): CloudflarePagesArtifact {
  if (
    artifact.schemaVersion !== 1 ||
    artifact.kind !== "cloudflare_pages_manifest" ||
    artifact.manifest === null ||
    typeof artifact.manifest !== "object" ||
    Array.isArray(artifact.manifest) ||
    (Object.getPrototypeOf(artifact.manifest) !== Object.prototype &&
      Object.getPrototypeOf(artifact.manifest) !== null)
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.pages.deploy",
      "The host returned an invalid Pages artifact descriptor.",
    );
  }
  const entries = Object.entries(artifact.manifest);
  if (
    entries.length === 0 ||
    entries.length > MAX_PAGES_FILES ||
    entries.some(
      ([path, hash]) =>
        !safeArtifactPath(path) ||
        typeof hash !== "string" ||
        !CONTENT_HASH.test(hash),
    ) ||
    cloudflarePagesArtifactDigest(artifact) !== expectedDigest
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.pages.deploy",
      "The Pages artifact does not match the exact prepared digest.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "cloudflare_pages_manifest",
    manifest: sortedManifest(artifact.manifest),
  };
}

function validateWorkersArtifact(
  artifact: CloudflareWorkersArtifact,
  expectedDigest: AutopilotDigest,
): CloudflareWorkersArtifact {
  const allowedTypes = new Set([
    "application/javascript+module",
    "text/javascript+module",
    "application/javascript",
    "text/javascript",
    "text/x-python",
    "text/x-python-requirement",
    "application/wasm",
    "text/plain",
    "application/octet-stream",
    "application/source-map",
  ]);
  if (
    artifact.schemaVersion !== 1 ||
    artifact.kind !== "cloudflare_workers_modules" ||
    !Array.isArray(artifact.modules) ||
    artifact.modules.length === 0 ||
    artifact.modules.length > MAX_WORKER_MODULES ||
    !safeArtifactPath(artifact.mainModule)
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.workers.version.upload",
      "The host returned an invalid Workers artifact descriptor.",
    );
  }
  const names = new Set<string>();
  let totalBytes = 0;
  for (const module of artifact.modules) {
    if (
      !module ||
      typeof module !== "object" ||
      !safeArtifactPath(module.name) ||
      names.has(module.name) ||
      !allowedTypes.has(module.contentType) ||
      !(module.content instanceof Uint8Array) ||
      module.content.byteLength === 0 ||
      module.content.byteLength > MAX_WORKER_MODULE_BYTES
    ) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.version.upload",
        "The Workers artifact contains an unsupported module.",
      );
    }
    names.add(module.name);
    totalBytes += module.content.byteLength;
  }
  if (
    !names.has(artifact.mainModule) ||
    totalBytes > MAX_WORKER_TOTAL_BYTES ||
    (artifact.compatibilityDate !== undefined &&
      !/^\d{4}-\d{2}-\d{2}$/.test(artifact.compatibilityDate)) ||
    (artifact.compatibilityFlags !== undefined &&
      (!Array.isArray(artifact.compatibilityFlags) ||
        new Set(artifact.compatibilityFlags).size !==
          artifact.compatibilityFlags.length ||
        artifact.compatibilityFlags.some(
          (flag) =>
            typeof flag !== "string" ||
            !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(flag),
        ))) ||
    cloudflareWorkersArtifactDigest(artifact) !== expectedDigest
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.workers.version.upload",
      "The Workers artifact does not match the exact prepared digest.",
    );
  }
  return artifact;
}

export function cloudflarePagesDeploymentDigest(
  deployment: Pick<
    PagesDeployment,
    "id" | "environment" | "branch" | "commitHash"
  >,
): AutopilotDigest {
  return autopilotRecordDigest({
    provider: "cloudflare",
    resource: "pages_deployment",
    id: deployment.id,
    environment: deployment.environment,
    branch: deployment.branch,
    commitHash: deployment.commitHash,
  });
}

export function cloudflareWorkersDeploymentDigest(
  deployment: WorkerDeployment,
): AutopilotDigest {
  return autopilotRecordDigest({
    provider: "cloudflare",
    resource: "workers_deployment",
    id: deployment.id,
    versions: [...deployment.versions].sort((left, right) =>
      left.versionId.localeCompare(right.versionId),
    ),
  });
}

function emptyDeploymentDigest(input: {
  resource: "pages" | "workers";
  target: AutopilotDigest;
}): AutopilotDigest {
  return autopilotRecordDigest({
    provider: "cloudflare",
    resource: input.resource,
    target: input.target,
    deployment: null,
  });
}

function parsePagesDeployment(
  body: unknown,
  operation: ShippingProviderOperation,
): PagesDeployment {
  const object = plainProviderObject(
    body,
    "cloudflare",
    operation,
    "Pages deployment",
  );
  const trigger = plainProviderObject(
    object.deployment_trigger,
    "cloudflare",
    operation,
    "Pages deployment trigger",
  );
  const metadata = plainProviderObject(
    trigger.metadata,
    "cloudflare",
    operation,
    "Pages deployment metadata",
  );
  const stage =
    object.latest_stage === undefined
      ? {}
      : plainProviderObject(
          object.latest_stage,
          "cloudflare",
          operation,
          "Pages deployment stage",
        );
  const environment = providerString(
    object.environment,
    "cloudflare",
    operation,
    "Pages environment",
    /^(?:production|preview)$/,
  ) as "production" | "preview";
  return {
    id: providerString(
      object.id,
      "cloudflare",
      operation,
      "Pages deployment identifier",
      DEPLOYMENT_ID,
    ),
    environment,
    branch: providerString(
      metadata.branch,
      "cloudflare",
      operation,
      "Pages branch",
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/,
    ),
    commitHash:
      typeof metadata.commit_hash === "string" &&
      /^[A-Za-z0-9._:-]{0,128}$/.test(metadata.commit_hash)
        ? metadata.commit_hash
        : "",
    stageStatus:
      typeof stage.status === "string" &&
      /^[a-z_]{2,32}$/.test(stage.status)
        ? stage.status
        : "unknown",
  };
}

function parseWorkerDeployment(
  body: unknown,
  operation: ShippingProviderOperation,
): WorkerDeployment {
  const object = plainProviderObject(
    body,
    "cloudflare",
    operation,
    "Workers deployment",
  );
  if (!Array.isArray(object.versions) || object.versions.length === 0) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      operation,
      "Cloudflare returned a Workers deployment without versions.",
    );
  }
  const versions = object.versions.map((raw) => {
    const value = plainProviderObject(
      raw,
      "cloudflare",
      operation,
      "Workers deployment version",
    );
    if (
      typeof value.percentage !== "number" ||
      !Number.isFinite(value.percentage) ||
      value.percentage <= 0 ||
      value.percentage > 100
    ) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        operation,
        "Cloudflare returned an invalid Workers traffic percentage.",
      );
    }
    return {
      versionId: providerString(
        value.version_id,
        "cloudflare",
        operation,
        "Workers version identifier",
        VERSION_ID,
      ),
      percentage: value.percentage,
    };
  });
  return {
    id: providerString(
      object.id,
      "cloudflare",
      operation,
      "Workers deployment identifier",
      DEPLOYMENT_ID,
    ),
    versions,
  };
}

function parsePagesCompensation(
  payload: [string, string],
  effect: CloudflarePagesEffect,
): PagesCompensation {
  const value: PagesCompensation = {
    kind: "pages",
    accountId: effect.accountId,
    projectName: effect.projectName,
    environment: effect.environment,
    branch: effect.branch,
    createdDeploymentId: payload[0],
    priorDeploymentId: payload[1] === "none" ? null : payload[1],
  };
  if (
    !DEPLOYMENT_ID.test(String(value.createdDeploymentId)) ||
    (value.priorDeploymentId !== null &&
      !DEPLOYMENT_ID.test(String(value.priorDeploymentId)))
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.pages.compensate",
      "The Pages recovery receipt is invalid.",
    );
  }
  return value;
}

function parseWorkersCompensation(
  payload: [string, string],
  effect: CloudflareWorkersEffect,
): WorkersCompensation {
  const value: WorkersCompensation = {
    kind: "workers",
    accountId: effect.accountId,
    workerName: effect.workerName,
    environment: "production",
    createdDeploymentId: payload[0],
    priorVersionId: payload[1],
  };
  if (
    !DEPLOYMENT_ID.test(String(value.createdDeploymentId)) ||
    !VERSION_ID.test(String(value.priorVersionId))
  ) {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.workers.compensate",
      "The Workers recovery receipt is invalid.",
    );
  }
  if (effect.environment !== "production") {
    throw new ShippingProviderInvariantError(
      "cloudflare",
      "cloudflare.workers.compensate",
      "The Workers recovery receipt is not for a supported environment.",
    );
  }
  return value;
}

export class CloudflareStructuredShippingProvider {
  readonly #options: CloudflareProviderOptions;

  constructor(options: CloudflareProviderOptions) {
    this.#options = options;
  }

  async #pagesArtifact(
    effect: CloudflarePagesEffect,
  ): Promise<CloudflarePagesArtifact> {
    try {
      return validatePagesArtifact(
        await this.#options.artifactResolver.resolvePagesArtifact(
          effect.artifactDigest,
        ),
        effect.artifactDigest,
      );
    } catch (error) {
      if (error instanceof ShippingProviderInvariantError) throw error;
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.pages.deploy",
        "The host could not resolve the prepared Pages artifact.",
      );
    }
  }

  async #workersArtifact(
    effect: CloudflareWorkersEffect,
  ): Promise<CloudflareWorkersArtifact> {
    try {
      return validateWorkersArtifact(
        await this.#options.artifactResolver.resolveWorkersArtifact(
          effect.artifactDigest,
        ),
        effect.artifactDigest,
      );
    } catch (error) {
      if (error instanceof ShippingProviderInvariantError) throw error;
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.version.upload",
        "The host could not resolve the prepared Workers artifact.",
      );
    }
  }

  async #request(input: {
    operation: ShippingProviderOperation;
    token: string;
    url: URL;
    method?: "GET" | "POST" | "DELETE";
    body?: RequestInit["body"];
    json?: unknown;
    acceptedStatuses?: readonly number[];
  }) {
    return providerRequest({
      provider: "cloudflare",
      operation: input.operation,
      fetch: this.#options.fetch,
      timeoutMs: this.#options.requestTimeoutMs,
      url: input.url,
      token: input.token,
      method: input.method,
      headers:
        input.json === undefined ? {} : { "content-type": "application/json" },
      ...(input.json !== undefined
        ? { body: JSON.stringify(input.json) }
        : input.body !== undefined
          ? { body: input.body }
          : {}),
      acceptedStatuses: input.acceptedStatuses,
    });
  }

  async #pagesDeployments(
    token: string,
    effect: CloudflarePagesEffect,
    operation: ShippingProviderOperation,
  ): Promise<PagesDeployment[]> {
    const url = cloudflareUrl([
      "accounts",
      effect.accountId,
      "pages",
      "projects",
      effect.projectName,
      "deployments",
    ]);
    url.searchParams.set("env", effect.environment);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "100");
    const response = await this.#request({ operation, token, url });
    const result = envelopeResult(response.body, operation);
    if (!Array.isArray(result)) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        operation,
        "Cloudflare returned a malformed Pages deployment list.",
      );
    }
    return result
      .map((item) => parsePagesDeployment(item, operation))
      .filter(
        (deployment) =>
          deployment.environment === effect.environment &&
          deployment.branch === effect.branch,
      );
  }

  async #workersDeployments(
    token: string,
    effect: CloudflareWorkersEffect,
    operation: ShippingProviderOperation,
  ): Promise<WorkerDeployment[]> {
    if (effect.environment !== "production") {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        operation,
        "The initial Workers adapter supports only the production environment.",
      );
    }
    const response = await this.#request({
      operation,
      token,
      url: cloudflareUrl([
        "accounts",
        effect.accountId,
        "workers",
        "scripts",
        effect.workerName,
        "deployments",
      ]),
    });
    const result = plainProviderObject(
      envelopeResult(response.body, operation),
      "cloudflare",
      operation,
      "Workers deployment list",
    );
    if (!Array.isArray(result.deployments)) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        operation,
        "Cloudflare returned a malformed Workers deployment list.",
      );
    }
    return result.deployments.map((item) =>
      parseWorkerDeployment(item, operation),
    );
  }

  async inspectCloudflarePages(
    effect: CloudflarePagesEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection> {
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      credentialHandle,
    );
    const [deployments] = await Promise.all([
      this.#pagesDeployments(token, effect, "cloudflare.inspect"),
      this.#pagesArtifact(effect),
    ]);
    const current = deployments[0];
    const currentDigest = current
      ? cloudflarePagesDeploymentDigest(current)
      : null;
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectKind: effect.kind,
      targetLocatorDigest: targetLocatorDigest(effect),
      currentStateDigest:
        currentDigest ??
        emptyDeploymentDigest({
          resource: "pages",
          target: targetLocatorDigest(effect),
        }),
      evidenceIds: [
        evidenceId("cloudflare:pages-inspection", {
          target: targetLocatorDigest(effect),
          current: currentDigest,
        }),
      ],
      canMutate: currentDigest === effect.expectedCurrentDeploymentDigest,
      ...(currentDigest === effect.expectedCurrentDeploymentDigest
        ? {}
        : {
            denialReason:
              "The Cloudflare Pages deployment changed after preparation.",
          }),
      currentDeploymentDigest: currentDigest,
    };
  }

  async deployCloudflarePages(
    request: ShippingMutationRequest<CloudflarePagesEffect>,
  ): Promise<ProviderMutationResult> {
    const effect = request.effect;
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const before = (
      await this.#pagesDeployments(
        token,
        effect,
        "cloudflare.pages.deploy",
      )
    )[0];
    const beforeDigest = before
      ? cloudflarePagesDeploymentDigest(before)
      : null;
    if (beforeDigest !== effect.expectedCurrentDeploymentDigest) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.pages.deploy",
        "The Pages deployment changed after preflight; deployment was refused.",
      );
    }
    const artifact = await this.#pagesArtifact(effect);
    const form = new FormData();
    form.set("manifest", JSON.stringify(artifact.manifest));
    form.set("branch", effect.branch);
    form.set("commit_dirty", "true");
    form.set(
      "commit_message",
      `Krater Pro artifact ${effect.artifactDigest}`,
    );
    const response = await this.#request({
      operation: "cloudflare.pages.deploy",
      token,
      url: cloudflareUrl([
        "accounts",
        effect.accountId,
        "pages",
        "projects",
        effect.projectName,
        "deployments",
      ]),
      method: "POST",
      body: form,
      acceptedStatuses: [200, 201],
    });
    const created = parsePagesDeployment(
      envelopeResult(response.body, "cloudflare.pages.deploy"),
      "cloudflare.pages.deploy",
    );
    const exact =
      created.environment === effect.environment &&
      created.branch === effect.branch;
    const canCompensate =
      effect.environment === "preview" ||
      Boolean(before && before.stageStatus === "success");
    const compensation: PagesCompensation = {
      kind: "pages",
      accountId: effect.accountId,
      projectName: effect.projectName,
      environment: effect.environment,
      branch: effect.branch,
      createdDeploymentId: created.id,
      priorDeploymentId: before?.id ?? null,
    };
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: exact ? "succeeded" : "partially_succeeded",
      summary: exact
        ? `Cloudflare accepted the exact Pages manifest as deployment ${created.id}.`
        : `Cloudflare created Pages deployment ${created.id}, but its environment or branch did not match.`,
      targetStateDigest: effect.artifactDigest,
      evidenceIds: [
        evidenceId("cloudflare:pages-deployed", {
          target: targetLocatorDigest(effect),
          deploymentId: created.id,
          artifactDigest: effect.artifactDigest,
          exact,
        }),
      ],
      providerReceiptHandle: receiptHandle("cloudflare:pages", {
        target: targetLocatorDigest(effect),
        deploymentId: created.id,
        artifactDigest: effect.artifactDigest,
      }),
      ...(canCompensate
        ? {
            compensationHandle: encodeCompensation(
              "cloudflare-pages",
              compensation,
              targetLocatorDigest(effect),
            ),
          }
        : {}),
    };
  }

  async compensateCloudflarePages(
    request: ShippingCompensationRequest<CloudflarePagesEffect>,
  ): Promise<ProviderCompensationResult> {
    const effect = request.effect;
    const recovery = parsePagesCompensation(
      decodeCompensationPayload(
        request.compensationHandle,
        "cloudflare-pages",
        targetLocatorDigest(effect),
      ),
      effect,
    );
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const current = (
      await this.#pagesDeployments(
        token,
        effect,
        "cloudflare.pages.compensate",
      )
    )[0];
    if (current?.id !== recovery.createdDeploymentId) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.pages.compensate",
        "The active Pages deployment changed after shipping; compensation was refused.",
      );
    }
    let resultDigest: AutopilotDigest;
    let receiptDeploymentId: string;
    if (effect.environment === "production") {
      if (!recovery.priorDeploymentId) {
        throw new ShippingProviderInvariantError(
          "cloudflare",
          "cloudflare.pages.compensate",
          "No successful prior production deployment is available.",
        );
      }
      const response = await this.#request({
        operation: "cloudflare.pages.compensate",
        token,
        url: cloudflareUrl([
          "accounts",
          effect.accountId,
          "pages",
          "projects",
          effect.projectName,
          "deployments",
          recovery.priorDeploymentId,
          "rollback",
        ]),
        method: "POST",
        json: {},
      });
      const rolledBack = parsePagesDeployment(
        envelopeResult(response.body, "cloudflare.pages.compensate"),
        "cloudflare.pages.compensate",
      );
      if (rolledBack.environment !== "production") {
        throw new ShippingProviderInvariantError(
          "cloudflare",
          "cloudflare.pages.compensate",
          "Cloudflare did not confirm a production rollback.",
        );
      }
      resultDigest = cloudflarePagesDeploymentDigest(rolledBack);
      receiptDeploymentId = rolledBack.id;
    } else {
      await this.#request({
        operation: "cloudflare.pages.compensate",
        token,
        url: cloudflareUrl([
          "accounts",
          effect.accountId,
          "pages",
          "projects",
          effect.projectName,
          "deployments",
          recovery.createdDeploymentId,
        ]),
        method: "DELETE",
        acceptedStatuses: [200, 204],
      });
      const after = (
        await this.#pagesDeployments(
          token,
          effect,
          "cloudflare.pages.compensate",
        )
      )[0];
      if ((after?.id ?? null) !== recovery.priorDeploymentId) {
        throw new ShippingProviderInvariantError(
          "cloudflare",
          "cloudflare.pages.compensate",
          "The preview deployment could not be reconciled after deletion.",
        );
      }
      resultDigest = after
        ? cloudflarePagesDeploymentDigest(after)
        : emptyDeploymentDigest({
            resource: "pages",
            target: targetLocatorDigest(effect),
          });
      receiptDeploymentId = recovery.createdDeploymentId;
    }
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary:
        effect.environment === "production"
          ? "Cloudflare rolled production back to the exact prior deployment."
          : "Cloudflare removed the exact preview deployment created by Krater.",
      targetStateDigest: resultDigest,
      evidenceIds: [
        evidenceId("cloudflare:pages-compensated", {
          target: targetLocatorDigest(effect),
          receiptDeploymentId,
          resultDigest,
        }),
      ],
      providerReceiptHandle: receiptHandle(
        "cloudflare:pages-compensation",
        {
          target: targetLocatorDigest(effect),
          receiptDeploymentId,
          resultDigest,
        },
      ),
    };
  }

  async inspectCloudflareWorkers(
    effect: CloudflareWorkersEffect,
    credentialHandle: ShippingCredentialHandle,
  ): Promise<ShippingInspection> {
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      credentialHandle,
    );
    const [deployments] = await Promise.all([
      this.#workersDeployments(token, effect, "cloudflare.inspect"),
      this.#workersArtifact(effect),
    ]);
    const current = deployments[0];
    const currentDigest = current
      ? cloudflareWorkersDeploymentDigest(current)
      : null;
    const reversible =
      !current ||
      (current.versions.length === 1 &&
        current.versions[0]?.percentage === 100);
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      effectKind: effect.kind,
      targetLocatorDigest: targetLocatorDigest(effect),
      currentStateDigest:
        currentDigest ??
        emptyDeploymentDigest({
          resource: "workers",
          target: targetLocatorDigest(effect),
        }),
      evidenceIds: [
        evidenceId("cloudflare:workers-inspection", {
          target: targetLocatorDigest(effect),
          current: currentDigest,
          reversible,
        }),
      ],
      canMutate:
        reversible &&
        currentDigest === effect.expectedCurrentDeploymentDigest,
      ...(!reversible ||
      currentDigest !== effect.expectedCurrentDeploymentDigest
        ? {
            denialReason: !reversible
              ? "Traffic-split Workers deployments are not supported by the exact rollback adapter."
              : "The Workers deployment changed after preparation.",
          }
        : {}),
      currentDeploymentDigest: currentDigest,
    };
  }

  async deployCloudflareWorkers(
    request: ShippingMutationRequest<CloudflareWorkersEffect>,
  ): Promise<ProviderMutationResult> {
    const effect = request.effect;
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const before = (
      await this.#workersDeployments(
        token,
        effect,
        "cloudflare.workers.deploy",
      )
    )[0];
    const beforeDigest = before
      ? cloudflareWorkersDeploymentDigest(before)
      : null;
    if (beforeDigest !== effect.expectedCurrentDeploymentDigest) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.deploy",
        "The Workers deployment changed after preflight; deployment was refused.",
      );
    }
    if (
      before &&
      (before.versions.length !== 1 ||
        before.versions[0]?.percentage !== 100)
    ) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.deploy",
        "Traffic-split Workers deployments are unsupported because exact rollback cannot be guaranteed.",
      );
    }
    const artifact = await this.#workersArtifact(effect);

    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: artifact.mainModule,
        annotations: {
          "workers/message": `Krater Pro artifact ${effect.artifactDigest}`,
          "workers/triggered_by": "krater-pro",
        },
        ...(artifact.compatibilityDate
          ? { compatibility_date: artifact.compatibilityDate }
          : {}),
        ...(artifact.compatibilityFlags
          ? { compatibility_flags: artifact.compatibilityFlags }
          : {}),
      }),
    );
    for (const module of artifact.modules) {
      form.append(
        module.name,
        new Blob([Buffer.from(module.content)], {
          type: module.contentType,
        }),
        module.name,
      );
    }
    const versionResponse = await this.#request({
      operation: "cloudflare.workers.version.upload",
      token,
      url: cloudflareUrl([
        "accounts",
        effect.accountId,
        "workers",
        "scripts",
        effect.workerName,
        "versions",
      ]),
      method: "POST",
      body: form,
      acceptedStatuses: [200, 201],
    });
    const version = plainProviderObject(
      envelopeResult(
        versionResponse.body,
        "cloudflare.workers.version.upload",
      ),
      "cloudflare",
      "cloudflare.workers.version.upload",
      "Workers version",
    );
    const versionId = providerString(
      version.id,
      "cloudflare",
      "cloudflare.workers.version.upload",
      "Workers version identifier",
      VERSION_ID,
    );

    let deploymentResponse;
    try {
      deploymentResponse = await this.#request({
        operation: "cloudflare.workers.deploy",
        token,
        url: cloudflareUrl([
          "accounts",
          effect.accountId,
          "workers",
          "scripts",
          effect.workerName,
          "deployments",
        ]),
        method: "POST",
        json: {
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: versionId }],
          annotations: {
            "workers/message": `Krater Pro artifact ${effect.artifactDigest}`,
            "workers/triggered_by": "krater-pro",
          },
        },
        acceptedStatuses: [200, 201],
      });
    } catch {
      return {
        schemaVersion: SHIPPING_SCHEMA_VERSION,
        status: "partially_succeeded",
        summary:
          "Cloudflare stored the exact Worker version but did not confirm traffic deployment; the inactive version may require provider-side cleanup.",
        targetStateDigest:
          beforeDigest ??
          emptyDeploymentDigest({
            resource: "workers",
            target: targetLocatorDigest(effect),
          }),
        evidenceIds: [
          evidenceId("cloudflare:workers-version-only", {
            target: targetLocatorDigest(effect),
            versionId,
            artifactDigest: effect.artifactDigest,
          }),
        ],
        providerReceiptHandle: receiptHandle("cloudflare:workers-version", {
          target: targetLocatorDigest(effect),
          versionId,
          artifactDigest: effect.artifactDigest,
        }),
      };
    }
    const deployed = parseWorkerDeployment(
      envelopeResult(
        deploymentResponse.body,
        "cloudflare.workers.deploy",
      ),
      "cloudflare.workers.deploy",
    );
    const exact =
      deployed.versions.length === 1 &&
      deployed.versions[0]?.versionId === versionId &&
      deployed.versions[0]?.percentage === 100;
    const priorVersionId = before?.versions[0]?.versionId;
    const compensation: WorkersCompensation | undefined = priorVersionId
      ? {
          kind: "workers",
          accountId: effect.accountId,
          workerName: effect.workerName,
          environment: "production",
          createdDeploymentId: deployed.id,
          priorVersionId,
        }
      : undefined;
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: exact ? "succeeded" : "partially_succeeded",
      summary: exact
        ? `Cloudflare deployed the exact Worker artifact as version ${versionId}.`
        : `Cloudflare created deployment ${deployed.id}, but traffic did not resolve entirely to the uploaded version.`,
      targetStateDigest: effect.artifactDigest,
      evidenceIds: [
        evidenceId("cloudflare:workers-deployed", {
          target: targetLocatorDigest(effect),
          deploymentId: deployed.id,
          versionId,
          artifactDigest: effect.artifactDigest,
          exact,
        }),
      ],
      providerReceiptHandle: receiptHandle("cloudflare:workers", {
        target: targetLocatorDigest(effect),
        deploymentId: deployed.id,
        versionId,
        artifactDigest: effect.artifactDigest,
      }),
      ...(compensation
        ? {
            compensationHandle: encodeCompensation(
              "cloudflare-workers",
              compensation,
              targetLocatorDigest(effect),
            ),
          }
        : {}),
    };
  }

  async compensateCloudflareWorkers(
    request: ShippingCompensationRequest<CloudflareWorkersEffect>,
  ): Promise<ProviderCompensationResult> {
    const effect = request.effect;
    const recovery = parseWorkersCompensation(
      decodeCompensationPayload(
        request.compensationHandle,
        "cloudflare-workers",
        targetLocatorDigest(effect),
      ),
      effect,
    );
    const token = await resolveProviderToken(
      "cloudflare",
      this.#options.credentialResolver,
      request.credentialHandle,
    );
    const current = (
      await this.#workersDeployments(
        token,
        effect,
        "cloudflare.workers.compensate",
      )
    )[0];
    if (current?.id !== recovery.createdDeploymentId) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.compensate",
        "The active Workers deployment changed after shipping; compensation was refused.",
      );
    }
    const response = await this.#request({
      operation: "cloudflare.workers.compensate",
      token,
      url: cloudflareUrl([
        "accounts",
        effect.accountId,
        "workers",
        "scripts",
        effect.workerName,
        "deployments",
      ]),
      method: "POST",
      json: {
        strategy: "percentage",
        versions: [
          { percentage: 100, version_id: recovery.priorVersionId },
        ],
        annotations: {
          "workers/message": "Krater Pro structured compensation",
          "workers/triggered_by": "krater-pro",
        },
      },
      acceptedStatuses: [200, 201],
    });
    const restored = parseWorkerDeployment(
      envelopeResult(
        response.body,
        "cloudflare.workers.compensate",
      ),
      "cloudflare.workers.compensate",
    );
    if (
      restored.versions.length !== 1 ||
      restored.versions[0]?.versionId !== recovery.priorVersionId ||
      restored.versions[0]?.percentage !== 100
    ) {
      throw new ShippingProviderInvariantError(
        "cloudflare",
        "cloudflare.workers.compensate",
        "Cloudflare did not restore all traffic to the exact prior Worker version.",
      );
    }
    const stateDigest = cloudflareWorkersDeploymentDigest(restored);
    return {
      schemaVersion: SHIPPING_SCHEMA_VERSION,
      status: "succeeded",
      summary: `Cloudflare restored all Worker traffic to version ${recovery.priorVersionId}.`,
      targetStateDigest: stateDigest,
      evidenceIds: [
        evidenceId("cloudflare:workers-compensated", {
          target: targetLocatorDigest(effect),
          deploymentId: restored.id,
          versionId: recovery.priorVersionId,
        }),
      ],
      providerReceiptHandle: receiptHandle(
        "cloudflare:workers-compensation",
        {
          target: targetLocatorDigest(effect),
          deploymentId: restored.id,
          stateDigest,
        },
      ),
    };
  }

  executor(): StructuredShippingExecutor {
    return {
      inspectCloudflarePages: this.inspectCloudflarePages.bind(this),
      deployCloudflarePages: this.deployCloudflarePages.bind(this),
      compensateCloudflarePages: this.compensateCloudflarePages.bind(this),
      inspectCloudflareWorkers: this.inspectCloudflareWorkers.bind(this),
      deployCloudflareWorkers: this.deployCloudflareWorkers.bind(this),
      compensateCloudflareWorkers:
        this.compensateCloudflareWorkers.bind(this),
    };
  }
}
