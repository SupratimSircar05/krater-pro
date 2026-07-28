import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HSTS_POLICY, PERMISSIONS_POLICY } from "../lib/security";

const headers = readFileSync(
  resolve(import.meta.dirname, "../public/_headers"),
  "utf8",
);

describe("cloud static security headers", () => {
  it("sets the production transport and browser isolation policy", () => {
    expect(headers).toContain(
      `Strict-Transport-Security: ${HSTS_POLICY}`,
    );
    expect(headers).toContain(
      "Content-Security-Policy: default-src 'self';",
    );
    expect(headers).not.toMatch(/'unsafe-(?:eval|inline)'/u);
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(headers).toContain("Cross-Origin-Resource-Policy: same-origin");
    expect(headers).toContain(`Permissions-Policy: ${PERMISSIONS_POLICY}`);
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
  });
});
