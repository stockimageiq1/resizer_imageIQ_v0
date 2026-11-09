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
    // 12 MP: a real iPhone grid, which libheif's default limits refuse
    await sharp(await pngBuffer(4032, 3024)).withExif({ IFD0: { Make: 'SintetikaCam', Orientation: '6' }, IFD2: DATES, IFD3: SENSITIVE.IFD3 })
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

/** A camera-style JPEG: EXIF with the date and an IFD1 thumbnail that carries a marker. */
async function jpegWithThumbnail(marker: string): Promise<Buffer> {
  const small = await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 9, g: 200, b: 30 } } }).jpeg().toBuffer();
  const text = Buffer.from(marker, 'latin1');
  const com = Buffer.alloc(4);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(text.length + 2, 2);
  const thumb = Buffer.concat([small.subarray(0, 2), com, text, small.subarray(2)]);

  const date = Buffer.from('2026:05:09 14:03:22\0', 'latin1');
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;
  const ifd1At = exifAt + 2 + 12 + 4;
  const dateAt = ifd1At + 2 + 3 * 12 + 4;
  const thumbAt = dateAt + date.length;
  const tiff = Buffer.alloc(thumbAt + thumb.length);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0At, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number): void => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(value, at + 8);
  };
  tiff.writeUInt16LE(1, ifd0At);
  entry(ifd0At + 2, 0x8769, 4, 1, exifAt);
  tiff.writeUInt32LE(ifd1At, ifd0At + 14);
  tiff.writeUInt16LE(1, exifAt);
  entry(exifAt + 2, 0x9003, 2, date.length, dateAt);
  tiff.writeUInt16LE(3, ifd1At);
  entry(ifd1At + 2, 0x103, 3, 1, 6);
  entry(ifd1At + 14, 0x201, 4, 1, thumbAt);
  entry(ifd1At + 26, 0x202, 4, 1, thumb.length);
  date.copy(tiff, dateAt);
  thumb.copy(tiff, thumbAt);

  const main = await sharp(await pngBuffer(2000, 1500)).jpeg({ quality: 90 }).toBuffer();
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([main.subarray(0, 2), app1, body, main.subarray(2)]);
}

async function firstPixel(file: string): Promise<number[]> {
  const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return [data[0] ?? -1, data[1] ?? -1, data[2] ?? -1];
}

function near(actual: number[], expected: number[]): void {
  assert.ok(actual.every((v, i) => Math.abs(v - (expected[i] ?? 0)) <= 3), `${actual.join(',')} is not ${expected.join(',')}`);
}

const solid = (width: number, height: number, r: number, g: number, b: number): sharp.Sharp =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } });

test('a copy carries no thumbnail, correct colours, and no run is aborted by one bad file', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-review-'));
  const inputDir = path.join(scratch, 'Review');
  await fs.mkdir(inputDir, { recursive: true });
  const in_ = (name: string): string => path.join(inputDir, name);
  t.after(async () => {
    await fs.chmod(in_('locked.jpg'), 0o644).catch(() => undefined);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const camera = await jpegWithThumbnail('SkrivnaSlicica');
  for (const name of ['thumb.jpg', 'thumb-as.png', 'thumb-as.webp']) await fs.writeFile(in_(name), camera);

  await solid(2000, 1500, 200, 40, 30).toColourspace('rgb16').withIccProfile('srgb').tiff({ compression: 'none' }).toFile(in_('icc16.tiff'));
  await solid(2000, 1500, 200, 40, 30).toColourspace('rgb16').withIccProfile('srgb').png().toFile(in_('icc16.png'));
  await solid(2000, 1500, 200, 40, 30).toColourspace('rgb16').tiff({ compression: 'none' }).toFile(in_('plain16.tiff'));

  const clear = { create: { width: 300, height: 200, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } } };
  await sharp(clear).png().toFile(in_('alpha-named.jpg'));
  await sharp(clear).png().toFile(in_('alpha-keep.png'));

  await fs.mkdir(in_('folder-clash.jpg'));
  await solid(300, 200, 1, 2, 3).jpeg().toFile(path.join(in_('folder-clash.jpg'), 'inside.jpg'));
  await solid(300, 200, 9, 9, 9).heif({ compression: 'av1', quality: 60 }).toFile(in_('folder-clash.heic'));

  await solid(300, 200, 1, 2, 3).jpeg().toFile(in_('\u010Cebela.jpg'));
  await solid(900, 600, 9, 9, 9).heif({ compression: 'av1', quality: 60 }).toFile(in_('C\u030Cebela.heic'));

  await solid(300, 200, 5, 5, 5).jpeg().toFile(in_('locked.jpg'));
  const lockable = process.platform !== 'win32' && process.getuid?.() !== 0;
  if (lockable) await fs.chmod(in_('locked.jpg'), 0o000);

  const summary = await runShrink({ inputDir, outDir: path.join(scratch, 'out') });
  const out = (name: string): string => path.join(summary.outputPath, name);

  for (const name of ['thumb.jpg', 'thumb-as.png', 'thumb-as.webp']) {
    await t.test(`${name}: the EXIF thumbnail is gone, the date stays`, async () => {
      assert.ok(!(await fs.readFile(out(name))).toString('latin1').includes('SkrivnaSlicica'));
      assert.equal((await datesOf(out(name))).DateTimeOriginal, DATES.DateTimeOriginal);
    });
  }

  for (const name of ['icc16.tiff', 'icc16.png', 'plain16.tiff']) {
    await t.test(`${name}: colours are right and no profile is left`, async () => {
      near(await firstPixel(out(name)), [200, 40, 30]);
      assert.equal((await sharp(out(name)).metadata()).icc, undefined);
    });
  }

  await t.test('transparency: white in a JPEG, kept in a PNG', async () => {
    near(await firstPixel(out('alpha-named.jpg')), [255, 255, 255]);
    assert.equal((await sharp(out('alpha-keep.png')).metadata()).hasAlpha, true);
  });

  await t.test('a folder that owns the .jpg name: the HEIC is copied and reported', async () => {
    assert.ok((await fs.stat(out('folder-clash.jpg'))).isDirectory());
    assert.ok(summary.copiedUnprocessed.some((c) => c.relPath === 'folder-clash.heic' && /already/.test(c.reason)));
  });

  await t.test('names that differ only in Unicode form do not overwrite each other', async () => {
    assert.equal((await sharp(out('\u010Cebela.jpg')).metadata()).width, 300);
    assert.ok(summary.copiedUnprocessed.some((c) => c.relPath.normalize('NFC') === '\u010Cebela.heic' && /already/.test(c.reason)));
  });

  await t.test('an unreadable original is reported and the run goes on', (sub) => {
    if (!lockable) {
      sub.skip('permissions cannot lock a file here');
      return;
    }
    assert.ok(summary.copiedUnprocessed.some((c) => c.relPath === 'locked.jpg' && /nothing copied/.test(c.reason)), JSON.stringify(summary.copiedUnprocessed));
  });
});

