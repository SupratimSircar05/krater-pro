import { describe, expect, it } from "vitest";
import { isStableRegularFileIdentity } from "./file-identity.js";

function identity(
  overrides: Partial<{
    dev: bigint;
    ino: bigint;
    file: boolean;
    symbolicLink: boolean;
  }> = {},
) {
  const {
    dev = 7n,
    ino = 42n,
    file = true,
    symbolicLink = false,
  } = overrides;
  return {
    dev,
    ino,
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
  };
}

describe("stable regular file identity", () => {
  it("accepts the same regular file observed through a descriptor and path", () => {
    expect(
      isStableRegularFileIdentity(identity(), identity()),
    ).toBe(true);
  });

  it("rejects a followed final symlink when O_NOFOLLOW is unavailable", () => {
    expect(
      isStableRegularFileIdentity(
        identity(),
        identity({ symbolicLink: true }),
      ),
    ).toBe(false);
  });

  it("rejects replaced identities and non-file path types", () => {
    expect(
      isStableRegularFileIdentity(identity(), identity({ ino: 43n })),
    ).toBe(false);
    expect(
      isStableRegularFileIdentity(identity(), identity({ dev: 8n })),
    ).toBe(false);
    expect(
      isStableRegularFileIdentity(identity(), identity({ file: false })),
    ).toBe(false);
  });
});
