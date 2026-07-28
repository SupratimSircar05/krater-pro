import { join, resolve } from "node:path";
import { CloudflareStructuredShippingProvider } from "./cloudflare-provider.js";
import { GitHubStructuredShippingProvider } from "./github-provider.js";
import type {
  ProviderShippingExecutorOptions,
  ProviderShippingServiceOptions,
} from "./provider-types.js";
import { StructuredShippingService } from "./service.js";
import {
  FileShippingLedger,
  FileShippingRuntimeVault,
} from "./state.js";
import type { StructuredShippingExecutor } from "./types.js";

/**
 * Creates only the explicitly configured provider methods. An omitted provider
 * remains structurally unsupported rather than discovering ambient tokens.
 */
export function createProviderShippingExecutor(
  options: ProviderShippingExecutorOptions,
): StructuredShippingExecutor {
  return {
    ...(options.github
      ? new GitHubStructuredShippingProvider(options.github).executor()
      : {}),
    ...(options.cloudflare
      ? new CloudflareStructuredShippingProvider(
          options.cloudflare,
        ).executor()
      : {}),
  };
}

/**
 * Production service factory with persistent idempotency and compensation
 * state. The state contains digests and opaque handles only.
 */
export function createProviderShippingService(
  options: ProviderShippingServiceOptions,
): StructuredShippingService {
  const stateRoot = resolve(options.stateRoot);
  return new StructuredShippingService({
    executor: createProviderShippingExecutor(options),
    ledger: new FileShippingLedger(
      join(stateRoot, "shipping-attempts.json"),
    ),
    vault: new FileShippingRuntimeVault(
      join(stateRoot, "shipping-compensation.json"),
    ),
    now: options.now,
    createId: options.createId,
  });
}
