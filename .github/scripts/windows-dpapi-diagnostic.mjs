import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

if (process.platform !== "win32") {
  throw new Error("This diagnostic is Windows-only.");
}

const objectManagerPowerShell =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const executable = realpathSync.native(objectManagerPowerShell);
const script = [
  "Add-Type -AssemblyName System.Security",
  "$plain = [byte[]](75, 82, 65, 84, 69, 82)",
  "$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "$roundtrip = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "if ($roundtrip.Length -ne $plain.Length) { exit 3 }",
].join("; ");
const args = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];

for (const [label, environment] of [
  ["inherited", process.env],
  ["empty", {}],
]) {
  const startedAt = Date.now();
  const result = spawnSync(executable, args, {
    cwd: dirname(executable),
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  console.log(
    JSON.stringify({
      label,
      durationMs: Date.now() - startedAt,
      status: result.status,
      signal: result.signal,
      errorCode:
        result.error && "code" in result.error
          ? String(result.error.code)
          : undefined,
    }),
  );
  if (result.error || result.status !== 0) {
    process.exitCode = 1;
  }
}
