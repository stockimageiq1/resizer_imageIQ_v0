import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * The capture time of a photo — the only EXIF a copy carries.
 *
 * The server reads it once, at upload, from the file it receives
 * (capture_date.py: EXIF DateTimeOriginal, else DateTimeDigitized, with
 * OffsetTimeOriginal); the editorial caption and the "date created" column
 * depend on it. Same fields as the browser's reduced copy and the Mac app.
 * Keys are the EXIF tag names sharp's withExif expects (ExifTool calls
 * DateTimeDigitized "CreateDate").
 *
 * Reading never throws: a damaged block simply yields no dates.
 */
export interface CaptureDates {
  DateTimeOriginal?: string;
  DateTimeDigitized?: string;
  OffsetTime?: string;
  OffsetTimeOriginal?: string;
  OffsetTimeDigitized?: string;
}

const TAG_EXIF_IFD = 0x8769;
const DATE_TAGS: ReadonlyMap<number, keyof CaptureDates> = new Map([
  [0x9003, 'DateTimeOriginal'],
  [0x9004, 'DateTimeDigitized'],
  [0x9010, 'OffsetTime'],
  [0x9011, 'OffsetTimeOriginal'],
  [0x9012, 'OffsetTimeDigitized'],
]);

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const ENTRY_BYTES = 12;
const TIFF_MAGIC = 42;
const MAX_IFD_ENTRIES = 4096;
const LONGEST_TEXT = 64;
const EXIF_PREFIX = 'Exif\0\0';

// The same shapes the server accepts (capture_date.py).
const DATE_SHAPE = /^\s*(\d{4}:\d{2}:\d{2}[ T]\d{2}:\d{2}:\d{2})/;
const OFFSET_SHAPE = /^[+-]\d{2}:\d{2}$/;

type ReadAt = (offset: number, length: number) => Promise<Buffer>;

function clean(key: keyof CaptureDates, value: string): string | null {
  if (key === 'DateTimeOriginal' || key === 'DateTimeDigitized') return DATE_SHAPE.exec(value)?.[1] ?? null;
  const trimmed = value.trim();
  return OFFSET_SHAPE.test(trimmed) ? trimmed : null;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** The four value bytes as they stand in the entry. */
  raw: Buffer;
}

async function readDates(readAt: ReadAt): Promise<CaptureDates> {
  const head = await readAt(0, 8);
  if (head.length < 8) return {};
  const order = head.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return {};
  const le = order === 'II';
  const u16 = (b: Buffer, o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(head, 2) !== TIFF_MAGIC) return {};

  const readIfd = async (offset: number): Promise<Entry[]> => {
    const countBytes = await readAt(offset, 2);
    if (countBytes.length < 2) return [];
    const count = u16(countBytes, 0);
    if (count === 0 || count > MAX_IFD_ENTRIES) return [];
    const body = await readAt(offset + 2, count * ENTRY_BYTES);
    if (body.length < count * ENTRY_BYTES) return [];
    return Array.from({ length: count }, (_, i) => {
      const at = i * ENTRY_BYTES;
      return { tag: u16(body, at), type: u16(body, at + 2), count: u32(body, at + 4), raw: body.subarray(at + 8, at + 12) };
    });
  };

  const pointer = (await readIfd(u32(head, 4))).find((e) => e.tag === TAG_EXIF_IFD);
  if (pointer === undefined) return {};

  const dates: CaptureDates = {};
  for (const entry of await readIfd(u32(pointer.raw, 0))) {
    const key = DATE_TAGS.get(entry.tag);
    if (key === undefined || entry.type !== TYPE_ASCII || entry.count > LONGEST_TEXT) continue;
    const bytes = entry.count <= 4 ? entry.raw.subarray(0, entry.count) : await readAt(u32(entry.raw, 0), entry.count);
    const text = bytes.toString('latin1').split('\0')[0] ?? '';
    const value = clean(key, text);
    if (value !== null) dates[key] = value;
  }
  return dates;
}

