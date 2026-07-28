import { describe, expect, it } from "vitest";
import {
  editorResourceKey,
  monacoLanguageForPath,
} from "../src/editor-language";

describe("Monaco editor language selection", () => {
  it.each([
    ["src/server.ts", "typescript"],
    ["src/component.TSX", "typescript"],
    ["scripts/check.py", "python"],
    ["Cargo.toml", "ini"],
    [".github/workflows/ci.yml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["Dockerfile.release", "dockerfile"],
    ["Makefile", "plaintext"],
    ["README", "plaintext"],
  ])("maps %s to %s", (path, expected) => {
    expect(monacoLanguageForPath(path)).toBe(expected);
  });

  it("uses project-scoped resource keys so models cannot cross workspaces", () => {
    expect(editorResourceKey("project-a", "src/app.ts")).not.toBe(
      editorResourceKey("project-b", "src/app.ts"),
    );
    expect(editorResourceKey("project-a", "src\\app.ts")).toBe(
      editorResourceKey("project-a", "src/app.ts"),
    );
  });
});
