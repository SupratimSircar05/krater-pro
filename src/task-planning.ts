import { createHash } from "node:crypto";
import {
  VerifiedAutopilotService,
  type AutopilotDigest,
  type AutopilotEvidenceGrade,
  type PlanStepInput,
  type ProofObligationInput,
  type ProofObligation,
  type TaskPlan,
} from "./autopilot/index.js";
import {
  canonicalStringify,
  sha256Digest,
  type EvidenceGrade,
  type EvidenceRecord,
  type ProofGraphStore,
  type TaskContract,
  type TaskProjection,
  type TaskState,
} from "./proofgraph/index.js";

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return `${prefix}:${hash.digest("hex").slice(0, 24)}`;
}

function assuranceGrade(
  assurance: TaskContract["assurance"],
): AutopilotEvidenceGrade {
  if (assurance === "fast") return "observed";
  if (assurance === "high") return "stress_tested";
  return "tested";
}

function contractDigest(contract: TaskContract): AutopilotDigest {
  return sha256Digest(canonicalStringify(contract)) as AutopilotDigest;
}

function initialProofObligations(
  contract: TaskContract,
  digest: AutopilotDigest,
  createdAt: string,
): ProofObligationInput[] {
  const minimumGrade = assuranceGrade(contract.assurance);
  const acceptance = contract.acceptanceCriteria.map(
    (criterion): ProofObligationInput => ({
      id: stableId("proof", contract.taskId, "criterion", criterion.id),
      taskId: contract.taskId,
      kind: "acceptance_criterion",
      statement: criterion.statement,
      required: criterion.required,
      minimumGrade,
      status: "pending",
      acceptanceCriterionIds: [criterion.id],
      evidenceIds: [],
      scopeDigests: [digest],
      createdAt,
      updatedAt: createdAt,
    }),
  );
  const guarantees = contract.negativeGuarantees.map(
    (statement, index): ProofObligationInput => ({
      id: stableId(
        "proof",
        contract.taskId,
        "negative-guarantee",
        String(index),
        statement,
      ),
      taskId: contract.taskId,
      kind: "security",
      statement,
      required: true,
      minimumGrade,
      status: "pending",
      acceptanceCriterionIds: [],
      evidenceIds: [],
      scopeDigests: [digest],
      createdAt,
      updatedAt: createdAt,
    }),
  );
  const checks = contract.requiredChecks.map(
    (check, index): ProofObligationInput => ({
      id: stableId(
        "proof",
        contract.taskId,
        "required-check",
        String(index),
        check,
      ),
      taskId: contract.taskId,
      kind:
        check === "conflict_check" || check === "workspace_digest"
          ? "publication_precondition"
          : check === "security_check" || check === "secret_scan"
            ? "security"
            : "regression",
      statement: `Required check: ${check}`,
      required: true,
      minimumGrade,
      status: "pending",
      acceptanceCriterionIds: [],
      evidenceIds: [],
      scopeDigests: [digest],
      createdAt,
      updatedAt: createdAt,
    }),
  );
  return [...acceptance, ...guarantees, ...checks];
}

