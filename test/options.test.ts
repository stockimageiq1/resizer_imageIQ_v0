import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { runShrink } from '../src/engine';
import { buildFixtures } from './fixtures';

async function videoInfo(file: string): Promise<{ width: number; height: number; hasAudio: boolean }> {
  assert.ok(ffmpegPath !== null);
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
  const dims = / (\d{2,5})x(\d{2,5})/.exec(stderr);
  assert.ok(dims?.[1] !== undefined && dims[2] !== undefined, `no video dimensions found for ${file}:\n${stderr}`);
  return { width: Number(dims[1]), height: Number(dims[2]), hasAudio: /\bAudio:/.test(stderr) };
}

test('engine option plumbing: dimension, quality, height, crf, audio', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-options-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const inputDir = path.join(scratch, 'Options Shoot');
  await buildFixtures(inputDir);

  const summary = await runShrink({
    inputDir,
    imageMaxDimension: 512,
    jpegQuality: 60,
    videoMaxHeight: 360,
    videoCrf: 30,
    keepAudio: true,
  });
  const outDir = summary.outputPath;

  await t.test('images honor custom max dimension and still never upscale', async () => {
    const big = await sharp(path.join(outDir, 'big-landscape.jpg')).metadata();
    assert.equal(big.width, 512); // 3000x2000 → 512 on the longest side
    assert.equal(big.height, 341);

    const small = await sharp(
      path.join(outDir, 'Luka Ažman', '2026-05-18 CREATIVE - Lab Tech', 'small.png'),
    ).metadata();
    assert.equal(small.width, 400); // under the cap → untouched dimensions
    assert.equal(small.height, 300);
  });

  await t.test('videos honor custom max height and keep audio when asked', async () => {
    const hd = await videoInfo(path.join(outDir, 'clip-hd.mov'));
    assert.equal(hd.width, 640); // 1920x1080 fits 640x360 (16:9 bound at height 360)
    assert.equal(hd.height, 360);
    assert.equal(hd.hasAudio, true); // keepAudio: fixture clip has a sine track

    const small = await videoInfo(path.join(outDir, 'Luka Ažman', 'clip-small.mp4'));
    assert.equal(small.width, 320); // 320x240 is under the cap → no upscale
    assert.equal(small.height, 240);
  });

  await t.test('defaults unchanged when options are omitted', async () => {
    const defaultsRun = await runShrink({ inputDir, outDir: path.join(scratch, 'defaults_out') });
    const big = await sharp(path.join(defaultsRun.outputPath, 'big-landscape.jpg')).metadata();
    assert.equal(big.width, 1280);
    const hd = await videoInfo(path.join(defaultsRun.outputPath, 'clip-hd.mov'));
    assert.equal(hd.width, 1280);
    assert.equal(hd.height, 720);
    assert.equal(hd.hasAudio, false);
  });
});
