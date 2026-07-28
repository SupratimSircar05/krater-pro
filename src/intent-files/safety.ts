import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { redactSensitiveText } from "../trust/redaction.js";
import {
  INTENT_DIRECTORY_NAME,
  IntentFilesError,
} from "./types.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathParts(path: string): readonly string[] {
  return normalize(path).split(sep).filter(Boolean);
}

export function resolveIntentDirectory(candidate: string): string {
  if (!candidate.trim()) {
    throw new IntentFilesError(
      "invalid_path",
      "The living-intent directory path must not be empty.",
    );
  }
  const directory = resolve(candidate);
  if (!isAbsolute(directory) || basename(directory) !== INTENT_DIRECTORY_NAME) {
    throw new IntentFilesError(
      "invalid_path",
      `Living intent may be stored only in a directory named ${INTENT_DIRECTORY_NAME}.`,
    );
  }
  if (pathParts(directory).includes(".krater")) {
    throw new IntentFilesError(
      "invalid_path",
      "Living-intent artifacts must never be stored under .krater.",
    );
  }
  return directory;
}

export async function assertSafeIntentDirectory(
  directory: string,
  options: { allowMissingTarget: boolean },
): Promise<void> {
  const parent = dirname(directory);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    throw new IntentFilesError(
      "invalid_path",
      "The parent of .krater-intent must be an existing directory.",
      { cause: error },
    );
  }
  if (canonicalParent !== parent) {
    throw new IntentFilesError(
      "unsafe_symlink",
      "The .krater-intent parent path must not traverse symbolic links.",
    );
  }

  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink()) {
      throw new IntentFilesError(
        "unsafe_symlink",
        "The .krater-intent directory must not be a symbolic link.",
      );
    }
    if (!details.isDirectory()) {
      throw new IntentFilesError(
        "invalid_path",
        "The .krater-intent path exists but is not a directory.",
      );
    }
  } catch (error) {
    if (isMissing(error) && options.allowMissingTarget) return;
    if (error instanceof IntentFilesError) throw error;
    if (isMissing(error)) {
      throw new IntentFilesError(
        "not_initialized",
        "Living intent is not initialized for this project.",
      );
    }
    throw error;
  }
}

export async function assertRegularArtifact(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new IntentFilesError(
        "unsafe_symlink",
        "Living-intent artifacts must not be symbolic links.",
      );
    }
    if (!details.isFile()) {
      throw new IntentFilesError(
        "invalid_artifact",
        "A living-intent artifact is not a regular file.",
      );
    }
  } catch (error) {
    if (error instanceof IntentFilesError) throw error;
    if (isMissing(error)) {
      throw new IntentFilesError(
        "not_initialized",
        "Living intent is not initialized for this project.",
      );
    }
    throw error;
  }
}

export function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

export function assertNoSerializedSecrets(
  serialized: string,
  secrets: readonly string[],
): void {
  const redacted = redactSensitiveText(serialized, { secrets });
  if (redacted !== serialized) {
    throw new IntentFilesError(
      "secret_detected",
      "Refusing to write a living-intent artifact containing secret material.",
    );
  }
}
