import { describe, expect, it } from "vitest";
import { windowsSystemExecutable } from "./windows-system-executable.js";

describe("Windows system executable resolution", () => {
  it.each([
    [
      "cmd.exe",
      String.raw`\\?\GLOBALROOT\SystemRoot\System32\cmd.exe`,
    ],
    [
      "taskkill.exe",
      String.raw`\\?\GLOBALROOT\SystemRoot\System32\taskkill.exe`,
    ],
  ] as const)("resolves %s without environment interpolation", (name, path) => {
    expect(windowsSystemExecutable(name)).toBe(path);
    expect(path).not.toContain("${");
  });
});
