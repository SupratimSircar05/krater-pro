#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const framesDirectory = join(root, "frames");
const generatedDirectory = join(root, "generated");
const slidesDirectory = join(generatedDirectory, "slides");
const audioDirectory = join(generatedDirectory, "audio");
const segmentsDirectory = join(generatedDirectory, "segments");
const storyboard = JSON.parse(readFileSync(join(root, "storyboard.json"), "utf8"));
const ffmpeg = process.env.FFMPEG_BIN;

if (!ffmpeg || !existsSync(ffmpeg)) {
  throw new Error("Set FFMPEG_BIN to a working ffmpeg executable.");
}

for (const directory of [generatedDirectory, slidesDirectory, audioDirectory, segmentsDirectory]) {
  mkdirSync(directory, { recursive: true });
}

const WIDTH = 1920;
const HEIGHT = 1080;
const COLORS = {
  background: "#07111f",
  panel: "#0d1d2d",
  panel2: "#10283a",
  border: "#21455c",
  cyan: "#46d9ff",
  blue: "#3a90ff",
  green: "#69df91",
  amber: "#ffc760",
  red: "#ff747d",
  text: "#f5f8fb",
  muted: "#a7bdca",
  caption: "#cbd8e0"
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value, maximumCharacters) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maximumCharacters) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textLines(lines, x, y, size, lineHeight, options = {}) {
  const {
    fill = COLORS.text,
    weight = 600,
    anchor = "start",
    opacity = 1,
    family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" opacity="${opacity}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("")}</text>`;
}

function brandMark() {
  return `
    <g transform="translate(94,73)">
      <circle cx="24" cy="24" r="24" fill="${COLORS.cyan}" opacity="0.14"/>
      <path d="M12 29 L20 21 L27 27 L39 14" fill="none" stroke="${COLORS.cyan}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="64" y="32" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="30" font-weight="750">KRATER PRO</text>
    </g>`;
}

function baseSvg(scene, content, caption = scene.caption) {
  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#07111f"/>
          <stop offset="0.62" stop-color="#081726"/>
          <stop offset="1" stop-color="#0b2435"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" x2="1">
          <stop offset="0" stop-color="${COLORS.cyan}"/>
          <stop offset="1" stop-color="${COLORS.blue}"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="20" stdDeviation="28" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <circle cx="1740" cy="50" r="370" fill="${COLORS.cyan}" opacity="0.045"/>
      <circle cx="250" cy="1050" r="300" fill="${COLORS.blue}" opacity="0.04"/>
      ${brandMark()}
      <text x="1825" y="102" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" text-anchor="end">SPACE MANAGER · TEAM DEMO</text>
      ${content}
      <rect x="0" y="940" width="${WIDTH}" height="140" fill="#050b13" opacity="0.96"/>
      <rect x="90" y="970" width="5" height="64" rx="2" fill="url(#accent)"/>
      ${textLines(wrap(caption, 96), 126, 1000, 30, 38, { fill: COLORS.caption, weight: 600 })}
      <text x="1830" y="1031" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" text-anchor="end">EDITED · SANITIZED · READ-ONLY</text>
    </svg>
  `);
}

