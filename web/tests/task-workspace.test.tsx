import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvidenceCenter, {
  EvidenceOriginBadge,
  type EvidenceOrigin,
} from "../src/EvidenceCenter";
import {
  ASSURANCE_PROFILES,
  IntentMirror,
  PlanOutline,
  TaskJourney,
  TrustDial,
  taskListIndexForKey,
  taskJourney,
  taskStateCopy,
  workspaceViewForKey,
} from "../src/TaskWorkspace";

describe("TaskWorkspace", () => {
  it("maps technical assurance levels to user-facing Trust Dial choices", () => {
    expect(ASSURANCE_PROFILES.fast.label).toBe("Quick check");
    expect(ASSURANCE_PROFILES.standard.label).toBe("Build and verify");
    expect(ASSURANCE_PROFILES.high.label).toBe("High-stakes review");

    const html = renderToStaticMarkup(
      <TrustDial value="standard" onChange={() => undefined} compact />,
    );

    expect(html).toContain("<legend>Trust Dial</legend>");
    expect(html).toMatch(/checked="" value="standard"/);
    expect(html).toContain("Build and verify.");
    expect(html).toContain('aria-label="Build and verify"');
    expect(html).toContain("Build safely, then prove the result.");
  });

  it("uses plain-language task states and safely falls back for future states", () => {
    expect(taskStateCopy("verification").label).toBe("Proving the result");
    expect(taskStateCopy("blocked").label).toBe("Needs your help");
    expect(taskStateCopy("future_state").label).toBe("Task update");
  });

  it("shows the complete six-step journey without pretending Watch is active", () => {
    const steps = taskJourney("verification");
    expect(steps.map((step) => step.label)).toEqual([
      "Understand",
      "Plan",
      "Build / Debug",
      "Prove",
      "Ship",
      "Watch",
    ]);
    expect(steps.find((step) => step.id === "prove")?.status).toBe("current");
    expect(steps.find((step) => step.id === "watch")?.status).toBe("upcoming");

    const html = renderToStaticMarkup(<TaskJourney state="verification" />);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Not connected");
  });

  it("closes a no-change journey without implying build, ship, or watch work", () => {
    const complete = taskJourney("abstained");
    expect(
      complete.map((step) => [step.id, step.status]),
    ).toEqual([
      ["understand", "complete"],
      ["plan", "complete"],
      ["build", "skipped"],
      ["prove", "complete"],
      ["ship", "skipped"],
      ["watch", "skipped"],
    ]);
    expect(taskJourney("abstained", undefined, true)).toContainEqual(
      expect.objectContaining({ id: "prove", status: "stopped" }),
    );

    const html = renderToStaticMarkup(
      <TaskJourney
        state="abstained"
        gaps={["The requested outcome still lacks direct evidence."]}
      />,
    );
    expect(html).not.toContain('aria-current="step"');
    expect(html).toContain("No code or release was produced");
    expect(html).toContain("Uncertainty recorded");
    expect(html.match(/Not needed/g)).toHaveLength(3);
    expect(html).not.toContain("Shipping the change");
  });

  it("renders the Intent Mirror from selected intent, boundaries, and success criteria", () => {
    const html = renderToStaticMarkup(
      <IntentMirror
        request="Make checkout safer"
        interpretations={[
          {
            id: "interpretation-1",
            description: "Prevent duplicate checkout submissions",
            selected: true,
          },
          {
            id: "interpretation-2",
            description: "Redesign the checkout",
            selected: false,
          },
        ]}
        nonGoals={["Do not change payment providers"]}
        acceptanceCriteria={["A repeated click creates only one order"]}
      />,
    );

    expect(html).toContain("What I understood");
    expect(html).toContain("Prevent duplicate checkout submissions");
    expect(html).not.toContain("Redesign the checkout");
    expect(html).toContain("What stays protected");
    expect(html).toContain("Do not change payment providers");
    expect(html).toContain("How we know it worked");
    expect(html).toContain("A repeated click creates only one order");
  });

  it("renders the executable plan and proof progress without agent jargon", () => {
    const html = renderToStaticMarkup(
      <PlanOutline
        plan={{
          id: "plan-1",
          revision: 2,
          status: "approved",
          objective: "Prevent duplicate checkout submissions",
          steps: [
            {
              id: "discover",
              kind: "discover",
              title: "Understand the project",
              description: "Inspect the existing checkout behavior.",
              status: "completed",
              proofObligationIds: [],
            },
            {
              id: "verify",
              kind: "verify",
              title: "Prove the result",
              description: "Run the duplicate-submission checks.",
              status: "running",
              proofObligationIds: ["proof-1"],
            },
          ],
          proofObligations: [
            {
              id: "proof-1",
              statement: "Repeated clicks create one order",
              status: "pending",
              required: true,
              minimumGrade: "tested",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Adaptive plan");
    expect(html).toContain("Revision 2 · approved");
    expect(html).toContain("1</strong> of 2 steps cleared");
    expect(html).toContain(
      "0</strong> of 1 applicable required proofs established",
    );
    expect(html).toContain("In progress");
    expect(html).toContain('role="status"');
  });

  it("separates no-change dispositions from applicable proof gaps", () => {
    const html = renderToStaticMarkup(
      <PlanOutline
        plan={{
          id: "plan-no-change",
          revision: 3,
          status: "closed",
          objective: "Leave the already-correct parser unchanged",
          steps: [
            {
              id: "discover",
              kind: "discover",
              title: "Establish whether a change is needed",
              description: "Repository evidence supports no change.",
              status: "completed",
              proofObligationIds: [],
            },
            {
              id: "publish",
              kind: "publish",
              title: "No publication needed",
              description: "Nothing was shipped.",
              status: "skipped",
              proofObligationIds: ["proof-publish"],
            },
          ],
          proofObligations: [
            {
              id: "proof-request",
              statement: "The parser already behaves as requested",
              status: "pending",
              required: true,
              minimumGrade: "tested",
            },
            {
              id: "proof-publish",
              statement: "Required check: conflict_check",
              status: "not_applicable",
              required: true,
              minimumGrade: "tested",
              nonApplicabilityReason: "No patch was published.",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Revision 3 · closed after no-change decision");
    expect(html).toContain("2</strong> of 2 steps concluded");
    expect(html).toContain(
      "0</strong> of 1 applicable required proofs established",
    );
    expect(html).toContain("1</strong> change-only proof not applicable");
    expect(html).toContain("1</strong> remaining outcome uncertainty");
    expect(html).toContain("They are not counted as passed");
    expect(html).toContain("Why 1 proof did not apply");
    expect(html).toContain("Required check: conflict_check");
    expect(html).toContain("No patch was published");
    expect(html).toContain("proof checks not needed");
    expect(html).not.toContain("2 required proofs cleared");
  });

  it("supports standard keyboard navigation for workspace tabs", () => {
    expect(workspaceViewForKey("ide", "ArrowRight")).toBe("chat");
    expect(workspaceViewForKey("evidence", "ArrowRight")).toBe("ide");
    expect(workspaceViewForKey("ide", "ArrowLeft")).toBe("evidence");
    expect(workspaceViewForKey("chat", "Home")).toBe("ide");
    expect(workspaceViewForKey("chat", "End")).toBe("evidence");
    expect(workspaceViewForKey("chat", "Enter")).toBeUndefined();
  });

  it("supports wraparound arrow navigation in task history", () => {
    expect(taskListIndexForKey(0, "ArrowUp", 4)).toBe(3);
    expect(taskListIndexForKey(3, "ArrowDown", 4)).toBe(0);
    expect(taskListIndexForKey(2, "Home", 4)).toBe(0);
    expect(taskListIndexForKey(0, "End", 4)).toBe(3);
    expect(taskListIndexForKey(0, "Tab", 4)).toBeUndefined();
    expect(taskListIndexForKey(0, "ArrowDown", 0)).toBeUndefined();
  });

  it("exposes labelled task-history and live loading semantics", () => {
    const html = renderToStaticMarkup(
      <EvidenceCenter projectId="local-project" />,
    );

    expect(html).toContain('aria-label="Krater task workspace"');
    expect(html).toContain('aria-labelledby="task-history-heading"');
    expect(html).toContain('id="task-history-heading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Task details"');
    expect(html).toContain('aria-busy="true"');
  });

  it.each([
    ["repository", "Repository evidence"],
    ["agent_author", "Agent-authored evidence"],
    ["blind_verifier", "Independent verifier"],
    ["human", "Human-provided evidence"],
    ["tool", "Host tool evidence"],
  ] satisfies Array<[EvidenceOrigin, string]>)(
    "renders the %s provenance in plain language",
    (origin, label) => {
      const html = renderToStaticMarkup(
        <EvidenceOriginBadge origin={origin} />,
      );

      expect(html).toContain(`Source: ${label}`);
      expect(html).toContain(`aria-label="Evidence source: ${label}"`);
    },
  );

  it("renders unknown API provenance safely", () => {
    const html = renderToStaticMarkup(
      <EvidenceOriginBadge origin="future_attestation_provider" />,
    );

    expect(html).toContain("Source: Unknown source");
    expect(html).toContain('aria-label="Evidence source: Unknown source"');
    expect(html).toContain("evidence-origin--unknown");
    expect(html).not.toContain("future_attestation_provider");
  });
});
