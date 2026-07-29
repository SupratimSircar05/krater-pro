import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureProtectedDirectory,
  noFollowFlag,
  rejectSymlink,
  syncDirectory,
} from "./proofgraph/filesystem.js";

export type DefaultAssurance = "fast" | "standard" | "high";

export interface WorkspacePreferences {
  schemaVersion: 1;
  defaultAssurance: DefaultAssurance;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  schemaVersion: 1,
  defaultAssurance: "standard",
};

const MAX_PREFERENCES_BYTES = 16_384;

export function workspacePreferencesPath(cwd: string): string {
  return join(resolve(cwd), ".krater", "preferences.json");
}

function parsePreferences(value: unknown): WorkspacePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Krater workspace preferences must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "defaultAssurance" ||
    keys[1] !== "schemaVersion" ||
    record.schemaVersion !== 1 ||
    !["fast", "standard", "high"].includes(
      typeof record.defaultAssurance === "string"
        ? record.defaultAssurance
        : "",
    )
  ) {
    throw new Error(
      "Krater workspace preferences use an unsupported or invalid schema.",
    );
  }
  return {
    schemaVersion: 1,
    defaultAssurance: record.defaultAssurance as DefaultAssurance,
  };
}

export function readWorkspacePreferences(
  cwd: string,
): WorkspacePreferences | undefined {
  const path = workspacePreferencesPath(cwd);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Could not open Krater workspace preferences: ${(error as Error).message}`,
    );
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const lexical = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      lexical.isSymbolicLink() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size < 0n ||
      before.size > BigInt(MAX_PREFERENCES_BYTES)
    ) {
      throw new Error(
        "Krater workspace preferences are not a bounded private regular file.",
      );
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    const finalLexical = lstatSync(path, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      finalLexical.isSymbolicLink() ||
      finalLexical.dev !== after.dev ||
      finalLexical.ino !== after.ino
    ) {
      throw new Error("Krater workspace preferences changed while being read.");
    }
    return parsePreferences(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Krater workspace preferences are not valid JSON.");
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

export async function writeWorkspacePreferences(
  cwd: string,
  preferences: WorkspacePreferences,
): Promise<string> {
  const normalized = parsePreferences(preferences);
  const stateRoot = join(resolve(cwd), ".krater");
  await ensureProtectedDirectory(stateRoot);
  const path = workspacePreferencesPath(cwd);
  await rejectSymlink(path);
  const temporary = join(
    stateRoot,
    `.preferences-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      noFollowFlag(),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(stateRoot);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  readWorkspacePreferences(cwd);
  return path;
}