/** From the block sharp returns as metadata().exif (JPEG, PNG, WebP, HEIF). */
export async function readExifBufferDates(exif: Buffer): Promise<CaptureDates> {
  const tiff = exif.subarray(0, EXIF_PREFIX.length).toString('latin1') === EXIF_PREFIX ? exif.subarray(EXIF_PREFIX.length) : exif;
  try {
    return await readDates(async (offset, length) => tiff.subarray(offset, offset + length));
  } catch {
    return {};
  }
}

/** A TIFF is its own EXIF structure, and sharp does not expose it. Reads only the directories, not the image. */
export async function readTiffFileDates(file: string): Promise<CaptureDates> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      return await readDates(async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      });
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

export function hasDates(dates: CaptureDates): boolean {
  return Object.keys(dates).length > 0;
}

/**
 * Adds the dates to a TIFF that sharp has just written. libvips does not write
 * EXIF into TIFF at all, so without this a TIFF copy would lose its date.
 *
 * Nothing in the file moves: an Exif directory with the dates and a new copy of
 * the first directory (with the pointer to the Exif one, in tag order) are
 * appended, and the header is pointed at the new copy.
 */
export async function appendExifDatesToTiff(file: string, dates: CaptureDates): Promise<void> {
  const items = [...DATE_TAGS.entries()]
    .map(([tag, key]) => ({ tag, value: dates[key] }))
    .filter((i): i is { tag: number; value: string } => i.value !== undefined);
  if (items.length === 0) return;

  const tiff = await fs.readFile(file);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF file');
  const le = order === 'II';
  const r16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const r32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (r16(2) !== TIFF_MAGIC) throw new Error('not a classic TIFF file');

  const put16 = (b: Buffer, o: number, v: number): void => void (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const put32 = (b: Buffer, o: number, v: number): void => void (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));

  const ifd0 = r32(4);
  const ifd0Count = r16(ifd0);
  const kept: Buffer[] = [];
  for (let i = 0; i < ifd0Count; i += 1) {
    const at = ifd0 + 2 + i * ENTRY_BYTES;
    if (r16(at) !== TAG_EXIF_IFD) kept.push(tiff.subarray(at, at + ENTRY_BYTES));
  }
  const nextIfd = r32(ifd0 + 2 + ifd0Count * ENTRY_BYTES);

  const padding = tiff.length % 2;
  const exifIfdAt = tiff.length + padding;
  const exifIfdBytes = 2 + items.length * ENTRY_BYTES + 4;
  const exifIfd = Buffer.alloc(exifIfdBytes);
  put16(exifIfd, 0, items.length);

  const values: Buffer[] = [];
  let valueAt = exifIfdAt + exifIfdBytes;
  items.forEach((item, i) => {
    const text = Buffer.from(`${item.value}\0`, 'latin1');
    const at = 2 + i * ENTRY_BYTES;
    put16(exifIfd, at, item.tag);
    put16(exifIfd, at + 2, TYPE_ASCII);
    put32(exifIfd, at + 4, text.length);
    // every value here is longer than the 4 inline bytes
    put32(exifIfd, at + 8, valueAt);
    const stored = text.length % 2 === 0 ? text : Buffer.concat([text, Buffer.alloc(1)]);
    values.push(stored);
    valueAt += stored.length;
  });

  const pointer = Buffer.alloc(ENTRY_BYTES);
  put16(pointer, 0, TAG_EXIF_IFD);
  put16(pointer, 2, TYPE_LONG);
  put32(pointer, 4, 1);
  put32(pointer, 8, exifIfdAt);

  const insertAt = kept.findIndex((e) => (le ? e.readUInt16LE(0) : e.readUInt16BE(0)) > TAG_EXIF_IFD);
  kept.splice(insertAt === -1 ? kept.length : insertAt, 0, pointer);

  const newIfd0 = Buffer.alloc(2 + kept.length * ENTRY_BYTES + 4);
  put16(newIfd0, 0, kept.length);
  kept.forEach((entry, i) => entry.copy(newIfd0, 2 + i * ENTRY_BYTES));
  put32(newIfd0, 2 + kept.length * ENTRY_BYTES, nextIfd);

  put32(tiff, 4, valueAt);
  // Through a temporary file: a failed write (full disk) must leave the copy as it was.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, Buffer.concat([tiff, Buffer.alloc(padding), exifIfd, ...values, newIfd0]));
    await fs.rename(temporary, file);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}
