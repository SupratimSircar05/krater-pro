import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const profileUrl = "https://www.linkedin.com/in/supratimsircar/";

async function source(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("Krater Pro brand contract", () => {
  it("uses the canonical crater mark in the GUI and favicon", async () => {
    const [asset, app, index] = await Promise.all([
      source("web/src/assets/krater-pro-mark.svg"),
      source("web/src/App.tsx"),
      source("web/index.html"),
    ]);

    expect(asset).toContain('viewBox="0 0 64 64"');
    expect(asset).toContain("<title id=\"title\">Krater Pro</title>");
    expect(app).toContain(
      'import kraterProMark from "./assets/krater-pro-mark.svg";',
    );
    expect(index).toContain(
      'rel="icon" type="image/svg+xml" href="/src/assets/krater-pro-mark.svg"',
    );
  });

  it("links only Supratim in hyperlink-capable surfaces", async () => {
    const [app, readme, brand] = await Promise.all([
      source("web/src/App.tsx"),
      source("README.md"),
      source("docs/BRAND.md"),
    ]);

    expect(app).toContain(`href="${profileUrl}"`);
    expect(app).toMatch(/Built by\{" "\}[\s\S]*?>\s*Supratim\s*<\/a>\{" "\}\s*with ❤️/);
    expect(readme).toContain(
      `Built by <a href="${profileUrl}">Supratim</a> with ❤️`,
    );
    expect(brand).toContain(
      `Built by [Supratim](${profileUrl}) with ❤️`,
    );
  });

  it("uses an OSC-free terminal counterpart and plain creator URL", async () => {
    const cli = await source("src/cli.ts");

    expect(cli).toContain('const CREATOR_CREDIT = "Built by Supratim with ❤️";');
    expect(cli).toContain(`const CREATOR_PROFILE = "${profileUrl}";`);
    expect(cli).toContain("◉");
    expect(cli).not.toContain("\\u001b]8;");
  });
});
