import {
  assertValidAgentDelegation,
  assertValidExternalEffectPlan,
  assertValidExternalEffectReceipt,
  assertValidPlanRevision,
  assertValidProductionObservation,
  assertValidProofLease,
  assertValidProofLeaseInvalidation,
} from "../autopilot/records.js";
import type {
  AgentDelegation,
  ExternalEffectPlan,
  ExternalEffectReceipt,
  ProductionObservation,
  ProofLease,
  ProofLeaseInvalidation,
  TaskPlan,
} from "../autopilot/types.js";
import type {
  ActionRecord,
  ClaimRecord,
  EvidenceCapsule,
  EvidenceRecord,
  IntentNode,
  ProofGraphEventKind,
  ChangePassport,
  StoredProofGraphEvent,
  TaskProjection,
  TaskState,
} from "./types.js";

const ORDERED_STATES: TaskState[] = [
  "intake",
  "discovery",
  "clarification",
  "reproduction",
  "staging",
  "verification",
  "review",
  "publication",
  "complete",
];

const TERMINAL_STATES = new Set<TaskState>([
  "complete",
  "abstained",
  "blocked",
  "accepted_with_gaps",
  "cancelled",
]);

export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Invalid ProofGraph task transition: ${from} -> ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

export class TaskProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskProjectionError";
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionTaskState(from: TaskState, to: TaskState): boolean {
  if (isTerminalTaskState(from) || from === to) return false;
  if (to === "abstained" || to === "blocked" || to === "cancelled") return true;
  if (to === "accepted_with_gaps") {
    return from === "verification" || from === "review" || from === "publication";
  }
  const index = ORDERED_STATES.indexOf(from);
  return index >= 0 && ORDERED_STATES[index + 1] === to;
}

export function assertTaskStateTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTaskState(from, to)) {
    throw new InvalidTaskTransitionError(from, to);
  }
}

function recordForKind<Kind extends ProofGraphEventKind>(
  event: StoredProofGraphEvent,
  kind: Kind,
): StoredProofGraphEvent<Kind> | undefined {
  return event.kind === kind ? (event as StoredProofGraphEvent<Kind>) : undefined;
}

