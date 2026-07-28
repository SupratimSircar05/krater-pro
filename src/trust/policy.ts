import { matchCapability } from "./capabilities.js";
import type {
  CapabilityGrant,
  ContextDestination,
  LabeledContext,
  PolicyDecision,
  PolicyDecisionCode,
  PolicySimulationRequest,
} from "./types.js";

const DESTINATIONS = new Set<ContextDestination>([
  "model",
  "network",
  "command",
  "cache",
  "export",
  "local_tool",
]);
const SOURCES = new Set([
  "user",
  "system_policy",
  "repository",
  "local_tool",
  "external_tool",
  "generated",
]);
const TRUST_LEVELS = new Set([
  "authoritative_instruction",
  "approved_policy",
  "untrusted_data",
]);
const SENSITIVITIES = new Set([
  "public",
  "proprietary",
  "pii",
  "secret",
  "license_restricted",
]);

function deny(
  code: Exclude<PolicyDecisionCode, "allowed">,
  reason: string,
  provenancePath: readonly string[],
  remediation: string,
): PolicyDecision {
  return {
    effect: "deny",
    code,
    reasons: [reason],
    provenancePath,
    remediation,
  };
}

function contextPath(context: LabeledContext, destination: string): string[] {
  return [
    `${context.source}:${context.id}`,
    `trust:${context.trust}`,
    `sensitivity:${context.sensitivity}`,
    `destination:${destination}`,
  ];
}

function isDataSource(context: LabeledContext): boolean {
  return context.source !== "user" && context.source !== "system_policy";
}

function invalidRequest(request: PolicySimulationRequest): string | undefined {
  if (!DESTINATIONS.has(request.destination)) {
    return "Policy destination is invalid.";
  }
  if (!Array.isArray(request.contexts)) {
    return "Policy contexts must be an array.";
  }
  for (const context of request.contexts) {
    if (
      !context ||
      typeof context !== "object" ||
      typeof context.id !== "string" ||
      !context.id.trim() ||
      typeof context.content !== "string" ||
      !SOURCES.has(context.source) ||
      !TRUST_LEVELS.has(context.trust) ||
      !SENSITIVITIES.has(context.sensitivity)
    ) {
      return "A policy context has invalid provenance labels.";
    }
    if (
      context.trust !== "untrusted_data" &&
      context.source !== "user" &&
      context.source !== "system_policy"
    ) {
      return `${context.source} context cannot grant itself instruction or policy authority.`;
    }
    if (
      context.permittedDestinations !== undefined &&
      (!Array.isArray(context.permittedDestinations) ||
        context.permittedDestinations.some(
          (destination: ContextDestination) => !DESTINATIONS.has(destination),
        ))
    ) {
      return `Context ${context.id} has an invalid permitted destination.`;
    }
    if (
      context.permittedOperations !== undefined &&
      (!Array.isArray(context.permittedOperations) ||
        context.permittedOperations.some(
          (operation: string) =>
            typeof operation !== "string" || !operation.trim(),
        ))
    ) {
      return `Context ${context.id} has an invalid permitted operation.`;
    }
  }
  return undefined;
}

function capabilityFailure(
  request: PolicySimulationRequest,
): PolicyDecision | undefined {
  if (!request.capability) {
    if (!request.requiresCapability) return undefined;
    return deny(
      "missing_capability",
      "This operation requires an exact, time-bounded capability.",
      [`operation:${request.operation}`, `resource:${request.resource}`, `scope:${request.scope}`],
      "Ask the user or an approved policy to grant this exact operation, resource, and scope.",
    );
  }
  const match = matchCapability(request.capability, request, request.now ?? Date.now());
  if (match.matches) return undefined;
  if (match.reason === "expired" || match.reason === "not_yet_valid") {
    return deny(
      "expired_capability",
      match.reason === "expired"
        ? "The supplied capability has expired."
        : "The supplied capability is not valid yet.",
      [`capability:${request.capability.id}`],
      "Obtain a new capability with a valid, minimal duration.",
    );
  }
  return deny(
    "capability_mismatch",
    "The supplied capability does not exactly match the operation, resource, and scope.",
    [
      `capability:${request.capability.id}`,
      `requested:${request.operation}:${request.resource}:${request.scope}`,
    ],
    "Obtain a capability for the exact requested operation, resource, and scope.",
  );
}

