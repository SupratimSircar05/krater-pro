import { describe, expect, it } from "vitest";
import {
  parseFormulaArguments,
  renderFormula,
  validateFormulaInputs,
} from "./render-formula.mjs";

const template = [
  'url "{{URL}}"',
  'sha256 "{{SHA256}}"',
  'version "{{VERSION}}"',
  "",
].join("\n");

describe("Homebrew formula renderer", () => {
  it("renders a pinned HTTPS URL, version, and checksum", () => {
    const sha256 = "a".repeat(64);
    const output = renderFormula(template, {
      version: "0.2.0",
      sha256,
      url: "https://registry.npmjs.org/krater-pro/-/krater-pro-0.2.0.tgz",
    });

    expect(output).toContain('version "0.2.0"');
    expect(output).toContain(`sha256 "${sha256}"`);
    expect(output).toContain(
      'url "https://registry.npmjs.org/krater-pro/-/krater-pro-0.2.0.tgz"',
    );
    expect(output).not.toContain("{{");
  });

  it("rejects credentials, query strings, and malformed checksums", () => {
    expect(() =>
      validateFormulaInputs({
        version: "0.2.0",
        sha256: "a".repeat(64),
        url: "https://user:secret@example.com/package.tgz",
      }),
    ).toThrow(/no credentials/);
    expect(() =>
      validateFormulaInputs({
        version: "0.2.0",
        sha256: "a".repeat(64),
        url: "https://example.com/package.tgz?token=secret",
      }),
    ).toThrow(/query/);
    expect(() =>
      validateFormulaInputs({
        version: "0.2.0",
        sha256: "ABC",
        url: "https://example.com/package.tgz",
      }),
    ).toThrow(/64 lowercase hex/);
  });

  it("parses explicit output options without reading the environment", () => {
    expect(
      parseFormulaArguments([
        "--version",
        "0.2.0",
        "--sha256",
        "b".repeat(64),
        "--output",
        "Formula/krater-pro.rb",
      ]),
    ).toEqual({
      version: "0.2.0",
      sha256: "b".repeat(64),
      output: "Formula/krater-pro.rb",
    });
  });
});