function initialPlanSteps(
  contract: TaskContract,
  proofObligationIds: string[],
  createdAt: string,
): PlanStepInput[] {
  const step = (
    suffix: string,
    kind: PlanStepInput["kind"],
    title: string,
    description: string,
    status: PlanStepInput["status"],
    dependsOnStepIds: string[],
    allowedCapabilities: string[],
    proofs: string[] = [],
  ): PlanStepInput => ({
    id: stableId("step", contract.taskId, suffix),
    taskId: contract.taskId,
    kind,
    title,
    description,
    status,
    dependsOnStepIds,
    proofObligationIds: proofs,
    allowedCapabilities,
    createdAt,
    updatedAt: createdAt,
  });

  const discover = step(
    "discover",
    "discover",
    "Understand the project",
    "Inspect repository facts and establish whether a change is justified.",
    "running",
    [],
    ["workspace.read", "git.read", "skill.read"],
  );
  const build = step(
    "build",
    "implement",
    "Build or abstain safely",
    "Produce an isolated change only when the Action Gate establishes that one is required.",
    "pending",
    [discover.id],
    ["workspace.read", "workspace.stage", "process.execute.approved"],
  );
  const verify = step(
    "verify",
    "verify",
    "Prove the requested outcome",
    "Satisfy every acceptance criterion and negative guarantee with origin-labeled evidence.",
    "pending",
    [build.id],
    ["workspace.read", "process.execute.approved"],
    proofObligationIds,
  );
  const review = step(
    "review",
    "review",
    "Review evidence and gaps",
    "Present the complete patch, weakest evidence, and any unresolved uncertainty.",
    "pending",
    [verify.id],
    ["workspace.read"],
    proofObligationIds,
  );
  const publish = step(
    "publish",
    "publish",
    "Publish atomically",
    "Apply the reviewed ProofPatch only after exact conflict and evidence checks.",
    "pending",
    [review.id],
    ["workspace.publish"],
    proofObligationIds,
  );
  return [discover, build, verify, review, publish];
}

export async function createInitialAutopilotPlan(
  store: ProofGraphStore,
  contract: TaskContract,
): Promise<TaskPlan> {
  const digest = contractDigest(contract);
  const proofObligations = initialProofObligations(
    contract,
    digest,
    contract.createdAt,
  );
  const steps = initialPlanSteps(
    contract,
    proofObligations.map((obligation) => obligation.id),
    contract.createdAt,
  );
  return new VerifiedAutopilotService(store).revisePlan({
    id: stableId("plan", contract.taskId),
    taskId: contract.taskId,
    status: "active",
    objective: contract.request,
    contractDigest: digest,
    steps,
    proofObligations,
    createdBy: "system",
    revisedBy: "system",
    createdAt: contract.createdAt,
    revisedAt: contract.createdAt,
    revisionReason:
      "Initial executable plan compiled from the accepted task contract.",
  });
}

const GRADE_WEIGHT: Readonly<Record<EvidenceGrade, number>> = {
  not_established: 0,
  observed: 1,
  tested: 2,
  stress_tested: 3,
  formally_verified: 4,
};

function evidenceMeetsGrade(
  evidence: EvidenceRecord,
  minimum: ProofObligation["minimumGrade"],
): boolean {
  return (
    !evidence.stale &&
    GRADE_WEIGHT[evidence.grade] >= GRADE_WEIGHT[minimum]
  );
}

function evidenceForRequiredCheck(
  check: string,
  evidence: readonly EvidenceRecord[],
  hasWorkspaceDigests: boolean,
  minimum: ProofObligation["minimumGrade"],
): EvidenceRecord[] {
  const eligible = evidence.filter((item) =>
    evidenceMeetsGrade(item, minimum),
  );
  if (check === "workspace_digest") {
    return hasWorkspaceDigests
      ? eligible.filter(
          (item) =>
            item.kind === "property" &&
            item.artifactDigests.length >= 2 &&
            /workspace (?:snapshot )?digests?/i.test(item.summary),
        )
      : [];
  }
  if (check === "conflict_check") {
    return eligible.filter(
      (item) =>
        item.kind === "property" &&
        /unchanged-base digest|conflict check/i.test(item.summary),
    );
  }
  if (check === "targeted_check") {
    return eligible.filter((item) =>
      ["test", "static_analysis", "security", "differential"].includes(
        item.kind,
      ),
    );
  }
  if (check === "tests") {
    return eligible.filter((item) => item.kind === "test");
  }
  if (check === "typecheck") {
    return eligible.filter((item) => item.kind === "static_analysis");
  }
  if (check === "secret_scan" || check === "security_check") {
    return eligible.filter((item) => item.kind === "security");
  }
  if (check === "independent_verifier") {
    return eligible.filter((item) => item.origin === "blind_verifier");
  }
  if (check === "mutation_or_property_check") {
    return eligible.filter(
      (item) => item.kind === "mutation" || item.kind === "property",
    );
  }
  if (check === "rollback_check") {
    return eligible.filter(
      (item) => item.kind === "property" && /rollback/i.test(item.summary),
    );
  }
  return [];
}

