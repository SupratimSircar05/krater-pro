import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { windowsSystemExecutable } from "./windows-system-executable.js";

const objectManagerSystem32 = String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

describe("Windows system executable resolution", () => {
  it.each([
    ["cmd.exe", "cmd.exe"],
    [
      "powershell.exe",
      String.raw`WindowsPowerShell\v1.0\powershell.exe`,
    ],
    ["taskkill.exe", "taskkill.exe"],
  ] as const)(
    "resolves %s to a spawn-compatible path on a non-C system drive",
    (name, relativeExecutable) => {
      const resolvedSystem32 = String.raw`D:\Windows\System32`;
      const objectManagerExecutable = `${objectManagerSystem32}\\${relativeExecutable}`;
      const resolvedExecutable = `${resolvedSystem32}\\${relativeExecutable}`;
      const realpath = vi.fn((path: string) => {
        if (path === objectManagerSystem32) return resolvedSystem32;
        if (path === objectManagerExecutable) {
          return resolvedExecutable;
        }
        throw new Error(`Unexpected resolution input: ${path}`);
      });

      expect(windowsSystemExecutable(name, { realpath })).toBe(
        resolvedExecutable,
      );
      expect(realpath.mock.calls).toEqual([
        [objectManagerSystem32],
        [objectManagerExecutable],
      ]);
    },
  );

  it.each([
    String.raw`\\server\share\Windows\System32`,
    String.raw`\\?\D:\Windows\System32`,
    String.raw`D:\Attacker\System32`,
  ])("rejects an unsafe resolved system directory: %s", (systemDirectory) => {
    expect(() =>
      windowsSystemExecutable("cmd.exe", {
        realpath: (path) =>
          path === objectManagerSystem32
            ? systemDirectory
            : String.raw`D:\Windows\System32\cmd.exe`,
      }),
    ).toThrow(/drive path|outside the system directory/i);
  });

  it("rejects an executable redirected outside the resolved system directory", () => {
    expect(() =>
      windowsSystemExecutable("cmd.exe", {
        realpath: (path) =>
          path === objectManagerSystem32
            ? String.raw`D:\Windows\System32`
            : String.raw`D:\Attacker\cmd.exe`,
      }),
    ).toThrow(/outside the system directory/i);
  });

  it.runIf(process.platform === "win32")(
    "returns a path accepted by Node spawn on Windows",
    () => {
      const executable = windowsSystemExecutable("cmd.exe");
      const result = spawnSync(executable, ["/d", "/q", "/c", "ver"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 5_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Windows/i);
    },
  );
});
