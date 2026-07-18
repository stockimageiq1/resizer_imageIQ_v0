import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { analyzeVideo, detectVideoEncoding, processVideo } from '../src/engine/videoProcessor';
import { makeHdrClip, makeOddSizeClip, makeRotatedClip, makeVfrClip } from './fixtures';

async function streamLine(file: string): Promise<string> {
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
  return stderr.split('\n').find((line) => /Stream #.*Video:/.test(line)) ?? '';
}

function dims(line: string): { width: number; height: number } {
  const match = / (\d{2,5})x(\d{2,5})/.exec(line);
  assert.ok(match?.[1] !== undefined && match[2] !== undefined, `no dimensions in: ${line}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

test('real-world footage robustness', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-robust-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const caps = await detectVideoEncoding();

  await t.test('HDR (PQ/bt2020) source is tonemapped to tagged bt709', async () => {
    const src = path.join(scratch, 'hdr.mp4');
    const dest = path.join(scratch, 'hdr-out.mp4');
    await makeHdrClip(src);

    const analysis = await analyzeVideo(src);
    assert.equal(analysis.hdr, true, 'fixture must be detected as HDR');
    assert.equal(caps.hdrTonemap, true, 'bundled ffmpeg must support the tonemap chain (probed)');

    await processVideo(src, dest, undefined, undefined, { encoder: 'libx264', tonemapSupported: caps.hdrTonemap });
    const line = await streamLine(dest);
    assert.ok(!/smpte2084|arib-std-b67|bt2020/.test(line), `HDR tags leaked into output: ${line}`);
    assert.match(line, /bt709/);
  });

  await t.test('rotation side data is honored — vertical stays vertical', async () => {
    const src = path.join(scratch, 'rotated.mov');
    const dest = path.join(scratch, 'rotated-out.mov');
    await makeRotatedClip(src);
    await processVideo(src, dest, undefined, undefined, { encoder: 'libx264' });
    const out = dims(await streamLine(dest));
    assert.equal(out.width, 240); // 320x240 + 90° displaymatrix → 240x320 pixels
    assert.equal(out.height, 320);
  });

  await t.test('odd-dimension input comes out even on the shared filter chain', async () => {
    const src = path.join(scratch, 'odd.mp4');
    const dest = path.join(scratch, 'odd-out.mp4');
    await makeOddSizeClip(src); // 321x181
    await processVideo(src, dest, undefined, undefined, { encoder: 'libx264' });
    const out = dims(await streamLine(dest));
    assert.equal(out.width % 2, 0, `odd output width ${out.width}`);
    assert.equal(out.height % 2, 0, `odd output height ${out.height}`);
    assert.ok(out.width >= 320 && out.height >= 180, 'should not shrink materially');
  });

  await t.test('VFR input is detected and forced to CFR; CFR input is left alone', async () => {
    const vfrSrc = path.join(scratch, 'vfr.mp4');
    const vfrDest = path.join(scratch, 'vfr-out.mp4');
    await makeVfrClip(vfrSrc);

    const vfrAnalysis = await analyzeVideo(vfrSrc);
    assert.equal(vfrAnalysis.vfr, true, 'fixture must be detected as VFR');

    await processVideo(vfrSrc, vfrDest, undefined, undefined, { encoder: 'libx264' });
    const outAnalysis = await analyzeVideo(vfrDest);
    assert.equal(outAnalysis.vfr, false, 'output must be CFR');

    // CFR control: a plain fixture must NOT be flagged (no blanket-forcing)
    const cfrSrc = path.join(scratch, 'cfr.mp4');
    await makeHdrClip(cfrSrc); // any CFR clip works; reuse the generator
    const cfrAnalysis = await analyzeVideo(cfrSrc);
    assert.equal(cfrAnalysis.vfr, false, 'plain CFR fixture wrongly flagged as VFR');
  });
});
