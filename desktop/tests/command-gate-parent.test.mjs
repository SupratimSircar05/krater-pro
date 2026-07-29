import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertTrustedCommandGateParent,
  windowsPowerShellExecutable,
} from "../command-gate-parent.mjs";

const identity = (value) => value;
const objectManagerSystem32 =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32`;
const objectManagerPowerShell =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const resolvedSystem32 = String.raw`D:\Windows\System32`;
const resolvedPowerShell =
  String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const resolveWindowsFinalPath = (path) => {
  if (path === objectManagerSystem32) return resolvedSystem32;
  if (path === objectManagerPowerShell) return resolvedPowerShell;
  throw new Error(`Unexpected Windows final-path input: ${path}`);
};

test("resolves the fixed Windows parent-query executable to a spawn path", () => {
  assert.equal(
    windowsPowerShellExecutable(resolveWindowsFinalPath),
    resolvedPowerShell,
  );
  assert.throws(
    () =>
      windowsPowerShellExecutable((path) =>
        path === objectManagerSystem32
          ? resolvedSystem32
          : String.raw`D:\Attacker\powershell.exe`,
      ),
    /outside System32/,
  );
});

test("accepts a live Linux parent using the same canonical executable", () => {
  assert.doesNotThrow(() =>
    assertTrustedCommandGateParent({
      platform: "linux",
      parentPid: 42,
      currentExecutable: "/opt/Krater Pro/krater-pro",
      currentParentPid: () => 42,
      readLink: () => "/opt/Krater Pro/krater-pro",
      resolveRealPath: identity,
    }),
  );
});

test("accepts a live macOS parent using the same canonical executable", () => {
  assert.doesNotThrow(() =>
    assertTrustedCommandGateParent({
      platform: "darwin",
      parentPid: 43,
      currentExecutable: "/Applications/Krater Pro.app/Contents/MacOS/Krater Pro",
      currentParentPid: () => 43,
      execute: (executable, args) => {
        assert.equal(executable, "/bin/ps");
        assert.deepEqual(args, ["-p", "43", "-o", "comm="]);
        return "/Applications/Krater Pro.app/Contents/MacOS/Krater Pro\n";
      },
      resolveRealPath: identity,
    }),
  );
});

test("accepts a case-insensitive Windows parent using the same executable", () => {
  assert.doesNotThrow(() =>
    assertTrustedCommandGateParent({
      platform: "win32",
      parentPid: 44,
      currentExecutable: String.raw`C:\Program Files\Krater Pro\KraterPro.exe`,
      currentParentPid: () => 44,
      environment: {
        SystemRoot: String.raw`C:\Attacker\FakeWindows`,
        PATH: String.raw`C:\Attacker\bin`,
        PSModulePath: String.raw`C:\Attacker\modules`,
        COR_ENABLE_PROFILING: "1",
        COR_PROFILER_PATH: String.raw`C:\Attacker\profiler.dll`,
      },
      resolveWindowsFinalPath,
      execute: (executable, args, options) => {
        assert.equal(executable, resolvedPowerShell);
        assert.ok(
          args.at(-1).includes(
            "[System.Diagnostics.Process]::GetProcessById(44)",
          ),
        );
        assert.deepEqual(options.env, {});
        return String.raw`c:\program files\krater pro\KRATERPRO.EXE`;
      },
      resolveRealPath: identity,
    }),
  );
});

test("rejects a different executable or a reparented gate", () => {
  assert.throws(
    () =>
      assertTrustedCommandGateParent({
        platform: "linux",
        parentPid: 45,
        currentExecutable: "/opt/Krater Pro/krater-pro",
        currentParentPid: () => 45,
        readLink: () => "/usr/bin/node",
        resolveRealPath: identity,
      }),
    /not launched by the Krater host/,
  );
  assert.throws(
    () =>
      assertTrustedCommandGateParent({
        platform: "linux",
        parentPid: 46,
        currentExecutable: "/opt/Krater Pro/krater-pro",
        currentParentPid: () => 1,
        readLink: () => "/opt/Krater Pro/krater-pro",
        resolveRealPath: identity,
      }),
    /not launched by the Krater host/,
  );
});
