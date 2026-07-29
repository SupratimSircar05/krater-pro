import {
  constants,
  mkdir,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isStableRegularFileIdentity } from "../file-identity.js";
import { isSha256Digest, redactText } from "../proofgraph/index.js";
import {
  ShippingIdempotencyConflictError,
  ShippingReplayError,
  ShippingStateError,
} from "./errors.js";
import type {
  ShippingAttemptClaim,
  ShippingAttemptLedger,
  ShippingRuntimeVault,
} from "./types.js";

interface LedgerDocument {
  schemaVersion: 1;
  claims: Record<string, ShippingAttemptClaim>;
}

interface VaultDocument {
  schemaVersion: 1;
  compensationHandles: Record<string, string>;
}

function assertDigest(value: string, field: string): void {
  if (!isSha256Digest(value)) {
    throw new ShippingStateError(`${field} is not a valid digest.`);
  }
}

function assertRuntimeHandle(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value) ||
    redactText(value) !== value
  ) {
    throw new ShippingStateError(
      "Shipping runtime handle is invalid or contains credential material.",
    );
  }
}

function assertClaim(claim: ShippingAttemptClaim): void {
  if (claim.schemaVersion !== 1 || claim.state !== "reserved") {
    throw new ShippingStateError("Shipping attempt claim is not reservable.");
  }
  assertDigest(claim.idempotencyKeyDigest, "Idempotency key");
  assertDigest(claim.operationDigest, "Shipping operation");
  assertDigest(claim.effectPlanDigest, "External effect plan");
  assertDigest(claim.confirmationDigest, "Shipping confirmation");
  if (
    !["execute", "compensate"].includes(claim.operation) ||
    !Number.isFinite(Date.parse(claim.reservedAt))
  ) {
    throw new ShippingStateError("Shipping attempt claim is malformed.");
  }
}

function reserveIn(
  claims: Map<string, ShippingAttemptClaim>,
  claim: ShippingAttemptClaim,
): void {
  assertClaim(claim);
  const existing = claims.get(claim.idempotencyKeyDigest);
  if (existing) {
    if (existing.operationDigest === claim.operationDigest) {
      throw new ShippingReplayError();
    }
    throw new ShippingIdempotencyConflictError();
  }
  claims.set(claim.idempotencyKeyDigest, { ...claim });
}

function completeIn(
  claims: Map<string, ShippingAttemptClaim>,
  idempotencyKeyDigest: string,
  operationDigest: string,
  receiptDigest: string,
  completedAt: string,
): void {
  assertDigest(idempotencyKeyDigest, "Idempotency key");
  assertDigest(operationDigest, "Shipping operation");
  assertDigest(receiptDigest, "Shipping receipt");
  if (!Number.isFinite(Date.parse(completedAt))) {
    throw new ShippingStateError("Shipping completion time is invalid.");
  }
  const existing = claims.get(idempotencyKeyDigest);
  if (!existing) {
    throw new ShippingStateError("Shipping attempt was not reserved.");
  }
  if (existing.operationDigest !== operationDigest) {
    throw new ShippingIdempotencyConflictError();
  }
  if (existing.state !== "reserved") {
    throw new ShippingReplayError("Shipping attempt was already finalized.");
  }
  claims.set(idempotencyKeyDigest, {
    ...existing,
    state: "completed",
    completedAt,
    receiptDigest: receiptDigest as `sha256:${string}`,
  });
}

export class InMemoryShippingLedger implements ShippingAttemptLedger {
  readonly durability = "memory" as const;
  readonly #claims = new Map<string, ShippingAttemptClaim>();

  async reserve(claim: ShippingAttemptClaim): Promise<void> {
    reserveIn(this.#claims, claim);
  }

  async complete(
    idempotencyKeyDigest: `sha256:${string}`,
    operationDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
    completedAt: string,
  ): Promise<void> {
    completeIn(
      this.#claims,
      idempotencyKeyDigest,
      operationDigest,
      receiptDigest,
      completedAt,
    );
  }
}

export class InMemoryShippingRuntimeVault implements ShippingRuntimeVault {
  readonly durability = "memory" as const;
  readonly #handles = new Map<string, string>();

