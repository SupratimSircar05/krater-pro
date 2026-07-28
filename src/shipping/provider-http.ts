import {
  ShippingProviderError,
  ShippingProviderInvariantError,
  type ShippingProviderOperation,
} from "./errors.js";
import type {
  HostShippingCredentialResolver,
  ShippingFetch,
} from "./provider-types.js";
import type {
  ShippingCredentialHandle,
  ShippingProvider,
} from "./types.js";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ProviderHttpResult {
  status: number;
  body: unknown;
}

export function assertProviderCredentialHandle(
  handle: ShippingCredentialHandle,
  provider: ShippingProvider,
): void {
  if (
    handle.schemaVersion !== 1 ||
    handle.provider !== provider ||
    !handle.id.startsWith(`credential:${provider}:`)
  ) {
    throw new ShippingProviderInvariantError(
      provider,
      "credential.resolve",
      "The host credential handle does not match the provider.",
    );
  }
}

export async function resolveProviderToken(
  provider: ShippingProvider,
  resolver: HostShippingCredentialResolver,
  handle: ShippingCredentialHandle,
): Promise<string> {
  assertProviderCredentialHandle(handle, provider);
  let token: string;
  try {
    token = (await resolver.resolve(handle)).token;
  } catch {
    throw new ShippingProviderError({
      provider,
      operation: "credential.resolve",
      message: "The host credential handle could not be resolved.",
    });
  }
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 4_096 ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new ShippingProviderError({
      provider,
      operation: "credential.resolve",
      message: "The host credential resolver returned an invalid value.",
    });
  }
  return token;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error(
      "Provider request timeout must be an integer from 1000 to 120000 milliseconds.",
    );
  }
  return timeout;
}

async function readBoundedBody(
  response: Response,
  provider: ShippingProvider,
  operation: ShippingProviderOperation,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new ShippingProviderError({
      provider,
      operation,
      status: response.status,
      message: "The provider response exceeded the safe size limit.",
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ShippingProviderError({
      provider,
      operation,
      status: response.status,
      message: "The provider response exceeded the safe size limit.",
    });
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ShippingProviderError({
      provider,
      operation,
      status: response.status,
      message: "The provider returned a malformed response.",
    });
  }
}

export async function providerRequest(input: {
  provider: ShippingProvider;
  operation: ShippingProviderOperation;
  fetch?: ShippingFetch;
  timeoutMs?: number;
  url: URL;
  token: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: RequestInit["body"];
  acceptedStatuses?: readonly number[];
}): Promise<ProviderHttpResult> {
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(input.url, {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        ...input.headers,
        authorization: `Bearer ${input.token}`,
      },
      ...(input.body !== undefined ? { body: input.body } : {}),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new ShippingProviderError({
      provider: input.provider,
      operation: input.operation,
      message: "The provider request did not complete.",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await readBoundedBody(
    response,
    input.provider,
    input.operation,
  );
  const accepted = input.acceptedStatuses ?? [200];
  if (!accepted.includes(response.status)) {
    throw new ShippingProviderError({
      provider: input.provider,
      operation: input.operation,
      status: response.status,
      message: `The provider rejected the structured operation (HTTP ${response.status}).`,
    });
  }
  return { status: response.status, body };
}

export function plainProviderObject(
  value: unknown,
  provider: ShippingProvider,
  operation: ShippingProviderOperation,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShippingProviderInvariantError(
      provider,
      operation,
      `The provider response omitted ${field}.`,
    );
  }
  return value as Record<string, unknown>;
}

export function providerString(
  value: unknown,
  provider: ShippingProvider,
  operation: ShippingProviderOperation,
  field: string,
  pattern: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !pattern.test(value)
  ) {
    throw new ShippingProviderInvariantError(
      provider,
      operation,
      `The provider response contained an invalid ${field}.`,
    );
  }
  return value;
}
