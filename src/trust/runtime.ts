import { createHash } from "node:crypto";
import type { JsonObject, ModelMessage, ToolCall } from "../types.js";
import { createCapabilityGrant } from "./capabilities.js";
import { labelContext } from "./labels.js";
import { simulatePolicy } from "./policy.js";
import { redactObject, redactSensitiveText } from "./redaction.js";
import type { PolicyDecision } from "./types.js";

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:api[_-]?key|authorization|password|passwd|secret|token|cookie|private[_-]?key|client[_-]?secret)/i;

export interface RuntimeRedactionOptions {
  secrets?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}

export interface CommandAuthorizationInput extends RuntimeRedactionOptions {
  command: string;
  scope: string;
  approvedBy?: "user" | "approved_policy";
  now?: number;
}

/**
 * Capability resources must be exact strings. A generated shell command can
 * legitimately contain glob metacharacters as inert quoted data or shell
 * syntax, so the command text itself is not a safe capability-resource
 * encoding. Bind authority to the normalized command bytes instead.
 */
export function commandCapabilityResource(command: string): string {
  const normalized = command.normalize("NFC").trim();
  return `command:sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function uniqueSecrets(options: RuntimeRedactionOptions): string[] {
  const environment = options.environment ?? process.env;
  const environmentSecrets = Object.entries(environment)
    .filter(
      ([name, value]) =>
        SENSITIVE_ENVIRONMENT_NAME.test(name) &&
        typeof value === "string" &&
        value.length >= 4,
    )
    .map(([, value]) => value as string);
  return [...new Set([...(options.secrets ?? []), ...environmentSecrets])]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

/**
 * Redacts host-known values and high-confidence credential shapes before text
 * crosses from the local control plane into a model, event stream, cache, or
 * exported record.
 */
export function sanitizeRuntimeText(
  text: string,
  options: RuntimeRedactionOptions = {},
): string {
  return redactSensitiveText(text, { secrets: uniqueSecrets(options) });
}

export function containsSensitiveRuntimeText(
  text: string,
  options: RuntimeRedactionOptions = {},
): boolean {
  return sanitizeRuntimeText(text, options) !== text;
}

function sanitizeToolCall(
  call: ToolCall,
  options: RuntimeRedactionOptions,
): ToolCall {
  let args: string;
  try {
    args = JSON.stringify(
      redactObject(JSON.parse(call.function.arguments || "{}"), {
        secrets: uniqueSecrets(options),
      }),
    );
  } catch {
    args = sanitizeRuntimeText(call.function.arguments, options);
  }
  return {
    ...call,
    function: {
      ...call.function,
      arguments: args,
    },
  };
}

export function sanitizeModelMessages(
  messages: readonly ModelMessage[],
  options: RuntimeRedactionOptions = {},
): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "assistant") {
      return {
        ...message,
        content:
          message.content === null
            ? null
            : sanitizeRuntimeText(message.content, options),
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map((call) =>
                sanitizeToolCall(call, options),
              ),
            }
          : {}),
      };
    }
    return {
      ...message,
      content: sanitizeRuntimeText(message.content, options),
    };
  });
}

export function sanitizeRuntimeObject(
  value: JsonObject,
  options: RuntimeRedactionOptions = {},
): JsonObject {
  return redactObject(value, {
    secrets: uniqueSecrets(options),
  }) as JsonObject;
}

/**
 * Generated commands are untrusted data. An approval creates process-local
 * authority for only this command and workspace; a copied receipt is not
 * sufficient because capability identities are tracked by the host.
 */
export function authorizeGeneratedCommand(
  input: CommandAuthorizationInput,
): PolicyDecision {
  const command = input.command.normalize("NFC").trim();
  const scope = input.scope.normalize("NFC").trim();
  if (!command || !scope) {
    return simulatePolicy({
      operation: "command.execute",
      resource: command,
      scope,
      destination: "command",
      contexts: [],
      requiresCapability: true,
      now: input.now,
    });
  }
  if (containsSensitiveRuntimeText(command, input)) {
    return {
      effect: "deny",
      code: "secret_to_command",
      reasons: [
        "The generated command contains credential material and cannot be executed.",
      ],
      provenancePath: [
        "generated:command",
        "sensitivity:secret",
        "destination:command",
      ],
      remediation:
        "Use a host-side credential handle or environment binding instead of embedding a secret in a command.",
    };
  }

  const context = labelContext({
    id: "generated-command",
    content: command,
    source: "generated",
    trust: "untrusted_data",
    sensitivity: "public",
    permittedDestinations: ["command"],
    permittedOperations: ["command.execute"],
  });
  const resource = commandCapabilityResource(command);
  const capability = input.approvedBy
    ? createCapabilityGrant({
        operation: "command.execute",
        resource,
        scope,
        issuedBy: input.approvedBy,
        issuedAt: input.now,
        durationMs: 60_000,
        exceptions: { untrustedDataToCommand: true },
      })
    : undefined;
  return simulatePolicy({
    operation: "command.execute",
    resource,
    scope,
    destination: "command",
    contexts: [context],
    capability,
    requiresCapability: true,
    now: input.now,
  });
}
