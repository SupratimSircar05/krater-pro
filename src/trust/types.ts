export const CONTEXT_SOURCES = [
  "user",
  "system_policy",
  "repository",
  "local_tool",
  "external_tool",
  "generated",
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export type ContextTrust =
  | "authoritative_instruction"
  | "approved_policy"
  | "untrusted_data";

export type ContextSensitivity =
  | "public"
  | "proprietary"
  | "pii"
  | "secret"
  | "license_restricted";

export type ContextDestination =
  | "model"
  | "network"
  | "command"
  | "cache"
  | "export"
  | "local_tool";

export interface LabeledContext {
  id: string;
  content: string;
  source: ContextSource;
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  permittedDestinations?: readonly ContextDestination[];
  permittedOperations?: readonly string[];
}

export interface CapabilityExceptions {
  untrustedDataToCommand?: boolean;
  secretToModel?: boolean;
  secretToNetwork?: boolean;
  licenseRestrictedEgress?: boolean;
}

export interface CapabilityGrant {
  id: string;
  operation: string;
  resource: string;
  scope: string;
  issuedBy: "user" | "approved_policy";
  issuedAt: number;
  durationMs: number;
  expiresAt: number;
  exceptions: Readonly<CapabilityExceptions>;
}

export interface CapabilityGrantInput {
  operation: string;
  resource: string;
  scope: string;
  issuedBy: "user" | "approved_policy";
  durationMs: number;
  issuedAt?: number;
  exceptions?: CapabilityExceptions;
}

export interface PolicySimulationRequest {
  operation: string;
  resource: string;
  scope: string;
  destination: ContextDestination;
  contexts: readonly LabeledContext[];
  capability?: CapabilityGrant;
  requiresCapability?: boolean;
  now?: number;
}

export type PolicyDecisionCode =
  | "allowed"
  | "invalid_request"
  | "missing_capability"
  | "expired_capability"
  | "capability_mismatch"
  | "destination_not_permitted"
  | "operation_not_permitted"
  | "untrusted_data_to_command"
  | "secret_to_command"
  | "secret_to_model"
  | "secret_to_network"
  | "license_restricted_egress";

export interface PolicyDecision {
  effect: "allow" | "deny";
  code: PolicyDecisionCode;
  reasons: readonly string[];
  provenancePath: readonly string[];
  remediation?: string;
  matchedCapabilityId?: string;
}
