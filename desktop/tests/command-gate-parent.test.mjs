import assert from "node:assert/strict";
import { test } from "vitest";
import { assertTrustedCommandGateParent } from "../command-gate-parent.mjs";

const identity = (value) => value;

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
      execute: (executable, args, options) => {
        assert.equal(
          executable,
          String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
        );
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
