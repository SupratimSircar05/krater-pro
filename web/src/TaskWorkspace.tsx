import { useId, type ReactNode } from "react";

export type AssuranceLevel = "fast" | "standard" | "high";
export type WorkspaceView = "ide" | "chat" | "evidence";

export type TaskState =
  | "intake"
  | "discovery"
  | "clarification"
  | "reproduction"
  | "staging"
  | "verification"
  | "review"
  | "publication"
  | "complete"
  | "abstained"
  | "blocked"
  | "accepted_with_gaps"
  | "cancelled";

type AssuranceProfile = {
  label: string;
  shortLabel: string;
  description: string;
};

export const ASSURANCE_PROFILES: Record<AssuranceLevel, AssuranceProfile> = {
  fast: {
    label: "Quick check",
    shortLabel: "Quick",
    description: "Move quickly with the essential checks.",
  },
  standard: {
    label: "Build and verify",
    shortLabel: "Verified",
    description: "Build safely, then prove the result.",
  },
  high: {
    label: "High-stakes review",
    shortLabel: "High stakes",
    description: "Use deeper checks and independent review.",
  },
};

const WORKSPACE_VIEW_ORDER: WorkspaceView[] = ["ide", "chat", "evidence"];

/**
 * Implements the expected arrow/Home/End behavior for the workspace tab list.
 * Returning undefined leaves unrelated keyboard shortcuts untouched.
 */
export function workspaceViewForKey(
  current: WorkspaceView,
  key: string,
): WorkspaceView | undefined {
  const index = WORKSPACE_VIEW_ORDER.indexOf(current);
  if (key === "Home") return WORKSPACE_VIEW_ORDER[0];
  if (key === "End") return WORKSPACE_VIEW_ORDER.at(-1);
  if (key === "ArrowRight" || key === "ArrowDown") {
    return WORKSPACE_VIEW_ORDER[(index + 1) % WORKSPACE_VIEW_ORDER.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return WORKSPACE_VIEW_ORDER[
      (index - 1 + WORKSPACE_VIEW_ORDER.length) % WORKSPACE_VIEW_ORDER.length
    ];
  }
  return undefined;
}

/**
 * Supports efficient keyboard traversal of long task histories without
 * changing the current task until the user activates the focused button.
 */
export function taskListIndexForKey(
  current: number,
  key: string,
  count: number,
): number | undefined {
  if (count < 1) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown" || key === "ArrowRight") {
    return (current + 1) % count;
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return (current - 1 + count) % count;
  }
  return undefined;
}

type TaskStateCopy = {
  label: string;
  description: string;
};

const TASK_STATE_COPY: Record<TaskState, TaskStateCopy> = {
  intake: {
    label: "Understanding your request",
    description: "Krater is turning your request into a clear outcome.",
  },
  discovery: {
    label: "Reading the project",
    description: "Krater is finding the relevant code, rules, and constraints.",
  },
  clarification: {
    label: "One decision needed",
    description: "A focused answer can prevent the wrong implementation.",
  },
  reproduction: {
    label: "Reproducing the issue",
    description: "Krater is confirming the current behavior before changing it.",
  },
  staging: {
    label: "Building safely",
    description: "Changes are isolated from your working files until review.",
  },
  verification: {
    label: "Proving the result",
    description: "Krater is checking behavior, regressions, and required guarantees.",
  },
  review: {
    label: "Ready for your review",
    description: "The change and its evidence are ready for your decision.",
  },
  publication: {
    label: "Shipping the change",
    description: "The approved change is being applied atomically.",
  },
  complete: {
    label: "Done and verified",
    description: "The requested result was shipped with its supporting evidence.",
  },
  abstained: {
    label: "No change needed",
    description:
      "Recorded evidence supports leaving the project unchanged. Any unresolved outcome guarantees remain listed separately.",
  },
  blocked: {
    label: "Needs your help",
    description: "Krater cannot continue safely without evidence or authority.",
  },
  accepted_with_gaps: {
    label: "Shipped with known gaps",
    description: "You accepted the documented gaps before publication.",
  },
  cancelled: {
    label: "Stopped safely",
    description: "Work stopped and unpublished changes were kept out of your project.",
  },
};

export function taskStateCopy(state: TaskState | string): TaskStateCopy {
  if (Object.prototype.hasOwnProperty.call(TASK_STATE_COPY, state)) {
    return TASK_STATE_COPY[state as TaskState];
  }
  return {
    label: "Task update",
    description: "Krater recorded a newer task state. Advanced details remain available.",
  };
}

