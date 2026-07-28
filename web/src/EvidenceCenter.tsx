import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  ASSURANCE_PROFILES,
  IntentMirror,
  PlanOutline,
  TaskJourney,
  TrustDial,
  taskListIndexForKey,
  taskStateCopy,
  type AssuranceLevel,
  type TaskState,
  type TaskPlanView,
} from "./TaskWorkspace";
import { apiFetch } from "./api";

type EvidenceGrade =
  | "not_established"
  | "observed"
  | "tested"
  | "stress_tested"
  | "formally_verified";

type TaskSummary = {
  id: string;
  projectId: string;
  request: string;
  state: TaskState;
  assurance: AssuranceLevel;
  createdAt: string;
  updatedAt: string;
  verdict?: string;
  evidenceGrade?: EvidenceGrade;
};

type IntentRecord = {
  id: string;
  kind: string;
  text: string;
  status?: string;
};

type EvidenceRecord = {
  id: string;
  kind: string;
  grade: EvidenceGrade;
  summary: string;
  ok?: boolean;
  createdAt?: string;
  stale?: boolean;
};

type ClaimRecord = {
  id: string;
  statement: string;
  grade: EvidenceGrade;
  status?: string;
  evidenceIds?: string[];
};

type TaskDetail = {
  task: TaskSummary;
  contract?: {
    interpretations?: Array<{
      id?: string;
      description?: string;
      label?: string;
      selected?: boolean;
    }>;
    assumptions?: string[];
    acceptanceCriteria?: string[];
    nonGoals?: string[];
    negativeGuarantees?: string[];
    maxCostUsd?: number;
    maxTimeMs?: number;
  };
  intents?: IntentRecord[];
  evidence?: EvidenceRecord[];
  claims?: ClaimRecord[];
  gaps?: string[];
  watch?: {
    state?: string;
    summary?: string;
  };
  autopilot?: {
    currentPlan?: TaskPlanView;
    planRevisions?: TaskPlanView[];
    proofLeases?: Array<{ id: string; expiresAt: string }>;
    proofLeaseInvalidations?: Array<{ id: string; leaseId: string }>;
    productionObservations?: Array<{
      id: string;
      status: string;
      summary: string;
    }>;
  };
  eventCount?: number;
  passportDigest?: string;
  capsuleDigest?: string;
  proofPatch?: {
    transactionId: string;
    status: "staged" | "published" | "rolled_back";
    changedPaths: string[];
    unsupportedPaths: string[];
    publishedAt?: string;
    rolledBackAt?: string;
  };
};

type TasksPayload = { tasks: TaskSummary[] };
const PUBLICATION_PENDING_GAP =
  "Transactional publication is pending explicit user acceptance.";

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof payload.error?.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    // Keep the caller's stable fallback for malformed or empty responses.
  }
  return fallback;
}

function EmptyState() {
  return (
    <div className="evidence-empty">
      <div className="evidence-empty__mark" aria-hidden="true">
        ◇
      </div>
      <h3>No task history yet</h3>
      <p>
        Start a task in Chat or the IDE. Krater will keep its intent, progress,
        proof, and publication decision together here.
      </p>
    </div>
  );
}

function GradeBadge({ grade }: { grade: EvidenceGrade }) {
  return (
    <span
      className={`evidence-grade evidence-grade--${grade}`}
      aria-label={`Evidence grade: ${humanize(grade)}`}
    >
      {humanize(grade)}
    </span>
  );
}

