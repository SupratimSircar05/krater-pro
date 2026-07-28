import { describe, expect, it } from "vitest";
import { generateMacOsSandboxProfile } from "./index.js";

describe("macOS Seatbelt profile", () => {
  it("is deny-first, no-fork, network-denied, and scoped to exact paths", () => {
    const profile = generateMacOsSandboxProfile({
      executable: "/usr/bin/tool",
      shellExecutable: "/bin/zsh",
      workingDirectory: "/private/tmp/staged",
      readable: [
        { path: "/private/tmp/staged", kind: "directory" },
        { path: '/private/tmp/quote"file', kind: "file" },
      ],
      writable: [
        { path: "/private/tmp/staged/output", kind: "directory" },
      ],
      denied: [{ path: "/private/tmp/staged/.env", kind: "file" }],
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny process-fork)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(
      '(allow process-exec (literal "/bin/zsh") (literal "/usr/bin/tool"))',
    );
    expect(profile).toContain(
      '(subpath "/private/tmp/staged/output")',
    );
    expect(profile).toContain('(literal "/private/tmp/quote\\"file")');
    expect(profile).not.toContain("(allow network");
    expect(profile).not.toContain("(allow process*)");
    expect(profile).toContain(
      '(deny file-read* (literal "/private/tmp/staged/.env"))',
    );
    expect(profile).toContain(
      '(deny file-write* (literal "/private/tmp/staged/.env"))',
    );
  });

  it("rejects control-line profile injection", () => {
    expect(() =>
      generateMacOsSandboxProfile({
        executable: "/usr/bin/tool\n(allow default)",
        shellExecutable: "/bin/zsh",
        workingDirectory: "/private/tmp/staged",
        readable: [],
        writable: [],
      }),
    ).toThrow(/single-line paths/i);
  });
});
