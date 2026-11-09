import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { runShrink } from '../src/engine';
import { ProgressEvent, ShrinkError } from '../src/engine/types';
import { buildFixtures } from './fixtures';

const INPUT_NAME = 'Client Shoot 2026';

interface WalkedFile {
  rel: string; // NFC-normalized, POSIX separators
  abs: string;
}

async function walkFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const entryAbs = path.join(abs, entry.name);
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(entryAbs, entryRel);
      else out.push({ rel: entryRel.normalize('NFC'), abs: entryAbs });
    }
  }
  await walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

async function treeChecksums(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const file of await walkFiles(root)) map.set(file.rel, await sha256(file.abs));
  return map;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function videoInfo(file: string): Promise<{ width: number; height: number; hasAudio: boolean }> {
  assert.ok(ffmpegPath !== null);
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(text)); // exits non-zero without an output file; stream info is on stderr
  });
  const dims = / (\d{2,5})x(\d{2,5})/.exec(stderr);
  assert.ok(dims?.[1] !== undefined && dims[2] !== undefined, `no video dimensions found for ${file}:\n${stderr}`);
  return { width: Number(dims[1]), height: Number(dims[2]), hasAudio: /\bAudio:/.test(stderr) };
}

async function zipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-Z1', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.split('\n').filter((line) => line.length > 0));
      else reject(new Error(`unzip -Z1 failed (${code}): ${err}`));
    });
  });
}

const norm = (s: string): string => s.normalize('NFC');