function matchingEvidence(
  obligation: ProofObligation,
  projection: TaskProjection,
  hasWorkspaceDigests: boolean,
): EvidenceRecord[] {
  const requiredCheck = /^Required check:\s*(.+)$/i.exec(
    obligation.statement,
  )?.[1];
  if (requiredCheck) {
    return evidenceForRequiredCheck(
      requiredCheck,
      projection.evidence,
      hasWorkspaceDigests,
      obligation.minimumGrade,
    );
  }

  if (obligation.kind === "acceptance_criterion") {
    const normalized = obligation.statement.trim().toLowerCase();
    const matchingClaims = projection.claims.filter(
      (claim) =>
        claim.status === "supported" &&
        claim.statement.trim().toLowerCase() === normalized &&
        GRADE_WEIGHT[claim.grade] >= GRADE_WEIGHT[obligation.minimumGrade],
    );
    const evidenceIds = new Set(
      matchingClaims.flatMap((claim) => claim.supportingEvidenceIds),
    );
    return projection.evidence.filter(
      (item) =>
        evidenceIds.has(item.id) &&
        evidenceMeetsGrade(item, obligation.minimumGrade),
    );
  }

  if (obligation.kind === "security") {
    return projection.evidence.filter(
      (item) =>
        item.kind === "security" &&
        evidenceMeetsGrade(item, obligation.minimumGrade),
    );
  }

  return [];
}

const NON_CHANGE_ONLY_GUARANTEES = new Set([
  "do_not_overwrite_concurrent_edits",
]);

function noChangeNonApplicabilityReason(
  obligation: ProofObligation,
): string | undefined {
  const requiredCheck = /^Required check:\s*(.+)$/i.exec(
    obligation.statement,
  )?.[1];
  if (requiredCheck) {
    return `No publishable patch was created, so the change-verification check "${requiredCheck}" was not required.`;
  }
  if (obligation.kind === "publication_precondition") {
    return "No patch or external effect was published, so this publication precondition did not apply.";
  }
  if (
    ["regression", "performance", "reliability"].includes(obligation.kind)
  ) {
    return "No publishable change was created, so this change-specific proof did not apply.";
  }
  if (
    NON_CHANGE_ONLY_GUARANTEES.has(
      obligation.statement.trim().toLowerCase(),
    )
  ) {
    return "No workspace mutation or publication occurred, so concurrent user edits could not be overwritten by this task.";
  }
  return undefined;
}

function closedNoChangeStep(
  step: TaskPlan["steps"][number],
  updatedAt: string,
): PlanStepInput {
  const { schemaVersion: _schemaVersion, ...body } = step;
  if (step.kind === "discover") {
    return {
      ...body,
      title: "Establish whether a change is needed",
      description:
        "Bounded repository evidence supported the recorded no-change decision.",
      status: "completed",
      updatedAt,
    };
  }
  if (step.kind === "implement" || step.kind === "debug") {
    return {
      ...body,
      title: "Leave the project unchanged",
      description:
        "The Action Gate did not justify a publishable edit, so no implementation was staged.",
      status: "skipped",
      updatedAt,
    };
  }
  if (step.kind === "verify") {
    return {
      ...body,
      title: "Verify the no-change decision",
      description:
        "The Action Gate references successful discovery evidence. Any unsupported outcome guarantees remain explicit proof gaps.",
      status: "completed",
      updatedAt,
    };
  }
  if (step.kind === "review") {
    return {
      ...body,
      title: "Record the decision and remaining uncertainty",
      description:
        "The no-change result, evidence provenance, and applicable proof gaps were preserved for review.",
      status: "completed",
      updatedAt,
    };
  }
  if (step.kind === "publish" || step.kind === "external_effect") {
    return {
      ...body,
      title: "No publication needed",
      description:
        "No patch or external effect was produced. Nothing was shipped.",
      status: "skipped",
      updatedAt,
    };
  }
  return {
    ...body,
    status: "skipped",
    updatedAt,
  };
}

