import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ProofPatchConflictError,
  ProofPatchPathError,
} from "./errors.js";
import type {
  ExistingFileSnapshot,
  FileSnapshot,
  MissingFileSnapshot,
  ProofPatchDigest,
  ProofPatchWorkspaceBackend,
} from "./types.js";

const MISSING_FILE: MissingFileSnapshot = Object.freeze({
  exists: false,
  digest: null,
  size: 0,
  mode: null,
});

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function digest(content: Uint8Array): ProofPatchDigest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isProtectedPath(path: string): boolean {
  const parts = path.split("/").map((part) => part.toLowerCase());
  if (parts.includes(".git") || parts.includes(".krater")) return true;
  const name = parts.at(-1) ?? "";
  return (
    name === ".env" ||
    (name.startsWith(".env.") &&
      ![".env.example", ".env.sample", ".env.template"].includes(name))
  );
}

function normalizeMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new ProofPatchPathError(
      `File mode must be an integer from 0 to 0777; received ${String(mode)}.`,
    );
  }
  return mode;
}

export function missingFileSnapshot(): MissingFileSnapshot {
  return { ...MISSING_FILE };
}

export function snapshotForContent(
  content: Uint8Array,
  mode: number,
): ExistingFileSnapshot {
  return {
    exists: true,
    digest: digest(content),
    size: content.byteLength,
    mode: normalizeMode(mode),
  };
}

