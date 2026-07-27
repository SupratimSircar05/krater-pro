import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Cloudflare runtime configuration", () => {
  it("pins global fetches to public network routes", async () => {
    const source = await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(source) as {
      compatibility_flags?: unknown;
    };

    expect(config.compatibility_flags).toContain(
      "global_fetch_strictly_public",
    );
  });
});