async function renderTitle(scene, output) {
  const headline = scene.headline.split("\n");
  const content = `
    <text x="96" y="265" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="800" letter-spacing="4">${escapeXml(scene.eyebrow)}</text>
    ${textLines(headline, 96, 410, 92, 104, { weight: 780 })}
    ${textLines(wrap(scene.detail, 52), 100, 672, 38, 52, { fill: COLORS.muted, weight: 500 })}
    <g transform="translate(1370,330)">
      <circle cx="180" cy="180" r="170" fill="#0c2133" stroke="${COLORS.border}" stroke-width="3"/>
      <circle cx="180" cy="180" r="116" fill="${COLORS.cyan}" opacity="0.08"/>
      <path d="M76 192 L140 128 L191 179 L287 82" fill="none" stroke="url(#accent)" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="287" cy="82" r="14" fill="${COLORS.cyan}"/>
    </g>
    <rect x="98" y="795" width="690" height="74" rx="37" fill="#0f2a3e" stroke="${COLORS.border}" stroke-width="2"/>
    <circle cx="139" cy="832" r="10" fill="${COLORS.green}"/>
    <text x="168" y="843" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="650">Live incident evidence · 28 Jul 2026</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function sanitizedSymptom() {
  const input = join(framesDirectory, "03-live-space-manager-symptom.png");
  const output = join(generatedDirectory, "sanitized-live-space-manager-symptom.png");
  const headerPatch = Buffer.from(`
    <svg width="330" height="60" xmlns="http://www.w3.org/2000/svg">
      <rect width="330" height="60" fill="#29466f"/>
      <text x="312" y="25" text-anchor="end" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="700">AUTHORIZED READ-ONLY SESSION</text>
      <text x="312" y="44" text-anchor="end" fill="#dce8f5" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">identity redacted</text>
    </svg>`);
  await sharp(input)
    .composite([{ input: headerPatch, left: 950, top: 0 }])
    .png()
    .toFile(output);
  return output;
}

async function sanitizedMonitor() {
  const input = join(framesDirectory, "04-monitor-dashboard-evidence.png");
  const privacyPatch = Buffer.from(`
    <svg width="1265" height="712" xmlns="http://www.w3.org/2000/svg">
      <rect x="15" y="194" width="640" height="52" rx="8" fill="#1b3043"/>
      <text x="20" y="229" fill="#f5f8fb" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="33" font-weight="750">Space Manager · Target workspace</text>
      <rect x="1064" y="210" width="184" height="76" rx="12" fill="#18364b" stroke="#28566c" stroke-width="2"/>
      <text x="1156" y="239" text-anchor="middle" fill="#46d9ff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="800">US · TARGET REDACTED</text>
      <text x="1156" y="263" text-anchor="middle" fill="#f5f8fb" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" font-weight="700">LOCATION REDACTED</text>
      <rect x="684" y="431" width="246" height="27" rx="5" fill="#172d3f"/>
      <text x="807" y="450" text-anchor="middle" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="650">RUN ID REDACTED</text>
      <rect x="542" y="548" width="142" height="18" fill="#1b3244"/>
      <text x="548" y="561" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11">schema not evaluated</text>
      <rect x="542" y="607" width="142" height="18" fill="#1b3244"/>
      <text x="548" y="620" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11">schema not evaluated</text>
      <rect x="542" y="666" width="142" height="18" fill="#1b3244"/>
      <text x="548" y="679" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11">schema not evaluated</text>
      <rect x="1080" y="675" width="160" height="22" rx="4" fill="#172d3f"/>
      <text x="1230" y="691" text-anchor="end" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="650">LOCATION REDACTED</text>
    </svg>`);
  const sanitized = await sharp(input).composite([{ input: privacyPatch, left: 0, top: 0 }]).png().toBuffer();
  writeFileSync(input, sanitized);
  return input;
}

async function sanitizedKraterExcerpts() {
  const diagnosisOutput = join(framesDirectory, "05-krater-corrected-diagnosis.png");
  const remediationOutput = join(framesDirectory, "06-krater-corrected-remediation.png");
  const privateInput = process.env.KRATER_DEMO_PRIVATE_CAPTURE;
  if (!privateInput || !existsSync(privateInput)) {
    if (existsSync(diagnosisOutput) && existsSync(remediationOutput)) {
      return { diagnosis: diagnosisOutput, remediation: remediationOutput };
    }
    throw new Error("Provide KRATER_DEMO_PRIVATE_CAPTURE once to create the sanitized Krater result excerpts.");
  }

  const metadata = await sharp(privateInput).metadata();
  const width = metadata.width ?? 2232;
  const contentLeft = Math.max(0, width - 762);
  const paneLeft = Math.max(0, width - 797);
  const source = sharp(privateInput);
  const [rootHeading, factBlock, fixHeading, epistemicBlock, highStakes] = await Promise.all([
    source.clone().extract({ left: contentLeft, top: 48, width: 510, height: 20 }).png().toBuffer(),
    source.clone().extract({ left: contentLeft, top: 150, width: 755, height: 100 }).png().toBuffer(),
    source.clone().extract({ left: contentLeft, top: 525, width: 755, height: 55 }).png().toBuffer(),
    source.clone().extract({ left: contentLeft, top: 850, width: 755, height: 115 }).png().toBuffer(),
    source.clone().extract({ left: paneLeft, top: 983, width: 797, height: 38 }).png().toBuffer()
  ]);
  const safeLabel = Buffer.from(`
    <svg width="757" height="36" xmlns="http://www.w3.org/2000/svg">
      <rect width="757" height="36" rx="8" fill="#242628"/>
      <text x="18" y="24" fill="#a7bdca" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="700">CROPPED AUTHENTIC RESULT · PRIVATE PATH, PROJECT AND TARGET IDENTIFIERS EXCLUDED</text>
    </svg>`);
  const diagnosisCanvas = sharp({
    create: { width: 797, height: 500, channels: 4, background: "#1b1c1e" }
  });
  await diagnosisCanvas.composite([
    { input: safeLabel, left: 20, top: 18 },
    { input: await sharp(rootHeading).resize(720, 38, { fit: "fill" }).png().toBuffer(), left: 38, top: 92 },
    { input: await sharp(factBlock).resize(720, 168, { fit: "fill" }).png().toBuffer(), left: 38, top: 170 },
    { input: await sharp(highStakes).resize(757, 36, { fit: "fill" }).png().toBuffer(), left: 20, top: 442 }
  ]).png().toFile(diagnosisOutput);
  const remediationCanvas = sharp({
    create: { width: 797, height: 500, channels: 4, background: "#1b1c1e" }
  });
  await remediationCanvas.composite([
    { input: safeLabel, left: 20, top: 18 },
    { input: await sharp(fixHeading).resize(720, 90, { fit: "fill" }).png().toBuffer(), left: 38, top: 82 },
    { input: await sharp(epistemicBlock).resize(720, 190, { fit: "fill" }).png().toBuffer(), left: 38, top: 202 },
    { input: await sharp(highStakes).resize(757, 36, { fit: "fill" }).png().toBuffer(), left: 20, top: 442 }
  ]).png().toFile(remediationOutput);
  return { diagnosis: diagnosisOutput, remediation: remediationOutput };
}

async function renderScreenshotScene(scene, screenshot, output, options = {}) {
  const screenshotTop = options.screenshotTop ?? 294;
  const screenshotHeight = options.screenshotHeight ?? 585;
  const screenshotWidth = options.screenshotWidth ?? 1040;
  const screenshotLeft = options.screenshotLeft ?? 780;
  const metadata = await sharp(screenshot).metadata();
  const resized = await sharp(screenshot)
    .resize(screenshotWidth, screenshotHeight, { fit: "cover", position: options.position ?? "centre" })
    .png()
    .toBuffer();
  const content = `
    <text x="96" y="225" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    ${textLines(wrap(scene.headline, 17), 96, 330, 62, 72, { weight: 760 })}
    ${textLines(wrap(scene.detail, 34), 100, 530, 30, 43, { fill: COLORS.muted, weight: 500 })}
    <g transform="translate(100,735)">
      <rect width="565" height="145" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <circle cx="44" cy="46" r="12" fill="${options.noteColor ?? COLORS.amber}"/>
      ${textLines(wrap(options.note ?? "Evidence is scoped to what the capture establishes.", 39), 76, 55, 22, 31, { fill: COLORS.caption, weight: 580 })}
    </g>
    <rect x="${screenshotLeft - 14}" y="${screenshotTop - 14}" width="${screenshotWidth + 28}" height="${screenshotHeight + 28}" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="3" filter="url(#shadow)"/>
    <text x="${screenshotLeft}" y="${screenshotTop - 35}" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="18">${metadata.width} × ${metadata.height} live capture · sanitized for team sharing</text>`;
  await sharp(baseSvg(scene, content))
    .composite([
      { input: resized, left: screenshotLeft, top: screenshotTop },
      ...(options.overlay
        ? [{ input: Buffer.from(options.overlay), left: screenshotLeft, top: screenshotTop }]
        : [])
    ])
    .png()
    .toFile(output);
}

async function renderMonitorOverview(scene, screenshot, output) {
  const overlay = `
    <svg width="1120" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="255" width="220" height="104" rx="16" fill="none" stroke="${COLORS.red}" stroke-width="6"/>
      <rect x="20" y="263" width="194" height="36" rx="18" fill="${COLORS.red}"/>
      <text x="117" y="288" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17" font-weight="800">0 / 5 PASS</text>
      <rect x="660" y="255" width="222" height="104" rx="16" fill="none" stroke="${COLORS.green}" stroke-width="6"/>
      <rect x="672" y="263" width="198" height="36" rx="18" fill="${COLORS.green}"/>
      <text x="771" y="288" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17" font-weight="800">100% DISCOVERED</text>
    </svg>`;
  await renderScreenshotScene(scene, screenshot, output, {
    screenshotLeft: 720,
    screenshotWidth: 1120,
    screenshotHeight: 630,
    screenshotTop: 275,
    position: "north",
    note: "Failure spans every monitored section while discovery still covers the target location.",
    noteColor: COLORS.red,
    overlay
  });
}

async function renderPattern(scene, screenshot, output) {
  const crop = await sharp(screenshot)
    .extract({ left: 8, top: 286, width: 910, height: 420 })
    .resize(1670, 550, { fit: "fill" })
    .png()
    .toBuffer();
  const overlay = Buffer.from(`
    <svg width="1670" height="550" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="1670" height="550" rx="24" fill="none" stroke="${COLORS.border}" stroke-width="4"/>
      <rect x="18" y="145" width="575" height="344" rx="18" fill="none" stroke="${COLORS.red}" stroke-width="7"/>
      <rect x="610" y="145" width="1000" height="344" rx="18" fill="none" stroke="${COLORS.green}" stroke-width="7"/>
      <rect x="30" y="106" width="320" height="48" rx="24" fill="${COLORS.red}"/>
      <text x="190" y="138" text-anchor="middle" fill="#08111e" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="850">LOCATION-STATE FAILURES</text>
      <rect x="1030" y="106" width="550" height="48" rx="24" fill="${COLORS.green}"/>
      <text x="1305" y="138" text-anchor="middle" fill="#08111e" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="850">REQUESTS COMPLETE · WS 101 + 6 FRAMES</text>
    </svg>`);
  const content = `
    <text x="96" y="215" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    <text x="96" y="292" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="56" font-weight="760">${escapeXml(scene.headline)}</text>
    <text x="96" y="348" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="26" font-weight="500">${escapeXml(scene.detail)}</text>`;
  await sharp(baseSvg(scene, content))
    .composite([
      { input: crop, left: 125, top: 375 },
      { input: overlay, left: 125, top: 375 }
    ])
    .png()
    .toFile(output);
}

function card(x, y, width, height, label, headline, detail, color) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="26" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <rect x="0" y="0" width="8" height="${height}" rx="4" fill="${color}"/>
      <text x="36" y="52" fill="${color}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="800" letter-spacing="2">${escapeXml(label)}</text>
      ${textLines(wrap(headline, Math.max(25, Math.floor(width / 15))), 36, 108, 31, 38, { weight: 720 })}
      ${textLines(wrap(detail, Math.max(34, Math.floor(width / 12))), 36, 196, 21, 30, { fill: COLORS.muted, weight: 500 })}
    </g>`;
}

