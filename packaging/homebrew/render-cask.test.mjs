import { describe, expect, it } from "vitest";
import {
  parseCaskArguments,
  renderCask,
  validateCaskInputs,
} from "./render-cask.mjs";

const template = [
  'version "{{VERSION}}"',
  'sha256 arm: "{{ARM64_SHA256}}", intel: "{{X64_SHA256}}"',
  "",
].join("\n");

describe("Homebrew cask renderer", () => {
  it("renders architecture-specific immutable checksums", () => {
    const output = renderCask(template, {
      version: "1.0.0",
      arm64Sha256: "a".repeat(64),
      x64Sha256: "b".repeat(64),
    });
    expect(output).toContain('version "1.0.0"');
    expect(output).toContain(`arm: "${"a".repeat(64)}"`);
    expect(output).toContain(`intel: "${"b".repeat(64)}"`);
    expect(output).not.toContain("{{");
  });

  it("rejects malformed versions and either malformed checksum", () => {
    expect(() =>
      validateCaskInputs({
        version: "../1.0.0",
        arm64Sha256: "a".repeat(64),
        x64Sha256: "b".repeat(64),
      }),
    ).toThrow(/semantic version/);
    expect(() =>
      validateCaskInputs({
        version: "1.0.0",
        arm64Sha256: "A".repeat(64),
        x64Sha256: "b".repeat(64),
      }),
    ).toThrow(/ARM64/);
    expect(() =>
      validateCaskInputs({
        version: "1.0.0",
        arm64Sha256: "a".repeat(64),
        x64Sha256: "short",
      }),
    ).toThrow(/x64/);
  });

  it("requires explicit release inputs and rejects unknown options", () => {
    expect(
      parseCaskArguments([
        "--version",
        "1.0.0",
        "--arm64-sha256",
        "a".repeat(64),
        "--x64-sha256",
        "b".repeat(64),
        "--output",
        "Casks/krater-pro-app.rb",
      ]),
    ).toEqual({
      version: "1.0.0",
      arm64Sha256: "a".repeat(64),
      x64Sha256: "b".repeat(64),
      output: "Casks/krater-pro-app.rb",
    });
    expect(() => parseCaskArguments(["--token", "secret"])).toThrow(
      /Unknown option/,
    );
  });
});