type JourneyStatus =
  | "complete"
  | "current"
  | "upcoming"
  | "stopped"
  | "skipped";

export type JourneyStep = {
  id: "understand" | "plan" | "build" | "prove" | "ship" | "watch";
  label: string;
  description: string;
  status: JourneyStatus;
};

const JOURNEY_STEPS: Array<Omit<JourneyStep, "status">> = [
  {
    id: "understand",
    label: "Understand",
    description: "Intent, assumptions, and boundaries",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Safest path and proof required",
  },
  {
    id: "build",
    label: "Build / Debug",
    description: "Isolated implementation or diagnosis",
  },
  {
    id: "prove",
    label: "Prove",
    description: "Checks, claims, and known gaps",
  },
  {
    id: "ship",
    label: "Ship",
    description: "Review and atomic publication",
  },
  {
    id: "watch",
    label: "Watch",
    description: "Optional follow-up assurance",
  },
];

function currentJourneyIndex(state: TaskState | string): number {
  if (state === "intake") return 0;
  if (state === "discovery" || state === "clarification") return 1;
  if (state === "reproduction" || state === "staging") return 2;
  if (state === "verification" || state === "review") return 3;
  if (
    state === "publication" ||
    state === "complete" ||
    state === "accepted_with_gaps"
  ) {
    return 4;
  }
  return 0;
}

export function taskJourney(
  state: TaskState | string,
  watchState?: string,
  hasEvidenceGaps = false,
): JourneyStep[] {
  if (state === "abstained") {
    return JOURNEY_STEPS.map((step) => ({
      ...step,
      status:
        step.id === "understand" || step.id === "plan"
          ? "complete"
          : step.id === "prove"
            ? hasEvidenceGaps
              ? "stopped"
              : "complete"
            : "skipped",
    }));
  }
  const current = currentJourneyIndex(state);
  const isStopped = state === "blocked" || state === "cancelled";
  const isTerminal =
    state === "complete" ||
    state === "accepted_with_gaps" ||
    state === "abstained";
  const normalizedWatch = watchState?.toLowerCase();
  const watchIsComplete = ["complete", "healthy", "verified"].includes(
    normalizedWatch ?? "",
  );
  const watchIsCurrent = Boolean(normalizedWatch) && !watchIsComplete;

  return JOURNEY_STEPS.map((step, index) => {
    let status: JourneyStatus =
      index < current ? "complete" : index === current ? "current" : "upcoming";

    if (isStopped && index === current) status = "stopped";
    if (isTerminal && index <= current) status = "complete";

    if (step.id === "watch") {
      status = watchIsComplete
        ? "complete"
        : watchIsCurrent
          ? "current"
          : "upcoming";
    }

    return { ...step, status };
  });
}

