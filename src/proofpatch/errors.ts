export class ProofPatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProofPatchError";
    this.code = code;
  }
}

export class ProofPatchConflictError extends ProofPatchError {
  readonly path: string;

  constructor(path: string, message?: string) {
    super(
      "PROOFPATCH_CONFLICT",
      message ?? `The workspace changed after staging: ${path}`,
    );
    this.name = "ProofPatchConflictError";
    this.path = path;
  }
}

export class ProofPatchPathError extends ProofPatchError {
  constructor(message: string) {
    super("PROOFPATCH_UNSAFE_PATH", message);
    this.name = "ProofPatchPathError";
  }
}

export class ProofPatchStateError extends ProofPatchError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROOFPATCH_INVALID_STATE", message, options);
    this.name = "ProofPatchStateError";
  }
}

export class ProofPatchPublicationError extends ProofPatchError {
  readonly publicationCause: unknown;
  readonly rollbackCause?: unknown;

  constructor(publicationCause: unknown, rollbackCause?: unknown) {
    const publicationMessage =
      publicationCause instanceof Error
        ? publicationCause.message
        : String(publicationCause);
    const rollbackMessage =
      rollbackCause === undefined
        ? ""
        : ` Rollback also failed: ${
            rollbackCause instanceof Error
              ? rollbackCause.message
              : String(rollbackCause)
          }`;
    super(
      "PROOFPATCH_PUBLICATION_FAILED",
      `ProofPatch publication failed and was${
        rollbackCause === undefined ? "" : " not"
      } rolled back safely: ${publicationMessage}.${rollbackMessage}`,
      publicationCause instanceof Error ? { cause: publicationCause } : undefined,
    );
    this.name = "ProofPatchPublicationError";
    this.publicationCause = publicationCause;
    this.rollbackCause = rollbackCause;
  }
}

/**
 * Test/fault-injection sentinel that models process death. Publication does not
 * catch and roll this back, allowing recovery to be exercised on the next open.
 */
export class ProofPatchSimulatedCrashError extends ProofPatchError {
  constructor(message = "Simulated ProofPatch process crash.") {
    super("PROOFPATCH_SIMULATED_CRASH", message);
    this.name = "ProofPatchSimulatedCrashError";
  }
}
