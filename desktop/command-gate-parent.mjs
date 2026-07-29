import { execFileSync } from "node:child_process";
import {
  readlinkSync,
  realpathSync,
} from "node:fs";
import { win32 } from "node:path";

const PARENT_LOOKUP_TIMEOUT_MS = 2_000;
const WINDOWS_OBJECT_MANAGER_SYSTEM32 =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32`;
const WINDOWS_OBJECT_MANAGER_POWERSHELL =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_POWERSHELL_PARTS = [
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
];

function normalizedWindowsDrivePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 32_767 ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error("The Windows parent-query executable path was invalid.");
  }
  const normalized = win32.normalize(path);
  if (!/^[a-z]:\\/iu.test(normalized) || !win32.isAbsolute(normalized)) {
    throw new Error(
      "The Windows parent-query executable did not resolve to a drive path.",
    );
  }
  return normalized;
}

export function windowsPowerShellExecutable(
  resolveFinalPath = realpathSync.native,
) {
  const systemDirectory = normalizedWindowsDrivePath(
    resolveFinalPath(WINDOWS_OBJECT_MANAGER_SYSTEM32),
  );
  const executable = normalizedWindowsDrivePath(
    resolveFinalPath(WINDOWS_OBJECT_MANAGER_POWERSHELL),
  );
  const expected = win32.join(systemDirectory, ...WINDOWS_POWERSHELL_PARTS);
  if (executable.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      "The Windows parent-query executable resolved outside System32.",
    );
  }
  return executable;
}

function parentExecutablePath({
  platform,
  parentPid,
  execute = execFileSync,
  readLink = readlinkSync,
  resolveWindowsFinalPath,
}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
    throw new Error("The command gate parent process was unavailable.");
  }
  if (platform === "linux") {
    return readLink(`/proc/${parentPid}/exe`);
  }
  if (platform === "darwin") {
    return execute(
      "/bin/ps",
      ["-p", String(parentPid), "-o", "comm="],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        timeout: PARENT_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
  }
  if (platform === "win32") {
    const powerShell = windowsPowerShellExecutable(resolveWindowsFinalPath);
    const script =
      `$process = [System.Diagnostics.Process]::GetProcessById(${parentPid}); ` +
      "$path = $process.MainModule.FileName; $process.Dispose(); " +
      "if ([string]::IsNullOrWhiteSpace($path)) { exit 3 }; " +
      "[Console]::Out.Write($path)";
    return execute(
      powerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        // Do not explicitly forward caller configuration. libuv may restore
        // Windows-required variables, so the fixed GLOBALROOT executable and
        // fully qualified .NET query are the meaningful defenses here.
        env: {},
        timeout: PARENT_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
  }
  throw new Error(`Unsupported Electron command-gate platform: ${platform}`);
}

function canonicalExecutable(path, platform, resolveRealPath = realpathSync) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 8_192 ||
    /[\u0000\r\n]/u.test(path)
  ) {
    throw new Error("The command gate executable path was invalid.");
  }
  const resolved = resolveRealPath(path);
  return platform === "win32"
    ? win32.normalize(resolved).toLowerCase()
    : resolved;
}

/**
 * The packaged Electron binary is also the only available Node host after the
 * RunAsNode fuse is disabled. Keep the internal gate route private by requiring
 * its live parent to be the same canonical Electron executable. This rejects
 * ordinary accidental/external invocation, but it is defense-in-depth rather
 * than an unforgeable same-user capability or an OS containment boundary.
 */
export function assertTrustedCommandGateParent({
  platform = process.platform,
  parentPid = process.ppid,
  currentExecutable = process.execPath,
  currentParentPid = () => process.ppid,
  execute,
  readLink,
  resolveRealPath,
  resolveWindowsFinalPath,
} = {}) {
  const parentExecutable = parentExecutablePath({
    platform,
    parentPid,
    ...(execute ? { execute } : {}),
    ...(readLink ? { readLink } : {}),
    ...(resolveWindowsFinalPath ? { resolveWindowsFinalPath } : {}),
  });
  if (
    currentParentPid() !== parentPid ||
    canonicalExecutable(parentExecutable, platform, resolveRealPath) !==
      canonicalExecutable(currentExecutable, platform, resolveRealPath)
  ) {
    throw new Error("The command gate was not launched by the Krater host.");
  }
}
