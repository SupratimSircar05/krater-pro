import {
  canonicalStringify,
  isSha256Digest,
  sha256Digest,
  verifySha256Digest,
} from "./canonical.js";
import { redactForPersistence } from "./redaction.js";
import type {
  ChangePassport,
  EvidenceCapsule,
  EvidenceGrade,
} from "./types.js";

const EVIDENCE_WEIGHT: Record<EvidenceGrade, number> = {
  not_established: 0,
  observed: 1,
  tested: 2,
  stress_tested: 3,
  formally_verified: 4,
};

type DigestEnvelope = { digest: string };
type EvidenceCapsuleInput = Omit<EvidenceCapsule, "digest">;
type ChangePassportInput = Omit<ChangePassport, "digest">;

export interface DigestVerification {
  valid: boolean;
  expectedDigest: string;
  actualDigest: string;
  errors: string[];
}

function unsigned<T extends DigestEnvelope>(value: T): Omit<T, "digest"> {
  const { digest: _digest, ...rest } = value;
  return rest;
}

function digestEnvelope(value: Omit<DigestEnvelope, "digest">): string {
  return sha256Digest(canonicalStringify(value));
}

function verifyEnvelope<T extends DigestEnvelope>(value: T): DigestVerification {
  try {
    const unsignedValue = unsigned(value);
    const body = canonicalStringify(unsignedValue);
    const actualDigest = sha256Digest(body);
    const valid = verifySha256Digest(body, value.digest);
    const errors = valid
      ? []
      : ["Envelope digest does not match its canonical contents."];
    if (
      canonicalStringify(redactForPersistence(unsignedValue)) !== body
    ) {
      errors.push("Envelope contains unredacted secret-like content.");
    }
    return {
      valid: errors.length === 0,
      expectedDigest: value.digest,
      actualDigest,
      errors,
    };
  } catch (error) {
    return {
      valid: false,
      expectedDigest:
        value && typeof value.digest === "string" ? value.digest : "",
      actualDigest: "",
      errors: [
        `Envelope cannot be canonicalized: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

function validateEvidenceGrades(capsule: EvidenceCapsule): string[] {
  const errors: string[] = [];
  if (capsule.schemaVersion !== 1 || !capsule.taskId?.trim()) {
    errors.push("Capsule envelope has an invalid schema version or task ID.");
  }
  if (capsule.contract.taskId !== capsule.taskId) {
    errors.push("Capsule contract has a mismatched task ID.");
  }
  const documentsPostCompletionRollback =
    capsule.approvals.includes("human:requested_proofpatch_rollback") &&
    capsule.evidence.some(
      (evidence) =>
        evidence.tool === "ProofPatch" &&
        /rolled back/i.test(evidence.summary),
    );
  if (
    capsule.state === "complete" &&
    capsule.gaps.length > 0 &&
    !documentsPostCompletionRollback
  ) {
    errors.push("A complete capsule cannot retain documented evidence gaps.");
  }
  if (
    capsule.state === "accepted_with_gaps" &&
    (capsule.gaps.length === 0 || capsule.approvals.length === 0)
  ) {
    errors.push(
      "An accepted-with-gaps capsule requires documented gaps and an explicit approval receipt.",
    );
  }
  if (
    capsule.state === "complete" &&
    capsule.evidence.filter((evidence) => !evidence.stale).length === 0
  ) {
    errors.push("A complete capsule requires current supporting evidence.");
  }
  for (const [name, digest] of [
    ["base workspace", capsule.baseWorkspaceDigest],
    ["final workspace", capsule.finalWorkspaceDigest],
  ] as const) {
    if (digest && !isSha256Digest(digest)) {
      errors.push(`Capsule ${name} digest is not a SHA-256 digest.`);
    }
  }
  const evidenceIds = new Set<string>();
  for (const evidence of capsule.evidence) {
    if (!evidence.id?.trim() || evidenceIds.has(evidence.id)) {
      errors.push(`Evidence ID is empty or duplicated: ${evidence.id}.`);
    }
    evidenceIds.add(evidence.id);
    if (evidence.taskId !== capsule.taskId) {
      errors.push(`Evidence ${evidence.id} has a mismatched task ID.`);
    }
    for (const digest of evidence.artifactDigests) {
      if (!isSha256Digest(digest)) {
        errors.push(`Evidence ${evidence.id} has a malformed artifact digest.`);
      }
    }
    if (
      evidence.proofArtifactDigest &&
      !isSha256Digest(evidence.proofArtifactDigest)
    ) {
      errors.push(`Evidence ${evidence.id} has a malformed proof artifact digest.`);
    }
    if (
      evidence.grade === "formally_verified" &&
      (evidence.kind !== "formal_proof" || !evidence.proofArtifactDigest)
    ) {
      errors.push(
        `Evidence ${evidence.id} claims formal verification without a formal proof artifact.`,
      );
    }
  }
  const evidenceById = new Map(
    capsule.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const claimIds = new Set<string>();
  for (const claim of capsule.claims) {
    if (!claim.id?.trim() || claimIds.has(claim.id)) {
      errors.push(`Claim ID is empty or duplicated: ${claim.id}.`);
    }
    claimIds.add(claim.id);
    if (claim.taskId !== capsule.taskId) {
      errors.push(`Claim ${claim.id} has a mismatched task ID.`);
    }
    if (
      capsule.state === "complete" &&
      claim.status !== "supported"
    ) {
      errors.push(
        `Complete capsule retains ${claim.status} claim ${claim.id}.`,
      );
    }
    const supporting = claim.supportingEvidenceIds
      .map((id) => evidenceById.get(id))
      .filter(
        (item): item is EvidenceCapsule["evidence"][number] =>
          item !== undefined && !item.stale,
      );
    const strongest = supporting.reduce(
      (grade, item) =>
        EVIDENCE_WEIGHT[item.grade] > EVIDENCE_WEIGHT[grade] ? item.grade : grade,
      "not_established" as EvidenceGrade,
    );
    if (
      claim.status === "supported" &&
      EVIDENCE_WEIGHT[claim.grade] > EVIDENCE_WEIGHT[strongest]
    ) {
      errors.push(
        `Claim ${claim.id} has grade ${claim.grade}, above supporting evidence ${strongest}.`,
      );
    }
    if (claim.status === "supported" && supporting.length === 0) {
      errors.push(`Supported claim ${claim.id} has no current supporting evidence.`);
    }
    for (const evidenceId of claim.supportingEvidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        errors.push(
          `Claim ${claim.id} references missing supporting evidence ${evidenceId}.`,
        );
      } else if (!evidence.supportsClaimIds.includes(claim.id)) {
        errors.push(
          `Claim ${claim.id} and evidence ${evidenceId} do not link bidirectionally.`,
        );
      }
    }
    for (const evidenceId of claim.contradictingEvidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        errors.push(
          `Claim ${claim.id} references missing contradicting evidence ${evidenceId}.`,
        );
      } else if (!evidence.contradictsClaimIds.includes(claim.id)) {
        errors.push(
          `Claim ${claim.id} and contradicting evidence ${evidenceId} do not link bidirectionally.`,
        );
      }
    }
  }
  for (const evidence of capsule.evidence) {
    for (const claimId of [
      ...evidence.supportsClaimIds,
      ...evidence.contradictsClaimIds,
    ]) {
      if (!claimIds.has(claimId)) {
        errors.push(
          `Evidence ${evidence.id} references missing claim ${claimId}.`,
        );
      }
    }
  }
  return errors;
}

export function createEvidenceCapsule(input: EvidenceCapsuleInput): EvidenceCapsule {
  const body = redactForPersistence(input);
  return {
    ...body,
    digest: digestEnvelope(body),
  };
}

export function verifyEvidenceCapsule(capsule: EvidenceCapsule): DigestVerification {
  const verification = verifyEnvelope(capsule);
  let semanticErrors: string[];
  try {
    semanticErrors = validateEvidenceGrades(capsule);
  } catch (error) {
    semanticErrors = [
      `Capsule structure is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  const errors = [...verification.errors, ...semanticErrors];
  return {
    ...verification,
    valid: errors.length === 0,
    errors,
  };
}

export function weakestEvidenceGrade(
  grades: readonly EvidenceGrade[],
): EvidenceGrade {
  if (!grades.length) return "not_established";
  return grades.reduce((weakest, grade) =>
    EVIDENCE_WEIGHT[grade] < EVIDENCE_WEIGHT[weakest] ? grade : weakest,
  );
}

export function createChangePassport(
  capsule: EvidenceCapsule,
  input: Omit<
    ChangePassportInput,
    | "taskId"
    | "schemaVersion"
    | "verdict"
    | "assurance"
    | "evidenceGrades"
    | "weakestEvidenceGrade"
    | "gaps"
    | "approvals"
    | "capsuleDigest"
  >,
): ChangePassport {
  const verification = verifyEvidenceCapsule(capsule);
  if (!verification.valid) {
    throw new Error(
      `Cannot create a passport from an invalid evidence capsule: ${verification.errors.join(
        " ",
      )}`,
    );
  }
  const grades = capsule.evidence
    .filter((evidence) => !evidence.stale)
    .map((evidence) => evidence.grade);
  const body: ChangePassportInput = redactForPersistence({
    ...input,
    schemaVersion: 1,
    taskId: capsule.taskId,
    verdict: capsule.state,
    assurance: capsule.contract.assurance,
    evidenceGrades: grades,
    weakestEvidenceGrade: weakestEvidenceGrade(grades),
    gaps: capsule.gaps,
    approvals: capsule.approvals,
    capsuleDigest: capsule.digest,
  });
  return {
    ...body,
    digest: digestEnvelope(body),
  };
}

export function verifyChangePassport(
  passport: ChangePassport,
  capsule?: EvidenceCapsule,
): DigestVerification {
  const verification = verifyEnvelope(passport);
  const errors = [...verification.errors];
  try {
    if (!isSha256Digest(passport.capsuleDigest)) {
      errors.push("Passport capsule digest is not a SHA-256 digest.");
    }
    if (
      passport.weakestEvidenceGrade !==
      weakestEvidenceGrade(passport.evidenceGrades)
    ) {
      errors.push("Passport weakest evidence grade is inconsistent.");
    }
    if (capsule) {
      const capsuleVerification = verifyEvidenceCapsule(capsule);
      errors.push(
        ...capsuleVerification.errors.map((error) => `Capsule: ${error}`),
      );
      if (passport.capsuleDigest !== capsule.digest) {
        errors.push("Passport does not reference the supplied capsule digest.");
      }
      if (passport.taskId !== capsule.taskId) {
        errors.push("Passport and capsule task IDs differ.");
      }
      if (passport.verdict !== capsule.state) {
        errors.push("Passport verdict differs from its evidence capsule.");
      }
      if (passport.assurance !== capsule.contract.assurance) {
        errors.push("Passport assurance differs from its evidence capsule.");
      }
      if (
        canonicalStringify(passport.gaps) !==
        canonicalStringify(capsule.gaps)
      ) {
        errors.push("Passport gaps differ from its evidence capsule.");
      }
      if (
        canonicalStringify(passport.approvals) !==
        canonicalStringify(capsule.approvals)
      ) {
        errors.push("Passport approvals differ from its evidence capsule.");
      }
      const capsuleGrades = capsule.evidence
        .filter((evidence) => !evidence.stale)
        .map((evidence) => evidence.grade);
      if (
        canonicalStringify(passport.evidenceGrades) !==
        canonicalStringify(capsuleGrades)
      ) {
        errors.push("Passport evidence grades differ from its evidence capsule.");
      }
    }
  } catch (error) {
    errors.push(
      `Passport structure is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    ...verification,
    valid: errors.length === 0,
    errors,
  };
}
