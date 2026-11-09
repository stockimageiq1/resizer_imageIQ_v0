import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  appendExifDatesToTiff,
  type CaptureDates,
  hasDates,
  readExifBufferDates,
  readTiffFileDates,
} from './exifDates';

const execFileAsync = promisify(execFile);
const SIPS_TIMEOUT_MS = 120_000;

// Originals change between runs (an edited folder, "Overwrite"): libvips' file
// cache would serve the previous picture for a path it has already seen.
sharp.cache(false);

/** The long side the server, the browser upload and the Mac app all work at. */
export const MAX_IMAGE_DIMENSION = 1280;
/** As the Mac app's proxy: above the server's q85, so its re-encode starts from clean pixels. */
export const DEFAULT_JPEG_QUALITY = 92;

export interface ImageOptions {
  /** Longest side in px; never upscales. Default MAX_IMAGE_DIMENSION. */
  maxDimension?: number;
  /** JPEG and WebP quality. Default DEFAULT_JPEG_QUALITY. */
  quality?: number;
}

type OutputFormat = 'jpeg' | 'png' | 'tiff' | 'webp';

/** A copy is encoded in the format its name says: the server refuses a name that does not match the bytes (415). */
const FORMAT_BY_EXTENSION: Readonly<Record<string, OutputFormat>> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.tiff': 'tiff',
  '.tif': 'tiff',
  '.webp': 'webp',
};

/** The web app does not take HEIC/HEIF, so their copies are JPEGs named .jpg. */
export function isHeifName(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '.heic' || ext === '.heif';
}

/** Where a copy goes, relative to the output root: the original's own path, except HEIC/HEIF. */
export function outputRelPath(relPath: string): string {
  return isHeifName(relPath) ? `${relPath.slice(0, -path.posix.extname(relPath).length)}.jpg` : relPath;
}

/**
 * True when this sharp build can decode HEIC/HEIF files at all (libheif
 * present). Note: prebuilt sharp binaries lack the patent-encumbered HEVC
 * decoder (real iPhone files); see hevcToTiff. Elsewhere those fail at decode
 * time and fall back to copy-unprocessed in the engine.
 */
export function heicSupported(): boolean {
  return sharp.format.heif?.input?.file === true;
}

/** macOS decodes HEVC itself; a lossless temporary TIFF carries the pixels (and orientation tag) to sharp. */
async function hevcToTiff(src: string, temporary: string): Promise<void> {
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'tiff', src, '--out', temporary], { timeout: SIPS_TIMEOUT_MS });
}

/** sips exits 0 on a damaged HEIC and writes a black picture; a copy like that must not count as processed. */
function allBlack(pixels: Buffer, channels: number): boolean {
  const colour = Math.min(channels, 3);
  for (let i = 0; i < pixels.length; i += 1) {
    if (i % channels < colour && pixels[i] !== 0) return false;
  }
  return true;
}

async function datesOf(src: string, meta: sharp.Metadata): Promise<CaptureDates> {
  if (meta.format === 'tiff') return readTiffFileDates(src);
  return meta.exif === undefined ? {} : readExifBufferDates(meta.exif);
}

/**
 * Downscale to max `maxDimension` px on the longest side (never upscale),
 * apply EXIF orientation to the pixels, keep the capture-date fields and
 * strip every other piece of metadata, and encode in the format `dest` names.
 *
 * The copy keeps the original's name and format (HEIC/HEIF: see outputRelPath)
 * — downstream CSV matching is keyed by exact file name, and the server checks
 * that a file's bytes match its extension.
 */
export async function processImage(src: string, dest: string, options?: ImageOptions): Promise<void> {
  const maxDimension = options?.maxDimension ?? MAX_IMAGE_DIMENSION;
  const quality = options?.quality ?? DEFAULT_JPEG_QUALITY;
  const format = FORMAT_BY_EXTENSION[path.extname(dest).toLowerCase()];
  if (format === undefined) throw new Error(`no output format for ${path.basename(dest)}`);

  // libheif's default limits refuse a real iPhone photo (a grid of 48 tiles).
  const open: sharp.SharpOptions = isHeifName(src) ? { unlimited: true } : {};
  const meta = await sharp(src, open).metadata();
  const dates = await datesOf(src, meta);
  const viaSystem = meta.format === 'heif' && meta.compression === 'hevc' && process.platform === 'darwin';
  // Short and in the same folder: a name built on the file's own would overflow on a long one.
  const temporary = path.join(path.dirname(dest), `.iq-${randomUUID()}.tiff`);

  try {
    if (viaSystem) await hevcToTiff(src, temporary);
    const decoded = viaSystem ? await sharp(temporary).metadata() : meta;
    const resized = sharp(viaSystem ? temporary : src, viaSystem ? {} : open)
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
    const flattened = format === 'jpeg' ? resized.flatten({ background: '#ffffff' }) : resized;
    // Rendered to bare 8-bit sRGB pixels first, so nothing else the source carries
    // reaches the encoder: withExif alone lets the EXIF thumbnail through. A source
    // with a profile needs it applied for 16-bit input to keep its colours; on one
    // without a profile the same call shifts them.
    const { data, info } = await (decoded.icc === undefined ? flattened : flattened.withIccProfile('srgb'))
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    if (viaSystem && allBlack(data, info.channels)) throw new Error('macOS could not decode this HEIC');

    let pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    // TIFF: libvips writes no EXIF into it, the dates are added after the encode.
    if (hasDates(dates) && format !== 'tiff') pipeline = pipeline.withExif({ IFD2: { ...dates } });
    await encode(pipeline, format, quality).toFile(dest);
  } finally {
    if (viaSystem) await fs.rm(temporary, { force: true });
  }

  // A lost date must not cost the photographer the copy (the fallback would be the full-size, GPS-carrying original).
  if (format === 'tiff') await appendExifDatesToTiff(dest, dates).catch(() => undefined);
}

function encode(pipeline: sharp.Sharp, format: OutputFormat, quality: number): sharp.Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
    case 'png':
      return pipeline.png({ compressionLevel: 6 });
    case 'tiff':
      return pipeline.tiff({ compression: 'deflate' }); // smaller than LZW; a 1280 px deflate original must not grow
    case 'webp':
      return pipeline.webp({ quality });
  }
}
