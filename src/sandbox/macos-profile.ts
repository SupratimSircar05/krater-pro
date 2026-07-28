import { dirname, resolve, sep } from "node:path";

export interface MacOsProfilePath {
  path: string;
  kind: "file" | "directory";
}

export interface MacOsSandboxProfileInput {
  executable: string;
  shellExecutable: string;
  workingDirectory: string;
  readable: readonly MacOsProfilePath[];
  writable: readonly MacOsProfilePath[];
  denied?: readonly MacOsProfilePath[];
}

const SYSTEM_READ_PATHS: readonly MacOsProfilePath[] = [
  { path: "/System", kind: "directory" },
  { path: "/usr/lib", kind: "directory" },
  { path: "/dev/null", kind: "file" },
  { path: "/dev/random", kind: "file" },
  { path: "/dev/urandom", kind: "file" },
];

function assertProfilePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    /[\r\n\u2028\u2029]/u.test(path)
  ) {
    throw new Error("macOS sandbox profiles require absolute single-line paths.");
  }
}

function literal(path: string): string {
  assertProfilePath(path);
  return `(literal ${JSON.stringify(path)})`;
}

function pathFilter(path: MacOsProfilePath): string {
  return path.kind === "directory"
    ? `${literal(path.path)} (subpath ${JSON.stringify(path.path)})`
    : literal(path.path);
}

function uniquePaths(paths: readonly MacOsProfilePath[]): MacOsProfilePath[] {
  const merged = new Map<string, MacOsProfilePath>();
  for (const item of paths) {
    assertProfilePath(item.path);
    const previous = merged.get(item.path);
    merged.set(item.path, {
      path: item.path,
      kind:
        previous?.kind === "directory" || item.kind === "directory"
          ? "directory"
          : "file",
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function parentPaths(paths: readonly string[]): MacOsProfilePath[] {
  const parents = new Map<string, MacOsProfilePath>();
  for (const value of paths) {
    let current = resolve(value);
    while (current !== sep) {
      current = dirname(current);
      parents.set(current, { path: current, kind: "file" });
    }
    parents.set("/", { path: "/", kind: "file" });
  }
  return [...parents.values()];
}

/**
 * Builds a deterministic Seatbelt profile. It intentionally supports only
 * deny-all networking. Hostname/IP allowlists are not represented because
 * Seatbelt cannot safely bind a hostname to an exact, stable destination.
 *
 * Process creation is stricter than the caller's numerical process ceiling:
 * forks are denied, so the shell must replace itself with the requested
 * executable and the resulting sandbox contains one process.
 */
export function generateMacOsSandboxProfile(
  input: MacOsSandboxProfileInput,
): string {
  for (const path of [
    input.executable,
    input.shellExecutable,
    input.workingDirectory,
  ]) {
    assertProfilePath(path);
  }

  const readable = uniquePaths([
    ...SYSTEM_READ_PATHS,
    ...input.readable,
    { path: input.executable, kind: "file" },
    { path: input.shellExecutable, kind: "file" },
    ...parentPaths([
      input.workingDirectory,
      input.executable,
      input.shellExecutable,
      ...input.readable.map(({ path }) => path),
      ...input.writable.map(({ path }) => path),
    ]),
  ]);
  const writable = uniquePaths([
    ...input.writable,
    { path: "/dev/null", kind: "file" },
  ]);
  const denied = uniquePaths(input.denied ?? []);

  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${literal(input.shellExecutable)} ${literal(input.executable)})`,
    "(deny process-fork)",
    "(allow sysctl-read)",
    `(allow file-read* ${readable.map(pathFilter).join(" ")})`,
    `(allow file-write* ${writable.map(pathFilter).join(" ")})`,
    "(deny network*)",
    ...(denied.length
      ? [
          `(deny file-read* ${denied.map(pathFilter).join(" ")})`,
          `(deny file-write* ${denied.map(pathFilter).join(" ")})`,
        ]
      : []),
  ].join("\n");
}