async function renderReasoning(scene, output) {
  const content = `
    <text x="96" y="215" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    <text x="96" y="300" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="60" font-weight="760">${escapeXml(scene.headline)}</text>
    ${card(96, 365, 520, 460, "OBSERVED", "Location state fails across five surfaces.", "Requests complete. Devices returns WebSocket HTTP 101, and one API/UI count agrees exactly.", COLORS.green)}
    ${card(700, 365, 520, 460, "INFERRED", scene.detail, "The common boundary explains the cross-section pattern better than five independent service failures.", COLORS.cyan)}
    ${card(1304, 365, 520, 460, "NOT YET PROVED", "Exact defective symbol or state transition.", "Instrument the shared location store and route hydration path before calling the cause confirmed.", COLORS.amber)}`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderAuthenticKraterScene(scene, screenshot, output, region) {
  const body = await sharp(screenshot)
    .resize(1100, 620, { fit: "fill" })
    .png()
    .toBuffer();
  const content = `
    <text x="96" y="215" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="800" letter-spacing="2.5">${escapeXml(scene.eyebrow)}</text>
    ${textLines(wrap(scene.headline, 18), 96, 315, 58, 70, { weight: 760 })}
    ${textLines(wrap(scene.detail, 34), 100, 515, 29, 42, { fill: COLORS.muted, weight: 500 })}
    <g transform="translate(100,735)">
      <rect width="520" height="145" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <circle cx="44" cy="46" r="12" fill="${COLORS.green}"/>
      ${textLines(["Authentic result excerpts.", "Private path, sidebar, project and", "target identifiers excluded by crop."], 76, 54, 22, 31, { fill: COLORS.caption, weight: 580 })}
    </g>
    <rect x="700" y="265" width="1140" height="655" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="3" filter="url(#shadow)"/>
    <rect x="720" y="220" width="240" height="42" rx="21" fill="${COLORS.green}"/>
    <text x="840" y="248" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="18" font-weight="850">AUTHENTIC KRATER UI</text>`;
  await sharp(baseSvg(scene, content))
    .composite([
      { input: body, left: 720, top: 282 }
    ])
    .png()
    .toFile(output);
}

async function renderWorkflow(scene, output) {
  const steps = [
    ["01", "Inspect", "Read monitor contract and repository facts"],
    ["02", "Correlate", "Join section, request, exact-count, and socket evidence"],
    ["03", "Rank", "Prefer the hypothesis that explains every surface"],
    ["04", "Abstain", "Do not edit production without source confirmation"],
    ["05", "Prove", "Replay the same five-section verification contract"]
  ];
  const stepWidth = 316;
  const startX = 96;
  const content = `
    <text x="96" y="215" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    <text x="96" y="300" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="56" font-weight="760">${escapeXml(scene.headline)}</text>
    ${steps.map(([number, title, detail], index) => {
      const x = startX + index * 354;
      return `
        <g transform="translate(${x},410)">
          <rect width="${stepWidth}" height="360" rx="28" fill="${index === 4 ? COLORS.panel2 : COLORS.panel}" stroke="${index === 4 ? COLORS.cyan : COLORS.border}" stroke-width="${index === 4 ? 3 : 2}"/>
          <circle cx="52" cy="55" r="27" fill="${index === 3 ? COLORS.amber : COLORS.cyan}" opacity="0.18"/>
          <text x="52" y="64" text-anchor="middle" fill="${index === 3 ? COLORS.amber : COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="800">${number}</text>
          <text x="30" y="138" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="34" font-weight="750">${title}</text>
          ${textLines(wrap(detail, 22), 30, 195, 23, 33, { fill: COLORS.muted, weight: 520 })}
        </g>
        ${index < steps.length - 1 ? `<path d="M${x + stepWidth + 8} 590 H${x + stepWidth + 32}" stroke="${COLORS.cyan}" stroke-width="5" stroke-linecap="round"/><path d="M${x + stepWidth + 24} 580 L${x + stepWidth + 36} 590 L${x + stepWidth + 24} 600" fill="none" stroke="${COLORS.cyan}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}`;
    }).join("")}`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderProof(scene, output) {
  const content = `
    <text x="96" y="215" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    <text x="96" y="300" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="56" font-weight="760">${escapeXml(scene.headline)}</text>
    <g transform="translate(96,375)">
      <rect width="520" height="430" rx="28" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <text x="40" y="62" fill="${COLORS.green}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="800" letter-spacing="2">BASELINE VERIFIED</text>
      <text x="40" y="150" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="66" font-weight="800">140 + 27</text>
      <text x="40" y="194" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24">monitor tests + subtests</text>
      <text x="40" y="286" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="58" font-weight="800">32 + 2</text>
      <text x="40" y="330" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24">dashboard tests + subtests</text>
      <text x="40" y="382" fill="${COLORS.green}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="650">Python 3.11 · compile · shell · bundle</text>
    </g>
    <g transform="translate(690,375)">
      <rect width="1134" height="430" rx="28" fill="${COLORS.panel2}" stroke="${COLORS.cyan}" stroke-width="3"/>
      <text x="44" y="62" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="800" letter-spacing="2">FIX ACCEPTANCE CONTRACT</text>
      ${[
        "Selected location survives section navigation.",
        "All five sections and nested views receive non-null location state.",
        "API and UI values match exactly where a count pair exists.",
        "Retries cannot turn a persistent null state into a false green.",
        "The incident closes only after the live monitor replays cleanly."
      ].map((line, index) => `
        <circle cx="60" cy="${130 + index * 58}" r="13" fill="${index < 4 ? COLORS.cyan : COLORS.green}" opacity="0.2"/>
        <path d="M53 ${130 + index * 58} l6 7 l13 -17" fill="none" stroke="${index < 4 ? COLORS.cyan : COLORS.green}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="94" y="${139 + index * 58}" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="600">${escapeXml(line)}</text>`).join("")}
    </g>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderResult(scene, output) {
  const headline = scene.headline.split("\n");
  const content = `
    <text x="960" y="280" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="800" letter-spacing="4" text-anchor="middle">${escapeXml(scene.eyebrow)}</text>
    ${textLines(headline, 960, 435, 88, 102, { weight: 780, anchor: "middle" })}
    ${textLines(wrap(scene.detail, 66), 960, 675, 34, 48, { fill: COLORS.muted, weight: 500, anchor: "middle" })}
    <rect x="565" y="790" width="790" height="76" rx="38" fill="${COLORS.panel2}" stroke="${COLORS.cyan}" stroke-width="2"/>
    <circle cx="620" cy="828" r="12" fill="${COLORS.green}"/>
    <text x="654" y="840" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="27" font-weight="650">Evidence first · confidence proportional to proof</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderSlides() {
  const symptom = await sanitizedSymptom();
  const monitor = await sanitizedMonitor();
  const kraterResult = await sanitizedKraterExcerpts();
  for (const scene of storyboard.scenes) {
    const output = join(slidesDirectory, `${scene.id}.png`);
    if (scene.kind === "title") await renderTitle(scene, output);
    else if (scene.kind === "symptom") {
      await renderScreenshotScene(scene, symptom, output, {
        screenshotLeft: 770,
        screenshotWidth: 1050,
        screenshotHeight: 590,
        screenshotTop: 292,
        position: "north",
        note: "This comparison image illustrates the symptom only; the targeted incident evidence comes next.",
        noteColor: COLORS.amber,
        overlay: `
          <svg width="1050" height="590" xmlns="http://www.w3.org/2000/svg">
            <rect x="212" y="104" width="822" height="118" rx="16" fill="none" stroke="${COLORS.amber}" stroke-width="7"/>
            <rect x="380" y="344" width="440" height="92" rx="16" fill="none" stroke="${COLORS.red}" stroke-width="7"/>
          </svg>`
      });
    } else if (scene.kind === "monitor") await renderMonitorOverview(scene, monitor, output);
    else if (scene.kind === "pattern") await renderPattern(scene, monitor, output);
    else if (scene.kind === "authenticDiagnosis") await renderAuthenticKraterScene(scene, kraterResult.diagnosis, output, "diagnosis");
    else if (scene.kind === "authenticFix") await renderAuthenticKraterScene(scene, kraterResult.remediation, output, "fix");
    else if (scene.kind === "reasoning") await renderReasoning(scene, output);
    else if (scene.kind === "workflow") await renderWorkflow(scene, output);
    else if (scene.kind === "proof") await renderProof(scene, output);
    else if (scene.kind === "result") await renderResult(scene, output);
    else throw new Error(`Unsupported scene kind: ${scene.kind}`);
  }
}

function run(command, args, options = {}) {
  const finalArgs = command === ffmpeg ? ["-hide_banner", "-loglevel", "warning", ...args] : args;
  const result = spawnSync(command, finalArgs, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || ""}`);
  }
  return result;
}

