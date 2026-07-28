import type { AutopilotDigest } from "../autopilot/index.js";
import type {
  ShippingCredentialHandle,
  StructuredShippingExecutor,
} from "./types.js";

export interface ResolvedShippingCredential {
  /**
   * The credential exists only inside the host adapter call. Callers must not
   * log, persist, return, or attach this value to an Error.
   */
  token: string;
}

export interface HostShippingCredentialResolver {
  resolve(
    handle: ShippingCredentialHandle,
  ): Promise<ResolvedShippingCredential>;
}

export type ShippingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflarePagesArtifact {
  schemaVersion: 1;
  kind: "cloudflare_pages_manifest";
  /**
   * A direct-upload manifest whose content hashes have already been uploaded
   * to Cloudflare Pages by a separately audited artifact uploader.
   */
  manifest: Readonly<Record<string, string>>;
}

export type CloudflareWorkerModuleType =
  | "application/javascript+module"
  | "text/javascript+module"
  | "application/javascript"
  | "text/javascript"
  | "text/x-python"
  | "text/x-python-requirement"
  | "application/wasm"
  | "text/plain"
  | "application/octet-stream"
  | "application/source-map";

export interface CloudflareWorkerModule {
  name: string;
  contentType: CloudflareWorkerModuleType;
  content: Uint8Array;
}

export interface CloudflareWorkersArtifact {
  schemaVersion: 1;
  kind: "cloudflare_workers_modules";
  mainModule: string;
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
  modules: readonly CloudflareWorkerModule[];
}

export interface HostShippingArtifactResolver {
  resolvePagesArtifact(
    digest: AutopilotDigest,
  ): Promise<CloudflarePagesArtifact>;
  resolveWorkersArtifact(
    digest: AutopilotDigest,
  ): Promise<CloudflareWorkersArtifact>;
}

export interface GitHubProviderOptions {
  credentialResolver: HostShippingCredentialResolver;
  fetch?: ShippingFetch;
  requestTimeoutMs?: number;
}

export interface CloudflareProviderOptions {
  credentialResolver: HostShippingCredentialResolver;
  artifactResolver: HostShippingArtifactResolver;
  fetch?: ShippingFetch;
  requestTimeoutMs?: number;
}

export interface ProviderShippingExecutorOptions {
  github?: GitHubProviderOptions;
  cloudflare?: CloudflareProviderOptions;
}

export interface ProviderShippingServiceOptions
  extends ProviderShippingExecutorOptions {
  /**
   * Protected local directory used only for idempotency claims and opaque
   * compensation handles. Credential values and artifact bytes are excluded.
   */
  stateRoot: string;
  now?: () => Date;
  createId?: () => string;
}

export type ProviderShippingExecutor = StructuredShippingExecutor;
