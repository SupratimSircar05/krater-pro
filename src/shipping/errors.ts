export class ShippingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShippingError";
    this.code = code;
  }
}

export class ShippingValidationError extends ShippingError {
  constructor(message: string) {
    super("shipping_validation_failed", message);
    this.name = "ShippingValidationError";
  }
}

export class ShippingUnsupportedError extends ShippingError {
  constructor(message = "The requested structured shipping operation is unsupported.") {
    super("shipping_operation_unsupported", message);
    this.name = "ShippingUnsupportedError";
  }
}

export class ShippingConfirmationError extends ShippingError {
  constructor(message: string) {
    super("shipping_confirmation_invalid", message);
    this.name = "ShippingConfirmationError";
  }
}

export class ShippingReplayError extends ShippingError {
  constructor(message = "The shipping idempotency value has already been used.") {
    super("shipping_replay_refused", message);
    this.name = "ShippingReplayError";
  }
}

export class ShippingIdempotencyConflictError extends ShippingError {
  constructor(
    message = "The shipping idempotency value is bound to a different operation.",
  ) {
    super("shipping_idempotency_conflict", message);
    this.name = "ShippingIdempotencyConflictError";
  }
}

export class ShippingStateError extends ShippingError {
  constructor(message: string) {
    super("shipping_state_unavailable", message);
    this.name = "ShippingStateError";
  }
}

export type ShippingProviderOperation =
  | "credential.resolve"
  | "github.inspect"
  | "github.push"
  | "github.pull_request.create"
  | "github.compensate"
  | "cloudflare.inspect"
  | "cloudflare.pages.deploy"
  | "cloudflare.pages.compensate"
  | "cloudflare.workers.version.upload"
  | "cloudflare.workers.deploy"
  | "cloudflare.workers.compensate";

/**
 * A deliberately sanitized provider failure. It never carries response bodies,
 * request headers, URLs with query strings, or credential values.
 */
export class ShippingProviderError extends ShippingError {
  readonly provider: "github" | "cloudflare";
  readonly operation: ShippingProviderOperation;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(input: {
    provider: "github" | "cloudflare";
    operation: ShippingProviderOperation;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super("shipping_provider_request_failed", input.message);
    this.name = "ShippingProviderError";
    this.provider = input.provider;
    this.operation = input.operation;
    this.status = input.status;
    this.retryable =
      input.retryable ??
      (input.status === 408 ||
        input.status === 409 ||
        input.status === 425 ||
        input.status === 429 ||
        (input.status !== undefined && input.status >= 500));
  }
}

export class ShippingProviderInvariantError extends ShippingError {
  readonly provider: "github" | "cloudflare";
  readonly operation: ShippingProviderOperation;

  constructor(
    provider: "github" | "cloudflare",
    operation: ShippingProviderOperation,
    message: string,
  ) {
    super("shipping_provider_state_mismatch", message);
    this.name = "ShippingProviderInvariantError";
    this.provider = provider;
    this.operation = operation;
  }
}
