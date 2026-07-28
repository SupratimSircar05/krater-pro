import { createHash } from "node:crypto";
import type {
  ContextDestination,
  ContextSensitivity,
  ContextSource,
  ContextTrust,
  LabeledContext,
} from "./types.js";

export interface LabelContextInput {
  id?: string;
  content: string;
  source: ContextSource;
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  permittedDestinations?: readonly ContextDestination[];
  permittedOperations?: readonly string[];
}

function unique<T extends string>(values: readonly T[] | undefined): T[] | undefined {
  if (!values) return undefined;
  return [...new Set(values)];
}

export function labelContext(input: LabelContextInput): LabeledContext {
  const content = input.content;
  if (
    input.trust !== "untrusted_data" &&
    input.source !== "user" &&
    input.source !== "system_policy"
  ) {
    throw new Error(
      `${input.source} context is data and cannot grant itself instruction or policy authority.`,
    );
  }
  const derivedId = `ctx:${createHash("sha256")
    .update(input.source)
    .update("\0")
    .update(input.trust)
    .update("\0")
    .update(input.sensitivity)
    .update("\0")
    .update(content)
    .digest("hex")
    .slice(0, 24)}`;
  const id = input.id?.trim() || derivedId;
  const permittedOperations = input.permittedOperations?.map((value) => value.trim());
  if (permittedOperations?.some((value) => !value)) {
    throw new Error("Permitted operations must not contain empty values.");
  }
  return {
    id,
    content,
    source: input.source,
    trust: input.trust,
    sensitivity: input.sensitivity,
    ...(input.permittedDestinations
      ? { permittedDestinations: unique(input.permittedDestinations) }
      : {}),
    ...(permittedOperations
      ? { permittedOperations: unique(permittedOperations) }
      : {}),
  };
}
