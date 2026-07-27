import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const socialDirectory = path.join(repositoryRoot, "assets", "social");
const backgroundPath = path.join(
  socialDirectory,
  "krater-pro-social-preview-background.png",
);
const logoPath = path.join(
  repositoryRoot,
  "web",
  "src",
  "assets",
  "krater-pro-mark.svg",
);
const outputPath = path.join(
  socialDirectory,
  "krater-pro-social-preview.png",
);

const [logo] = await Promise.all([
  sharp(await readFile(logoPath)).resize(92, 92).png().toBuffer(),
]);

const typography = Buffer.from(`
  <svg width="1280" height="640" viewBox="0 0 1280 640" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="veil" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#090b0e" stop-opacity=".98"/>
        <stop offset=".48" stop-color="#090b0e" stop-opacity=".86"/>
        <stop offset=".72" stop-color="#090b0e" stop-opacity=".24"/>
        <stop offset="1" stop-color="#090b0e" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
        <stop stop-color="#ffb083"/>
        <stop offset="1" stop-color="#e66d3d" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="1280" height="640" fill="url(#veil)"/>
    <rect x="64" y="64" width="1152" height="512" rx="28" fill="none" stroke="#ffb083" stroke-opacity=".16"/>
    <text x="184" y="132" fill="#f8fafc" font-size="57" font-weight="750"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing="-1.8">Krater Pro</text>
    <text x="80" y="261" fill="#ffffff" font-size="50" font-weight="690"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing="-1.4">Agentic coding at</text>
    <text x="80" y="321" fill="#ffae7d" font-size="50" font-weight="690"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing="-1.4">escape velocity.</text>
    <rect x="80" y="363" width="465" height="2" fill="url(#rule)"/>
    <text x="80" y="413" fill="#d9dee7" font-size="23" font-weight="520"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing=".3">CLI  ·  Agentic IDE  ·  Smart model routing</text>
    <text x="80" y="454" fill="#9da5b4" font-size="20" font-weight="460"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing=".2">Powered by Krater.ai</text>
    <text x="80" y="535" fill="#c7cdd8" font-size="18" font-weight="500"
      font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
      letter-spacing=".4">Built by Supratim with <tspan fill="#ff8a65">♥</tspan></text>
  </svg>
`);

await sharp(backgroundPath)
  .resize(1280, 640, { fit: "cover", position: "center" })
  .composite([
    { input: typography, left: 0, top: 0 },
    { input: logo, left: 80, top: 79 },
  ])
  .png({ compressionLevel: 9, palette: true, quality: 100 })
  .toFile(outputPath);

const metadata = await sharp(outputPath).metadata();
if (metadata.width !== 1280 || metadata.height !== 640) {
  throw new Error(
    `Unexpected social preview dimensions: ${metadata.width}x${metadata.height}`,
  );
}

console.log(`Created ${path.relative(repositoryRoot, outputPath)} (1280x640)`);
