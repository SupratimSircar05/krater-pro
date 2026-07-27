import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const sourcePath = join(
  repositoryRoot,
  "web",
  "src",
  "assets",
  "krater-pro-mark.svg",
);
const outputDirectory = join(repositoryRoot, "desktop", "assets");
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function icnsEntry(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

function createIcns(pngBySize) {
  const entries = [
    icnsEntry("ic11", pngBySize.get(32)),
    icnsEntry("ic12", pngBySize.get(64)),
    icnsEntry("ic07", pngBySize.get(128)),
    icnsEntry("ic08", pngBySize.get(256)),
    icnsEntry("ic13", pngBySize.get(256)),
    icnsEntry("ic09", pngBySize.get(512)),
    icnsEntry("ic14", pngBySize.get(512)),
    icnsEntry("ic10", pngBySize.get(1024)),
  ];
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(
    entries.reduce((total, entry) => total + entry.length, 8),
    4,
  );
  return Buffer.concat([header, ...entries]);
}

function createIco(pngBySize) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);

  let offset = directory.length;
  const images = sizes.map((size, index) => {
    const image = pngBySize.get(size);
    const entryOffset = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset);
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += image.length;
    return image;
  });

  return Buffer.concat([directory, ...images]);
}

export async function generateDesktopIcons() {
  const source = await readFile(sourcePath);
  await mkdir(outputDirectory, { recursive: true });
  const pngBySize = new Map();
  for (const size of pngSizes) {
    const png = await sharp(source, { density: 1200 })
      .resize(size, size)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    pngBySize.set(size, png);
    await writeFile(join(outputDirectory, `icon-${size}.png`), png);
  }

  await writeFile(join(outputDirectory, "icon.png"), pngBySize.get(1024));
  await writeFile(join(outputDirectory, "icon.icns"), createIcns(pngBySize));
  await writeFile(join(outputDirectory, "icon.ico"), createIco(pngBySize));
  await writeFile(join(outputDirectory, "icon.svg"), source);
}

await generateDesktopIcons();