export function sameSnapshot(
  left: FileSnapshot,
  right: FileSnapshot,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return (
    left.digest === right.digest &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
  physical: string;
}

/**
 * Safe file primitives for a plain local directory. The backend rejects links
 * and protected paths at every observation and immediately before mutation.
 */
export class ScratchWorkspaceBackend implements ProofPatchWorkspaceBackend {
  readonly kind = "scratch";
  readonly workspaceRoot: string;

  private constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  static async open(workspaceRoot: string): Promise<ScratchWorkspaceBackend> {
    const lexicalRoot = resolve(workspaceRoot);
    const details = await lstat(lexicalRoot);
    if (!details.isDirectory()) {
      throw new ProofPatchPathError(
        `ProofPatch workspace root is not a directory: ${workspaceRoot}`,
      );
    }
    const physicalRoot = await realpath(lexicalRoot);
    return new ScratchWorkspaceBackend(physicalRoot);
  }

  normalizePath(input: string): string {
    if (!input || input.includes("\0")) {
      throw new ProofPatchPathError("ProofPatch paths must be non-empty and contain no null bytes.");
    }
    if (
      isAbsolute(input) ||
      /^[A-Za-z]:[\\/]/.test(input) ||
      input.startsWith("\\\\") ||
      input.includes("\\")
    ) {
      throw new ProofPatchPathError(
        `ProofPatch paths must be portable workspace-relative paths: ${input}`,
      );
    }

    const parts = input.split("/");
    if (
      parts.some((part) => !part || part === "." || part === "..") ||
      isProtectedPath(input)
    ) {
      throw new ProofPatchPathError(
        `ProofPatch path is outside the safe mutable workspace: ${input}`,
      );
    }

    const candidate = resolve(this.workspaceRoot, ...parts);
    if (!within(this.workspaceRoot, candidate)) {
      throw new ProofPatchPathError(
        `ProofPatch path escapes the workspace: ${input}`,
      );
    }
    return parts.join("/");
  }

  async inspect(path: string): Promise<FileSnapshot> {
    const normalized = this.normalizePath(path);
    const absolute = this.absolute(normalized);
    await this.verifyPathComponents(normalized);
    try {
      const verified = await this.readVerifiedFile(normalized);
      return verified.snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.verifiedDirectory(dirname(absolute), normalized);
      return missingFileSnapshot();
    }
  }

  async readFile(
    path: string,
    expected: ExistingFileSnapshot,
  ): Promise<Buffer> {
    const normalized = this.normalizePath(path);
    await this.verifyPathComponents(normalized);
    const verified = await this.readVerifiedFile(normalized);
    if (!sameSnapshot(verified.snapshot, expected)) {
      throw new ProofPatchConflictError(normalized);
    }
    return verified.content;
  }

  async writeFile(
    path: string,
    content: Buffer,
    expected: FileSnapshot,
    mode: number,
  ): Promise<void> {
    const normalized = this.normalizePath(path);
    const finalMode = normalizeMode(mode);
    const absolute = this.absolute(normalized);
    const parent = dirname(absolute);
    await this.verifyPathComponents(normalized);
    const parentBefore = await this.verifiedDirectory(parent, normalized);
    await this.assertExpected(normalized, expected);

    const temporary = resolve(
      parent,
      `.${basename(absolute)}.proofpatch-${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryCreated = true;
      try {
        await handle.writeFile(content);
        await handle.chmod(finalMode);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.assertDirectoryUnchanged(parent, parentBefore, normalized);
      await this.assertExpected(normalized, expected);
      const temporaryDetails = await lstat(temporary);
      if (
        temporaryDetails.isSymbolicLink() ||
        !temporaryDetails.isFile() ||
        temporaryDetails.nlink !== 1
      ) {
        throw new ProofPatchPathError(
          `ProofPatch temporary file became unsafe: ${normalized}`,
        );
      }

      if (expected.exists) {
        try {
          await rename(temporary, absolute);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EEXIST", "EPERM"].includes(code ?? "")) throw error;
          await this.assertExpected(normalized, expected);
          await unlink(absolute);
          await rename(temporary, absolute);
        }
      } else {
        try {
          await link(temporary, absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ProofPatchConflictError(normalized);
          }
          throw error;
        }
        await unlink(temporary);
      }
      temporaryCreated = false;

      const written = await this.inspect(normalized);
      const intended = snapshotForContent(content, finalMode);
      if (!sameSnapshot(written, intended)) {
        throw new ProofPatchConflictError(
          normalized,
          `ProofPatch could not verify the published content: ${normalized}`,
        );
      }
      await this.syncDirectory(parent);
    } finally {
      if (temporaryCreated) {
        await unlink(temporary).catch(() => undefined);
      }
    }
  }

  async removeFile(
    path: string,
    expected: ExistingFileSnapshot,
  ): Promise<void> {
    const normalized = this.normalizePath(path);
    const absolute = this.absolute(normalized);
    const parent = dirname(absolute);
    await this.verifyPathComponents(normalized);
    const parentBefore = await this.verifiedDirectory(parent, normalized);
    await this.assertExpected(normalized, expected);
    await unlink(absolute);
    await this.assertDirectoryUnchanged(parent, parentBefore, normalized);
    await this.syncDirectory(parent);
  }

  private absolute(path: string): string {
    return resolve(this.workspaceRoot, ...path.split("/"));
  }

  private async assertExpected(
    path: string,
    expected: FileSnapshot,
  ): Promise<void> {
    const current = await this.inspect(path);
    if (!sameSnapshot(current, expected)) {
      throw new ProofPatchConflictError(path);
    }
  }

  private async readVerifiedFile(
    path: string,
  ): Promise<{ content: Buffer; snapshot: ExistingFileSnapshot }> {
    const absolute = this.absolute(path);
    const handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new ProofPatchPathError(`ProofPatch only supports regular files: ${path}`);
      }
      if (before.nlink > 1) {
        throw new ProofPatchPathError(
          `ProofPatch refuses hard-linked files: ${path}`,
        );
      }

      const physical = await realpath(absolute);
      const lexical = relative(this.workspaceRoot, physical).split(sep).join("/");
      if (
        !within(this.workspaceRoot, physical) ||
        isProtectedPath(lexical)
      ) {
        throw new ProofPatchPathError(
          `ProofPatch file resolves outside the safe workspace: ${path}`,
        );
      }

      const current = await lstat(absolute);
      if (
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      ) {
        throw new ProofPatchPathError(
          `ProofPatch file changed while it was opened: ${path}`,
        );
      }

      const content = await handle.readFile();
      const after = await handle.stat();
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink > 1
      ) {
        throw new ProofPatchPathError(
          `ProofPatch file changed while it was read: ${path}`,
        );
      }
      return {
        content,
        snapshot: snapshotForContent(content, after.mode & 0o777),
      };
    } finally {
      await handle.close();
    }
  }

  private async verifyPathComponents(path: string): Promise<void> {
    let current = this.workspaceRoot;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      try {
        const details = await lstat(current);
        if (details.isSymbolicLink()) {
          throw new ProofPatchPathError(
            `ProofPatch refuses symbolic-link paths: ${path}`,
          );
        }
        if (index < parts.length - 1 && !details.isDirectory()) {
          throw new ProofPatchPathError(
            `ProofPatch path has a non-directory parent: ${path}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (index < parts.length - 1) {
          throw new ProofPatchPathError(
            `ProofPatch requires parent directories to exist: ${path}`,
          );
        }
      }
    }
  }

  private async verifiedDirectory(
    path: string,
    displayPath: string,
  ): Promise<DirectoryIdentity> {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new ProofPatchPathError(
        `ProofPatch parent is not a safe directory: ${displayPath}`,
      );
    }
    const physical = await realpath(path);
    if (!within(this.workspaceRoot, physical)) {
      throw new ProofPatchPathError(
        `ProofPatch parent resolves outside the workspace: ${displayPath}`,
      );
    }
    return { dev: details.dev, ino: details.ino, physical };
  }

  private async assertDirectoryUnchanged(
    path: string,
    expected: DirectoryIdentity,
    displayPath: string,
  ): Promise<void> {
    const current = await this.verifiedDirectory(path, displayPath);
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.physical !== expected.physical
    ) {
      throw new ProofPatchConflictError(
        displayPath,
        `ProofPatch parent directory changed during publication: ${displayPath}`,
      );
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Windows and some filesystems do not support directory fsync.
    }
  }
}
