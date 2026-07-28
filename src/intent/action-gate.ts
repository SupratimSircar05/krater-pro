import type { ActionGateDecision, ActionGateInput } from "./types.js";

function decision(
  outcome: ActionGateDecision["outcome"],
  reasons: readonly string[],
  input: ActionGateInput,
): ActionGateDecision {
  return {
    outcome,
    shouldStageCode:
      outcome === "change_required" || outcome === "partial_fix_requires_change",
    reasons,
    evidenceRefs: [...new Set(input.evidenceRefs?.map((item) => item.trim()).filter(Boolean))],
  };
}

export function classifyActionNeed(input: ActionGateInput): ActionGateDecision {
  if (!input.discoveryComplete) {
    return decision(
      "cannot_establish_safely",
      ["Bounded discovery has not completed."],
      input,
    );
  }
  if (!input.safeToProceed) {
    return decision(
      "cannot_establish_safely",
      ["Available evidence does not permit safe execution."],
      input,
    );
  }
  if (input.evidenceState === "conflicting") {
    return decision(
      "cannot_establish_safely",
      ["Discovery evidence conflicts and must be resolved."],
      input,
    );
  }
  if (input.evidenceState === "insufficient") {
    return decision(
      "cannot_establish_safely",
      ["Discovery evidence is insufficient to justify an action or abstention."],
      input,
    );
  }
  if (input.observedState === "unknown" || input.resolution === "unknown") {
    return decision(
      "cannot_establish_safely",
      ["The observed state or required resolution remains unknown."],
      input,
    );
  }

  if (input.observedState === "satisfied" && input.resolution === "none") {
    return decision(
      "already_satisfied_no_change",
      ["The acceptance condition is already satisfied; no change is justified."],
      input,
    );
  }

  if (
    input.resolution === "configuration" ||
    input.resolution === "documentation" ||
    input.resolution === "user_action"
  ) {
    if (input.observedState === "satisfied") {
      return decision(
        "cannot_establish_safely",
        ["Evidence says the request is satisfied but also prescribes additional action."],
        input,
      );
    }
    return decision(
      "configuration_documentation_or_user_action",
      [`The established resolution is ${input.resolution.replaceAll("_", " ")} rather than a code edit.`],
      input,
    );
  }

  if (
    input.observedState === "partially_satisfied" &&
    input.resolution === "code_change"
  ) {
    return decision(
      "partial_fix_requires_change",
      ["An existing implementation partially satisfies the contract and needs a bounded code change."],
      input,
    );
  }

  if (
    input.observedState === "absent_or_broken" &&
    input.resolution === "code_change"
  ) {
    return decision(
      "change_required",
      ["Evidence establishes missing or broken behavior that requires a code change."],
      input,
    );
  }

  return decision(
    "cannot_establish_safely",
    ["The established state and proposed resolution are internally inconsistent."],
    input,
  );
}
