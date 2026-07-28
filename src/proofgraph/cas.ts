import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalStringify,
  isSha256Digest,
  sha256Digest,
  verifySha256Digest,
} from "./canonical.js";
import {
  ensureProtectedDirectory,
  noFollowFlag,
  readPrivateFile,
  rejectSymlink,
  syncDirectory,
} from "./filesystem.js";
import { redactForPersistence, redactText } from "./redaction.js";

export interface CasBlobReference {
  digest: string;
  size: number;
  redacted: boolean;
}

export class CasIntegrityError extends Error {
  constructor(
    message: string,
    readonly digest: string,
  ) {
    super(message);
    this.name = "CasIntegrityError";
  }
}

function textualBytes(value: Uint8Array): string | undefined {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function prepareBlob(value: string | Uint8Array): {
  bytes: Buffer;
  redacted: boolean;
} {
  if (typeof value === "string") {
    const persisted = redactText(value);
    return { bytes: Buffer.from(persisted), redacted: persisted !== value };
  }
  const bytes = Buffer.from(value);
  const text = textualBytes(bytes);
  if (text === undefined) return { bytes, redacted: false };
  const persisted = redactText(text);
  return {
    bytes: Buffer.from(persisted),
    redacted: persisted !== text,
  };
}

export class ContentAddressedStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!root.trim() || this.root === parse(this.root).root) {
      throw new TypeError("CAS root must be a dedicated non-root directory.");
    }
  }

  async initialize(): Promise<void> {
    await ensureProtectedDirectory(this.root);
  }

  private pathFor(digest: string): string {
    if (!isSha256Digest(digest)) throw new TypeError(`Invalid SHA-256 digest: ${digest}`);
    const hex = digest.slice("sha256:".length);
    return join(this.root, hex.slice(0, 2), hex.slice(2));
  }

  async put(value: string | Uint8Array): Promise<CasBlobReference> {
    await this.initialize();
    const prepared = prepareBlob(value);
    const digest = sha256Digest(prepared.bytes);
    const target = this.pathFor(digest);
    const directory = dirname(target);
    await ensureProtectedDirectory(directory);
    await rejectSymlink(target);

    try {
      const existing = await readPrivateFile(target);
      if (!verifySha256Digest(existing, digest)) {
        throw new CasIntegrityError("Existing CAS object failed digest verification.", digest);
      }
      return {
        digest,
        size: existing.byteLength,
        redacted: prepared.redacted,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const flags =
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      noFollowFlag();
    const handle = await open(temporary, flags, 0o600);
    try {
      await handle.writeFile(prepared.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readPrivateFile(target);
      if (!verifySha256Digest(existing, digest)) {
        throw new CasIntegrityError("Racing CAS object failed digest verification.", digest);
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }

    return {
      digest,
      size: prepared.bytes.byteLength,
      redacted: prepared.redacted,
    };
  }

  async putJson(value: unknown): Promise<CasBlobReference> {
    return this.put(canonicalStringify(redactForPersistence(value)));
  }

  async has(digest: string): Promise<boolean> {
    const path = this.pathFor(digest);
    try {
      const details = await lstat(path);
      return details.isFile() && !details.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async get(digest: string): Promise<Buffer> {
    const path = this.pathFor(digest);
    await rejectSymlink(path);
    const value = await readPrivateFile(path);
    if (!verifySha256Digest(value, digest)) {
      throw new CasIntegrityError("CAS object failed digest verification.", digest);
    }
    return value;
  }

  async getJson<T = unknown>(digest: string): Promise<T> {
    return JSON.parse((await this.get(digest)).toString("utf8")) as T;
  }
}
