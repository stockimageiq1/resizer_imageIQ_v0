import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { DEFAULT_JPEG_QUALITY, MAX_IMAGE_DIMENSION, runShrink } from '../src/engine';
import {
  appendExifDatesToTiff,
  type CaptureDates,
  readExifBufferDates,
  readTiffFileDates,
} from '../src/engine/exifDates';
import { DEFAULT_SETTINGS } from '../src/shared/ipc';

const DATES: Required<CaptureDates> = {
  DateTimeOriginal: '2026:05:09 14:03:22',
  DateTimeDigitized: '2026:05:09 14:03:23',
  OffsetTime: '+02:00',
  OffsetTimeOriginal: '+02:00',
  OffsetTimeDigitized: '+02:00',
};
const SENSITIVE = {
  IFD0: { Make: 'SintetikaCam', Model: 'ModelX1', Copyright: 'SkrivniAvtor' },
  IFD2: { ...DATES, UserComment: 'SkrivenKomentar' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/1 3/1 0/1' },
};
const MARKERS = ['SintetikaCam', 'ModelX1', 'SkrivniAvtor', 'SkrivenKomentar', 'SkrivniXmp'];
const XMP =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>SkrivniXmp</dc:title>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

const TAG_GPS_IFD = 0x8825;

/** Photo-like pixels (noise softened by a blur), so the file sizes mean something. */
function photo(width: number, height: number): sharp.Sharp {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 }, noise: { type: 'gaussian', mean: 120, sigma: 40 } },
  });
}

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return photo(width, height).blur(1.2).png({ compressionLevel: 1 }).toBuffer();
}

async function tiffWithDates(base: Buffer, dest: string): Promise<void> {
  await sharp(base).withXmp(XMP).tiff({ compression: 'none' }).toFile(dest);
  await appendExifDatesToTiff(dest, DATES);
}

/** The EXIF block of a non-TIFF output, or a TIFF file itself (which is one). */
async function exifBlock(file: string): Promise<Buffer | null> {
  const meta = await sharp(file).metadata();
  if (meta.format === 'tiff') return fs.readFile(file);
  return meta.exif ?? null;
}

async function datesOf(file: string): Promise<CaptureDates> {
  if ((await sharp(file).metadata()).format === 'tiff') return readTiffFileDates(file);
  const exif = (await sharp(file).metadata()).exif;
  return exif === undefined ? {} : readExifBufferDates(exif);
}

function ifd0Tags(block: Buffer): number[] {
  const tiff = block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block;
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const start = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  return Array.from({ length: u16(start) }, (_, i) => u16(start + 2 + i * 12));
}

