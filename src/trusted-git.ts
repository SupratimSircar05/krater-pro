import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { isStableRegularFileIdentity } from "./file-identity.js";

const MAX_TRUSTED_GIT_BYTES = 256n * 1024n * 1024n;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface TrustedGitExecutable {
  path: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  linkCount: bigint;
  modifiedAtNanoseconds: bigint;
  changedAtNanoseconds: bigint;
  sha256: string;
}

export interface SerializedTrustedGitExecutable {
  path: string;
  device: string;
  inode: string;
  size: string;
  mode: string;
  uid: string;
  gid: string;
  linkCount: string;
  modifiedAtNanoseconds: string;
  changedAtNanoseconds: string;
  sha256: string;
}

function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() ===
        win32.normalize(right).toLowerCase()
    : left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

function metadataMatches(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function inspectTrustedGitExecutable(path: string): TrustedGitExecutable {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      !isStableRegularFileIdentity(opened, current) ||
      !samePhysicalPath(realpathSync(path), path) ||
      opened.size < 1n ||
      opened.size > MAX_TRUSTED_GIT_BYTES ||
      (process.platform !== "win32" && (opened.mode & 0o111n) === 0n)
    ) {
      throw new Error("The trusted Git executable is not a stable executable file.");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let total = 0n;
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      if (total > MAX_TRUSTED_GIT_BYTES) {
        throw new Error("The trusted Git executable exceeds its size limit.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }

    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !metadataMatches(opened, afterRead) ||
      !isStableRegularFileIdentity(afterRead, afterPath) ||
      !samePhysicalPath(realpathSync(path), path)
    ) {
      throw new Error("The trusted Git executable changed while it was inspected.");
    }

    return {
      path,
      device: afterRead.dev,
      inode: afterRead.ino,
      size: afterRead.size,
      mode: afterRead.mode,
      uid: afterRead.uid,
      gid: afterRead.gid,
      linkCount: afterRead.nlink,
      modifiedAtNanoseconds: afterRead.mtimeNs,
      changedAtNanoseconds: afterRead.ctimeNs,
      sha256: hash.digest("hex"),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function fixedGitCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === "win32"
    ? [
        String.raw`C:\Program Files\Git\cmd\git.exe`,
        String.raw`C:\Program Files\Git\bin\git.exe`,
        String.raw`C:\Program Files (x86)\Git\cmd\git.exe`,
      ]
    : ["/usr/bin/git", "/bin/git"];
}

export function resolveTrustedGitExecutable(
  configured?: string,
  excludedRoots: readonly string[] = [],
): TrustedGitExecutable | undefined {
  if (
    configured !== undefined &&
    (!isAbsolute(configured) ||
      configured.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(configured))
  ) {
    throw new Error(
      "The host-selected Git executable must be a safe absolute path.",
    );
  }

  const roots = excludedRoots.map((root) => realpathSync(resolve(root)));
  const candidates =
    configured === undefined ? fixedGitCandidates() : [configured];
  const seen = new Set<string>();
  let excludedConfiguredPath = false;
  for (const candidate of candidates) {
    try {
      const physical = realpathSync(candidate);
      if (seen.has(physical)) continue;
      seen.add(physical);
      if (roots.some((root) => isWithin(root, physical))) {
        excludedConfiguredPath ||= configured !== undefined;
        continue;
      }
      return inspectTrustedGitExecutable(physical);
    } catch {
      // Continue through fixed host paths without exposing filesystem details.
    }
  }

  if (configured !== undefined) {
    if (excludedConfiguredPath) {
      throw new Error(
        "The host-selected Git executable must resolve outside writable workspace roots.",
      );
    }
    throw new Error("The host-selected Git executable was not a stable file.");
  }
  return undefined;
}

function sameTrustedGitIdentity(
  expected: TrustedGitExecutable,
  current: TrustedGitExecutable,
): boolean {
  return (
    samePhysicalPath(current.path, expected.path) &&
    current.device === expected.device &&
    current.inode === expected.inode &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    current.uid === expected.uid &&
    current.gid === expected.gid &&
    current.linkCount === expected.linkCount &&
    current.modifiedAtNanoseconds === expected.modifiedAtNanoseconds &&
    current.changedAtNanoseconds === expected.changedAtNanoseconds &&
    current.sha256 === expected.sha256
  );
}

export function assertTrustedGitExecutable(
  expected: TrustedGitExecutable,
): string {
  let current: TrustedGitExecutable;
  try {
    current = inspectTrustedGitExecutable(expected.path);
  } catch (error) {
    throw new Error("The trusted Git executable changed or disappeared.", {
      cause: error,
    });
  }
  if (!sameTrustedGitIdentity(expected, current)) {
    throw new Error("The trusted Git executable changed or disappeared.");
  }
  return expected.path;
}

export function serializeTrustedGitExecutable(
  executable: TrustedGitExecutable,
): SerializedTrustedGitExecutable {
  return {
    path: executable.path,
    device: executable.device.toString(),
    inode: executable.inode.toString(),
    size: executable.size.toString(),
    mode: executable.mode.toString(),
    uid: executable.uid.toString(),
    gid: executable.gid.toString(),
    linkCount: executable.linkCount.toString(),
    modifiedAtNanoseconds: executable.modifiedAtNanoseconds.toString(),
    changedAtNanoseconds: executable.changedAtNanoseconds.toString(),
    sha256: executable.sha256,
  };
}

export function isSerializedTrustedGitExecutable(
  value: unknown,
): value is SerializedTrustedGitExecutable {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SerializedTrustedGitExecutable>;
  return (
    typeof candidate.path === "string" &&
    isAbsolute(candidate.path) &&
    candidate.path.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(candidate.path) &&
    [
      candidate.device,
      candidate.inode,
      candidate.size,
      candidate.mode,
      candidate.uid,
      candidate.gid,
      candidate.linkCount,
      candidate.modifiedAtNanoseconds,
      candidate.changedAtNanoseconds,
    ].every((part) => typeof part === "string" && /^\d{1,40}$/.test(part)) &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256)
  );
}

export function assertSerializedTrustedGitExecutable(
  expected: SerializedTrustedGitExecutable,
): string {
  const trusted: TrustedGitExecutable = {
    path: expected.path,
    device: BigInt(expected.device),
    inode: BigInt(expected.inode),
    size: BigInt(expected.size),
    mode: BigInt(expected.mode),
    uid: BigInt(expected.uid),
    gid: BigInt(expected.gid),
    linkCount: BigInt(expected.linkCount),
    modifiedAtNanoseconds: BigInt(expected.modifiedAtNanoseconds),
    changedAtNanoseconds: BigInt(expected.changedAtNanoseconds),
    sha256: expected.sha256,
  };
  return assertTrustedGitExecutable(trusted);
}
