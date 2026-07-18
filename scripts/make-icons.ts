/**
 * App icon generator — rasterizes the real STOCK IMAGEIQ "iq" monogram
 * (assets/mark-iq.svg, duo-color) into build/icon.png, build/icon.icns
 * (via macOS iconutil) and build/icon.ico (hand-assembled PNG-based ICO).
 *
 *  - macOS: monogram centered on a white rounded square with ~12% outer
 *    margin (current macOS icon convention).
 *  - Windows: same art, full-bleed white square, slightly less margin.
 *
 *   npm run build && node dist/scripts/make-icons.js
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';

const ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const MARK_SVG = path.join(ROOT, 'assets', 'mark-iq.svg');

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 } as const;

async function markPng(height: number): Promise<Buffer> {
  return sharp(await fs.readFile(MARK_SVG))
    .resize({ height: Math.max(4, height) })
    .png()
    .toBuffer();
}

function roundedSquareSvg(canvas: number, square: number, radius: number): string {
  const offset = (canvas - square) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">` +
    `<rect x="${offset}" y="${offset}" width="${square}" height="${square}" rx="${radius}" fill="rgb(255,255,255)"/>` +
    `</svg>`
  );
}

/** macOS style: white rounded square, ~12% margin, monogram ~72% of square. */
async function macIcon(size: number): Promise<Buffer> {
  const margin = Math.round(size * 0.12);
  const square = size - 2 * margin;
  const radius = Math.round(square * 0.225);
  const mark = await markPng(Math.round(square * 0.72));
  return sharp(Buffer.from(roundedSquareSvg(size, square, radius)))
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();
}

/** Windows style: full-bleed white square, monogram ~80% of the canvas. */
async function winIcon(size: number): Promise<Buffer> {
  const mark = await markPng(Math.round(size * 0.8));
  return sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();
}

/** ICO container with PNG-encoded images (valid since Vista). */
async function makeIco(sizes: number[], dest: string): Promise<void> {
  const images = await Promise.all(sizes.map((size) => winIcon(size)));
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

  await fs.writeFile(path.join(BUILD_DIR, 'icon.png'), await macIcon(1024));

  // .icns via macOS iconutil (only runs on macOS; icns is committed so CI
  // and other platforms never need to regenerate it)
  const iconset = path.join(ROOT, 'icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    await fs.writeFile(path.join(iconset, `icon_${base}x${base}.png`), await macIcon(base));
    await fs.writeFile(path.join(iconset, `icon_${base}x${base}@2x.png`), await macIcon(base * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD_DIR, 'icon.icns')]);
  await fs.rm(iconset, { recursive: true, force: true });

  await makeIco([16, 24, 32, 48, 64, 128, 256], path.join(BUILD_DIR, 'icon.ico'));

  console.log('brand icons written to build/');
}

void main();