test('copies keep the format of the original, the capture date and nothing else', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-format-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Shoot 2026');
  await fs.mkdir(inputDir, { recursive: true });
  const in_ = (name: string): string => path.join(inputDir, name);

  const base = await pngBuffer(3000, 2000);
  await sharp(base).withExif(SENSITIVE).withXmp(XMP).jpeg({ quality: 95 }).toFile(in_('photo-a.jpg'));
  await sharp(base).withExif(SENSITIVE).withXmp(XMP).jpeg({ quality: 95 }).toFile(in_('photo-b.jpeg'));
  await sharp(base).withExif(SENSITIVE).withXmp(XMP).png({ compressionLevel: 1 }).toFile(in_('photo-c.png'));
  await sharp(base).withExif(SENSITIVE).withXmp(XMP).png({ compressionLevel: 1 }).toFile(in_('PHOTO-UPPER.PNG'));
  await sharp(base).withExif(SENSITIVE).withXmp(XMP).webp({ quality: 95 }).toFile(in_('photo-e.webp'));
  await tiffWithDates(base, in_('photo-f.tiff'));
  await tiffWithDates(base, in_('photo-g.tif'));

  // never upscaled
  await sharp(await pngBuffer(400, 300)).png().toFile(in_('small.png'));
  await sharp(await pngBuffer(400, 300)).tiff({ compression: 'none' }).toFile(in_('small.tiff'));
  // already within the limit: LZW, as a photographer's export would be
  await sharp(await pngBuffer(1280, 853)).tiff({ compression: 'lzw' }).toFile(in_('exact-1280.tiff'));
  await sharp(await pngBuffer(1280, 853)).tiff({ compression: 'deflate' }).toFile(in_('exact-1280-deflate.tiff'));
  // the extension decides, not the bytes: a JPEG named .png comes out a real PNG
  await sharp(base).resize(800).jpeg().toFile(in_('mislabeled.png'));
  // orientation
  await sharp(await pngBuffer(600, 400))
    .withExif({ IFD0: { Orientation: '6' }, IFD2: DATES })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(in_('rotated.jpg'));
  await sharp(await pngBuffer(600, 400)).withMetadata({ orientation: 6 }).tiff({ compression: 'none' }).toFile(in_('rotated-t.tiff'));
  // no date in the original → no EXIF block at all in the copy
  await sharp(await pngBuffer(900, 600)).jpeg().toFile(in_('no-date.jpg'));

  const summary = await runShrink({ inputDir, outDir: path.join(scratch, 'out') });
  const out = (name: string): string => path.join(summary.outputPath, name);

  const CASES: [string, string][] = [
    ['photo-a.jpg', 'jpeg'],
    ['photo-b.jpeg', 'jpeg'],
    ['photo-c.png', 'png'],
    ['PHOTO-UPPER.PNG', 'png'],
    ['photo-e.webp', 'webp'],
    ['photo-f.tiff', 'tiff'],
    ['photo-g.tif', 'tiff'],
  ];

  for (const [name, format] of CASES) {
    await t.test(`${name}: ${format} bytes under the same name, 1280 px, date kept, the rest gone`, async () => {
      const meta = await sharp(out(name)).metadata();
      assert.equal(meta.format, format);
      assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 1280);
      assert.equal(meta.height, 853);
      assert.ok(meta.orientation === undefined || meta.orientation === 1);
      assert.deepEqual(await datesOf(out(name)), DATES);

      const block = await exifBlock(out(name));
      assert.ok(block !== null);
      assert.ok(!ifd0Tags(block).includes(TAG_GPS_IFD), 'no GPS block');
      const bytes = (await fs.readFile(out(name))).toString('latin1');
      for (const marker of MARKERS) assert.ok(!bytes.includes(marker), `${marker} must be gone`);
    });
  }

  await t.test('every output keeps its exact name; nothing is left over from the work', async () => {
    const names = (await fs.readdir(summary.outputPath)).sort();
    assert.deepEqual(names, (await fs.readdir(inputDir)).sort());
    assert.equal(summary.copiedUnprocessed.length, 0);
  });

  await t.test('never upscaled, in any format', async () => {
    for (const name of ['small.png', 'small.tiff']) {
      const meta = await sharp(out(name)).metadata();
      assert.equal(meta.width, 400);
      assert.equal(meta.height, 300);
    }
  });

  await t.test('the extension decides the format: a JPEG named .png comes out a real PNG', async () => {
    assert.equal((await sharp(out('mislabeled.png')).metadata()).format, 'png');
  });

  await t.test('rotated once only: pixels upright, Orientation reset, date kept', async () => {
    const jpeg = await sharp(out('rotated.jpg')).metadata();
    assert.equal(jpeg.width, 400);
    assert.equal(jpeg.height, 600);
    assert.ok(jpeg.orientation === undefined || jpeg.orientation === 1);
    assert.deepEqual(await datesOf(out('rotated.jpg')), DATES);
    const tiff = await sharp(out('rotated-t.tiff')).metadata();
    assert.equal(tiff.width, 400);
    assert.equal(tiff.height, 600);
    assert.ok(tiff.orientation === undefined || tiff.orientation === 1);
  });

  await t.test('an original without a date gets a copy without an EXIF block', async () => {
    assert.equal((await sharp(out('no-date.jpg')).metadata()).exif, undefined);
  });

  await t.test('a TIFF copy is not larger than its original', async () => {
    for (const name of ['photo-f.tiff', 'exact-1280.tiff', 'exact-1280-deflate.tiff', 'small.tiff']) {
      const [input, output] = await Promise.all([fs.stat(in_(name)), fs.stat(out(name))]);
      assert.ok(output.size <= input.size, `${name}: ${output.size} > ${input.size}`);
    }
  });
});

