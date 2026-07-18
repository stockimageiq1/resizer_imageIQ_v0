import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { engineCapabilities } from '../src/engine/capabilities';
import { runShrink } from '../src/engine';
import type { ProgressEvent } from '../src/engine/types';
import type { VideoOptions } from '../src/engine/videoProcessor';
import { buildFixtures } from './fixtures';

test('encoder detection and per-file HW→SW fallback', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-enc-'));
  t.after(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const caps = await engineCapabilities();

  await t.test('detection probes candidates with real encodes; libx264 always usable', () => {
    const libx264 = caps.probedEncoders.find((p) => p.encoder === 'libx264');
    assert.ok(libx264 !== undefined, 'libx264 must be probed');
    assert.equal(libx264.usable, true, 'libx264 probe must pass');
    if (process.platform === 'darwin') {
      assert.ok(
        caps.probedEncoders.some((p) => p.encoder === 'h264_videotoolbox'),
        'videotoolbox must be probed on macOS',
      );
    }
    // selected = first usable candidate in platform order
    const firstUsable = caps.probedEncoders.find((p) => p.usable);
    assert.equal(caps.videoEncoder, firstUsable?.encoder);
  });

  await t.test('hardwareAcceleration: false forces libx264', async () => {
    const inputDir = path.join(scratch, 'SW Forced');
    await buildFixtures(inputDir);
    const summary = await runShrink({ inputDir, hardwareAcceleration: false });
    assert.equal(summary.videosProcessed, 2);
    assert.deepEqual(summary.encoderUsage, { libx264: 2 });
  });

  await t.test('HW encode failure falls back to libx264 per file (before copy-unprocessed)', async (sub) => {
    if (caps.videoEncoder === 'libx264') {
      sub.skip('no usable hardware encoder on this machine — fallback path not exercisable');
      return;
    }
    const inputDir = path.join(scratch, 'HW Fallback');
    await buildFixtures(inputDir);

    // Inject a failure for every non-libx264 attempt through the CJS module
    // namespace (engine calls processVideo via the namespace binding).
    const videoProcessorModule = require('../src/engine/videoProcessor') as {
      processVideo: (
        src: string,
        dest: string,
        onPercent?: (p: number) => void,
        signal?: AbortSignal,
        options?: VideoOptions,
      ) => Promise<void>;
    };
    const realProcessVideo = videoProcessorModule.processVideo;
    let hwAttempts = 0;
    videoProcessorModule.processVideo = async (src, dest, onPercent, signal, options) => {
      if (options?.encoder !== undefined && options.encoder !== 'libx264') {
        hwAttempts += 1;
        throw new Error(`injected ${options.encoder} failure`);
      }
      return realProcessVideo(src, dest, onPercent, signal, options);
    };

    try {
      const events: ProgressEvent[] = [];
      const summary = await runShrink({ inputDir, onProgress: (e) => events.push(e) });
      assert.ok(hwAttempts >= 2, `expected HW attempts, got ${hwAttempts}`);
      assert.equal(summary.videosProcessed, 2, 'both videos must still process via fallback');
      assert.deepEqual(summary.encoderUsage, { libx264: 2 });
      const videoDone = events.filter(
        (e) => e.type === 'file-done' && e.outcome === 'processed' && e.encoderUsed !== undefined,
      );
      assert.equal(videoDone.length, 2);
      for (const e of videoDone) {
        assert.ok(e.type === 'file-done' && e.encoderUsed === 'libx264');
      }
    } finally {
      videoProcessorModule.processVideo = realProcessVideo;
    }
  });

  await t.test('hardware path produces real output when available', async (sub) => {
    if (caps.videoEncoder === 'libx264') {
      sub.skip('no usable hardware encoder on this machine');
      return;
    }
    const inputDir = path.join(scratch, 'HW Real');
    await buildFixtures(inputDir);
    const summary = await runShrink({ inputDir });
    assert.equal(summary.videosProcessed, 2);
    assert.deepEqual(summary.encoderUsage, { [caps.videoEncoder]: 2 });
  });
});
