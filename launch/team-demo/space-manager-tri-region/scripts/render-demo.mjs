#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const framesDirectory = join(root, "frames");
const generatedDirectory = join(root, "generated");
const sanitizedDirectory = join(generatedDirectory, "sanitized");
const slidesDirectory = join(generatedDirectory, "slides");
const audioDirectory = join(generatedDirectory, "audio");
const segmentsDirectory = join(generatedDirectory, "segments");
const qaDirectory = join(generatedDirectory, "qa");
const sourceRoot = "/tmp/krater-space-source.iziwQL";
const storyboard = JSON.parse(readFileSync(join(root, "storyboard.json"), "utf8"));
const ffmpeg = process.env.FFMPEG_BIN;

if (!ffmpeg || !existsSync(ffmpeg)) {
  throw new Error("Set FFMPEG_BIN to a working ffmpeg executable.");
}

for (const directory of [
  generatedDirectory,
  sanitizedDirectory,
  slidesDirectory,
  audioDirectory,
  segmentsDirectory,
  qaDirectory
]) {
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

const privateInputs = [
  "01-us-space-manager-live-private.png",
  "02-eu-space-manager-live-private.png",
  "03-sg-space-manager-live-private.png",
  "04-us-incident-overview-private.png",
  "05-us-incident-space-manager-private.png",
  "06-us-incident-selection-result-private.png",
  "07-krater-corrected-diagnosis-private.png"
];

const expectedHashes = {
  "us-space-manager.js": "b726586a0dbc73fa4b5ea916e6c8ef4c53e584afa78673eabd69a5b1229f4c44",
  "eu-space-manager.js": "b726586a0dbc73fa4b5ea916e6c8ef4c53e584afa78673eabd69a5b1229f4c44",
  "sg-space-manager.js": "b726586a0dbc73fa4b5ea916e6c8ef4c53e584afa78673eabd69a5b1229f4c44",
  "us-app-lh2.js": "131f7fa61540b9bd57b0f8a9dd2440e21f6d1e62fbeb5a5eef9dde2c65529423",
  "eu-app-lh2.js": "131f7fa61540b9bd57b0f8a9dd2440e21f6d1e62fbeb5a5eef9dde2c65529423",
  "sg-app-lh2.js": "131f7fa61540b9bd57b0f8a9dd2440e21f6d1e62fbeb5a5eef9dde2c65529423",
  "us-space-manager.js.map": "8461bc57c8be028cad1c4b1be79988a1d0af9417c09537b8e11738aff0b0a31d",
  "us-app-lh2.js.map": "b1c8821f0655e6a128c5d25f0fa157d3c58f809620947fbf2eb58f3448ea35c2"
};

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isoModified(path) {
  return statSync(path).mtime.toISOString();
}

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
    if (!line) line = word;
    else if (`${line} ${word}`.length <= maximumCharacters) line += ` ${word}`;
    else {
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
    family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${lines
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

function baseSvg(scene, content) {
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
          <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <circle cx="1740" cy="50" r="370" fill="${COLORS.cyan}" opacity="0.045"/>
      <circle cx="250" cy="1050" r="300" fill="${COLORS.blue}" opacity="0.04"/>
      ${brandMark()}
      <text x="1825" y="102" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" text-anchor="end">SPACE MANAGER · TRI-REGION EVIDENCE</text>
      ${content}
      <rect x="0" y="940" width="${WIDTH}" height="140" fill="#050b13" opacity="0.96"/>
      <rect x="90" y="970" width="5" height="64" rx="2" fill="url(#accent)"/>
      ${textLines(wrap(scene.caption, 95), 126, 999, 29, 37, { fill: COLORS.caption, weight: 600 })}
      <text x="1830" y="1031" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" text-anchor="end">EDITED · SANITIZED · READ-ONLY</text>
    </svg>`);
}

function sceneHeading(scene, headlineSize = 56) {
  return `
    <text x="96" y="205" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="800" letter-spacing="3">${escapeXml(scene.eyebrow)}</text>
    ${textLines(wrap(scene.headline, 54), 96, 286, headlineSize, headlineSize + 10, { weight: 760 })}
    ${textLines(wrap(scene.detail, 102), 100, 360, 25, 36, { fill: COLORS.muted, weight: 500 })}`;
}

function parseSource(mapName, suffix) {
  const map = JSON.parse(readFileSync(join(sourceRoot, mapName), "utf8"));
  const index = map.sources.findIndex(source => source.endsWith(suffix));
  if (index < 0 || !map.sourcesContent?.[index]) {
    throw new Error(`Missing ${suffix} from ${mapName}`);
  }
  return {
    source: map.sources[index],
    lines: map.sourcesContent[index].split(/\r?\n/)
  };
}

function assertLine(source, number, expected) {
  const actual = source.lines[number - 1]?.trim();
  if (actual !== expected) {
    throw new Error(`Source drift at ${source.source}:${number}; expected ${expected}; got ${actual}`);
  }
}

function validateEvidence() {
  for (const input of privateInputs) {
    if (!existsSync(join(framesDirectory, input))) throw new Error(`Missing private input: ${input}`);
  }
  for (const [name, expected] of Object.entries(expectedHashes)) {
    const path = join(sourceRoot, name);
    if (!existsSync(path)) throw new Error(`Missing verified source artifact: ${name}`);
    const actual = checksum(path);
    if (actual !== expected) throw new Error(`Digest mismatch for ${name}: ${actual}`);
  }

  const lhBase = parseSource("us-app-lh2.js.map", "src/components/lh-base/lh-base.jsx");
  const middleware = parseSource("us-space-manager.js.map", "src/redux/middleware/space-manager-socket.ts");
  const appSlice = parseSource("us-space-manager.js.map", "src/redux/reducers/app/appSlice.ts");
  assertLine(lhBase, 416, "dispatch(updateLocationWrap(fullTreeData[0]));");
  assertLine(lhBase, 837, "if (e.value === null || e.value === undefined) {");
  assertLine(lhBase, 843, "singleLocationSelection(e);");
  assertLine(lhBase, 1089, 'node?.access !== "Read"');
  assertLine(lhBase, 1101, "return props.callback(node) && canSelectByLocationAccess(node);");
  assertLine(middleware, 39, "if (isLocationWrapAction && (payload === null || payload === undefined)) {");
  assertLine(middleware, 50, "return undefined;");
  assertLine(appSlice, 4, "selectedLocation: null,");
  assertLine(appSlice, 5, "selectedFloorLocation: null,");
  assertLine(appSlice, 6, "selectedFloor: null,");

  const monitor = JSON.parse(readFileSync(join(sourceRoot, "space-manager-overview.json"), "utf8"));
  const run = monitor.latest_run;
  if (
    run?.run_id !== "20260728T085201Z_US_a5ecc05c83" ||
    run?.run_mode !== "FULL" ||
    run?.section_summary?.passed !== 0 ||
    run?.section_summary?.total !== 5 ||
    monitor?.trends?.run_count !== 30 ||
    monitor?.trends?.availability_percent !== 0
  ) {
    throw new Error("Sanitized monitoring facts no longer match the captured run.");
  }
  const sections = Object.fromEntries(run.sections.map(section => [section.key, section]));
  const expectedRequests = {
    overview: [6, 6],
    devices: [6, 6],
    manage_rooms: [3, 3],
    manage_desks: [4, 4],
    user_management: [1, 1]
  };
  for (const [key, [total, successful]] of Object.entries(expectedRequests)) {
    if (
      sections[key]?.requests?.total !== total ||
      sections[key]?.requests?.successful !== successful
    ) {
      throw new Error(`Unexpected request summary for ${key}`);
    }
  }
  if (sections.devices.websocket.handshake_status !== 101 || sections.devices.websocket.frames_received !== 18) {
    throw new Error("Unexpected Devices WebSocket evidence.");
  }
  const exact = sections.user_management.comparisons?.[0];
  if (!exact?.match || exact.api !== 327 || exact.ui !== 327) {
    throw new Error("Unexpected User Management exact parity evidence.");
  }
  return { lhBase, middleware, appSlice, monitor, run, sections };
}

function identityPatch(width, height, label) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#29466f"/>
      <text x="${width - 18}" y="24" text-anchor="end" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="750">${escapeXml(label)}</text>
      <text x="${width - 18}" y="43" text-anchor="end" fill="#dce8f5" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">identity and account details redacted</text>
    </svg>`);
}

async function sanitizeInputs() {
  const regional = [
    ["01-us-space-manager-live-private.png", "01-us-validation.png", "US · READ-ONLY"],
    ["02-eu-space-manager-live-private.png", "02-eu-validation.png", "EU · READ-ONLY"],
    ["03-sg-space-manager-live-private.png", "03-sg-validation.png", "SG · READ-ONLY"]
  ];
  for (const [input, output, label] of regional) {
    await sharp(join(framesDirectory, input))
      .composite([{ input: identityPatch(330, 56, label), left: 950, top: 0 }])
      .png()
      .toFile(join(sanitizedDirectory, output));
  }

  const runtime = [
    ["05-us-incident-space-manager-private.png", "04-us-before-selection.png"],
    ["06-us-incident-selection-result-private.png", "05-us-after-selection.png"]
  ];
  for (const [input, output] of runtime) {
    await sharp(join(framesDirectory, input))
      .composite([{ input: identityPatch(194, 57, "US · IDENTITY REDACTED"), left: 249, top: 0 }])
      .png()
      .toFile(join(sanitizedDirectory, output));
  }

  const kraterInput = join(framesDirectory, "07-krater-corrected-diagnosis-private.png");
  await sharp(kraterInput)
    .extract({ left: 1435, top: 810, width: 760, height: 98 })
    .png()
    .toFile(join(sanitizedDirectory, "06-krater-epistemic-label.png"));
}

async function renderTitle(scene, output) {
  const content = `
    <text x="96" y="250" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="800" letter-spacing="4">${escapeXml(scene.eyebrow)}</text>
    ${textLines(scene.headline.split("\n"), 96, 400, 88, 100, { weight: 780 })}
    ${textLines(wrap(scene.detail, 63), 100, 666, 34, 48, { fill: COLORS.muted, weight: 500 })}
    <g transform="translate(1390,318)">
      <circle cx="170" cy="170" r="164" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="3"/>
      <path d="M62 190 L128 124 L186 181 L286 78" fill="none" stroke="${COLORS.cyan}" stroke-width="21" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="286" cy="78" r="14" fill="${COLORS.green}"/>
    </g>
    <rect x="98" y="798" width="760" height="72" rx="36" fill="${COLORS.panel2}" stroke="${COLORS.border}" stroke-width="2"/>
    <circle cx="140" cy="834" r="10" fill="${COLORS.green}"/>
    <text x="170" y="844" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="650">Runtime · telemetry · hashes · source maps</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderTriRegion(scene, output) {
  const labels = ["US", "EU", "SG"];
  const files = ["01-us-validation.png", "02-eu-validation.png", "03-sg-validation.png"];
  const composites = [];
  let panels = "";
  for (let index = 0; index < files.length; index += 1) {
    const left = 94 + index * 606;
    const image = await sharp(join(sanitizedDirectory, files[index]))
      .extract({ left: 248, top: 58, width: 1010, height: 535 })
      .resize(546, 289, { fit: "fill" })
      .png()
      .toBuffer();
    panels += `
      <g transform="translate(${left},470)">
        <rect width="546" height="350" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="3"/>
        <rect x="18" y="18" width="70" height="36" rx="18" fill="${COLORS.cyan}" opacity="0.2"/>
        <text x="53" y="44" fill="${COLORS.cyan}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="850">${labels[index]}</text>
        <rect x="12" y="72" width="522" height="266" rx="12" fill="none" stroke="${COLORS.amber}" stroke-width="4"/>
      </g>`;
    composites.push({ input: image, left: left, top: 542 });
  }
  const content = `${sceneHeading(scene, 52)}${panels}`;
  await sharp(baseSvg(scene, content)).composite(composites).png().toFile(output);
}

function evidenceCard(x, y, width, height, label, headline, detail, color) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="28" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <rect x="0" y="0" width="9" height="${height}" rx="4" fill="${color}"/>
      <text x="40" y="58" fill="${color}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="800" letter-spacing="2">${escapeXml(label)}</text>
      ${textLines(wrap(headline, Math.floor(width / 14)), 40, 128, 34, 42, { weight: 730 })}
      ${textLines(wrap(detail, Math.floor(width / 11)), 40, 236, 23, 33, { fill: COLORS.muted, weight: 520 })}
    </g>`;
}

async function renderSeparation(scene, output) {
  const content = `
    ${sceneHeading(scene)}
    ${evidenceCard(96, 455, 800, 370, "OBSERVED · REGIONAL VALIDATION", "Rich Map unavailable; choose a location.", "This is a configuration or permitted-location outcome in three validation environments.", COLORS.amber)}
    ${evidenceCard(1024, 455, 800, 370, "OBSERVED · US INCIDENT ENVIRONMENT", "BGL 17 is visible but selection does not commit.", "This is a runtime state mismatch in a separate environment. It has its own evidence chain.", COLORS.red)}
    <path d="M920 640 H1000" stroke="${COLORS.muted}" stroke-width="4" stroke-dasharray="12 12"/>
    <circle cx="960" cy="640" r="28" fill="${COLORS.panel2}" stroke="${COLORS.amber}" stroke-width="3"/>
    <text x="960" y="650" text-anchor="middle" fill="${COLORS.amber}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="850">≠</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderRuntime(scene, output) {
  const before = await sharp(join(sanitizedDirectory, "04-us-before-selection.png"))
    .extract({ left: 0, top: 52, width: 443, height: 540 })
    .resize(443, 540)
    .png()
    .toBuffer();
  const after = await sharp(join(sanitizedDirectory, "05-us-after-selection.png"))
    .extract({ left: 0, top: 52, width: 443, height: 540 })
    .resize(443, 540)
    .png()
    .toBuffer();
  const content = `
    ${sceneHeading(scene, 52)}
    <g transform="translate(740,390)">
      <rect x="-16" y="-16" width="475" height="572" rx="26" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="3"/>
      <rect x="132" y="80" width="185" height="90" rx="16" fill="none" stroke="${COLORS.amber}" stroke-width="6"/>
    </g>
    <g transform="translate(1280,390)">
      <rect x="-16" y="-16" width="475" height="572" rx="26" fill="${COLORS.panel}" stroke="${COLORS.red}" stroke-width="4"/>
      <rect x="132" y="80" width="185" height="90" rx="16" fill="none" stroke="${COLORS.red}" stroke-width="6"/>
    </g>
    ${evidenceCard(96, 505, 520, 330, "OBSERVED TWICE", "Selection event visible; committed state unchanged.", "The target exists in the hierarchy, but the selector and header retain the prior building.", COLORS.red)}`;
  await sharp(baseSvg(scene, content))
    .composite([
      { input: before, left: 740, top: 390 },
      { input: after, left: 1280, top: 390 },
      {
        input: Buffer.from(`
          <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
            <rect x="758" y="408" width="188" height="42" rx="21" fill="${COLORS.cyan}"/>
            <text x="852" y="437" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="850">BEFORE · BGL 15</text>
            <rect x="902" y="482" width="128" height="82" rx="12" fill="none" stroke="${COLORS.amber}" stroke-width="6"/>
            <rect x="1298" y="408" width="292" height="42" rx="21" fill="${COLORS.red}"/>
            <text x="1444" y="437" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="850">AFTER BGL 17 ATTEMPT · STILL 15</text>
            <rect x="1442" y="482" width="128" height="82" rx="12" fill="none" stroke="${COLORS.red}" stroke-width="6"/>
          </svg>`)
      }
    ])
    .png()
    .toFile(output);
}

async function renderMonitor(scene, output) {
  const rows = [
    ["Overview", "6 / 6", "location_selection_mismatch"],
    ["Devices", "6 / 6", "location_state_null · WS 101 · 18 frames"],
    ["Manage Rooms", "3 / 3", "location_state_null"],
    ["Manage Desks", "4 / 4", "location_state_null"],
    ["User Management", "1 / 1", "location_state_null · API/UI 327 = 327"]
  ];
  const content = `
    ${sceneHeading(scene, 50)}
    <g transform="translate(96,445)">
      <rect width="390" height="370" rx="28" fill="${COLORS.panel}" stroke="${COLORS.red}" stroke-width="3"/>
      <text x="36" y="58" fill="${COLORS.red}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="800" letter-spacing="2">LATEST FULL RUN</text>
      <text x="36" y="166" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="84" font-weight="850">0 / 5</text>
      <text x="36" y="210" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25">sections passing</text>
      <text x="36" y="294" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="62" font-weight="820">0%</text>
      <text x="36" y="338" fill="${COLORS.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23">30-run availability</text>
    </g>
    <g transform="translate(550,445)">
      <rect width="1274" height="370" rx="28" fill="${COLORS.panel2}" stroke="${COLORS.border}" stroke-width="2"/>
      <text x="34" y="54" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="800" letter-spacing="2">SECTION</text>
      <text x="370" y="54" fill="${COLORS.green}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="800" letter-spacing="2">REQUESTS</text>
      <text x="590" y="54" fill="${COLORS.amber}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="800" letter-spacing="2">OBSERVED RESULT</text>
      ${rows.map(([name, requests, result], index) => {
        const y = 105 + index * 53;
        return `
          <line x1="30" y1="${y + 24}" x2="1244" y2="${y + 24}" stroke="${COLORS.border}" stroke-width="1"/>
          <text x="34" y="${y}" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="23" font-weight="650">${escapeXml(name)}</text>
          <text x="370" y="${y}" fill="${COLORS.green}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="750">${escapeXml(requests)}</text>
          <text x="590" y="${y}" fill="${COLORS.caption}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20">${escapeXml(result)}</text>`;
      }).join("")}
    </g>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderHashes(scene, output) {
  const sm = expectedHashes["us-space-manager.js"];
  const lh = expectedHashes["us-app-lh2.js"];
  const hashCard = (y, label, hash) => `
    <g transform="translate(96,${y})">
      <rect width="1728" height="176" rx="28" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
      <circle cx="55" cy="52" r="13" fill="${COLORS.green}"/>
      <text x="85" y="61" fill="${COLORS.green}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="800" letter-spacing="2">${escapeXml(label)}</text>
      <text x="85" y="116" fill="${COLORS.text}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="27" font-weight="650">${hash.slice(0, 32)}</text>
      <text x="85" y="151" fill="${COLORS.text}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="27" font-weight="650">${hash.slice(32)}</text>
      ${["US", "EU", "SG"].map((region, index) => `
        <rect x="${1190 + index * 150}" y="57" width="118" height="62" rx="31" fill="${COLORS.panel2}" stroke="${COLORS.cyan}" stroke-width="2"/>
        <text x="${1249 + index * 150}" y="96" text-anchor="middle" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="850">${region} ✓</text>`).join("")}
    </g>`;
  const content = `
    ${sceneHeading(scene, 52)}
    ${hashCard(465, "SPACE MANAGER BUNDLE · SHA-256", sm)}
    ${hashCard(675, "SHARED LOCATION-HIERARCHY BUNDLE · SHA-256", lh)}`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

function codeCard(x, y, width, height, label, lines, color) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="24" fill="#08121d" stroke="${color}" stroke-width="2"/>
      <rect width="${width}" height="54" rx="24" fill="${COLORS.panel2}"/>
      <rect y="30" width="${width}" height="24" fill="${COLORS.panel2}"/>
      <text x="25" y="36" fill="${color}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="18" font-weight="800" letter-spacing="1">${escapeXml(label)}</text>
      ${lines.map(([number, code], index) => `
        <text x="22" y="${92 + index * 34}" fill="${COLORS.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19">${escapeXml(String(number))}</text>
        <text x="78" y="${92 + index * 34}" fill="${COLORS.text}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19">${escapeXml(code)}</text>`).join("")}
    </g>`;
}

async function renderSourceLh(scene, output) {
  const content = `
    ${sceneHeading(scene, 51)}
    ${codeCard(96, 445, 535, 340, "FIRST-NODE DISPATCH · lh-base.jsx", [
      [412, "useEffect(() => {"],
      [416, "dispatch(updateLocationWrap("],
      ["", "  fullTreeData[0]));"],
      [417, "}, [fullTreeData]);"]
    ], COLORS.amber)}
    ${codeCard(692, 445, 535, 340, "NULL DESELECTION GUARD · lh-base.jsx", [
      [834, "const callbackCheckAndSelect ="],
      ["", "  (e) => {"],
      [837, "if (e.value === null ||"],
      ["", "    e.value === undefined) {"],
      [838, "  return;"],
      [843, "singleLocationSelection(e);"]
    ], COLORS.cyan)}
    ${codeCard(1288, 445, 536, 340, "ACCESS GATE · lh-base.jsx", [
      [1082, "const canSelectByLocationAccess ="],
      ["", "  (node) => {"],
      [1089, "node?.access !== \"Read\""],
      [1101, "return props.callback(node) &&"],
      ["", "  canSelectByLocationAccess(node);"]
    ], COLORS.red)}
    <text x="96" y="858" fill="${COLORS.amber}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="650">Verified behavior, not a causal verdict. Elisions remove unrelated source.</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderSourceSm(scene, output) {
  const content = `
    ${sceneHeading(scene, 51)}
    ${codeCard(96, 455, 820, 340, "MIDDLEWARE · space-manager-socket.ts", [
      [37, "const isLocationWrapAction ="],
      ["", "  type === \"locationWrap/updateLocationWrap\";"],
      [39, "if (isLocationWrapAction &&"],
      ["", "  (payload === null || payload === undefined)) {"],
      [45, "console.warn(\"Skipping ... nullish payload\");"],
      [50, "return undefined;"]
    ], COLORS.amber)}
    ${codeCard(1004, 455, 820, 340, "INITIAL STATE · appSlice.ts", [
      [2, "const initialState = {"],
      [4, "selectedLocation: null,"],
      [5, "selectedFloorLocation: null,"],
      [6, "selectedFloor: null,"],
      [7, "forceReload: false"]
    ], COLORS.cyan)}
    <text x="96" y="858" fill="${COLORS.caption}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="650">Source-map path verified against captured production bundle digest.</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderLadder(scene, output) {
  const items = [
    ["OBSERVED", "BGL 17 selection leaves BGL 15 committed.", COLORS.green],
    ["OBSERVED", "All requests succeed; WS and exact API/UI path work.", COLORS.green],
    ["SOURCE-PROVED", "Dispatch, access gate, null-skip, and initial-null paths exist.", COLORS.cyan],
    ["INFERRED", "Shared client selection/state propagation is the best fit.", COLORS.amber],
    ["NOT ESTABLISHED", "The exact causal state transition or source symbol.", COLORS.red]
  ];
  const content = `
    ${sceneHeading(scene, 52)}
    <g transform="translate(96,455)">
      <line x1="62" y1="50" x2="62" y2="365" stroke="${COLORS.border}" stroke-width="8" stroke-linecap="round"/>
      ${items.map(([label, statement, color], index) => {
        const y = 40 + index * 78;
        return `
          <circle cx="62" cy="${y}" r="22" fill="${color}" opacity="0.2"/>
          <circle cx="62" cy="${y}" r="9" fill="${color}"/>
          <rect x="112" y="${y - 31}" width="1610" height="62" rx="22" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
          <text x="144" y="${y + 8}" fill="${color}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="850" letter-spacing="1">${escapeXml(label)}</text>
          <text x="400" y="${y + 8}" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="620">${escapeXml(statement)}</text>`;
      }).join("")}
    </g>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderKrater(scene, output) {
  const crop = await sharp(join(sanitizedDirectory, "06-krater-epistemic-label.png"))
    .resize(1460, 240, { fit: "fill" })
    .png()
    .toBuffer();
  const content = `
    ${sceneHeading(scene, 50)}
    <g transform="translate(230,455)">
      <rect x="-20" y="-20" width="1500" height="280" rx="28" fill="${COLORS.panel}" stroke="${COLORS.cyan}" stroke-width="3" filter="url(#shadow)"/>
      <rect x="20" y="18" width="300" height="43" rx="21" fill="${COLORS.cyan}"/>
      <text x="170" y="47" text-anchor="middle" fill="#07111f" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="19" font-weight="850">AUTHENTIC RESULT EXCERPT</text>
    </g>
    <text x="230" y="790" fill="${COLORS.green}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="650">Only the epistemic-label sentence is retained; all workspace chrome and paths are excluded.</text>`;
  await sharp(baseSvg(scene, content))
    .composite([{ input: crop, left: 230, top: 455 }])
    .png()
    .toFile(output);
}

async function renderProof(scene, output) {
  const checks = [
    ["1", "Select target", "Requested building and floor become visible in selector and header."],
    ["2", "Propagate state", "All five sections and nested views receive non-null location state."],
    ["3", "Preserve parity", "Exact API/UI comparison remains 327 = 327 or its current equivalent."],
    ["4", "Replay fully", "A full monitor run passes without retry-masked false greens."],
    ["5", "Sustain", "Availability moves off the 30-run 0% baseline and remains healthy."]
  ];
  const content = `
    ${sceneHeading(scene, 50)}
    ${checks.map(([number, title, detail], index) => {
      const x = 96 + index * 350;
      return `
        <g transform="translate(${x},470)">
          <rect width="316" height="345" rx="28" fill="${COLORS.panel}" stroke="${index === 4 ? COLORS.green : COLORS.border}" stroke-width="${index === 4 ? 3 : 2}"/>
          <circle cx="52" cy="55" r="27" fill="${index === 4 ? COLORS.green : COLORS.cyan}" opacity="0.2"/>
          <text x="52" y="64" text-anchor="middle" fill="${index === 4 ? COLORS.green : COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="850">${number}</text>
          <text x="30" y="135" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="30" font-weight="750">${escapeXml(title)}</text>
          ${textLines(wrap(detail, 23), 30, 193, 21, 31, { fill: COLORS.muted, weight: 520 })}
        </g>`;
    }).join("")}`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderResult(scene, output) {
  const content = `
    <text x="960" y="270" fill="${COLORS.cyan}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="800" letter-spacing="4" text-anchor="middle">${escapeXml(scene.eyebrow)}</text>
    ${textLines(scene.headline.split("\n"), 960, 430, 84, 98, { weight: 780, anchor: "middle" })}
    ${textLines(wrap(scene.detail, 70), 960, 680, 32, 46, { fill: COLORS.muted, weight: 500, anchor: "middle" })}
    <rect x="530" y="800" width="860" height="72" rx="36" fill="${COLORS.panel2}" stroke="${COLORS.cyan}" stroke-width="2"/>
    <circle cx="585" cy="836" r="11" fill="${COLORS.green}"/>
    <text x="618" y="847" fill="${COLORS.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="25" font-weight="650">Evidence first · confidence proportional to proof</text>`;
  await sharp(baseSvg(scene, content)).png().toFile(output);
}

async function renderSlides() {
  await sanitizeInputs();
  for (const scene of storyboard.scenes) {
    const output = join(slidesDirectory, `${scene.id}.png`);
    if (scene.kind === "title") await renderTitle(scene, output);
    else if (scene.kind === "tri-region") await renderTriRegion(scene, output);
    else if (scene.kind === "separation") await renderSeparation(scene, output);
    else if (scene.kind === "runtime") await renderRuntime(scene, output);
    else if (scene.kind === "monitor") await renderMonitor(scene, output);
    else if (scene.kind === "hashes") await renderHashes(scene, output);
    else if (scene.kind === "source-lh") await renderSourceLh(scene, output);
    else if (scene.kind === "source-sm") await renderSourceSm(scene, output);
    else if (scene.kind === "ladder") await renderLadder(scene, output);
    else if (scene.kind === "krater") await renderKrater(scene, output);
    else if (scene.kind === "proof") await renderProof(scene, output);
    else if (scene.kind === "result") await renderResult(scene, output);
    else throw new Error(`Unsupported scene kind: ${scene.kind}`);
  }
}

function run(command, args, capture = false) {
  const finalArgs = command === ffmpeg ? ["-hide_banner", "-loglevel", "warning", ...args] : args;
  const result = spawnSync(command, finalArgs, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
    "> Edited, narrated, credential-free team demo. No production mutation was performed.",
    ""
  ];
  const storyboardMarkdown = [
    "# Storyboard",
    "",
    `**Format:** ${storyboard.format}`,
    "",
    "| Scene | Evidence purpose | Minimum |",
    "|---|---|---:|"
  ];
  let elapsed = 0;

  for (const scene of storyboard.scenes) {
    const audio = join(audioDirectory, `${scene.id}.aiff`);
    run("/usr/bin/say", [
      "-v",
      process.env.KRATER_DEMO_VOICE || "Samantha",
      "-r",
      process.env.KRATER_DEMO_RATE || "184",
      "-o",
      audio,
      scene.narration
    ]);
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
      `[0:v]zoompan=z='min(zoom+0.00008,1.022)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30,format=yuv420p[v];[1:a]apad=pad_dur=2[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-t", duration.toFixed(3),
      "-c:v", "libx264",
      "-preset", "veryfast",
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
    storyboardMarkdown.push(
      `| ${scene.id} | ${scene.headline.replaceAll("\n", " ")} | ${scene.minimumSeconds}s |`
    );
    elapsed += duration;
  }

  const concatFile = join(generatedDirectory, "segments.txt");
  writeFileSync(
    concatFile,
    `${segments.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join("\n")}\n`
  );
  const captionFile = join(root, "captions.vtt");
  const transcriptFile = join(root, "transcript.md");
  writeFileSync(captionFile, `${captions.join("\n")}\n`);
  writeFileSync(transcriptFile, `${transcript.join("\n")}\n`);
  writeFileSync(join(root, "storyboard.md"), `${storyboardMarkdown.join("\n")}\n`);

  const baseVideo = join(generatedDirectory, "base-video.mp4");
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
    baseVideo
  ]);

  const finalVideo = join(root, "krater-pro-space-manager-tri-region-demo.mp4");
  run(ffmpeg, [
    "-y",
    "-i", baseVideo,
    "-i", captionFile,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-map", "1:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-c:s", "mov_text",
    "-metadata:s:s:0", "language=eng",
    "-metadata:s:s:0", "title=English captions",
    "-metadata", "title=Krater Pro tri-region Space Manager evidence",
    "-metadata", "comment=Edited, sanitized, read-only team demo; not a continuous raw recording.",
    "-movflags", "+faststart",
    finalVideo
  ]);

  return { finalVideo, duration: elapsed, captionFile, transcriptFile };
}

function buildManifest(media, evidence) {
  const sanitizedSources = [
    ["CAP-US-VALIDATION", "generated/sanitized/01-us-validation.png", "https://dnaspaces.io/space-manager/overview", "2026-07-28T09:02:05.744Z"],
    ["CAP-EU-VALIDATION", "generated/sanitized/02-eu-validation.png", "https://dnaspaces.eu/space-manager/overview", "2026-07-28T09:03:57.901Z"],
    ["CAP-SG-VALIDATION", "generated/sanitized/03-sg-validation.png", "https://ciscospaces.sg/space-manager/overview", "2026-07-28T09:05:30.163Z"],
    ["CAP-US-BEFORE", "generated/sanitized/04-us-before-selection.png", "https://dnaspaces.io/space-manager/overview", "2026-07-28T09:14:09.161Z"],
    ["CAP-US-AFTER", "generated/sanitized/05-us-after-selection.png", "https://dnaspaces.io/space-manager/overview", "2026-07-28T09:15:03.231Z"],
    ["CAP-KRATER-EPISTEMIC", "generated/sanitized/06-krater-epistemic-label.png", "local://krater-pro/task-result", "2026-07-28T09:19:59.401Z"]
  ].map(([id, path, url, capturedAt]) => ({
    id,
    path,
    url,
    capturedAt,
    sha256: checksum(join(root, path)),
    identityRedacted: true
  }));

  const bundleSources = Object.entries(expectedHashes).map(([name, sha256]) => ({
    name,
    sha256,
    capturedAt: isoModified(join(sourceRoot, name)),
    sourceMappingReference:
      name.endsWith(".js")
        ? readFileSync(join(sourceRoot, name), "utf8").match(/sourceMappingURL=([^\s]+)/)?.[1] || null
        : null
  }));

  const manifest = {
    schemaVersion: 1,
    demo: {
      title: storyboard.title,
      format: storyboard.format,
      continuousRawRecording: false,
      capturedOn: "2026-07-28",
      scope: "Read-only tri-region Space Manager diagnosis; no production mutation"
    },
    sources: {
      captures: sanitizedSources,
      monitor: {
        url: "http://52.45.105.208:8088/api/space-manager/overview",
        retrievedAt: evidence.monitor.generated_at,
        runId: evidence.run.run_id,
        runMode: evidence.run.run_mode,
        sanitizedFieldsUsed: [
          "section_summary",
          "section request totals",
          "failure classes",
          "Devices WebSocket status and frame count",
          "User Management exact API/UI comparison",
          "30-run availability"
        ],
        excludedFields: [
          "customer",
          "tenant_id",
          "email delivery configuration",
          "raw console findings",
          "raw authorization state"
        ],
        sourcePayloadIncluded: false
      },
      productionArtifacts: {
        pageOrigins: [
          "https://dnaspaces.io/",
          "https://dnaspaces.eu/",
          "https://ciscospaces.sg/"
        ],
        bundles: bundleSources,
        sourceMapEvidence: {
          statement: "Captured production bundles publish relative sourceMappingURL directives; the referenced public map files were retrieved during the read-only capture.",
          sourcePathsUsed: [
            "webpack://spaces-dash-app-lh2/./src/components/lh-base/lh-base.jsx",
            "webpack://spaces-dash-app-space-manager/./src/redux/middleware/space-manager-socket.ts",
            "webpack://spaces-dash-app-space-manager/./src/redux/reducers/app/appSlice.ts"
          ],
          excerptPolicy: "Only the minimum lines needed to establish the described behavior are shown."
        }
      }
    },
    claims: [
      {
        id: "CLAIM-001",
        grade: "observed",
        statement: "The US, EU, and SG validation overviews displayed Please select a location; their initial captures also reported that permitted locations lacked a published Rich Map.",
        supports: ["CAP-US-VALIDATION", "CAP-EU-VALIDATION", "CAP-SG-VALIDATION"],
        caveat: "This establishes a regional validation configuration outcome, not the separate US incident-environment defect."
      },
      {
        id: "CLAIM-002",
        grade: "observed",
        statement: "In the US incident environment, Space Manager remained on BGL 15 and First Floor after two read-only attempts to select visible BGL 17.",
        supports: ["CAP-US-BEFORE", "CAP-US-AFTER"]
      },
      {
        id: "CLAIM-003",
        grade: "observed",
        statement: "The latest full monitoring run failed all five sections and the 30-run availability was 0%, while all section request totals succeeded, Devices received WebSocket HTTP 101 plus 18 frames, and User Management API/UI matched 327=327.",
        supports: [evidence.run.run_id],
        caveat: "This argues against a broad transport or authentication outage; it does not prove every backend dependency healthy."
      },
      {
        id: "CLAIM-004",
        grade: "tested",
        statement: "The captured Space Manager and shared location-hierarchy bundles were byte-identical across US, EU, and SG.",
        supports: [
          expectedHashes["us-space-manager.js"],
          expectedHashes["us-app-lh2.js"]
        ],
        caveat: "Byte-identical code does not imply identical data, access policy, feature flags, or configuration."
      },
      {
        id: "CLAIM-005",
        grade: "observed",
        statement: "Captured source maps prove that the location hierarchy dispatches fullTreeData[0], guards null deselection, and applies explicit access gating; Space Manager skips nullish locationWrap updates and initializes selected location/floor state to null.",
        supports: [
          "lh-base.jsx:416,834-848,1082-1102",
          "space-manager-socket.ts:37-50",
          "appSlice.ts:2-6"
        ]
      },
      {
        id: "CLAIM-006",
        grade: "inferred",
        confidence: "strong",
        statement: "A shared client location-selection/state-propagation boundary is the best-supported explanation; explicit access gating and empty-hierarchy handling are code-level suspects.",
        supports: ["CLAIM-002", "CLAIM-003", "CLAIM-004", "CLAIM-005"],
        alternativesNotExcluded: [
          "An access-policy or hierarchy-data interaction that leaves selection uncommitted",
          "A timing defect between hierarchy update and downstream state hydration",
          "A configuration-dependent empty hierarchy path"
        ]
      },
      {
        id: "CLAIM-007",
        grade: "not_established",
        statement: "The exact causal source transition is not established.",
        requiredNextEvidence: [
          "Instrument the hierarchy selection and shared-state commit boundary",
          "Apply one controlled intervention to the same deterministic snapshot",
          "Confirm the predicted intervention changes the visible selection and all downstream state",
          "Replay all five sections, nested views, exact API/UI parity, and sustained availability"
        ]
      }
    ],
    artifact: {
      path: "krater-pro-space-manager-tri-region-demo.mp4",
      sha256: checksum(media.finalVideo),
      bytes: statSync(media.finalVideo).size,
      durationSeconds: Number(media.duration.toFixed(3)),
      width: WIDTH,
      height: HEIGHT,
      framesPerSecond: 30,
      video: "H.264 High, yuv420p",
      audio: "AAC LC, 48 kHz mono",
      subtitles: "Embedded English mov_text track plus on-screen scene captions",
      metadataDisclosure: "Edited sanitized demo; not a continuous raw recording."
    },
    privacy: {
      credentialsIncluded: false,
      serviceEmailsIncluded: false,
      accountOrTenantIdentifiersIncluded: false,
      cookiesIncluded: false,
      authorizationHeadersIncluded: false,
      privateUserTableDataIncluded: false,
      absoluteUserPathsIncluded: false,
      identityRedacted: true,
      productionMutationPerformed: false
    }
  };
  writeFileSync(join(root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function buildReceipt(media, manifest) {
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    format: storyboard.format,
    output: {
      path: "krater-pro-space-manager-tri-region-demo.mp4",
      sha256: checksum(media.finalVideo),
      bytes: statSync(media.finalVideo).size,
      durationSeconds: Number(media.duration.toFixed(3)),
      width: WIDTH,
      height: HEIGHT,
      videoCodec: "H.264",
      audio: "AAC narration",
      subtitles: "English mov_text plus on-screen captions"
    },
    sanitizedInputs: manifest.sources.captures.map(source => ({
      path: source.path,
      sha256: source.sha256
    })),
    sourceArtifactDigests: expectedHashes,
    privacy: manifest.privacy
  };
  writeFileSync(join(generatedDirectory, "render-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function quarantinePrivateInputs() {
  if (process.env.KEEP_PRIVATE_INPUTS === "1") return null;
  const quarantine = `/tmp/krater-space-manager-private-${Date.now()}`;
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  for (const input of privateInputs) {
    const source = join(framesDirectory, input);
    if (existsSync(source)) renameSync(source, join(quarantine, input));
  }
  writeFileSync(
    join(quarantine, "README.txt"),
    "Private source captures moved out of the repository after sanitized rendering. Do not distribute.\n",
    { mode: 0o600 }
  );
  return quarantine;
}

const evidence = validateEvidence();
await renderSlides();
const media = buildMedia();
const manifest = buildManifest(media, evidence);
const receipt = buildReceipt(media, manifest);
const quarantine = quarantinePrivateInputs();
console.log(JSON.stringify({ receipt, privateInputsQuarantined: Boolean(quarantine) }, null, 2));
