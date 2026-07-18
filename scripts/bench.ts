/**
 * Manual benchmark harness (NOT part of CI, excluded from the packaged app):
 *
 *   npm run build && node dist/scripts/bench.js <folder-with-videos> [--encoder libx264]
 *
 * Prints per file: encoder used, encode time, realtime factor
 * (video duration / encode time), input → output size.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegBinary from 'ffmpeg-static';
import { detectVideoEncoding, processVideo, VideoEncoder } from '../src/engine/videoProcessor';
import { classify } from '../src/engine/scanner';

const VALID_ENCODERS: VideoEncoder[] = ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];

async function durationSeconds(file: string): Promise<number | null> {
  if (ffmpegBinary === null) return null;
  const stderr = await new Promise<string>((resolve) => {
    const child = spawn(ffmpegBinary as string, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('close', () => resolve(text));
    child.on('error', () => resolve(''));
  });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const encoderFlag = args.indexOf('--encoder');
  const forcedEncoder = encoderFlag >= 0 ? (args[encoderFlag + 1] as VideoEncoder | undefined) : undefined;
  const folder = args.find((a, i) => !a.startsWith('--') && (encoderFlag < 0 || i !== encoderFlag + 1));
  if (folder === undefined) {
    console.error('usage: node dist/scripts/bench.js <folder-with-videos> [--encoder libx264]');
    process.exit(1);
  }
  if (forcedEncoder !== undefined && !VALID_ENCODERS.includes(forcedEncoder)) {
    console.error(`unknown encoder: ${forcedEncoder}`);
    process.exit(1);
  }

  const caps = await detectVideoEncoding();
  console.log(`probed encoders: ${caps.probedEncoders.map((p) => `${p.encoder}=${p.usable ? 'usable' : 'NO'}`).join(', ')}`);
  console.log(`hdr tonemap chain: ${caps.hdrTonemap ? 'supported' : 'NOT supported'}`);
  const encoder = forcedEncoder ?? caps.encoder;
  console.log(`benchmark encoder: ${encoder}\n`);

  const entries = await fs.readdir(path.resolve(folder), { withFileTypes: true });
  const videos = entries
    .filter((e) => e.isFile() && classify(e.name) === 'video')
    .map((e) => path.join(path.resolve(folder), e.name));
  if (videos.length === 0) {
    console.error('no video files found in that folder');
    process.exit(1);
  }

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iq-shrink-bench-'));
  console.log(
    `${'file'.padEnd(34)} ${'encoder'.padEnd(20)} ${'dur'.padStart(6)} ${'encode'.padStart(8)} ${'realtime'.padStart(9)} size`,
  );
  for (const src of videos) {
    const name = path.basename(src);
    const dest = path.join(outDir, name.replace(/\.[^.]+$/, '.mp4'));
    const duration = await durationSeconds(src);
    const inBytes = (await fs.stat(src)).size;
    const startedAt = Date.now();
    try {
      await processVideo(src, dest, undefined, undefined, { encoder, tonemapSupported: caps.hdrTonemap });
      const seconds = (Date.now() - startedAt) / 1000;
      const outBytes = (await fs.stat(dest)).size;
      const realtime = duration !== null && seconds > 0 ? `${(duration / seconds).toFixed(1)}x` : '—';
      console.log(
        `${name.padEnd(34)} ${encoder.padEnd(20)} ${(duration !== null ? `${duration.toFixed(1)}s` : '—').padStart(6)} ` +
          `${`${seconds.toFixed(1)}s`.padStart(8)} ${realtime.padStart(9)} ${formatMB(inBytes)} → ${formatMB(outBytes)}`,
      );
    } catch (err) {
      console.log(`${name.padEnd(34)} FAILED: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  console.log(`\noutputs in ${outDir} (delete when done)`);
}

void main();
