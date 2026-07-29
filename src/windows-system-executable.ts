import { win32 } from "node:path";

const WINDOWS_SYSTEM32_ROOT =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

/**
 * Resolve a small, compile-time allowlist through the Windows object manager
 * instead of trusting a caller-controlled drive, PATH, SystemRoot, or ComSpec.
 */
export function windowsSystemExecutable(
  name: "cmd.exe" | "taskkill.exe",
): string {
  return win32.join(WINDOWS_SYSTEM32_ROOT, name);
}
