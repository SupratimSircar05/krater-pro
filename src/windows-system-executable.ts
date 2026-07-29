import { realpathSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_OBJECT_MANAGER_SYSTEM32 =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

export type WindowsSystemExecutableName =
  | "cmd.exe"
  | "taskkill.exe";

export interface WindowsSystemExecutableOptions {
  realpath?: (path: string) => string;
}

function objectManagerExecutablePath(
  name: WindowsSystemExecutableName,
): string {
  switch (name) {
    case "cmd.exe":
      return String.raw`\\?\GLOBALROOT\SystemRoot\System32\cmd.exe`;
    case "taskkill.exe":
      return String.raw`\\?\GLOBALROOT\SystemRoot\System32\taskkill.exe`;
    default:
      throw new Error("The Windows system executable is not allowlisted.");
  }
}

function normalizedDrivePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 32_767 ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error("The Windows system executable path is invalid.");
  }
  const normalized = win32.normalize(path);
  if (!/^[a-z]:\\/i.test(normalized) || !win32.isAbsolute(normalized)) {
    throw new Error("The Windows system executable did not resolve to a drive path.");
  }
  return normalized;
}

/**
 * Resolve a compile-time allowlist through the machine-owned Windows object
 * namespace, then convert it to the ordinary DOS drive path CreateProcessW
 * expects. No caller-controlled PATH, SystemRoot, or ComSpec value is used.
 */
export function windowsSystemExecutable(
  name: WindowsSystemExecutableName,
  options: WindowsSystemExecutableOptions = {},
): string {
  const resolveFinalPath = options.realpath ?? realpathSync.native;
  const systemDirectory = normalizedDrivePath(
    resolveFinalPath(WINDOWS_OBJECT_MANAGER_SYSTEM32),
  );
  const executable = normalizedDrivePath(
    resolveFinalPath(objectManagerExecutablePath(name)),
  );
  const expected = win32.join(
    systemDirectory,
    name,
  );
  if (executable.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      "The Windows system executable resolved outside the system directory.",
    );
  }
  return executable;
}
