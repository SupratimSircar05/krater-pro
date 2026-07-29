import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../scripts/release/release-utils.mjs";
import {
  parseChecksumManifest,
  prepareTap,
} from "./prepare-tap.mjs";
import { scaffoldTap } from "./scaffold-tap.mjs";

describe("Homebrew tap preparation", () => {
  it("rejects malformed and duplicate checksum records", () => {
    expect(() => parseChecksumManifest("bad")).toThrow(/line 1/);
    expect(() =>
      parseChecksumManifest(
        `${"a".repeat(64)}  same.tgz\n${"b".repeat(64)}  same.tgz\n`,
      ),
    ).toThrow(/Duplicate/);
  });

  it("renders formula and cask only after all required asset hashes match", async () => {
    const root = await mkdtemp(join(tmpdir(), "krater-tap-prepare-"));
    const assets = join(root, "assets");
    const output = join(root, "tap");
    await (await import("node:fs/promises")).mkdir(assets);
    const version = "0.1.0";
    const files = {
      [`krater-pro-cli-${version}.tgz`]: "cli",
      [`Krater-Pro-${version}-arm64.dmg`]: "arm",
      [`Krater-Pro-${version}-x64.dmg`]: "intel",
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(assets, name), content);
    }
    await writeFile(
      join(assets, "SHA256SUMS.txt"),
      `${Object.entries(files)
        .map(([name, content]) => `${sha256(content)}  ${name}`)
        .sort()
        .join("\n")}\n`,
    );
    await prepareTap({ assets, output, version });
    const formula = await readFile(
      join(output, "Formula", "krater-pro.rb"),
      "utf8",
    );
    const cask = await readFile(
      join(output, "Casks", "krater-pro-app.rb"),
      "utf8",
    );
    expect(formula).toContain(`krater-pro-cli-${version}.tgz`);
    expect(formula).toContain(`sha256 "${sha256("cli")}"`);
    expect(formula).toContain('"npm", "ci"');
    expect(formula).toContain('man1.install libexec/"docs/man/krater.1"');
    expect(cask).toContain(`arm:   "${sha256("arm")}"`);
    expect(cask).toContain(`intel: "${sha256("intel")}"`);

    await writeFile(
      join(assets, `Krater-Pro-${version}-x64.dmg`),
      "tampered",
    );
    await expect(prepareTap({ assets, output, version })).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  it("scaffolds native tap CI without credentials or package versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "krater-tap-scaffold-"));
    await scaffoldTap(root);
    const readme = await readFile(join(root, "README.md"), "utf8");
    const workflow = await readFile(
      join(root, ".github", "workflows", "tests.yml"),
      "utf8",
    );
    const publishWorkflow = await readFile(
      join(root, ".github", "workflows", "publish.yml"),
      "utf8",
    );
    expect(readme).toContain(
      "brew install SupratimSircar05/homebrew-tap/krater-pro",
    );
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-26");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("brew test-bot --only-formulae");
    expect(workflow).toContain("Detect a staged CLI formula");
    expect(workflow).toContain("Detect a staged desktop cask");
    expect(workflow).toContain(
      "steps.package.outputs.present == 'true'",
    );
    expect(workflow).toContain(
      "--root-url=https://ghcr.io/v2/supratimsircar05/tap",
    );
    expect(publishWorkflow).toContain("--head-sha=\"$HEAD_SHA\"");
    expect(publishWorkflow).toContain("environment: bottle-publication");
    for (const contents of [workflow, publishWorkflow]) {
      expect(contents).not.toMatch(/uses:\s+[^@\s]+@v\d/u);
      for (const match of contents.matchAll(/uses:\s+[^@\s]+@([a-f0-9]+)/gu)) {
        expect(match[1]).toHaveLength(40);
      }
    }
    expect(workflow).not.toMatch(/password|api[_-]?key/iu);
    expect(readme).toContain("Linux, and WSL 2");
    expect(readme).toContain("signed WinGet package");
  });
});
