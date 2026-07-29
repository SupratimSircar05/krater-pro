const CUE_DELIMITER = " --> ";
const MAX_SOURCE_CHARACTERS = 1_000_000;
const MAX_LINE_CHARACTERS = 8_192;

function invalidWebVtt(message) {
  throw new Error(`Invalid WebVTT: ${message}`);
}

function isAsciiDigits(value) {
  if (!value) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function timestampMilliseconds(value) {
  const components = value.split(":");
  if (components.length !== 2 && components.length !== 3) {
    invalidWebVtt(`invalid cue timestamp "${value}"`);
  }

  const secondsComponent = components.at(-1);
  const secondParts = secondsComponent.split(".");
  if (
    secondParts.length !== 2 ||
    secondParts[0].length !== 2 ||
    secondParts[1].length !== 3 ||
    !isAsciiDigits(secondParts[0]) ||
    !isAsciiDigits(secondParts[1])
  ) {
    invalidWebVtt(`invalid cue timestamp "${value}"`);
  }

  const minuteComponent = components.at(-2);
  const hourComponent = components.length === 3 ? components[0] : "0";
  if (
    minuteComponent.length !== 2 ||
    (components.length === 3 && hourComponent.length < 2) ||
    !isAsciiDigits(minuteComponent) ||
    !isAsciiDigits(hourComponent)
  ) {
    invalidWebVtt(`invalid cue timestamp "${value}"`);
  }

  const hours = Number(hourComponent);
  const minutes = Number(minuteComponent);
  const seconds = Number(secondParts[0]);
  const milliseconds = Number(secondParts[1]);
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(milliseconds) ||
    minutes > 59 ||
    seconds > 59
  ) {
    invalidWebVtt(`out-of-range cue timestamp "${value}"`);
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function firstAsciiWhitespace(value) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === " " || character === "\t") return index;
  }
  return -1;
}

function parseTimingLine(line) {
  const delimiterIndex = line.indexOf(CUE_DELIMITER);
  if (
    delimiterIndex < 1 ||
    line.indexOf(CUE_DELIMITER, delimiterIndex + CUE_DELIMITER.length) !== -1
  ) {
    invalidWebVtt(`invalid cue timing line "${line}"`);
  }

  const start = line.slice(0, delimiterIndex);
  const endAndSettings = line.slice(delimiterIndex + CUE_DELIMITER.length);
  const settingsIndex = firstAsciiWhitespace(endAndSettings);
  const end =
    settingsIndex === -1
      ? endAndSettings
      : endAndSettings.slice(0, settingsIndex);
  const startMilliseconds = timestampMilliseconds(start);
  const endMilliseconds = timestampMilliseconds(end);
  if (endMilliseconds < startMilliseconds) {
    invalidWebVtt(`cue ends before it starts in "${line}"`);
  }

  return {
    startMilliseconds,
    endMilliseconds,
  };
}

function startsMetadataBlock(line, keyword) {
  return (
    line === keyword ||
    line.startsWith(`${keyword} `) ||
    line.startsWith(`${keyword}\t`)
  );
}

export function parseWebVttCues(source) {
  if (typeof source !== "string") {
    throw new TypeError("WebVTT source must be a string.");
  }
  if (source.length > MAX_SOURCE_CHARACTERS) {
    invalidWebVtt("source exceeds the bounded parser limit");
  }
  if (source.includes("\0")) invalidWebVtt("NUL bytes are not allowed");

  const withoutBom =
    source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = withoutBom
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  if (lines.some((line) => line.length > MAX_LINE_CHARACTERS)) {
    invalidWebVtt("a line exceeds the bounded parser limit");
  }
  const header = lines[0] ?? "";
  if (
    header !== "WEBVTT" &&
    !header.startsWith("WEBVTT ") &&
    !header.startsWith("WEBVTT\t")
  ) {
    invalidWebVtt("missing WEBVTT header");
  }
  if (header.includes(CUE_DELIMITER)) {
    invalidWebVtt("the WEBVTT header contains a cue delimiter");
  }

  let cursor = 1;
  while (cursor < lines.length && lines[cursor].trim() !== "") cursor += 1;
  if (cursor === lines.length) {
    invalidWebVtt("the header is not followed by a blank line");
  }

  const cues = [];
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
    if (cursor >= lines.length) break;

    const block = [];
    while (cursor < lines.length && lines[cursor].trim() !== "") {
      block.push(lines[cursor]);
      cursor += 1;
    }

    if (
      startsMetadataBlock(block[0], "NOTE") ||
      startsMetadataBlock(block[0], "STYLE") ||
      startsMetadataBlock(block[0], "REGION")
    ) {
      continue;
    }

    const timingIndex = block[0].includes(CUE_DELIMITER) ? 0 : 1;
    if (timingIndex === 1 && block.length < 2) {
      invalidWebVtt(`cue identifier "${block[0]}" has no timing line`);
    }
    if (block.length <= timingIndex + 1) {
      invalidWebVtt("a cue has no caption payload");
    }

    const timing = parseTimingLine(block[timingIndex]);
    cues.push({
      identifier: timingIndex === 1 ? block[0] : undefined,
      ...timing,
      text: block.slice(timingIndex + 1).join("\n"),
    });
  }
  return cues;
}

export function countWebVttCues(source) {
  return parseWebVttCues(source).length;
}
