import { describe, expect, it } from "vitest";
import { resolveInteractiveCommand } from "./interactive-commands.js";

describe("interactive command aliases", () => {
  it.each([
    ["/understood", "contract"],
    ["/plan", "plan"],
    ["/proof", "evidence"],
    ["/ship", "ship"],
    ["/watch", "watch"],
    ["/undo", "rollback"],
  ] as const)("maps %s to the shared %s behavior", (input, expected) => {
    expect(resolveInteractiveCommand(input)).toBe(expected);
  });

  it("preserves existing commands and rejects prompt text", () => {
    expect(resolveInteractiveCommand("/contract")).toBe("contract");
    expect(resolveInteractiveCommand("/rollback")).toBe("rollback");
    expect(resolveInteractiveCommand("fix the failing test")).toBeUndefined();
  });

  it("normalizes casing and surrounding whitespace", () => {
    expect(resolveInteractiveCommand("  /PrOoF ")).toBe("evidence");
  });
});