export function TrustDial({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: AssuranceLevel;
  onChange?: (value: AssuranceLevel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const dialId = useId();
  const profile = ASSURANCE_PROFILES[value];

  if (!onChange) {
    return (
      <section
        className={`trust-dial trust-dial--readonly${compact ? " trust-dial--compact" : ""}`}
        aria-labelledby={`${dialId}-label ${dialId}-value`}
        aria-describedby={`${dialId}-description`}
      >
        <div className="trust-dial__intro">
          <span id={`${dialId}-label`}>Trust Dial</span>
          <strong id={`${dialId}-value`}>{profile.label}</strong>
        </div>
        <p id={`${dialId}-description`}>{profile.description}</p>
      </section>
    );
  }

  return (
    <fieldset
      className={`trust-dial${compact ? " trust-dial--compact" : ""}`}
      disabled={disabled}
      aria-describedby={`${dialId}-selection`}
    >
      <legend>Trust Dial</legend>
      <div className="trust-dial__options">
        {(Object.keys(ASSURANCE_PROFILES) as AssuranceLevel[]).map((level) => {
          const option = ASSURANCE_PROFILES[level];
          return (
            <label
              className={level === value ? "is-selected" : undefined}
              key={level}
              title={`${option.label}: ${option.description}`}
            >
              <input
                type="radio"
                name="krater-assurance"
                value={level}
                checked={level === value}
                onChange={() => onChange(level)}
                aria-label={option.label}
                aria-describedby={`${dialId}-${level}-description`}
              />
              <span>{compact ? option.shortLabel : option.label}</span>
              <span
                className="sr-only"
                id={`${dialId}-${level}-description`}
              >
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
      <p
        id={`${dialId}-selection`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>{profile.label}.</strong> {profile.description}
      </p>
    </fieldset>
  );
}

export function TaskJourney({
  state,
  watchState,
  gaps = [],
}: {
  state: TaskState | string;
  watchState?: string;
  gaps?: readonly string[];
}) {
  const headingId = useId();
  const steps = taskJourney(state, watchState, gaps.length > 0);
  const isNoChange = state === "abstained";
  return (
    <section className="task-journey" aria-labelledby={headingId}>
      <div className="task-workspace-section-heading">
        <div>
          <span>Task journey</span>
          <h3 id={headingId}>From request to trusted result</h3>
        </div>
        <p>
          {isNoChange
            ? "No code or release was produced; shipping and production watch do not apply."
            : "Watch remains optional until follow-up assurance is connected."}
        </p>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li
            className={`task-journey__step task-journey__step--${step.status}`}
            key={step.id}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span className="task-journey__marker" aria-hidden="true">
              {step.status === "complete"
                ? "✓"
                : step.status === "stopped"
                  ? "!"
                  : step.status === "skipped"
                    ? "–"
                  : index + 1}
            </span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.description}</small>
              <em>
                {step.status === "complete"
                  ? "Complete"
                  : step.status === "current"
                    ? "In progress"
                    : step.status === "stopped"
                      ? isNoChange
                        ? "Uncertainty recorded"
                        : "Needs attention"
                      : step.status === "skipped"
                        ? "Not needed"
                      : step.id === "watch"
                        ? "Not connected"
                        : "Upcoming"}
              </em>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Interpretation = {
  id?: string;
  description?: string;
  label?: string;
  selected?: boolean;
};

function MirrorCard({
  eyebrow,
  title,
  icon,
  children,
}: {
  eyebrow: string;
  title: string;
  icon: string;
  children: ReactNode;
}) {
  return (
    <article className="intent-mirror__card">
      <span className="intent-mirror__icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <span className="intent-mirror__eyebrow">{eyebrow}</span>
        <h4>{title}</h4>
        {children}
      </div>
    </article>
  );
}

function MirrorItems({
  items,
  fallback,
}: {
  items: string[];
  fallback: string;
}) {
  if (!items.length) return <p className="intent-mirror__fallback">{fallback}</p>;
  if (items.length === 1) return <p>{items[0]}</p>;
  return (
    <ul>
      {items.slice(0, 3).map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

export function IntentMirror({
  request,
  interpretations = [],
  nonGoals = [],
  negativeGuarantees = [],
  acceptanceCriteria = [],
  claims = [],
  patchStatus,
}: {
  request: string;
  interpretations?: Interpretation[];
  nonGoals?: string[];
  negativeGuarantees?: string[];
  acceptanceCriteria?: string[];
  claims?: string[];
  patchStatus?: string;
}) {
  const headingId = useId();
  const selectedInterpretations = interpretations
    .filter((interpretation) => interpretation.selected)
    .map(
      (interpretation) =>
        interpretation.description?.trim() || interpretation.label?.trim() || "",
    )
    .filter(Boolean);
  const understood = selectedInterpretations.length
    ? selectedInterpretations
    : request.trim()
      ? [request.trim()]
      : [];
  const protectedItems = [...negativeGuarantees, ...nonGoals].filter(Boolean);
  const successItems = acceptanceCriteria.length
    ? acceptanceCriteria.filter(Boolean)
    : claims.filter(Boolean);

  return (
    <section className="intent-mirror" aria-labelledby={headingId}>
      <div className="task-workspace-section-heading">
        <div>
          <span>Intent Mirror</span>
          <h3 id={headingId}>The agreement before the code</h3>
        </div>
        <p>Check these three cards before you trust the result.</p>
      </div>
      <div className="intent-mirror__grid">
        <MirrorCard eyebrow="Understood" title="What I understood" icon="1">
          <MirrorItems
            items={understood}
            fallback="Krater has not recorded a clear interpretation yet."
          />
        </MirrorCard>
        <MirrorCard eyebrow="Protected" title="What stays protected" icon="2">
          <MirrorItems
            items={protectedItems}
            fallback={
              patchStatus === "staged"
                ? "Your working files stay untouched until you publish the staged change."
                : "No explicit protected behavior has been recorded yet."
            }
          />
        </MirrorCard>
        <MirrorCard eyebrow="Success" title="How we know it worked" icon="3">
          <MirrorItems
            items={successItems}
            fallback="Required proof is still being established."
          />
        </MirrorCard>
      </div>
    </section>
  );
}

export type PlanStepView = {
  id: string;
  title: string;
  description: string;
  kind: string;
  status: string;
  proofObligationIds?: string[];
};

export type ProofObligationView = {
  id: string;
  statement: string;
  status: string;
  required?: boolean;
  minimumGrade?: string;
  nonApplicabilityReason?: string;
};

export type TaskPlanView = {
  id: string;
  revision: number;
  status: string;
  objective: string;
  digest?: string;
  steps: PlanStepView[];
  proofObligations: ProofObligationView[];
};

const PLAN_STEP_STATUS: Record<
  string,
  { label: string; symbol: string }
> = {
  pending: { label: "Upcoming", symbol: "·" },
  ready: { label: "Ready", symbol: "→" },
  running: { label: "In progress", symbol: "…" },
  blocked: { label: "Needs attention", symbol: "!" },
  completed: { label: "Done", symbol: "✓" },
  skipped: { label: "Not needed", symbol: "–" },
  cancelled: { label: "Stopped", symbol: "×" },
};

function planStepStatus(status: string) {
  return (
    PLAN_STEP_STATUS[status] ?? {
      label: status.replace(/_/g, " "),
      symbol: "·",
    }
  );
}

export function PlanOutline({ plan }: { plan: TaskPlanView }) {
  const headingId = useId();
  const required = plan.proofObligations.filter(
    (obligation) => obligation.required !== false,
  );
  const notApplicable = required.filter(
    (obligation) => obligation.status === "not_applicable",
  );
  const applicable = required.filter(
    (obligation) => obligation.status !== "not_applicable",
  );
  const cleared = applicable.filter((obligation) =>
    ["satisfied", "waived"].includes(obligation.status),
  ).length;
  const unresolved = applicable.length - cleared;
  const completed = plan.steps.filter((step) =>
    ["completed", "skipped", "cancelled"].includes(step.status),
  ).length;
  const isClosedNoChange = plan.status === "closed";

  return (
    <section className="task-plan" aria-labelledby={headingId}>
      <div className="task-workspace-section-heading">
        <div>
          <span>Adaptive plan</span>
          <h3 id={headingId}>{plan.objective}</h3>
        </div>
        <p>
          Revision {plan.revision} ·{" "}
          {isClosedNoChange
            ? "closed after no-change decision"
            : plan.status.replace(/_/g, " ")}
        </p>
      </div>
      <div
        className="task-plan__summary"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span>
          <strong>{completed}</strong> of {plan.steps.length} steps{" "}
          {isClosedNoChange ? "concluded" : "cleared"}
        </span>
        <span>
          <strong>{cleared}</strong> of {applicable.length} applicable required
          proofs established
        </span>
        {notApplicable.length > 0 && (
          <span>
            <strong>{notApplicable.length}</strong> change-only proof
            {notApplicable.length === 1 ? "" : "s"} not applicable
          </span>
        )}
        {isClosedNoChange && unresolved > 0 && (
          <span>
            <strong>{unresolved}</strong> remaining outcome uncertaint
            {unresolved === 1 ? "y" : "ies"}
          </span>
        )}
      </div>
      {notApplicable.length > 0 && (
        <>
          <p className="task-plan__disposition">
            Not-applicable proofs were excluded because no patch or publication
            occurred. They are not counted as passed.
          </p>
          <details className="task-plan__proof-dispositions">
            <summary>
              Why {notApplicable.length} proof
              {notApplicable.length === 1 ? " did" : "s did"} not apply
            </summary>
            <ul>
              {notApplicable.map((obligation) => (
                <li key={obligation.id}>
                  <strong>{obligation.statement}</strong>
                  <span>
                    {obligation.nonApplicabilityReason ??
                      "The plan recorded this proof as not applicable."}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <ol className="task-plan__steps">
        {plan.steps.map((step) => {
          const status = planStepStatus(step.status);
          const referencedProofs = (step.proofObligationIds ?? [])
            .map((id) =>
              plan.proofObligations.find(
                (obligation) => obligation.id === id,
              ),
            )
            .filter(
              (obligation): obligation is ProofObligationView =>
                obligation !== undefined,
            );
          const applicableProofs = referencedProofs.filter(
            (obligation) => obligation.status !== "not_applicable",
          );
          return (
            <li
              key={step.id}
              className={`task-plan__step task-plan__step--${step.status}`}
            >
              <span className="task-plan__marker" aria-hidden="true">
                {status.symbol}
              </span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
                <small>
                  {status.label}
                  {referencedProofs.length
                    ? applicableProofs.length === 0
                      ? " · proof checks not needed"
                      : ` · ${applicableProofs.length} applicable proof obligation${
                          applicableProofs.length === 1 ? "" : "s"
                        }`
                    : ""}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
