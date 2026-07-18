/**
 * Placeholder icon generator (real branding comes later):
 * a minimal monochrome glyph — white down-arrow into a tray on a dark
 * rounded square. Produces build/icon.png, build/icon.icns (via macOS
 * iconutil), build/icon.ico (hand-assembled PNG-based ICO).
 *
 *   npm run build && node dist/scripts/make-icons.js
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';

const ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');

const GLYPH_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#1d2026"/>
  <g stroke="#f4f5f7" stroke-width="72" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M512 288 v300"/>
    <path d="M376 452 L512 596 L648 452"/>
    <path d="M312 700 h400"/>
  </g>
</svg>`;

async function png(size: number, dest: string): Promise<void> {
  await sharp(Buffer.from(GLYPH_SVG)).resize(size, size).png().toFile(dest);
}

/** ICO container with PNG-encoded images (valid since Vista). */
async function makeIco(sizes: number[], dest: string): Promise<void> {
  const images = await Promise.all(
    sizes.map((size) => sharp(Buffer.from(GLYPH_SVG)).resize(size, size).png().toBuffer()),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((size, i) => {
    const image = images[i];
    if (image === undefined) throw new Error('image buffer missing');
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    entries.push(entry);
  });
  await fs.writeFile(dest, Buffer.concat([header, ...entries, ...images]));
}

async function main(): Promise<void> {
  await fs.mkdir(BUILD_DIR, { recursive: true });

  await png(1024, path.join(BUILD_DIR, 'icon.png'));

  // .icns via macOS iconutil (only runs on macOS; icns is committed so CI
  // and other platforms never need to regenerate it)
  const iconset = path.join(ROOT, 'icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    await png(base, path.join(iconset, `icon_${base}x${base}.png`));
    await png(base * 2, path.join(iconset, `icon_${base}x${base}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD_DIR, 'icon.icns')]);
  await fs.rm(iconset, { recursive: true, force: true });

  await makeIco([16, 24, 32, 48, 64, 128, 256], path.join(BUILD_DIR, 'icon.ico'));

  console.log('icons written to build/');
}

void main();
