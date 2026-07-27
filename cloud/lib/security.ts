const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const SESSION_COOKIE = "__Host-krater_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_ROTATE_AFTER_SECONDS = 24 * 60 * 60;
export const PASSWORD_ITERATIONS = 100_000;
export const MAX_JSON_BYTES = 600 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_PROJECTS = 10;
export const MAX_ACCOUNT_PROJECT_BYTES = 512 * 1024;
export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_MESSAGES = 24;
export const MAX_MESSAGE_BYTES = 20 * 1024;
export const MAX_MESSAGES_BYTES = 64 * 1024;
export const MAX_KRATER_KEY_BYTES = 512;
export const PROJECT_MUTATION_RATE_LIMIT = 300;
export const PROJECT_MUTATION_RATE_WINDOW_SECONDS = 60 * 60;
export const KEY_VALIDATION_RATE_LIMIT = 20;
export const KEY_VALIDATION_RATE_WINDOW_SECONDS = 15 * 60;
export const LOGIN_ACCOUNT_RATE_LIMIT = 12;
export const LOGIN_ACCOUNT_RATE_WINDOW_SECONDS = 15 * 60;
export const MIN_RATE_LIMIT_SALT_BYTES = 16;
export const MIN_PASSWORD_PEPPER_BYTES = 32;

export type RateLimitScope =
  | "register"
  | "login"
  | "login_account"
  | "chat"
  | "key_validate"
  | "project_mutation";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ScratchSnapshot {
  files: Array<{ path: string; content: string }>;
  messages: ChatMessage[];
  activePath?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url data.");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  }
  const email = value.trim().toLowerCase();
  if (
    email.length < 3
    || email.length > 254
    || /[\u0000-\u0020\u007f]/u.test(email)
    || !/^[^@]+@[^@]+\.[^@]+$/u.test(email)
  ) {
    throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 15 || value.length > 128) {
    throw new HttpError(
      400,
      "invalid_password",
      "Password must be between 15 and 128 characters.",
    );
  }
  return value;
}

export function requirePasswordPepper(value: unknown): string {
  if (
    typeof value !== "string"
    || encoder.encode(value).byteLength < MIN_PASSWORD_PEPPER_BYTES
  ) {
    throw new HttpError(
      500,
      "configuration_error",
      "Service configuration error.",
    );
  }
  return value;
}

export function requireRateLimitSalt(value: unknown): string {
  if (
    typeof value !== "string"
    || encoder.encode(value).byteLength < MIN_RATE_LIMIT_SALT_BYTES
  ) {
    throw new HttpError(
      500,
      "configuration_error",
      "Service configuration error.",
    );
  }
  return value;
}

async function prehashPassword(
  password: string,
  pepper: string,
): Promise<ArrayBuffer> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", hmacKey, encoder.encode(password));
}

export async function hashPassword(
  password: string,
  pepper: string,
  salt = randomToken(16),
  iterations = PASSWORD_ITERATIONS,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const prehash = await prehashPassword(
    password,
    requirePasswordPepper(pepper),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    prehash,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(fromBase64Url(salt)).buffer,
      iterations,
    },
    key,
    256,
  );
  return { hash: toBase64Url(new Uint8Array(bits)), salt, iterations };
}

