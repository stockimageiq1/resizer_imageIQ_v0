import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

/**
 * Generates the fixture tree in a temp dir — no committed binaries.
 *
 * <inputDir>/
 *   big-landscape.jpg        3000x2000 → must resize to 1280x853
 *   broken.jpg               deliberately corrupt → copy + report
 *   broken-clip.mov          deliberately corrupt → copy + report
 *   clip-hd.mov              1s 1920x1080 + audio → 1280x720, audio stripped
 *   notes.txt                non-media → copy + report
 *   .DS_Store                junk → excluded
 *   __MACOSX/._big-landscape.jpg   junk → excluded
 *   Luka Ažman/
 *     clip-small.mp4         1s 320x240 → must NOT upscale
 *     2026-05-18 CREATIVE - Lab Tech/
 *       small.png            400x300 → must NOT upscale; PNG bytes, .png name
 *       rotated.jpg          600x400 with EXIF orientation 6 → pixels rotated to 400x600
 *       Thumbs.db            junk → excluded
 */
export async function buildFixtures(inputDir: string): Promise<void> {
  const lukaDir = path.join(inputDir, 'Luka Ažman');
  const labDir = path.join(lukaDir, '2026-05-18 CREATIVE - Lab Tech');
  const macosxDir = path.join(inputDir, '__MACOSX');
  await fs.mkdir(labDir, { recursive: true });
  await fs.mkdir(macosxDir, { recursive: true });

  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 190, g: 40, b: 40 } } })
    .jpeg({ quality: 90 })
    .toFile(path.join(inputDir, 'big-landscape.jpg'));

  await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 170, b: 60 } } })
    .png()
    .toFile(path.join(labDir, 'small.png'));

  await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 60, b: 200 } } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(path.join(labDir, 'rotated.jpg'));

  await fs.writeFile(path.join(inputDir, 'broken.jpg'), 'not actually a jpeg — deliberately corrupt fixture');
  await fs.writeFile(path.join(inputDir, 'broken-clip.mov'), 'not actually a video — deliberately corrupt fixture');
  await fs.writeFile(path.join(inputDir, 'notes.txt'), 'shoot notes for the metadata team\n');

  await fs.writeFile(path.join(inputDir, '.DS_Store'), Buffer.alloc(32));
  await fs.writeFile(path.join(labDir, 'Thumbs.db'), Buffer.alloc(16));
  await fs.writeFile(path.join(macosxDir, '._big-landscape.jpg'), Buffer.alloc(16));

  await makeVideo(path.join(inputDir, 'clip-hd.mov'), '1920x1080', true);
  await makeVideo(path.join(lukaDir, 'clip-small.mp4'), '320x240', false);
}

/** HDR-tagged clip (PQ/bt2020 metadata on 8-bit frames — the tags drive detection). */
export async function makeHdrClip(dest: string): Promise<void> {
  await runFixtureFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    dest,
  ]);
}

/** Phone-style clip with a 90° displaymatrix (rotation side data, not rotated pixels). */
export async function makeRotatedClip(dest: string): Promise<void> {
  const plain = `${dest}.plain.mp4`;
  await runFixtureFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    plain,
  ]);
  await runFixtureFfmpeg(['-display_rotation', '90', '-i', plain, '-c', 'copy', dest]);
  await fs.rm(plain, { force: true });
}

/** Odd-dimension clip (yuv444p allows odd sizes; our yuv420p output must round to even). */
export async function makeOddSizeClip(dest: string): Promise<void> {
  await runFixtureFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=321x181:rate=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p',
    dest,
  ]);
}

/**
 * Genuinely VFR clip via the concat demuxer (alternating 0.20s/0.05s frame
 * durations) — lavfi+setpts gets silently CFR-ified, concat does not.
 */
export async function makeVfrClip(dest: string): Promise<void> {
  const dir = path.dirname(dest);
  const frame = path.join(dir, 'vfr-frame.png');
  const list = path.join(dir, 'vfr-list.txt');
  await runFixtureFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=320x240:rate=10', '-frames:v', '1', frame]);
  const entries: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push(`file 'vfr-frame.png'`, `duration ${i % 2 === 0 ? '0.20' : '0.05'}`);
  }
  entries.push(`file 'vfr-frame.png'`);
  await fs.writeFile(list, `${entries.join('\n')}\n`);
  await runFixtureFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    dest,
  ]);
  await fs.rm(frame, { force: true });
  await fs.rm(list, { force: true });
}

async function runFixtureFfmpeg(args: string[]): Promise<void> {
  if (ffmpegPath === null) throw new Error('ffmpeg-static binary missing — cannot build fixtures');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`fixture ffmpeg failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function makeVideo(dest: string, size: string, withAudio: boolean): Promise<void> {
  if (ffmpegPath === null) throw new Error('ffmpeg-static binary missing — cannot build fixtures');
  const args = ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc=duration=1:size=${size}:rate=12`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-shortest');
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dest);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`fixture ffmpeg failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}