test('iq-shrink engine end-to-end', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-test-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const inputDir = path.join(scratch, INPUT_NAME);
  await buildFixtures(inputDir);

  const before = await treeChecksums(inputDir);
  const events: ProgressEvent[] = [];
  const summary = await runShrink({ inputDir, zip: true, onProgress: (e) => events.push(e) });
  const outDir = summary.outputPath;

  await t.test('originals untouched (checksums identical before/after)', async () => {
    const after = await treeChecksums(inputDir);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
  });

  await t.test('output file names EXACTLY mirror the input tree minus junk', async () => {
    const outFiles = (await walkFiles(outDir)).map((f) => f.rel);
    const expected = [
      'big-landscape.jpg',
      'broken-clip.mov',
      'broken.jpg',
      'clip-hd.mov',
      'notes.txt',
      norm('Luka Ažman/clip-small.mp4'),
      norm('Luka Ažman/2026-05-18 CREATIVE - Lab Tech/small.png'),
      norm('Luka Ažman/2026-05-18 CREATIVE - Lab Tech/rotated.jpg'),
    ].sort((a, b) => (a < b ? -1 : 1));
    assert.deepEqual(outFiles, expected);
  });

  await t.test('images: resized, never upscaled, EXIF applied + stripped, same format as the original', async () => {
    const big = await sharp(path.join(outDir, 'big-landscape.jpg')).metadata();
    assert.equal(big.width, 1280);
    assert.equal(big.height, 853);
    assert.equal(big.format, 'jpeg');
    assert.equal(big.isProgressive, true);

    // .png name, PNG content (the server refuses a name that does not match the bytes)
    const small = await sharp(path.join(outDir, 'Luka Ažman', '2026-05-18 CREATIVE - Lab Tech', 'small.png')).metadata();
    assert.equal(small.format, 'png');
    assert.equal(small.width, 400);
    assert.equal(small.height, 300);

    const rotated = await sharp(path.join(outDir, 'Luka Ažman', '2026-05-18 CREATIVE - Lab Tech', 'rotated.jpg')).metadata();
    assert.equal(rotated.width, 400); // 600x400 + orientation 6 → pixels rotated
    assert.equal(rotated.height, 600);
    assert.equal(rotated.orientation, undefined);
    assert.equal(rotated.exif, undefined);
  });

  await t.test('corrupt + non-media files copied byte-identical and reported with reasons', async () => {
    assert.equal(await sha256(path.join(outDir, 'broken.jpg')), before.get('broken.jpg'));
    assert.equal(await sha256(path.join(outDir, 'broken-clip.mov')), before.get('broken-clip.mov'));
    assert.equal(await sha256(path.join(outDir, 'notes.txt')), before.get('notes.txt'));

    const reasons = new Map(summary.copiedUnprocessed.map((c) => [norm(c.relPath), c.reason]));
    assert.equal(reasons.size, 3);
    assert.match(reasons.get('broken.jpg') ?? '', /image processing failed/);
    assert.match(reasons.get('broken-clip.mov') ?? '', /video processing failed/);
    assert.match(reasons.get('notes.txt') ?? '', /not a supported image or video type/);
  });

  await t.test('videos: fit within 1280x720, no upscale, no audio, original extension kept', async () => {
    const hd = await videoInfo(path.join(outDir, 'clip-hd.mov'));
    assert.equal(hd.width, 1280);
    assert.equal(hd.height, 720);
    assert.equal(hd.hasAudio, false);

    const small = await videoInfo(path.join(outDir, 'Luka Ažman', 'clip-small.mp4'));
    assert.equal(small.width, 320);
    assert.equal(small.height, 240);

    assert.ok(
      events.some((e) => e.type === 'video-progress' && e.percent === 100),
      'expected a video-progress event reaching 100%',
    );
  });

  await t.test('summary numbers', () => {
    assert.equal(summary.imagesProcessed, 3);
    assert.equal(summary.videosProcessed, 2);
    assert.equal(summary.copiedUnprocessed.length, 3);
    assert.ok(summary.inputBytes > 0);
    assert.ok(summary.outputBytes > 0);
    assert.ok(summary.elapsedMs > 0);
    assert.equal(summary.outputPath, path.join(scratch, `${INPUT_NAME}_lowres`));
    assert.equal(summary.zipPath, path.join(scratch, `${INPUT_NAME}_lowres.zip`));
  });

  await t.test('zip root is the ORIGINAL folder name; no _lowres, no junk inside', async () => {
    assert.ok(summary.zipPath !== undefined);
    const entries = (await zipEntries(summary.zipPath)).map(norm);
    assert.ok(entries.length >= 8, `unexpectedly few zip entries: ${entries.join(', ')}`);
    for (const entry of entries) {
      assert.ok(entry.startsWith(`${INPUT_NAME}/`), `zip entry outside root folder: ${entry}`);
      assert.ok(!entry.includes('_lowres'), `_lowres leaked into zip entry: ${entry}`);
      assert.ok(!entry.includes('.DS_Store') && !entry.includes('__MACOSX') && !entry.includes('Thumbs.db'), `junk in zip: ${entry}`);
    }
    assert.ok(entries.includes(`${INPUT_NAME}/clip-hd.mov`));
    assert.ok(entries.includes(norm(`${INPUT_NAME}/Luka Ažman/2026-05-18 CREATIVE - Lab Tech/small.png`)));
  });

  await t.test('existing output aborts without --overwrite; --overwrite recreates from scratch', async () => {
    await assert.rejects(
      runShrink({ inputDir }),
      (err: unknown) => err instanceof ShrinkError && err.code === 'OUTPUT_EXISTS',
    );
    const stale = path.join(outDir, 'stale-file.txt');
    await fs.writeFile(stale, 'stale content that must not survive --overwrite');
    const second = await runShrink({ inputDir, overwrite: true });
    assert.equal(await exists(stale), false, 'stale file survived --overwrite');
    assert.equal(second.imagesProcessed, 3);
  });

  await t.test('unsafe output locations are rejected', async () => {
    await assert.rejects(
      runShrink({ inputDir, outDir: path.join(inputDir, 'nested_out'), overwrite: true }),
      (err: unknown) => err instanceof ShrinkError && err.code === 'UNSAFE_OUTPUT',
    );
    await assert.rejects(
      runShrink({ inputDir, outDir: scratch, overwrite: true }),
      (err: unknown) => err instanceof ShrinkError && err.code === 'UNSAFE_OUTPUT',
    );
  });
});
