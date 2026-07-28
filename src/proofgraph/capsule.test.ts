import { describe, expect, it } from "vitest";
import {
  createChangePassport,
  createEvidenceCapsule,
  verifyChangePassport,
  verifyEvidenceCapsule,
  weakestEvidenceGrade,
} from "./index.js";
import type {
  ChangePassport,
  EvidenceRecord,
  TaskContract,
} from "./index.js";

const NOW = "2026-07-28T10:00:00.000Z";

function contract(taskId = "task-1"): TaskContract {
  return {
    schemaVersion: 1,
    id: "contract-1",
    taskId,
    request: "Fix the parser without exposing api_key=super-secret-value",
    interpretations: [
      { id: "interpretation-1", description: "Repair parsing", selected: true },
    ],
    assumptions: [],
    acceptanceCriteria: [
      { id: "criterion-1", statement: "Regression test passes", required: true },
    ],
    nonGoals: [],
    assurance: "standard",
    budget: { maxToolSteps: 20 },
    allowedCapabilities: ["read", "write", "test"],
    requiredChecks: ["npm test"],
    negativeGuarantees: ["No secret persistence"],
    createdAt: NOW,
  };
}

function testEvidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "evidence-1",
    taskId: "task-1",
    kind: "test",
    grade: "tested",
    origin: "blind_verifier",
    summary: "Regression test passed",
    supportsClaimIds: ["claim-1"],
    contradictsClaimIds: [],
    artifactDigests: [],
    stale: false,
    observedAt: NOW,
    ...overrides,
  };
}

function capsuleInput() {
  return {
    schemaVersion: 1 as const,
    taskId: "task-1",
    contract: contract(),
    state: "complete" as const,
    baseWorkspaceDigest: `sha256:${"a".repeat(64)}`,
    finalWorkspaceDigest: `sha256:${"b".repeat(64)}`,
    changedBehavior: ["Parser accepts empty optional fields"],
    negativeGuarantees: ["No secret persistence"],
    evidence: [testEvidence()],
    claims: [
      {
        id: "claim-1",
        taskId: "task-1",
        statement: "Parser regression is fixed",
        grade: "tested" as const,
        status: "supported" as const,
        supportingEvidenceIds: ["evidence-1"],
        contradictingEvidenceIds: [],
        createdAt: NOW,
      },
    ],
    gaps: [],
    approvals: [],
    cost: {
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 50,
      elapsedMs: 1_000,
    },
    generatedAt: NOW,
  };
}

describe("evidence capsules", () => {
  it("redacts secrets, generates a stable digest, and verifies offline", () => {
    const capsule = createEvidenceCapsule(capsuleInput());
    expect(capsule.contract.request).not.toContain("super-secret-value");
    expect(verifyEvidenceCapsule(capsule)).toMatchObject({
      valid: true,
      expectedDigest: capsule.digest,
      actualDigest: capsule.digest,
      errors: [],
    });
  });

  it("detects content tampering", () => {
    const capsule = createEvidenceCapsule(capsuleInput());
    const tampered = {
      ...capsule,
      changedBehavior: ["Unverified behavior"],
    };
    const verification = verifyEvidenceCapsule(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain(
      "Envelope digest does not match its canonical contents.",
    );
  });

  it("rejects unsupported formal-verification claims and inflated claim grades", () => {
    const unsupportedProof = createEvidenceCapsule({
      ...capsuleInput(),
      evidence: [
        testEvidence({
          kind: "test",
          grade: "formally_verified",
        }),
      ],
      claims: [
        {
          ...capsuleInput().claims[0],
          grade: "formally_verified",
        },
      ],
    });
    const errors = verifyEvidenceCapsule(unsupportedProof).errors;
    expect(errors.some((error) => /without a formal proof artifact/i.test(error))).toBe(
      true,
    );

    const inflated = createEvidenceCapsule({
      ...capsuleInput(),
      claims: [{ ...capsuleInput().claims[0], grade: "stress_tested" }],
    });
    expect(
      verifyEvidenceCapsule(inflated).errors.some((error) =>
        /above supporting evidence tested/i.test(error),
      ),
    ).toBe(true);
  });

  it("rejects false-complete capsules and broken evidence links", () => {
    const falseComplete = createEvidenceCapsule({
      ...capsuleInput(),
      gaps: ["Required check not established"],
    });
    expect(verifyEvidenceCapsule(falseComplete).errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/complete.*cannot.*gaps/i),
      ]),
    );

    const brokenLinks = createEvidenceCapsule({
      ...capsuleInput(),
      evidence: [
        testEvidence({
          supportsClaimIds: [],
        }),
      ],
    });
    expect(
      verifyEvidenceCapsule(brokenLinks).errors.some((error) =>
        /do not link bidirectionally/i.test(error),
      ),
    ).toBe(true);
  });
});