  async putCompensationHandle(
    effectPlanDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
    handle: string,
  ): Promise<void> {
    assertRuntimeHandle(handle);
    this.#handles.set(`${effectPlanDigest}:${receiptDigest}`, handle);
  }

  async getCompensationHandle(
    effectPlanDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
  ): Promise<string | undefined> {
    return this.#handles.get(`${effectPlanDigest}:${receiptDigest}`);
  }
}

interface FileStateOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

class LockedJsonFile<T> {
  readonly #file: string;
  readonly #lock: string;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #empty: () => T;
  readonly #validate: (value: unknown) => T;

  constructor(
    file: string,
    empty: () => T,
    validate: (value: unknown) => T,
    options: FileStateOptions,
  ) {
    this.#file = resolve(file);
    this.#lock = `${this.#file}.lock`;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
    this.#lockRetryMs = options.lockRetryMs ?? 25;
    this.#empty = empty;
    this.#validate = validate;
  }

  async #prepareDirectory(): Promise<void> {
    const directory = dirname(this.#file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(directory);
    if (canonical !== directory) {
      throw new ShippingStateError(
        "Shipping state directory must not traverse symbolic links.",
      );
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ShippingStateError("Shipping state directory is unsafe.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new ShippingStateError(
        "Shipping state directory must not be accessible by group or other users.",
      );
    }
  }

  async #acquire(): Promise<Awaited<ReturnType<typeof open>>> {
    await this.#prepareDirectory();
    const started = Date.now();
    while (Date.now() - started <= this.#lockTimeoutMs) {
      try {
        return await open(
          this.#lock,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, this.#lockRetryMs);
        });
      }
    }
    throw new ShippingStateError(
      "Shipping state is locked by another process; mutation was refused.",
    );
  }

  async #read(): Promise<T> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        this.#file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat({ bigint: true });
      const current = await lstat(this.#file, { bigint: true });
      if (!isStableRegularFileIdentity(opened, current)) {
        throw new ShippingStateError("Shipping state file is unsafe.");
      }
      if (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n) {
        throw new ShippingStateError(
          "Shipping state file permissions are too broad.",
        );
      }
      return this.#validate(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        handle === undefined
      ) {
        return this.#empty();
      }
      if (error instanceof ShippingStateError) throw error;
      throw new ShippingStateError("Shipping state is corrupt or unreadable.");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #write(value: T): Promise<void> {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      temporaryHandle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await temporaryHandle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, this.#file);
      const directoryHandle = await open(dirname(this.#file), "r").catch(
        () => undefined,
      );
      if (directoryHandle) {
        try {
          await directoryHandle.sync().catch(() => undefined);
        } finally {
          await directoryHandle.close().catch(() => undefined);
        }
      }
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async update<R>(mutation: (value: T) => R): Promise<R> {
    const lock = await this.#acquire();
    try {
      const value = await this.#read();
      const result = mutation(value);
      await this.#write(value);
      return result;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.#lock).catch(() => undefined);
    }
  }

  async read<R>(projection: (value: T) => R): Promise<R> {
    const lock = await this.#acquire();
    try {
      return projection(await this.#read());
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.#lock).catch(() => undefined);
    }
  }
}

function validateLedgerDocument(value: unknown): LedgerDocument {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new ShippingStateError("Shipping ledger schema is invalid.");
  }
  const claims = (value as { claims?: unknown }).claims;
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new ShippingStateError("Shipping ledger claims are invalid.");
  }
  const normalized: Record<string, ShippingAttemptClaim> = {};
  for (const [key, raw] of Object.entries(claims)) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !isSha256Digest(key)
    ) {
      throw new ShippingStateError("Shipping ledger claim is invalid.");
    }
    const claim = raw as ShippingAttemptClaim;
    if (
      claim.idempotencyKeyDigest !== key ||
      !["reserved", "completed"].includes(claim.state)
    ) {
      throw new ShippingStateError("Shipping ledger claim is inconsistent.");
    }
    const reservable = { ...claim, state: "reserved" as const };
    assertClaim(reservable);
    if (claim.state === "completed") {
      if (
        !claim.completedAt ||
        !claim.receiptDigest ||
        !Number.isFinite(Date.parse(claim.completedAt))
      ) {
        throw new ShippingStateError(
          "Completed shipping ledger claim is incomplete.",
        );
      }
      assertDigest(claim.receiptDigest, "Shipping receipt");
    }
    normalized[key] = { ...claim };
  }
  return { schemaVersion: 1, claims: normalized };
}