export async function verifyPassword(
  password: string,
  pepper: string,
  expectedHash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  let actualHash: string;
  try {
    actualHash = (await hashPassword(password, pepper, salt, iterations)).hash;
  } catch {
    return false;
  }
  const actual = encoder.encode(actualHash);
  const expected = encoder.encode(expectedHash);
  let difference = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function apiHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = apiHeaders(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site") {
    throw new HttpError(403, "forbidden", "Cross-origin request rejected.");
  }
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin === expected) return;

  // Non-browser API clients have no Origin. Requiring a custom header keeps this
  // path behind a CORS preflight in browsers, while allowing deliberate CLI use.
  if (!origin && request.headers.get("X-Krater-CSRF") === "1") return;
  throw new HttpError(403, "forbidden", "Same-origin request required.");
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "payload_too_large", "Request body is too large.");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "payload_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson(
  request: Request,
  limit = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const bytes = await readBoundedBytes(request, limit);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function boundedString(
  value: unknown,
  name: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `invalid_${name}`, `${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, `invalid_${name}`, `${name} has an invalid length.`);
  }
  return trimmed;
}

function validateVirtualPath(value: string): void {
  if (
    value.length > 240
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new HttpError(400, "invalid_snapshot", "Snapshot contains an invalid file path.");
  }
  const parts = value.split("/");
  if (
    parts.length === 0
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HttpError(400, "invalid_snapshot", "Snapshot contains an invalid file path.");
  }
}

export function validateSnapshot(value: unknown): ScratchSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_snapshot", "snapshot must be a virtual file object.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "files" && key !== "messages" && key !== "activePath")) {
    throw new HttpError(400, "invalid_snapshot", "Snapshot contains unsupported fields.");
  }
  const candidate = value as { files?: unknown; messages?: unknown; activePath?: unknown };
  if (!Array.isArray(candidate.files)) {
    throw new HttpError(400, "invalid_snapshot", "snapshot.files must be an array.");
  }
  if (candidate.files.length > MAX_FILES) {
    throw new HttpError(400, "invalid_snapshot", "Snapshot has too many files.");
  }
  const seen = new Set<string>();
  const files = candidate.files.map((file): { path: string; content: string } => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new HttpError(400, "invalid_snapshot", "Each snapshot file must be an object.");
    }
    const fileKeys = Object.keys(file);
    if (fileKeys.some((key) => key !== "path" && key !== "content")) {
      throw new HttpError(400, "invalid_snapshot", "Snapshot file contains unsupported fields.");
    }
    const path = (file as { path?: unknown }).path;
    const content = (file as { content?: unknown }).content;
    if (typeof path !== "string") {
      throw new HttpError(400, "invalid_snapshot", "Snapshot file path must be a string.");
    }
    validateVirtualPath(path);
    if (seen.has(path)) {
      throw new HttpError(400, "invalid_snapshot", "Snapshot contains a duplicate file path.");
    }
    seen.add(path);
    if (typeof content !== "string" || encoder.encode(content).byteLength > MAX_FILE_BYTES) {
      throw new HttpError(400, "invalid_snapshot", "Snapshot file content is too large.");
    }
    return { path, content };
  });
  if (!Array.isArray(candidate.messages) || candidate.messages.length > MAX_MESSAGES) {
    throw new HttpError(400, "invalid_snapshot", "snapshot.messages must be a bounded array.");
  }
  let messageBytes = 0;
  const messages = candidate.messages.map((message): ChatMessage => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new HttpError(400, "invalid_snapshot", "Each saved message must be an object.");
    }
    if (Object.keys(message).some((key) => key !== "role" && key !== "content")) {
      throw new HttpError(400, "invalid_snapshot", "Saved message contains unsupported fields.");
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new HttpError(400, "invalid_snapshot", "Saved message is invalid.");
    }
    const bytes = encoder.encode(content).byteLength;
    if (content.length < 1 || bytes > MAX_MESSAGE_BYTES) {
      throw new HttpError(400, "invalid_snapshot", "A saved message is too large.");
    }
    messageBytes += bytes;
    return { role, content };
  });
  if (messageBytes > MAX_MESSAGES_BYTES) {
    throw new HttpError(400, "invalid_snapshot", "Saved messages are too large.");
  }
  let activePath: string | undefined;
  if (candidate.activePath !== undefined) {
    if (typeof candidate.activePath !== "string") {
      throw new HttpError(400, "invalid_snapshot", "activePath must be a string.");
    }
    validateVirtualPath(candidate.activePath);
    if (!seen.has(candidate.activePath)) {
      throw new HttpError(400, "invalid_snapshot", "activePath must reference a snapshot file.");
    }
    activePath = candidate.activePath;
  }
  const snapshot = activePath ? { files, messages, activePath } : { files, messages };
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new HttpError(400, "invalid_snapshot", "Snapshot is too large.");
  }
  return snapshot;
}

export function validateMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) {
    throw new HttpError(400, "invalid_messages", "messages must contain 1 to 24 items.");
  }
  let totalBytes = 0;
  const messages = value.map((item): ChatMessage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "invalid_messages", "Each message must be an object.");
    }
    if (Object.keys(item).some((key) => key !== "role" && key !== "content")) {
      throw new HttpError(400, "invalid_messages", "A chat message contains unsupported fields.");
    }
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new HttpError(400, "invalid_messages", "Each message needs a valid role and content.");
    }
    const bytes = encoder.encode(content).byteLength;
    if (content.length < 1 || bytes > MAX_MESSAGE_BYTES) {
      throw new HttpError(400, "invalid_messages", "A chat message is too large.");
    }
    totalBytes += bytes;
    return { role, content };
  });
  if (messages.at(-1)?.role !== "user" || totalBytes > MAX_MESSAGES_BYTES) {
    throw new HttpError(400, "invalid_messages", "Chat history is invalid or too large.");
  }
  return messages;
}

const PROVIDER_TRUNCATION_SUFFIX =
  "\n\n[Response truncated to fit saved project limits.]";

export function fitProviderReply(value: string): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_MESSAGE_BYTES) return value;

  const suffixBytes = encoder.encode(PROVIDER_TRUNCATION_SUFFIX).byteLength;
  const contentBudget = MAX_MESSAGE_BYTES - suffixBytes;
  let usedBytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (usedBytes + characterBytes > contentBudget) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return prefix + PROVIDER_TRUNCATION_SUFFIX;
}

export function readKraterKey(request: Request): string {
  const key = request.headers.get("X-Krater-API-Key")?.trim() ?? "";
  const bytes = encoder.encode(key).byteLength;
  if (
    bytes < 8
    || bytes > MAX_KRATER_KEY_BYTES
    || /[\u0000-\u0020\u007f]/u.test(key)
  ) {
    throw new HttpError(400, "invalid_api_key", "Provide a valid Krater API key.");
  }
  return key;
}

export function safeErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  return jsonResponse(
    { error: { code: "internal_error", message: "The request could not be completed." } },
    500,
  );
}