function TaskDetailView({
  detail,
  onRefresh,
  onMutated,
  headingRef,
}: {
  detail: TaskDetail;
  onRefresh: () => void;
  onMutated: () => Promise<void>;
  headingRef: RefObject<HTMLHeadingElement>;
}) {
  const { task } = detail;
  const stateCopy = taskStateCopy(task.state);
  const assuranceProfile = ASSURANCE_PROFILES[task.assurance];
  const [mutationError, setMutationError] = useState("");
  const [mutating, setMutating] = useState<
    "export" | "publish" | "rollback" | "cancel" | ""
  >("");
  const [acceptGaps, setAcceptGaps] = useState(false);
  const publicationGaps = (detail.gaps ?? []).filter(
    (gap) => gap !== PUBLICATION_PENDING_GAP,
  );
  useEffect(() => {
    setMutationError("");
    setMutating("");
    setAcceptGaps(false);
  }, [task.id]);
  const downloadPassport = useCallback(async () => {
    setMutationError("");
    setMutating("export");
    try {
      const response = await apiFetch(
        `/api/v2/tasks/${encodeURIComponent(task.id)}/passport?format=markdown`,
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not export passport."),
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `krater-passport-${task.id}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setMutationError((caught as Error).message);
    } finally {
      setMutating("");
    }
  }, [task.id]);

  const publishPatch = useCallback(async () => {
    setMutationError("");
    setMutating("publish");
    try {
      const response = await apiFetch(
        `/api/v2/tasks/${encodeURIComponent(task.id)}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptGaps }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not publish patch."));
      }
      await onMutated();
    } catch (caught) {
      setMutationError((caught as Error).message);
    } finally {
      setMutating("");
    }
  }, [acceptGaps, onMutated, task.id]);

  const rollbackPatch = useCallback(async () => {
    if (
      !window.confirm(
        task.state === "review"
          ? "Discard this staged ProofPatch transaction?"
          : "Roll back this published ProofPatch? Concurrent edits will be protected.",
      )
    ) {
      return;
    }
    setMutationError("");
    setMutating("rollback");
    try {
      const response = await apiFetch(
        `/api/v2/tasks/${encodeURIComponent(task.id)}/rollback`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not roll back patch."));
      }
      await onMutated();
    } catch (caught) {
      setMutationError((caught as Error).message);
    } finally {
      setMutating("");
    }
  }, [onMutated, task.id, task.state]);

  const cancelTask = useCallback(async () => {
    if (!window.confirm("Cancel this unpublished task?")) return;
    setMutationError("");
    setMutating("cancel");
    try {
      const response = await apiFetch(
        `/api/v2/tasks/${encodeURIComponent(task.id)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Task cancelled from the Krater Pro task workspace.",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not cancel task."));
      }
      await onMutated();
    } catch (caught) {
      setMutationError((caught as Error).message);
    } finally {
      setMutating("");
    }
  }, [onMutated, task.id]);

  const canCancelWithoutRollback =
    [
      "intake",
      "discovery",
      "clarification",
      "reproduction",
      "staging",
      "verification",
      "review",
    ].includes(task.state) &&
    (!detail.proofPatch || detail.proofPatch.status === "rolled_back");

  return (
    <article className="evidence-detail" aria-labelledby="evidence-task-title">
      <header className="evidence-detail__header">
        <div>
          <div className="evidence-detail__eyebrow">
            <span className={`task-state task-state--${task.state}`}>
              {stateCopy.label}
            </span>
            <span>{assuranceProfile.label}</span>
            {task.evidenceGrade && <GradeBadge grade={task.evidenceGrade} />}
            {detail.proofPatch && (
              <span className="task-state">
                Patch {humanize(detail.proofPatch.status)}
              </span>
            )}
          </div>
          <h2 id="evidence-task-title" ref={headingRef} tabIndex={-1}>
            {task.request || "Untitled task"}
          </h2>
          <p className="evidence-detail__state-description">
            {stateCopy.description}
          </p>
          <p>
            Updated {formatDate(task.updatedAt)}
            {detail.eventCount !== undefined
              ? ` · ${detail.eventCount} recorded events`
              : ""}
          </p>
        </div>
        <div
          className="evidence-detail__actions"
          role="group"
          aria-label="Task actions"
        >
          <button type="button" className="button button--secondary" onClick={onRefresh}>
            Refresh
          </button>
          {detail.passportDigest && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => void downloadPassport()}
              disabled={Boolean(mutating)}
            >
              {mutating === "export" ? "Exporting…" : "Export passport"}
            </button>
          )}
          {task.state === "review" &&
            detail.proofPatch?.status === "staged" && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => void publishPatch()}
              disabled={
                Boolean(mutating) ||
                (publicationGaps.length > 0 && !acceptGaps)
              }
              aria-describedby={
                publicationGaps.length > 0
                  ? "publication-gap-instruction"
                  : undefined
              }
            >
              {mutating === "publish" ? "Publishing…" : "Publish patch"}
            </button>
          )}
          {detail.proofPatch &&
            ["staged", "published"].includes(detail.proofPatch.status) && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void rollbackPatch()}
              disabled={Boolean(mutating)}
            >
              {mutating === "rollback"
                ? "Rolling back…"
                : detail.proofPatch.status === "staged"
                  ? "Discard patch"
                  : "Roll back"}
            </button>
          )}
          {canCancelWithoutRollback && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void cancelTask()}
              disabled={Boolean(mutating)}
            >
              {mutating === "cancel" ? "Cancelling…" : "Cancel task"}
            </button>
          )}
        </div>
      </header>

      {mutationError && (
        <div className="notice notice--error" role="alert">
          {mutationError}
        </div>
      )}

      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {mutating === "export"
          ? "Exporting the task passport."
          : mutating === "publish"
            ? "Publishing the staged patch."
            : mutating === "rollback"
              ? "Rolling back the patch."
              : mutating === "cancel"
                ? "Cancelling the task."
                : ""}
      </div>

      {task.state === "review" && publicationGaps.length > 0 && (
        <label
          className="evidence-gap-acceptance"
          id="publication-gap-instruction"
        >
          <input
            type="checkbox"
            checked={acceptGaps}
            onChange={(event) => setAcceptGaps(event.target.checked)}
          />
          <span>
            I reviewed and accept all {publicationGaps.length} documented evidence
            gap{publicationGaps.length === 1 ? "" : "s"} for this publication.
          </span>
        </label>
      )}

      <div className="task-workspace-overview">
        <TrustDial value={task.assurance} />
        <div
          className="task-workspace-overview__status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>Right now</span>
          <strong>{stateCopy.label}</strong>
          <p>{stateCopy.description}</p>
        </div>
      </div>

      <TaskJourney
        state={task.state}
        watchState={detail.watch?.state}
        gaps={detail.gaps}
      />

      <IntentMirror
        request={task.request}
        interpretations={detail.contract?.interpretations}
        nonGoals={detail.contract?.nonGoals}
        negativeGuarantees={detail.contract?.negativeGuarantees}
        acceptanceCriteria={detail.contract?.acceptanceCriteria}
        claims={detail.claims
          ?.filter((claim) => claim.status !== "contradicted")
          .map((claim) => claim.statement)}
        patchStatus={detail.proofPatch?.status}
      />

      {detail.autopilot?.currentPlan && (
        <PlanOutline plan={detail.autopilot.currentPlan} />
      )}

      {detail.gaps?.length ? (
        <section className="task-gap-callout" aria-labelledby="task-gap-callout-title">
          <span aria-hidden="true">!</span>
          <div>
            <h3 id="task-gap-callout-title">
              {detail.gaps.length} known evidence gap
              {detail.gaps.length === 1 ? "" : "s"}
            </h3>
            <p>{detail.gaps[0]}</p>
          </div>
        </section>
      ) : null}

      <details className="advanced-evidence">
        <summary>
          <span>
            <strong>Advanced evidence and provenance</strong>
            <small>
              {detail.evidence?.length ?? 0} evidence records ·{" "}
              {detail.intents?.length ?? 0} intent links ·{" "}
              {detail.gaps?.length ?? 0} known gaps
            </small>
          </span>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="advanced-evidence__body">
          {detail.contract && (
            <section className="evidence-card" aria-labelledby="outcome-contract-heading">
              <div className="evidence-card__heading">
                <h3 id="outcome-contract-heading">Outcome contract</h3>
                <span>{assuranceProfile.label}</span>
              </div>
              <div className="evidence-contract-grid">
                <div>
                  <h4>Acceptance criteria</h4>
                  {detail.contract.acceptanceCriteria?.length ? (
                    <ul>
                      {detail.contract.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="evidence-muted">No explicit criteria recorded.</p>
                  )}
                </div>
                <div>
                  <h4>Assumptions</h4>
                  {detail.contract.assumptions?.length ? (
                    <ul>
                      {detail.contract.assumptions.map((assumption) => (
                        <li key={assumption}>{assumption}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="evidence-muted">No unresolved assumptions.</p>
                  )}
                </div>
                <div>
                  <h4>Boundaries</h4>
                  <p>
                    {detail.contract.maxCostUsd === undefined
                      ? "No monetary ceiling"
                      : `$${detail.contract.maxCostUsd.toFixed(2)} maximum`}
                    {" · "}
                    {detail.contract.maxTimeMs === undefined
                      ? "No explicit deadline"
                      : `${Math.round(detail.contract.maxTimeMs / 1_000)}s maximum`}
                  </p>
                </div>
              </div>
            </section>
          )}

          <div className="evidence-columns">
            <section className="evidence-card" aria-labelledby="intent-coverage-heading">
              <div className="evidence-card__heading">
                <h3 id="intent-coverage-heading">Intent coverage</h3>
                <span>{detail.intents?.length ?? 0}</span>
              </div>
              {detail.intents?.length ? (
                <ol className="evidence-list">
                  {detail.intents.map((intent) => (
                    <li key={intent.id}>
                      <div>
                        <strong>{intent.text}</strong>
                        <span>
                          {humanize(intent.kind)}
                          {intent.status ? ` · ${humanize(intent.status)}` : ""}
                        </span>
                      </div>
                      <code>{intent.id}</code>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="evidence-muted">No intent nodes recorded.</p>
              )}
            </section>

            <section className="evidence-card" aria-labelledby="claims-heading">
              <div className="evidence-card__heading">
                <h3 id="claims-heading">Claims</h3>
                <span>{detail.claims?.length ?? 0}</span>
              </div>
              {detail.claims?.length ? (
                <ol className="evidence-list">
                  {detail.claims.map((claim) => (
                    <li key={claim.id}>
                      <div>
                        <strong>{claim.statement}</strong>
                        <span>
                          {claim.status ? humanize(claim.status) : "Evidence linked"}
                        </span>
                      </div>
                      <GradeBadge grade={claim.grade} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="evidence-muted">No claims recorded.</p>
              )}
            </section>
          </div>

          <section className="evidence-card" aria-labelledby="verification-evidence-heading">
            <div className="evidence-card__heading">
              <h3 id="verification-evidence-heading">Verification evidence</h3>
              <span>{detail.evidence?.length ?? 0}</span>
            </div>
            {detail.evidence?.length ? (
              <ol className="evidence-list evidence-list--evidence">
                {detail.evidence.map((record) => (
                  <li
                    key={record.id}
                    className={record.stale ? "evidence-list__item--stale" : undefined}
                  >
                    <span className="sr-only">
                      {record.stale
                        ? "Stale evidence."
                        : record.ok === false
                          ? "Check failed."
                          : "Check passed."}
                    </span>
                    <div className="evidence-list__status" aria-hidden="true">
                      {record.stale ? "!" : record.ok === false ? "×" : "✓"}
                    </div>
                    <div>
                      <strong>{record.summary}</strong>
                      <span>
                        {humanize(record.kind)}
                        {record.createdAt ? ` · ${formatDate(record.createdAt)}` : ""}
                        {record.stale ? " · stale" : ""}
                      </span>
                    </div>
                    <GradeBadge grade={record.grade} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="evidence-muted">
                Required evidence has not yet been established.
              </p>
            )}
          </section>

          <section
            className={`evidence-card evidence-card--gaps${
              detail.gaps?.length ? " evidence-card--warning" : ""
            }`}
            aria-labelledby="known-gaps-heading"
          >
            <div className="evidence-card__heading">
              <h3 id="known-gaps-heading">Known gaps</h3>
              <span>{detail.gaps?.length ?? 0}</span>
            </div>
            {detail.gaps?.length ? (
              <ul>
                {detail.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            ) : (
              <p className="evidence-muted">No known evidence gaps.</p>
            )}
          </section>

          {(detail.passportDigest || detail.capsuleDigest) && (
            <footer className="evidence-passport-digest">
              <span>
                {detail.passportDigest ? "Passport digest" : "Capsule digest"}
              </span>
              <code>{detail.passportDigest ?? detail.capsuleDigest}</code>
            </footer>
          )}
        </div>
      </details>
    </article>
  );
}

export default function EvidenceCenter({
  projectId,
  onWorkspaceMutation,
}: {
  projectId: string;
  onWorkspaceMutation?: () => void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailRequestRef = useRef(0);
  const focusDetailAfterLoadRef = useRef(false);
  const taskButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch(
        `/api/v2/tasks?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not load tasks."));
      }
      const payload = (await response.json()) as TasksPayload;
      const next = Array.isArray(payload.tasks) ? payload.tasks : [];
      setTasks(next);
      setSelectedId((current) =>
        next.some((task) => task.id === current) ? current : (next[0]?.id ?? ""),
      );
    } catch (caught) {
      setError((caught as Error).message);
      setTasks([]);
      setSelectedId("");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadDetail = useCallback(async (taskId: string, preserve = false) => {
    const requestId = ++detailRequestRef.current;
    if (!taskId) {
      focusDetailAfterLoadRef.current = false;
      setDetail(null);
      return;
    }
    setError("");
    if (!preserve) setDetail(null);
    try {
      const response = await apiFetch(
        `/api/v2/tasks/${encodeURIComponent(taskId)}`,
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not load task evidence."),
        );
      }
      const nextDetail = (await response.json()) as TaskDetail;
      if (requestId === detailRequestRef.current) setDetail(nextDetail);
    } catch (caught) {
      if (requestId === detailRequestRef.current) {
        focusDetailAfterLoadRef.current = false;
        setError((caught as Error).message);
        setDetail(null);
      }
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!detail || !focusDetailAfterLoadRef.current) return;
    focusDetailAfterLoadRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      detailHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId),
    [selectedId, tasks],
  );

  const selectTask = useCallback((taskId: string) => {
    if (taskId === selectedId) {
      detailHeadingRef.current?.focus();
      return;
    }
    focusDetailAfterLoadRef.current = true;
    setSelectedId(taskId);
  }, [selectedId]);

  const moveTaskFocus = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const nextIndex = taskListIndexForKey(index, event.key, tasks.length);
      if (nextIndex === undefined) return;
      event.preventDefault();
      taskButtonRefs.current.get(tasks[nextIndex].id)?.focus();
    },
    [tasks],
  );

  return (
    <section
      className="evidence-center"
      aria-label="Krater task workspace"
      aria-busy={loading}
    >
      <aside className="evidence-sidebar" aria-labelledby="task-history-heading">
        <header>
          <div>
            <span className="evidence-sidebar__eyebrow">Local task record</span>
            <h2 id="task-history-heading">Tasks</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void loadTasks()}
            aria-label="Refresh task history"
            title="Refresh"
          >
            ↻
          </button>
        </header>
        {loading ? (
          <p className="evidence-sidebar__status" role="status">
            Loading task history…
          </p>
        ) : tasks.length ? (
          <nav
            aria-labelledby="task-history-heading"
            aria-describedby="task-history-keyboard-help"
          >
            <p className="sr-only" id="task-history-keyboard-help">
              Use the arrow keys to move through tasks, then press Enter or
              Space to open one.
            </p>
            <ol className="evidence-task-list">
              {tasks.map((task, index) => (
                <li key={task.id}>
                  <button
                    ref={(node) => {
                      if (node) taskButtonRefs.current.set(task.id, node);
                      else taskButtonRefs.current.delete(task.id);
                    }}
                    type="button"
                    className={`evidence-task${task.id === selectedId ? " is-active" : ""}`}
                    onClick={() => selectTask(task.id)}
                    onKeyDown={(event) => moveTaskFocus(event, index)}
                    aria-current={task.id === selectedId ? "page" : undefined}
                    aria-controls="task-detail-region"
                    tabIndex={task.id === selectedId ? 0 : -1}
                  >
                    <span
                      className={`evidence-task__state evidence-task__state--${task.state}`}
                      aria-hidden="true"
                    >
                      {task.state === "complete"
                        ? "✓"
                        : task.state === "abstained"
                          ? "○"
                          : task.state === "blocked"
                            ? "!"
                            : "◇"}
                    </span>
                    <span>
                      <strong>{task.request || "Untitled task"}</strong>
                      <small>
                        {taskStateCopy(task.state).label} ·{" "}
                        {formatDate(task.updatedAt)}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : (
          <p className="evidence-sidebar__status">No task history yet.</p>
        )}
      </aside>

      <section
        className="evidence-main"
        id="task-detail-region"
        aria-label="Task details"
        aria-busy={Boolean(selectedTask && !detail)}
      >
        {error && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}
        {!selectedTask ? (
          <EmptyState />
        ) : detail ? (
          <TaskDetailView
            detail={detail}
            headingRef={detailHeadingRef}
            onRefresh={() => void loadDetail(selectedTask.id, true)}
            onMutated={async () => {
              focusDetailAfterLoadRef.current = true;
              onWorkspaceMutation?.();
              await loadTasks();
              await loadDetail(selectedTask.id, true);
            }}
          />
        ) : error ? (
          <div className="evidence-empty">
            <h3>Task details unavailable</h3>
            <p>Resolve the reported error, then refresh the task history.</p>
          </div>
        ) : (
          <div
            className="evidence-empty"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            Loading task evidence…
          </div>
        )}
      </section>
    </section>
  );
}
