import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function rejectSymlink(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Protected ProofGraph path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function ensureProtectedDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
      details = await lstat(current);
    }
    // macOS commonly exposes /tmp and /var as top-level compatibility
    // symlinks. State roots are resolved before use, while deeper symlinks are
    // never accepted as protected application storage.
    if (details.isSymbolicLink() && index > 0) {
      throw new Error(
        `Protected ProofGraph directory must not traverse a symbolic link: ${current}`,
      );
    }
    if (!details.isDirectory() && !details.isSymbolicLink()) {
      throw new Error(`Protected ProofGraph path is not a directory: ${current}`);
    }
  }
  await rejectSymlink(absolute);
  await chmod(absolute, 0o700);
}

export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

export async function readPrivateFile(path: string): Promise<Buffer> {
  await rejectSymlink(path);
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) {
      throw new Error(`Protected file is not a private regular file: ${path}`);
    }
    const value = await handle.readFile();
    const after = await handle.stat();
    const lexical = await lstat(path);
    if (
      !after.isFile() ||
      after.nlink > 1 ||
      lexical.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== lexical.dev ||
      after.ino !== lexical.ino
    ) {
      throw new Error(`Protected file changed while it was read: ${path}`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

export function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
