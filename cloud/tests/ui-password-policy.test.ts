import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cloud signup password policy", () => {
  it("keeps the browser form and client check aligned at 15 through 128", async () => {
    const [html, script] = await Promise.all([
      readFile(new URL("../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('minlength="15"');
    expect(html).toContain('maxlength="128"');
    expect(html).toContain('placeholder="At least 15 characters"');
    expect(script).toContain("password.length < 15");
    expect(script).toContain("Use at least 15 characters for your password.");
    expect(html).not.toContain("At least 12 characters");
    expect(script).not.toContain("at least 12 characters");
  });
});