describe("change passports", () => {
  it("projects a valid capsule into an independently verifiable passport", () => {
    const capsule = createEvidenceCapsule(capsuleInput());
    const passport = createChangePassport(capsule, {
      title: "Parser repair",
      summary: "A regression was repaired and independently tested.",
      intentIds: ["criterion-1"],
      changedPaths: ["src/parser.ts"],
      provenance: [
        {
          source: "repository",
          trust: "untrusted",
          sensitivity: "proprietary",
        },
      ],
      generatedAt: NOW,
    });

    expect(passport.capsuleDigest).toBe(capsule.digest);
    expect(passport.weakestEvidenceGrade).toBe("tested");
    expect(verifyChangePassport(passport, capsule)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("detects passport tampering and a mismatched capsule", () => {
    const capsule = createEvidenceCapsule(capsuleInput());
    const passport = createChangePassport(capsule, {
      title: "Parser repair",
      summary: "Verified",
      intentIds: [],
      changedPaths: [],
      provenance: [],
      generatedAt: NOW,
    });
    const tampered: ChangePassport = { ...passport, gaps: ["new gap"] };
    expect(verifyChangePassport(tampered).valid).toBe(false);

    const otherCapsule = createEvidenceCapsule({
      ...capsuleInput(),
      taskId: "task-2",
      contract: contract("task-2"),
    });
    expect(
      verifyChangePassport(passport, otherCapsule).errors.some((error) =>
        /does not reference|task IDs differ/i.test(error),
      ),
    ).toBe(true);
  });

  it("rejects a self-consistent passport that misrepresents its capsule", () => {
    const capsule = createEvidenceCapsule(capsuleInput());
    const passport = createChangePassport(capsule, {
      title: "Parser repair",
      summary: "Verified",
      intentIds: [],
      changedPaths: [],
      provenance: [],
      generatedAt: NOW,
    });
    const forgedBody = {
      ...passport,
      verdict: "accepted_with_gaps" as const,
      gaps: ["hidden gap"],
    };
    const forged = createChangePassport(
      createEvidenceCapsule({
        ...capsuleInput(),
        state: "accepted_with_gaps",
        gaps: ["hidden gap"],
        approvals: ["human:test"],
      }),
      {
        title: forgedBody.title,
        summary: forgedBody.summary,
        intentIds: forgedBody.intentIds,
        changedPaths: forgedBody.changedPaths,
        provenance: forgedBody.provenance,
        generatedAt: forgedBody.generatedAt,
      },
    );

    expect(
      verifyChangePassport(forged, capsule).errors.some((error) =>
        /does not reference|verdict differs|gaps differ/i.test(error),
      ),
    ).toBe(true);
  });

  it("uses the conservative minimum evidence grade", () => {
    expect(weakestEvidenceGrade([])).toBe("not_established");
    expect(weakestEvidenceGrade(["stress_tested", "observed", "tested"])).toBe(
      "observed",
    );
  });
});
