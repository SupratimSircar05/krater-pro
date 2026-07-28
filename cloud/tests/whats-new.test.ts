import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cloud What's New section", () => {
  it("publishes the evidence-native checkpoint without presenting it as 1.0", async () => {
    const html = await readFile(
      new URL("../public/index.html", import.meta.url),
      "utf8",
    );

    expect(html).toContain('id="whats-new"');
    expect(html).toContain("ProofGraph + Change Passport");
    expect(html).toContain("Isolated ProofPatch");
    expect(html).toContain("Action / Abstention Gate");
    expect(html).toContain("One durable Task Workspace");
    expect(html).toContain("moonshotai/kimi-k3");
    expect(html).toContain("Proof, shipping, and release foundations");
    expect(html).toContain("All 100 sealed fixtures");
    expect(html).toContain("It is not the finished 1.0 system.");
    expect(html).toContain("Built by <a href=\"https://www.linkedin.com/in/supratimsircar/\"");
  });
});
