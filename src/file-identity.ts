import type { BigIntStats } from "node:fs";

type FileIdentity = Pick<
  BigIntStats,
  "dev" | "ino" | "isFile" | "isSymbolicLink"
>;

export function isStableRegularFileIdentity(
  opened: FileIdentity,
  current: FileIdentity,
): boolean {
  return (
    opened.isFile() &&
    !opened.isSymbolicLink() &&
    current.isFile() &&
    !current.isSymbolicLink() &&
    opened.dev === current.dev &&
    opened.ino === current.ino
  );
}
