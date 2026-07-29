import { describe, expect, it } from "vitest";
import { countWebVttCues, parseWebVttCues } from "./webvtt.mjs";

describe("WebVTT cue parsing", () => {
  it("counts only structurally valid cue blocks", () => {
    const source = [
      "\ufeffWEBVTT Tri-region demo",
      "Kind: captions",
      "Language: en",
      "",
      "NOTE generated --> text is not a cue",
      "This block may contain arrows --> too.",
      "",
      "opening",
      "00:00:00.000 --> 00:00:01.250 align:start",
      "First caption --> with an arrow in its text.",
      "",
      "00:01.250 --> 00:00:02.000",
      "Second caption.",
      "",
    ].join("\r\n");

    const cues = parseWebVttCues(source);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      identifier: "opening",
      startMilliseconds: 0,
      endMilliseconds: 1_250,
      text: "First caption --> with an arrow in its text.",
    });
    expect(countWebVttCues(source)).toBe(2);
  });

  it.each([
    ["missing header", "00:00.000 --> 00:01.000\nCaption\n"],
    [
      "arrow without timestamps",
      "WEBVTT\n\nnot a timestamp --> still not a timestamp\nCaption\n",
    ],
    [
      "out-of-range timestamp",
      "WEBVTT\n\n00:60.000 --> 00:61.000\nCaption\n",
    ],
    [
      "backwards cue",
      "WEBVTT\n\n00:02.000 --> 00:01.000\nCaption\n",
    ],
    [
      "missing payload",
      "WEBVTT\n\n00:00.000 --> 00:01.000\n",
    ],
    [
      "oversized line",
      `WEBVTT\n\n00:00.000 --> 00:01.000\n${"x".repeat(8_193)}\n`,
    ],
  ])("rejects %s instead of treating it as a cue", (_label, source) => {
    expect(() => countWebVttCues(source)).toThrow(/Invalid WebVTT/);
  });
});
