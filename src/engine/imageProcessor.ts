import sharp from 'sharp';

export const MAX_IMAGE_DIMENSION = 1024;
export const DEFAULT_JPEG_QUALITY = 80;

export interface ImageOptions {
  /** Longest side in px; never upscales. Default MAX_IMAGE_DIMENSION. */
  maxDimension?: number;
  /** JPEG quality. Default DEFAULT_JPEG_QUALITY. */
  quality?: number;
}

/**
 * True when this sharp build can decode HEIC/HEIF files at all (libheif
 * present). Note: prebuilt sharp binaries may still lack the patent-encumbered
 * HEVC decoder, in which case individual HEIC files fail at decode time and
 * fall back to copy-unprocessed in the engine.
 */
export function heicSupported(): boolean {
  return sharp.format.heif?.input?.file === true;
}

/**
 * Downscale to max `maxDimension` px on the longest side (never upscale),
 * apply EXIF orientation to the pixels, strip all metadata (sharp strips
 * EXIF/GPS/XMP unless explicitly asked to keep it), encode JPEG
 * progressive/mozjpeg.
 *
 * The output keeps the ORIGINAL file name and extension — downstream CSV
 * matching is keyed by exact file name, so a .png-named output contains JPEG
 * bytes by design.
 */
export async function processImage(src: string, dest: string, options?: ImageOptions): Promise<void> {
  const maxDimension = options?.maxDimension ?? MAX_IMAGE_DIMENSION;
  const quality = options?.quality ?? DEFAULT_JPEG_QUALITY;
  await sharp(src)
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toFile(dest);
}