test('HEIC / HEIF: the web app does not take them, so the copy is a JPEG named .jpg', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-heic-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Phone');
  await fs.mkdir(inputDir, { recursive: true });
  const in_ = (name: string): string => path.join(inputDir, name);
  const heif = (): sharp.Sharp => sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 90, g: 120, b: 60 } } });

  await heif().withExif(SENSITIVE).heif({ compression: 'av1', quality: 60 }).toFile(in_('phone.heic'));
  await heif().withExif(SENSITIVE).heif({ compression: 'av1', quality: 60 }).toFile(in_('SECOND.HEIF'));
  await heif().heif({ compression: 'av1', quality: 60 }).toFile(in_('clash.heic'));
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(in_('CLASH.JPG'));
  await fs.writeFile(in_('broken.heic'), 'not actually a heic');

  const hevcPossible = process.platform === 'darwin';
  if (hevcPossible) {
    const source = in_('hevc-source.tmp.jpg');
    await sharp(await pngBuffer(1600, 1200)).withExif({ IFD0: { Make: 'SintetikaCam', Orientation: '6' }, IFD2: DATES, IFD3: SENSITIVE.IFD3 })
      .withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toFile(source);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', source, '--out', in_('iphone.heic')], { stdio: 'ignore' });
    await fs.rm(source);
  }

  const summary = await runShrink({ inputDir, outDir: path.join(scratch, 'out') });
  const out = (name: string): string => path.join(summary.outputPath, name);
  const names = await fs.readdir(summary.outputPath);

  await t.test('phone.heic → phone.jpg, JPEG bytes, 1280 px, date kept, the rest gone', async () => {
    const meta = await sharp(out('phone.jpg')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 1280);
    assert.deepEqual(await datesOf(out('phone.jpg')), DATES);
    assert.ok(!names.includes('phone.heic'));
    const bytes = (await fs.readFile(out('phone.jpg'))).toString('latin1');
    assert.ok(!bytes.includes('SintetikaCam'));
  });

  await t.test('upper-case .HEIF → .jpg', async () => {
    assert.equal((await sharp(out('SECOND.jpg')).metadata()).format, 'jpeg');
  });

  await t.test('a sibling that already owns the .jpg name wins (case-insensitive); the HEIC is copied and reported', async () => {
    assert.equal((await sharp(out('CLASH.JPG')).metadata()).width, 300);
    assert.ok(names.includes('clash.heic'));
    assert.ok(!names.includes('clash.jpg'));
    const reported = summary.copiedUnprocessed.find((c) => c.relPath === 'clash.heic');
    assert.ok(reported !== undefined && /already/.test(reported.reason), JSON.stringify(summary.copiedUnprocessed));
  });

  await t.test('an undecodable HEIC is copied under its own name and reported', () => {
    assert.ok(names.includes('broken.heic'));
    assert.ok(!names.includes('broken.jpg'));
    assert.ok(summary.copiedUnprocessed.some((c) => c.relPath === 'broken.heic'));
  });

  await t.test('real iPhone-style HEVC HEIC (macOS): decoded through the system, upright, date kept, GPS gone', async (sub) => {
    if (!hevcPossible) {
      sub.skip('sips exists only on macOS');
      return;
    }
    const meta = await sharp(out('iphone.jpg')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 960);
    assert.equal(meta.height, 1280);
    assert.ok(meta.orientation === undefined || meta.orientation === 1);
    assert.deepEqual(await datesOf(out('iphone.jpg')), DATES);
    const block = await exifBlock(out('iphone.jpg'));
    assert.ok(block !== null && !ifd0Tags(block).includes(TAG_GPS_IFD));
    assert.ok(!(await fs.readFile(out('iphone.jpg'))).toString('latin1').includes('SintetikaCam'));
    assert.ok(!names.some((n) => n.includes('.sips')), 'the temporary decode is removed');
  });
});

test('a damaged EXIF block never breaks a copy and yields no dates', async () => {
  assert.deepEqual(await readExifBufferDates(Buffer.from('Exif\0\0IIgarbage')), {});
  assert.deepEqual(await readExifBufferDates(Buffer.alloc(0)), {});
  // IFD0 offset far outside the block
  const lying = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0x7f]);
  assert.deepEqual(await readExifBufferDates(lying), {});
});

test('defaults for new installs: 1280 px and the Mac app proxy quality', () => {
  assert.equal(MAX_IMAGE_DIMENSION, 1280);
  assert.equal(DEFAULT_JPEG_QUALITY, 92);
  assert.equal(DEFAULT_SETTINGS.imageMaxDimension, 1280);
  assert.equal(DEFAULT_SETTINGS.jpegQuality, 92);
});