test('a re-run over changed originals shows the new pictures, never the previous ones', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-stale-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Same Name');
  await fs.mkdir(inputDir, { recursive: true });
  const outDir = path.join(scratch, 'out');
  const file = path.join(inputDir, 'one.webp');

  await solid(900, 600, 20, 200, 40).webp().toFile(file);
  await runShrink({ inputDir, outDir });
  await fs.rm(file);
  await solid(900, 600, 200, 30, 40).webp().toFile(file);
  await runShrink({ inputDir, outDir, overwrite: true });
  near(await firstPixel(path.join(outDir, 'one.webp')), [200, 30, 40]);

  await t.test('HEVC HEIC through the system decoder (macOS)', async (sub) => {
    if (process.platform !== 'darwin') {
      sub.skip('sips exists only on macOS');
      return;
    }
    const dir = path.join(scratch, 'Phone Same');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(scratch, 'phone-out');
    const make = async (r: number, g: number, b: number): Promise<void> => {
      for (const n of [1, 2, 3]) {
        const png = path.join(scratch, `s${n}.png`);
        await solid(1600, 1200, r, g, b).png().toFile(png);
        execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', path.join(dir, `IMG_${n}.heic`)], { stdio: 'ignore' });
      }
    };
    await make(20, 200, 40);
    await runShrink({ inputDir: dir, outDir: out });
    await make(200, 30, 40);
    await runShrink({ inputDir: dir, outDir: out, overwrite: true });
    for (const n of [1, 2, 3]) near(await firstPixel(path.join(out, `IMG_${n}.jpg`)), [200, 30, 40]);
  });
});

test('a damaged HEVC HEIC is copied and reported, not turned into a black picture (macOS)', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('sips exists only on macOS');
    return;
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-damaged-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Damaged');
  await fs.mkdir(inputDir, { recursive: true });
  const png = path.join(scratch, 'source.png');
  await sharp(await pngBuffer(1600, 1200)).png().toFile(png);
  const heic = path.join(inputDir, 'cut.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' });
  const whole = await fs.readFile(heic);
  await fs.writeFile(heic, whole.subarray(0, Math.floor(whole.length / 2)));

  const summary = await runShrink({ inputDir, outDir: path.join(scratch, 'out') });
  assert.deepEqual(await fs.readdir(summary.outputPath), ['cut.heic']);
  assert.equal(summary.imagesProcessed, 0);
  assert.ok(summary.copiedUnprocessed.some((c) => c.relPath === 'cut.heic'));
});

test('adding the dates to a TIFF never damages it when the write fails', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('permissions cannot lock a folder here');
    return;
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-tiff-'));
  const dir = path.join(scratch, 'ro');
  await fs.mkdir(dir);
  t.after(async () => {
    await fs.chmod(dir, 0o755);
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const file = path.join(dir, 'a.tiff');
  await solid(100, 80, 1, 2, 3).tiff({ compression: 'deflate' }).toFile(file);
  const before = await fs.readFile(file);
  await fs.chmod(dir, 0o555);
  await assert.rejects(appendExifDatesToTiff(file, DATES));
  assert.ok(before.equals(await fs.readFile(file)));
});
