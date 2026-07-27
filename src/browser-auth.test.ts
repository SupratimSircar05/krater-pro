import { describe, expect, it } from "vitest";
import {
  KRATER_DEVELOPER_URL,
  browserAuthCapabilities,
  browserOpenCommand,
} from "./browser-auth.js";

describe("browser-assisted Krater authentication", () => {
  it("states the supported API-key handoff without claiming OAuth", () => {
    expect(browserAuthCapabilities()).toMatchObject({
      oauth: false,
      mode: "api-key-handoff",
      developerUrl: KRATER_DEVELOPER_URL,
    });
  });

  it("uses non-shell browser launchers where practical", () => {
    expect(browserOpenCommand("darwin")).toEqual({
      executable: "open",
      args: [KRATER_DEVELOPER_URL],
    });
    expect(browserOpenCommand("linux")).toEqual({
      executable: "xdg-open",
      args: [KRATER_DEVELOPER_URL],
    });
    expect(browserOpenCommand("win32").executable).toBe("cmd");
  });
});
