import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  REDACTED_VALUE,
  redactForPersistence,
  redactText,
  sha256Digest,
  verifySha256Digest,
} from "./index.js";

describe("canonical JSON and SHA-256 digests", () => {
  it("serializes object keys deterministically at every depth", () => {
    const first = {
      z: [{ b: true, a: "value" }],
      a: { y: 2, x: -0 },
    };
    const second = {
      a: { x: 0, y: 2 },
      z: [{ a: "value", b: true }],
    };
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(sha256Digest(canonicalStringify(first))).toBe(
      sha256Digest(canonicalStringify(second)),
    );
  });

  it("rejects values that cannot be represented unambiguously", () => {
    expect(() => canonicalStringify({ value: undefined })).toThrow(/cannot represent/i);
    expect(() => canonicalStringify(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalStringify([, "sparse"])).toThrow(/sparse/i);
    expect(() => canonicalStringify(new Date())).toThrow(/plain objects/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(/cycles/i);
  });

  it("verifies well-formed digests without accepting malformed values", () => {
    const body = "proof";
    const digest = sha256Digest(body);
    expect(verifySha256Digest(body, digest)).toBe(true);
    expect(verifySha256Digest("tampered", digest)).toBe(false);
    expect(verifySha256Digest(body, "sha256:not-a-digest")).toBe(false);
  });
});

describe("secret redaction", () => {
  it("redacts sensitive keys recursively without mutating the source", () => {
    const source = {
      apiKey: "krater-secret-value",
      nested: {
        authorization: "Bearer visible-secret",
        safe: "keep",
      },
      values: [{ refresh_token: "refresh-secret" }],
    };
    const redacted = redactForPersistence(source);

    expect(redacted).toEqual({
      apiKey: REDACTED_VALUE,
      nested: {
        authorization: REDACTED_VALUE,
        safe: "keep",
      },
      values: [{ refresh_token: REDACTED_VALUE }],
    });
    expect(source.apiKey).toBe("krater-secret-value");
  });

  it("redacts common inline credentials and credential-bearing URLs", () => {
    const value = [
      "Authorization: Bearer bearer-secret",
      `OPENAI_API_KEY=${["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-")}`,
      "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
      "https://developer:password@example.test/private.git",
      "https://example.test/?api_key=query-secret",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
    ].join("\n");
    const redacted = redactText(value);

    expect(redacted).not.toMatch(
      /bearer-secret|abcdefghijklmnopqrstuvwxyz|password@|query-secret|signaturevalue/,
    );
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("does not redact ordinary token-accounting fields", () => {
    expect(
      redactForPersistence({ promptTokens: 20, completionTokens: 5 }),
    ).toEqual({ promptTokens: 20, completionTokens: 5 });
  });

  it("redacts Krater credentials, passphrases, session IDs, and private keys", () => {
    const value = [
      "kr_demo_abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----",
      "private-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactForPersistence({
      output: value,
      passphrase: "do-not-store",
      sessionId: "session-secret",
    });

    expect(JSON.stringify(redacted)).not.toMatch(
      /kr_demo_|private-material|do-not-store|session-secret/,
    );
  });
});