function planProgressStatus(
  step: TaskPlan["steps"][number],
  state: TaskState,
  proofsComplete: boolean,
  changed: boolean,
): TaskPlan["steps"][number]["status"] {
  if (state === "cancelled") return "cancelled";
  if (step.kind === "discover") return "completed";
  if (step.kind === "implement") {
    if (state === "abstained") return "skipped";
    return changed ? "completed" : state === "blocked" ? "blocked" : "pending";
  }
  if (step.kind === "verify") {
    if (proofsComplete) return "completed";
    return state === "blocked" ? "blocked" : "running";
  }
  if (step.kind === "review") {
    if (["complete", "accepted_with_gaps"].includes(state)) return "completed";
    if (state === "review") return "ready";
    return proofsComplete ? "ready" : "pending";
  }
  if (step.kind === "publish" || step.kind === "external_effect") {
    if (["complete", "accepted_with_gaps"].includes(state)) return "completed";
    if (["abstained", "blocked", "cancelled"].includes(state)) return "skipped";
    return state === "publication" ? "running" : "pending";
  }
  return step.status;
}

function planStatusForState(
  state: TaskState,
  proofsComplete: boolean,
): TaskPlan["status"] {
  if (state === "cancelled") return "cancelled";
  if (state === "abstained") return "closed";
  if (
    proofsComplete &&
    ["complete", "accepted_with_gaps"].includes(state)
  ) {
    return "completed";
  }
  return "active";
}

export interface ReconcileAutopilotPlanOptions {
  taskId: string;
  state: TaskState;
  baseWorkspaceDigest?: string;
  finalWorkspaceDigest?: string;
  waiveUnsatisfied?: {
    reason: string;
    approvedAt: string;
  };
}

/**
 * Reconciles the executable plan only from durable ProofGraph evidence.
 * Model assertions alone never satisfy an obligation, and synthetic host
 * workspace-digest evidence is never persisted as a test result.
 */