function durationOf(path) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", path], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read duration from ${path}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function vttTimestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function buildMedia() {
  const segments = [];
  const captions = ["WEBVTT", ""];
  const transcript = [
    "# Narration transcript",
    "",
    "> Edited, narrated, credential-free screen demo assembled from sanitized live captures.",
    ""
  ];
  let elapsed = 0;

  for (const scene of storyboard.scenes) {
    const audio = join(audioDirectory, `${scene.id}.aiff`);
    run("/usr/bin/say", ["-v", process.env.KRATER_DEMO_VOICE || "Samantha", "-r", process.env.KRATER_DEMO_RATE || "185", "-o", audio, scene.narration]);
    const audioSeconds = durationOf(audio);
    const duration = Math.max(scene.minimumSeconds, Math.ceil((audioSeconds + 0.8) * 10) / 10);
    const frames = Math.ceil(duration * 30);
    const slide = join(slidesDirectory, `${scene.id}.png`);
    const segment = join(segmentsDirectory, `${scene.id}.mp4`);

    run(ffmpeg, [
      "-y",
      "-i", slide,
      "-i", audio,
      "-filter_complex",
      `[0:v]zoompan=z='min(zoom+0.00010,1.025)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30,format=yuv420p[v];[1:a]apad=pad_dur=2[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-t", duration.toFixed(3),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-profile:v", "high",
      "-level", "4.1",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-movflags", "+faststart",
      segment
    ]);
    segments.push(segment);

    captions.push(
      `${vttTimestamp(elapsed)} --> ${vttTimestamp(elapsed + duration)}`,
      scene.caption,
      ""
    );
    transcript.push(
      `## ${scene.id} — ${scene.headline.replaceAll("\n", " ")}`,
      "",
      scene.narration,
      ""
    );
    elapsed += duration;
  }

  const concatList = segments.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join("\n");
  const concatFile = join(generatedDirectory, "segments.txt");
  const captionFile = join(root, "captions.vtt");
  const transcriptFile = join(root, "transcript.md");
  writeFileSync(concatFile, `${concatList}\n`);
  writeFileSync(captionFile, `${captions.join("\n")}\n`);
  writeFileSync(transcriptFile, `${transcript.join("\n")}\n`);

  const silentWithNarration = join(generatedDirectory, "krater-pro-space-manager-root-cause-base.mp4");
  run(ffmpeg, [
    "-y",
    "-fflags", "+genpts",
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-af", "aresample=async=1:first_pts=0",
    "-movflags", "+faststart",
    silentWithNarration
  ]);

  const finalVideo = join(root, "krater-pro-space-manager-root-cause-demo.mp4");
  run(ffmpeg, [
    "-y",
    "-i", silentWithNarration,
    "-i", captionFile,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-map", "1:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-c:s", "mov_text",
    "-metadata:s:s:0", "language=eng",
    "-metadata:s:s:0", "title=English captions",
    "-metadata", "title=Krater Pro Space Manager root-cause evidence demo",
    "-metadata", "comment=Edited sanitized demo assembled from live captures; not a continuous raw recording.",
    "-movflags", "+faststart",
    finalVideo
  ]);

  return { finalVideo, duration: elapsed, captionFile, transcriptFile };
}

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

await renderSlides();
const media = buildMedia();

const renderReceipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  format: storyboard.format,
  output: {
    path: "krater-pro-space-manager-root-cause-demo.mp4",
    sha256: checksum(media.finalVideo),
    durationSeconds: Number(media.duration.toFixed(3)),
    width: WIDTH,
    height: HEIGHT,
    videoCodec: "H.264",
    audio: "AAC narration",
    subtitles: "English mov_text track plus on-screen scene captions"
  },
  inputs: [
    "frames/03-live-space-manager-symptom.png",
    "frames/04-monitor-dashboard-evidence.png",
    "frames/05-krater-corrected-diagnosis.png",
    "frames/06-krater-corrected-remediation.png"
  ].map(path => ({ path, sha256: checksum(join(root, path)) })),
  privacy: {
    credentialsIncluded: false,
    cookiesIncluded: false,
    authorizationHeadersIncluded: false,
    sourceIdentityRedacted: true
  }
};
writeFileSync(join(generatedDirectory, "render-receipt.json"), `${JSON.stringify(renderReceipt, null, 2)}\n`);

console.log(JSON.stringify(renderReceipt, null, 2));
