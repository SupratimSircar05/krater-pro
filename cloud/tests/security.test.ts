import { describe, expect, it } from "vitest";
import {
  PASSWORD_ITERATIONS,
  MIN_PASSWORD_PEPPER_BYTES,
  MAX_MESSAGE_BYTES,
  SESSION_COOKIE,
  HttpError,
  assertSameOrigin,
  clearSessionCookie,
  fitProviderReply,
  hashPassword,
  jsonResponse,
  normalizeEmail,
  readKraterKey,
  requirePasswordPepper,
  safeErrorResponse,
  sessionCookie,
  validateMessages,
  validatePassword,
  validateSnapshot,
  verifyPassword,
} from "../lib/security";

const TEST_PASSWORD_PEPPER = "p".repeat(32);

describe("cloud security helpers", () => {
  it("normalizes email addresses and rejects malformed input", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(() => normalizeEmail("not-an-email")).toThrow(HttpError);
    expect(() => normalizeEmail(`x@${"a".repeat(250)}.com`)).toThrow(HttpError);
  });

  it("enforces the password bounds", () => {
    expect(() => validatePassword("x".repeat(14))).toThrow(/15 and 128/u);
    expect(validatePassword("x".repeat(15))).toBe("x".repeat(15));
    expect(validatePassword("x".repeat(128))).toBe("x".repeat(128));
    expect(() => validatePassword("x".repeat(129))).toThrow(/15 and 128/u);
  });

  it("uses peppered, salted PBKDF2 and verifies in constant-work code", async () => {
    const first = await hashPassword(
      "a sufficiently long password",
      TEST_PASSWORD_PEPPER,
    );
    const second = await hashPassword(
      "a sufficiently long password",
      TEST_PASSWORD_PEPPER,
    );
    expect(first.iterations).toBe(PASSWORD_ITERATIONS);
    expect(PASSWORD_ITERATIONS).toBe(100_000);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    await expect(
      verifyPassword(
        "a sufficiently long password",
        TEST_PASSWORD_PEPPER,
        first.hash,
        first.salt,
        first.iterations,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(
        "a different password",
        TEST_PASSWORD_PEPPER,
        first.hash,
        first.salt,
        first.iterations,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "a sufficiently long password",
        "different-password-pepper-value-32",
        first.hash,
        first.salt,
        first.iterations,
      ),
    ).resolves.toBe(false);
  });

  it("requires an independent password pepper of at least 32 bytes", () => {
    expect(MIN_PASSWORD_PEPPER_BYTES).toBe(32);
    expect(requirePasswordPepper(TEST_PASSWORD_PEPPER)).toBe(TEST_PASSWORD_PEPPER);
    expect(() => requirePasswordPepper("too-short")).toThrow(
      /Service configuration error/u,
    );
    expect(() => requirePasswordPepper(undefined)).toThrow(
      /Service configuration error/u,
    );
  });

  it("builds host-only secure session cookies", () => {
    const cookie = sessionCookie("opaque-token");
    expect(cookie).toContain(`${SESSION_COOKIE}=opaque-token`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("requires same-origin mutations or an explicit non-browser CSRF header", () => {
    const url = "https://krater-pro.pages.dev/api/projects";
    expect(() => assertSameOrigin(new Request(url, {
      method: "POST",
      headers: { Origin: "https://krater-pro.pages.dev" },
    }))).not.toThrow();
    expect(() => assertSameOrigin(new Request(url, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    }))).toThrow(/Cross-origin/u);
    expect(() => assertSameOrigin(new Request(url, {
      method: "POST",
      headers: { "X-Krater-CSRF": "1" },
    }))).not.toThrow();
  });

  it("accepts only bounded virtual scratch snapshots", () => {
    expect(validateSnapshot({
      files: [{ path: "src/index.ts", content: "export {};" }],
      messages: [{ role: "user", content: "Explain this file." }],
      activePath: "src/index.ts",
    })).toEqual({
      files: [{ path: "src/index.ts", content: "export {};" }],
      messages: [{ role: "user", content: "Explain this file." }],
      activePath: "src/index.ts",
    });
    expect(() => validateSnapshot({
      files: [{ path: "../secret", content: "no" }],
      messages: [],
    })).toThrow(/invalid file path/u);
    expect(() => validateSnapshot({
      files: [
        { path: "same.ts", content: "one" },
        { path: "same.ts", content: "two" },
      ],
      messages: [],
    })).toThrow(/duplicate/u);
    expect(() => validateSnapshot({
      files: [{ path: "big.txt", content: "x".repeat((128 * 1024) + 1) }],
      messages: [],
    })).toThrow(/too large/u);
  });

  it("bounds chat history and requires the final turn to be a user", () => {
    expect(validateMessages([{ role: "user", content: "Help me." }])).toHaveLength(1);
    expect(() => validateMessages([{ role: "assistant", content: "Hello" }]))
      .toThrow(/invalid or too large/u);
    expect(() => validateMessages(
      Array.from({ length: 25 }, () => ({ role: "user", content: "x" })),
    )).toThrow(/1 to 24/u);
  });

  it("truncates provider replies on a UTF-8 code-point boundary", () => {
    const oversized = "😀".repeat(6_000);
    const fitted = fitProviderReply(oversized);
    expect(new TextEncoder().encode(fitted).byteLength)
      .toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(fitted).toContain("[Response truncated to fit saved project limits.]");
    expect(fitted).not.toContain("\uFFFD");
    expect(fitProviderReply(oversized)).toBe(fitted);
    expect(fitProviderReply("small reply")).toBe("small reply");
  });

  it("never includes API keys or arbitrary exception text in errors", () => {
    const secret = "krater-super-secret-value";
    const request = new Request("https://krater-pro.pages.dev/api/chat", {
      headers: { "X-Krater-API-Key": secret },
    });
    expect(readKraterKey(request)).toBe(secret);
    const response = safeErrorResponse(new Error(`upstream leaked ${secret}`));
    return response.text().then((body) => {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("upstream leaked");
    });
  });

  it("sets no-store and defensive headers on every JSON response", () => {
    const response = jsonResponse({ ok: true });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });
});
