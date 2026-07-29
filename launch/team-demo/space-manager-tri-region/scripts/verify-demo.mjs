#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { countWebVttCues } from "./webvtt.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const generated = join(root, "generated");
const qa = join(generated, "qa");
const video = join(root, "krater-pro-space-manager-tri-region-demo.mp4");
const ffmpeg = process.env.FFMPEG_BIN;

if (!ffmpeg || !existsSync(ffmpeg)) {
  throw new Error("Set FFMPEG_BIN to a working ffmpeg executable.");
}
if (!existsSync(video)) throw new Error("Render the demo before running verification.");
mkdirSync(qa, { recursive: true });

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspect(path) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", path], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "warning", ...args], {
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed with ${result.status}`);
}

const streams = inspect(video);
const durationMatch = streams.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
if (!durationMatch) throw new Error("Could not inspect video duration.");
const duration =
  Number(durationMatch[1]) * 3600 +
  Number(durationMatch[2]) * 60 +
  Number(durationMatch[3]);

const streamChecks = {
  h264: /Video:\s*h264/.test(streams),
  fullHd: /1920x1080/.test(streams),
  aac: /Audio:\s*aac/.test(streams),
  fortyEightKhz: /48000 Hz/.test(streams),
  subtitles: /Subtitle:\s*mov_text/.test(streams)
};
if (Object.values(streamChecks).some(value => !value)) {
  throw new Error(`Unexpected media streams: ${JSON.stringify(streamChecks)}`);
}

const sampleCount = 12;
const framePaths = [];
for (let index = 0; index < sampleCount; index += 1) {
  const seconds = ((index + 0.5) / sampleCount) * duration;
  const frame = join(qa, `frame-${String(index + 1).padStart(2, "0")}.png`);
  run(["-y", "-ss", seconds.toFixed(3), "-i", video, "-frames:v", "1", frame]);
  framePaths.push({ path: frame, seconds });
}

const cellWidth = 450;
const cellHeight = 253;
const gap = 18;
const margin = 33;
const contactWidth = 4 * cellWidth + 3 * gap + 2 * margin;
const contactHeight = 3 * (cellHeight + 42) + 2 * gap + 2 * margin;
const composites = [];
for (let index = 0; index < framePaths.length; index += 1) {
  const column = index % 4;
  const row = Math.floor(index / 4);
  const left = margin + column * (cellWidth + gap);
  const top = margin + row * (cellHeight + 42 + gap);
  const image = await sharp(framePaths[index].path)
    .resize(cellWidth, cellHeight, { fit: "cover" })
    .png()
    .toBuffer();
  composites.push({ input: image, left, top });
  composites.push({
    input: Buffer.from(`
      <svg width="${cellWidth}" height="42" xmlns="http://www.w3.org/2000/svg">
        <rect width="${cellWidth}" height="42" fill="#0d1d2d"/>
        <text x="14" y="28" fill="#cbd8e0" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="18" font-weight="650">QA ${String(index + 1).padStart(2, "0")} · ${framePaths[index].seconds.toFixed(1)}s</text>
      </svg>`),
    left,
    top: top + cellHeight
  });
}

const contactSheet = join(qa, "contact-sheet.png");
await sharp({
  create: {
    width: contactWidth,
    height: contactHeight,
    channels: 4,
    background: "#07111f"
  }
})
  .composite(composites)
  .png()
  .toFile(contactSheet);

const captionExtraction = join(qa, "embedded-captions.vtt");
run(["-y", "-i", video, "-map", "0:s:0", captionExtraction]);
const extractedCaptions = readFileSync(captionExtraction, "utf8");
const cueCount = countWebVttCues(extractedCaptions);
if (cueCount !== 12) throw new Error(`Expected 12 subtitle cues; found ${cueCount}.`);

const textFiles = [
  "README.md",
  "storyboard.json",
  "storyboard.md",
  "transcript.md",
  "captions.vtt",
  "evidence-manifest.json",
  "generated/render-receipt.json",
  "scripts/render-demo.mjs",
  "scripts/verify-demo.mjs",
  "scripts/webvtt.mjs"
];
const combinedText = textFiles
  .map(path => readFileSync(join(root, path), "utf8"))
  .join("\n");
const privacyChecks = {
  noEmailAddress: !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(combinedText),
  noAbsoluteUserPath: !/\/Users\/[^/\s]+/i.test(combinedText),
  noBearerValue: !/\bBearer\s+[A-Za-z0-9._~-]{12,}/i.test(combinedText),
  noCookieAssignment: !/\b(?:cookie|set-cookie)\s*[:=]\s*[^\s]/i.test(combinedText),
  noRawPrivateFrame: readdirSync(join(root, "frames")).every(name => !name.endsWith("-private.png"))
};

const receipt = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  artifact: {
    path: "krater-pro-space-manager-tri-region-demo.mp4",
    sha256: checksum(video),
    bytes: statSync(video).size,
    durationSeconds: duration
  },
  streamChecks,
  timelineQa: {
    samples: sampleCount,
    contactSheet: "generated/qa/contact-sheet.png",
    contactSheetSha256: checksum(contactSheet)
  },
  subtitleChecks: {
    embeddedFormat: "mov_text",
    extractedCueCount: cueCount,
    extractedPath: "generated/qa/embedded-captions.vtt",
    extractedSha256: checksum(captionExtraction)
  },
  privacyChecks,
  privateInputsPresentInRepository: !privacyChecks.noRawPrivateFrame
};

if (Object.values(privacyChecks).some(value => !value)) {
  writeFileSync(join(qa, "qa-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  throw new Error(`Privacy QA failed: ${JSON.stringify(privacyChecks)}`);
}

writeFileSync(join(qa, "qa-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