export function rebuildTaskProjection(
  events: readonly StoredProofGraphEvent[],
  taskId: string,
): TaskProjection {
  const taskEvents = events.filter((event) => event.taskId === taskId);
  const created = taskEvents.find((event) => event.kind === "task.created");
  if (!created) throw new TaskProjectionError(`Task does not exist: ${taskId}`);
  if (taskEvents[0] !== created) {
    throw new TaskProjectionError(
      `Task creation event is not the first event for task: ${taskId}`,
    );
  }
  const createdEvent = recordForKind(created, "task.created")!;
  if (
    !createdEvent.payload.contract ||
    createdEvent.payload.contract.taskId !== taskId
  ) {
    throw new TaskProjectionError("Task contract ID does not match its event task ID.");
  }

  let state: TaskState = "intake";
  let contract = createdEvent.payload.contract;
  const intents = new Map<string, IntentNode>();
  const actions = new Map<string, ActionRecord>();
  const evidence = new Map<string, EvidenceRecord>();
  const claims = new Map<string, ClaimRecord>();
  const planRevisions: TaskPlan[] = [];
  const delegations = new Map<string, AgentDelegation>();
  const externalEffectPlans = new Map<string, ExternalEffectPlan>();
  const externalEffectReceipts = new Map<string, ExternalEffectReceipt>();
  const proofLeases = new Map<string, ProofLease>();
  const proofLeaseInvalidations = new Map<string, ProofLeaseInvalidation>();
  const productionObservations = new Map<string, ProductionObservation>();
  let currentPlan: TaskPlan | undefined;
  let capsule: EvidenceCapsule | undefined;
  let passport: ChangePassport | undefined;
  const stateHistory: TaskProjection["stateHistory"] = [
    {
      state,
      sequence: created.sequence,
      occurredAt: created.occurredAt,
    },
  ];

  let creationCount = 0;
  for (const event of taskEvents) {
    if (event.kind === "task.created") {
      creationCount += 1;
      if (creationCount > 1) {
        throw new TaskProjectionError(`Task has multiple creation events: ${taskId}`);
      }
      continue;
    }
    const stateChange = recordForKind(event, "task.state.changed");
    if (stateChange) {
      if (stateChange.payload.from && stateChange.payload.from !== state) {
        throw new TaskProjectionError(
          `State event expected ${stateChange.payload.from}, projection is ${state}.`,
        );
      }
      assertTaskStateTransition(state, stateChange.payload.to);
      state = stateChange.payload.to;
      stateHistory.push({
        state,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        ...(stateChange.payload.reason
          ? { reason: stateChange.payload.reason }
          : {}),
      });
      continue;
    }
    const contractEvent = recordForKind(event, "contract.set");
    if (contractEvent) {
      if (contractEvent.payload.contract.taskId !== taskId) {
        throw new TaskProjectionError("Replacement contract has a mismatched task ID.");
      }
      contract = contractEvent.payload.contract;
      continue;
    }
    const intentEvent = recordForKind(event, "intent.recorded");
    if (intentEvent) {
      if (intentEvent.payload.intent.taskId !== taskId) {
        throw new TaskProjectionError("Intent record has a mismatched task ID.");
      }
      intents.set(intentEvent.payload.intent.id, intentEvent.payload.intent);
      continue;
    }
    const actionEvent = recordForKind(event, "action.recorded");
    if (actionEvent) {
      if (actionEvent.payload.action.taskId !== taskId) {
        throw new TaskProjectionError("Action record has a mismatched task ID.");
      }
      actions.set(actionEvent.payload.action.id, actionEvent.payload.action);
      continue;
    }
    const evidenceEvent = recordForKind(event, "evidence.recorded");
    if (evidenceEvent) {
      if (evidenceEvent.payload.evidence.taskId !== taskId) {
        throw new TaskProjectionError("Evidence record has a mismatched task ID.");
      }
      evidence.set(evidenceEvent.payload.evidence.id, evidenceEvent.payload.evidence);
      continue;
    }
    const claimEvent = recordForKind(event, "claim.recorded");
    if (claimEvent) {
      if (claimEvent.payload.claim.taskId !== taskId) {
        throw new TaskProjectionError("Claim record has a mismatched task ID.");
      }
      claims.set(claimEvent.payload.claim.id, claimEvent.payload.claim);
      continue;
    }
    const planEvent = recordForKind(event, "autopilot.plan.revised");
    if (planEvent) {
      if (planEvent.payload.plan.taskId !== taskId) {
        throw new TaskProjectionError("Task plan has a mismatched task ID.");
      }
      try {
        assertValidPlanRevision(currentPlan, planEvent.payload.plan);
      } catch (error) {
        throw new TaskProjectionError(
          `Task plan revision is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      currentPlan = planEvent.payload.plan;
      planRevisions.push(currentPlan);
      continue;
    }
    const delegationEvent = recordForKind(
      event,
      "autopilot.delegation.recorded",
    );
    if (delegationEvent) {
      const delegation = delegationEvent.payload.delegation;
      if (delegation.taskId !== taskId) {
        throw new TaskProjectionError("Agent delegation has a mismatched task ID.");
      }
      try {
        assertValidAgentDelegation(delegation);
      } catch (error) {
        throw new TaskProjectionError(
          `Agent delegation is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      delegations.set(delegation.id, delegation);
      continue;
    }
    const effectPlanEvent = recordForKind(
      event,
      "autopilot.external_effect.planned",
    );
    if (effectPlanEvent) {
      const effectPlan = effectPlanEvent.payload.effectPlan;
      if (effectPlan.taskId !== taskId) {
        throw new TaskProjectionError(
          "External effect plan has a mismatched task ID.",
        );
      }
      try {
        assertValidExternalEffectPlan(effectPlan);
      } catch (error) {
        throw new TaskProjectionError(
          `External effect plan is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      externalEffectPlans.set(effectPlan.id, effectPlan);
      continue;
    }
    const effectReceiptEvent = recordForKind(
      event,
      "autopilot.external_effect.receipt.recorded",
    );
    if (effectReceiptEvent) {
      const receipt = effectReceiptEvent.payload.receipt;
      if (receipt.taskId !== taskId) {
        throw new TaskProjectionError(
          "External effect receipt has a mismatched task ID.",
        );
      }
      try {
        assertValidExternalEffectReceipt(receipt);
      } catch (error) {
        throw new TaskProjectionError(
          `External effect receipt is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      externalEffectReceipts.set(receipt.id, receipt);
      continue;
    }
    const proofLeaseEvent = recordForKind(
      event,
      "autopilot.proof_lease.issued",
    );
    if (proofLeaseEvent) {
      const lease = proofLeaseEvent.payload.lease;
      if (lease.taskId !== taskId) {
        throw new TaskProjectionError("Proof lease has a mismatched task ID.");
      }
      try {
        assertValidProofLease(lease);
      } catch (error) {
        throw new TaskProjectionError(
          `Proof lease is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      proofLeases.set(lease.id, lease);
      continue;
    }
    const invalidationEvent = recordForKind(
      event,
      "autopilot.proof_lease.invalidated",
    );
    if (invalidationEvent) {
      const invalidation = invalidationEvent.payload.invalidation;
      if (invalidation.taskId !== taskId) {
        throw new TaskProjectionError(
          "Proof lease invalidation has a mismatched task ID.",
        );
      }
      try {
        assertValidProofLeaseInvalidation(invalidation);
      } catch (error) {
        throw new TaskProjectionError(
          `Proof lease invalidation is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      proofLeaseInvalidations.set(invalidation.id, invalidation);
      continue;
    }
    const observationEvent = recordForKind(
      event,
      "autopilot.production.observed",
    );
    if (observationEvent) {
      const observation = observationEvent.payload.observation;
      if (observation.taskId !== taskId) {
        throw new TaskProjectionError(
          "Production observation has a mismatched task ID.",
        );
      }
      try {
        assertValidProductionObservation(observation);
      } catch (error) {
        throw new TaskProjectionError(
          `Production observation is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      productionObservations.set(observation.id, observation);
      continue;
    }
    const capsuleEvent = recordForKind(event, "capsule.generated");
    if (capsuleEvent) {
      if (capsuleEvent.payload.capsule.taskId !== taskId) {
        throw new TaskProjectionError("Evidence capsule has a mismatched task ID.");
      }
      capsule = capsuleEvent.payload.capsule;
      continue;
    }
    const passportEvent = recordForKind(event, "passport.generated");
    if (passportEvent) {
      if (passportEvent.payload.passport.taskId !== taskId) {
        throw new TaskProjectionError("Change passport has a mismatched task ID.");
      }
      passport = passportEvent.payload.passport;
    }
  }

  const last = taskEvents.at(-1)!;
  return {
    taskId,
    state,
    contract,
    intents: [...intents.values()],
    actions: [...actions.values()],
    evidence: [...evidence.values()],
    claims: [...claims.values()],
    stateHistory,
    autopilot: {
      ...(currentPlan ? { currentPlan } : {}),
      planRevisions,
      delegations: [...delegations.values()],
      externalEffectPlans: [...externalEffectPlans.values()],
      externalEffectReceipts: [...externalEffectReceipts.values()],
      proofLeases: [...proofLeases.values()],
      proofLeaseInvalidations: [...proofLeaseInvalidations.values()],
      productionObservations: [...productionObservations.values()],
    },
    ...(capsule ? { capsule } : {}),
    ...(passport ? { passport } : {}),
    lastSequence: last.sequence,
    lastEventHash: last.hash,
  };
}

export function rebuildAllTaskProjections(
  events: readonly StoredProofGraphEvent[],
): Map<string, TaskProjection> {
  const ids = new Set(events.map((event) => event.taskId));
  return new Map([...ids].map((id) => [id, rebuildTaskProjection(events, id)]));
}