function validateVaultDocument(value: unknown): VaultDocument {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new ShippingStateError("Shipping runtime vault schema is invalid.");
  }
  const handles = (value as { compensationHandles?: unknown })
    .compensationHandles;
  if (
    handles === null ||
    typeof handles !== "object" ||
    Array.isArray(handles) ||
    Object.values(handles).some((handle) => typeof handle !== "string")
  ) {
    throw new ShippingStateError("Shipping runtime vault is invalid.");
  }
  for (const handle of Object.values(handles)) {
    assertRuntimeHandle(handle as string);
  }
  return {
    schemaVersion: 1,
    compensationHandles: { ...(handles as Record<string, string>) },
  };
}

export class FileShippingLedger implements ShippingAttemptLedger {
  readonly durability = "persistent" as const;
  readonly #file: LockedJsonFile<LedgerDocument>;

  constructor(file: string, options: FileStateOptions = {}) {
    this.#file = new LockedJsonFile(
      file,
      () => ({ schemaVersion: 1, claims: {} }),
      validateLedgerDocument,
      options,
    );
  }

  async reserve(claim: ShippingAttemptClaim): Promise<void> {
    await this.#file.update((document) => {
      const claims = new Map(Object.entries(document.claims));
      reserveIn(claims, claim);
      document.claims = Object.fromEntries(claims);
    });
  }

  async complete(
    idempotencyKeyDigest: `sha256:${string}`,
    operationDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
    completedAt: string,
  ): Promise<void> {
    await this.#file.update((document) => {
      const claims = new Map(Object.entries(document.claims));
      completeIn(
        claims,
        idempotencyKeyDigest,
        operationDigest,
        receiptDigest,
        completedAt,
      );
      document.claims = Object.fromEntries(claims);
    });
  }
}

export class FileShippingRuntimeVault implements ShippingRuntimeVault {
  readonly durability = "persistent" as const;
  readonly #file: LockedJsonFile<VaultDocument>;

  constructor(file: string, options: FileStateOptions = {}) {
    this.#file = new LockedJsonFile(
      file,
      () => ({ schemaVersion: 1, compensationHandles: {} }),
      validateVaultDocument,
      options,
    );
  }

  async putCompensationHandle(
    effectPlanDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
    handle: string,
  ): Promise<void> {
    assertDigest(effectPlanDigest, "External effect plan");
    assertDigest(receiptDigest, "Shipping receipt");
    assertRuntimeHandle(handle);
    await this.#file.update((document) => {
      document.compensationHandles[
        `${effectPlanDigest}:${receiptDigest}`
      ] = handle;
    });
  }

  async getCompensationHandle(
    effectPlanDigest: `sha256:${string}`,
    receiptDigest: `sha256:${string}`,
  ): Promise<string | undefined> {
    assertDigest(effectPlanDigest, "External effect plan");
    assertDigest(receiptDigest, "Shipping receipt");
    return this.#file.read(
      (document) =>
        document.compensationHandles[
          `${effectPlanDigest}:${receiptDigest}`
        ],
    );
  }
}