export async function reconcileAutopilotPlan(
  store: ProofGraphStore,
  options: ReconcileAutopilotPlanOptions,
): Promise<TaskPlan | undefined> {
  const projection = await store.task(options.taskId);
  const current = projection.autopilot.currentPlan;
  if (!current) return undefined;
  const hasWorkspaceDigests = Boolean(
    options.baseWorkspaceDigest &&
      options.finalWorkspaceDigest,
  );
  const changed = Boolean(
    hasWorkspaceDigests &&
      options.baseWorkspaceDigest !== options.finalWorkspaceDigest,
  );
  const revisedAt = new Date().toISOString();
  const proofObligations = current.proofObligations.map(
    (obligation): ProofObligationInput => {
      const matches = matchingEvidence(
        obligation,
        projection,
        hasWorkspaceDigests,
      );
      const evidenceIds = matches
        .map((item) => item.id)
        .filter((id) => id !== "host:workspace-digests");
      let status: ProofObligationInput["status"] = obligation.waiver
        ? "waived" as const
        : matches.length > 0
          ? "satisfied" as const
          : "pending" as const;
      let waiver = obligation.waiver;
      let nonApplicabilityReason: string | undefined;
      if (status === "pending" && options.state === "abstained" && !changed) {
        nonApplicabilityReason =
          noChangeNonApplicabilityReason(obligation);
        if (nonApplicabilityReason) status = "not_applicable";
      }
      if (
        status === "pending" &&
        obligation.required &&
        options.waiveUnsatisfied
      ) {
        status = "waived";
        waiver = {
          approvedBy: "user",
          reason: options.waiveUnsatisfied.reason,
          approvalReceiptDigest: sha256Digest(
            canonicalStringify({
              taskId: options.taskId,
              planDigest: current.digest,
              obligationId: obligation.id,
              approvedAt: options.waiveUnsatisfied.approvedAt,
              reason: options.waiveUnsatisfied.reason,
            }),
          ) as AutopilotDigest,
          approvedAt: options.waiveUnsatisfied.approvedAt,
        };
      }
      const {
        schemaVersion: _schemaVersion,
        waiver: _priorWaiver,
        nonApplicabilityReason: _priorNonApplicabilityReason,
        ...body
      } = obligation;
      return {
        ...body,
        status,
        evidenceIds,
        ...(nonApplicabilityReason ? { nonApplicabilityReason } : {}),
        ...(waiver ? { waiver } : {}),
        updatedAt: revisedAt,
      };
    },
  );
  const proofsComplete = proofObligations.every(
    (obligation) =>
      !obligation.required ||
      obligation.status === "satisfied" ||
      obligation.status === "not_applicable" ||
      obligation.status === "waived",
  );
  const steps: PlanStepInput[] =
    options.state === "abstained"
      ? current.steps.map((step) => closedNoChangeStep(step, revisedAt))
      : current.steps.map((step) => {
          const { schemaVersion: _schemaVersion, ...body } = step;
          return {
            ...body,
            status: planProgressStatus(
              step,
              options.state,
              proofsComplete,
              changed,
            ),
            updatedAt: revisedAt,
          };
        });
  const status = planStatusForState(options.state, proofsComplete);
  const before = canonicalStringify({
    status: current.status,
    steps: current.steps.map((step) => ({
      id: step.id,
      status: step.status,
    })),
    proofObligations: current.proofObligations.map((obligation) => ({
      id: obligation.id,
      status: obligation.status,
      evidenceIds: obligation.evidenceIds,
      nonApplicabilityReason: obligation.nonApplicabilityReason ?? null,
      waiver: obligation.waiver ?? null,
    })),
  });
  const after = canonicalStringify({
    status,
    steps: steps.map((step) => ({ id: step.id, status: step.status })),
    proofObligations: proofObligations.map((obligation) => ({
      id: obligation.id,
      status: obligation.status,
      evidenceIds: obligation.evidenceIds,
      nonApplicabilityReason: obligation.nonApplicabilityReason ?? null,
      waiver: obligation.waiver ?? null,
    })),
  });
  if (before === after) return current;

  return new VerifiedAutopilotService(store).revisePlan({
    id: current.id,
    taskId: options.taskId,
    status,
    objective: current.objective,
    ...(current.contractDigest
      ? { contractDigest: current.contractDigest }
      : {}),
    steps,
    proofObligations,
    revisedBy: "system",
    revisedAt,
    revisionReason:
      options.waiveUnsatisfied
        ? "The user explicitly accepted the remaining proof gaps."
        : options.state === "abstained"
          ? "Evidence closed the task with no publishable change; change-only proof obligations were marked not applicable without being counted as passed."
        : "Recorded evidence changed executable plan progress.",
  });
}

export function proofObligationGaps(
  plan: TaskPlan | undefined,
  options: { includePublicationPreconditions?: boolean } = {},
): string[] {
  if (!plan) return ["Executable task plan is unavailable."];
  return plan.proofObligations
    .filter(
      (obligation) =>
        obligation.required &&
        (options.includePublicationPreconditions !== false ||
          obligation.kind !== "publication_precondition") &&
        obligation.status !== "satisfied" &&
        obligation.status !== "not_applicable" &&
        obligation.status !== "waived",
    )
    .map(
      (obligation) =>
        `Proof obligation not established (${obligation.id}): ${obligation.statement}`,
    );
}