function exactCapability(
  request: PolicySimulationRequest,
): CapabilityGrant | undefined {
  if (!request.capability) return undefined;
  return matchCapability(
    request.capability,
    request,
    request.now ?? Date.now(),
  ).matches
    ? request.capability
    : undefined;
}

export function simulatePolicy(request: PolicySimulationRequest): PolicyDecision {
  if (!request || typeof request !== "object") {
    return deny(
      "invalid_request",
      "Policy simulation requires a structured request.",
      ["request:invalid"],
      "Provide a host-labeled policy simulation request.",
    );
  }
  const invalid = invalidRequest(request);
  if (invalid) {
    return deny(
      "invalid_request",
      invalid,
      ["request:invalid"],
      "Use host-owned context labels and a supported destination.",
    );
  }
  const operation = request.operation.trim();
  const resource = request.resource.trim();
  const scope = request.scope.trim();
  if (!operation || !resource || !scope) {
    return deny(
      "capability_mismatch",
      "Policy simulation requires an exact operation, resource, and scope.",
      ["request:invalid"],
      "Provide non-empty exact policy coordinates.",
    );
  }

  const capabilityDecision = capabilityFailure({ ...request, operation, resource, scope });
  if (capabilityDecision) return capabilityDecision;
  const normalizedRequest = { ...request, operation, resource, scope };
  const capability = exactCapability(normalizedRequest);

  for (const context of request.contexts) {
    if (
      context.permittedDestinations &&
      !context.permittedDestinations.includes(request.destination)
    ) {
      return deny(
        "destination_not_permitted",
        `Context ${context.id} is not permitted to flow to ${request.destination}.`,
        contextPath(context, request.destination),
        "Remove the context or update a user-authored policy to permit this exact destination.",
      );
    }
    if (
      context.permittedOperations &&
      !context.permittedOperations.includes(operation)
    ) {
      return deny(
        "operation_not_permitted",
        `Context ${context.id} is not permitted for operation ${operation}.`,
        contextPath(context, request.destination),
        "Remove the context or update a user-authored policy to permit this exact operation.",
      );
    }

    if (
      request.destination === "command" &&
      (context.trust === "untrusted_data" || isDataSource(context)) &&
      capability?.exceptions.untrustedDataToCommand !== true
    ) {
      return deny(
        "untrusted_data_to_command",
        `Untrusted context ${context.id} cannot control command execution by default.`,
        contextPath(context, request.destination),
        "Obtain an exact capability that explicitly permits untrusted data for this command.",
      );
    }
    if (
      request.destination === "model" &&
      context.sensitivity === "secret" &&
      capability?.exceptions.secretToModel !== true
    ) {
      return deny(
        "secret_to_model",
        `Secret context ${context.id} cannot be sent to a model by default.`,
        contextPath(context, request.destination),
        "Keep the secret host-side or obtain an exact exceptional capability.",
      );
    }
    if (
      request.destination === "network" &&
      context.sensitivity === "secret" &&
      capability?.exceptions.secretToNetwork !== true
    ) {
      return deny(
        "secret_to_network",
        `Secret context ${context.id} cannot be sent over the network by default.`,
        contextPath(context, request.destination),
        "Use a host-side credential handle or obtain an exact exceptional capability.",
      );
    }
    if (
      (request.destination === "model" || request.destination === "network") &&
      context.sensitivity === "license_restricted" &&
      capability?.exceptions.licenseRestrictedEgress !== true
    ) {
      return deny(
        "license_restricted_egress",
        `License-restricted context ${context.id} cannot leave the local trust boundary by default.`,
        contextPath(context, request.destination),
        "Remove the restricted context or obtain an exact exceptional capability.",
      );
    }
  }

  return {
    effect: "allow",
    code: "allowed",
    reasons: [
      capability
        ? "All context flows are permitted by labels and the exact capability."
        : "All context flows are permitted by their labels and default policy.",
    ],
    provenancePath: request.contexts.map(
      (context) => `${context.source}:${context.id}`,
    ),
    ...(capability ? { matchedCapabilityId: capability.id } : {}),
  };
}

export function explainPolicyDecision(decision: PolicyDecision): string {
  const trail = decision.provenancePath.length
    ? ` Provenance: ${decision.provenancePath.join(" -> ")}.`
    : "";
  const remediation = decision.remediation
    ? ` Remediation: ${decision.remediation}`
    : "";
  return `${decision.effect.toUpperCase()} [${decision.code}]: ${decision.reasons.join(
    " ",
  )}${trail}${remediation}`.trim();
}
