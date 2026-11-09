import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { heicSupported, isHeifName, outputRelPath, processImage } from './imageProcessor';
import { scanInput } from './scanner';
import * as videoProcessor from './videoProcessor';
import { detectVideoEncoding, ffmpegPath, VideoEncoder, VideoOptions } from './videoProcessor';
import { zipOutput } from './zipper';
import {
  CopiedUnprocessed,
  ProgressCallback,
  ScannedFile,
  ShrinkError,
  ShrinkOptions,
  ShrinkSummary,
} from './types';

const OUTPUT_ESTIMATE_RATIO = 0.05;
const DISK_MARGIN_BYTES = 16 * 1024 * 1024;
const DEFAULT_IMAGE_CONCURRENCY = 4;

interface Task {
  file: ScannedFile;
  action: 'image' | 'video' | 'copy';
  /** Reason when action is 'copy' (decided up front, e.g. HEIC unsupported). */
  reason?: string;
  /** Where the copy goes when it is not the original's own relative path (HEIC/HEIF → .jpg). */
  outRelPath?: string;
}

export async function runShrink(options: ShrinkOptions): Promise<ShrinkSummary> {
  const startedAt = Date.now();
  const onProgress: ProgressCallback = options.onProgress ?? (() => undefined);
  const signal = options.signal;
  throwIfCancelled(signal);

  const inputDir = path.resolve(options.inputDir);
  let inputStat;
  try {
    inputStat = await fs.stat(inputDir);
  } catch {
    throw new ShrinkError('INPUT_NOT_FOUND', `input folder not found: ${inputDir}`);
  }
  if (!inputStat.isDirectory()) {
    throw new ShrinkError('INPUT_NOT_DIRECTORY', `input path is not a folder: ${inputDir}`);
  }

  const inputName = path.basename(inputDir);
  const outDir = path.resolve(options.outDir ?? path.join(path.dirname(inputDir), `${inputName}_lowres`));
  assertSafeOutput(inputDir, outDir);
  // Zip name follows the output folder name (identical to "{inputName}_lowres.zip"
  // for the default outDir), so "keep both"-style outDir variants get matching,
  // collision-free zip names. The ROOT folder inside the zip stays inputName.
  const zipPath = options.zip === true ? path.join(path.dirname(outDir), `${path.basename(outDir)}.zip`) : undefined;
  if (zipPath !== undefined && isInside(inputDir, zipPath)) {
    throw new ShrinkError('UNSAFE_OUTPUT', `zip would land inside the input folder: ${zipPath}`);
  }

  // Collision checks happen before ANY work; --overwrite recreates from
  // scratch (never merges into stale contents).
  if ((await exists(outDir)) && options.overwrite !== true) {
    throw new ShrinkError(
      'OUTPUT_EXISTS',
      `output folder already exists: ${outDir} — re-run with --overwrite to delete and recreate it`,
    );
  }
  if (zipPath !== undefined && (await exists(zipPath)) && options.overwrite !== true) {
    throw new ShrinkError('OUTPUT_EXISTS', `zip already exists: ${zipPath} — re-run with --overwrite to replace it`);
  }

  const scan = await scanInput(inputDir);
  onProgress({ type: 'scan', totalFiles: scan.files.length, totalBytes: scan.totalBytes });

  await checkDiskSpace(path.dirname(outDir), scan.totalBytes, options.zip === true);

  throwIfCancelled(signal); // cancel before any output exists must not delete anything
  await fs.rm(outDir, { recursive: true, force: true });
  if (zipPath !== undefined) await fs.rm(zipPath, { force: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const dirRel of scan.dirs) {
    await fs.mkdir(toOutPath(outDir, dirRel), { recursive: true });
  }

  const tasks = planTasks(scan.files, heicSupported(), ffmpegPath() !== null);

  // Encoder selection happens once per run: probed hardware encoder (cached
  // per process) unless hardware acceleration is off. Probes only run when
  // the input actually contains videos.
  const hasVideos = tasks.some((t) => t.action === 'video');
  let chosenEncoder: VideoEncoder = 'libx264';
  let tonemapSupported = false;
  if (hasVideos) {
    const videoCaps = await detectVideoEncoding();
    chosenEncoder = options.hardwareAcceleration === false ? 'libx264' : videoCaps.encoder;
    tonemapSupported = videoCaps.hdrTonemap;
  }

  const copiedUnprocessed: CopiedUnprocessed[] = scan.unreadable.map((u) => ({ ...u }));
  const encoderUsage: Record<string, number> = {};
  let imagesProcessed = 0;
  let videosProcessed = 0;

  async function copyOriginal(file: ScannedFile, reason: string): Promise<void> {
    await fs.copyFile(file.absPath, toOutPath(outDir, file.relPath));
    copiedUnprocessed.push({ relPath: file.relPath, reason });
    onProgress({ type: 'file-done', relPath: file.relPath, outcome: 'copied-unprocessed', reason });
  }

  async function encodeVideoWithFallback(
    file: ScannedFile,
    dest: string,
    encoder: VideoEncoder,
    videoOptions: VideoOptions,
  ): Promise<VideoEncoder> {
    const onPercent = (percent: number): void => {
      onProgress({ type: 'video-progress', relPath: file.relPath, percent });
    };
    const attempt = async (enc: VideoEncoder): Promise<void> => {
      await videoProcessor.processVideo(file.absPath, dest, onPercent, signal, { ...videoOptions, encoder: enc });
      // HW encoders can exit 0 yet produce nothing on some driver stacks —
      // an empty output counts as a failed attempt
      const stat = await fs.stat(dest).catch(() => null);
      if (stat === null || stat.size === 0) throw new Error(`${enc} produced an empty output`);
    };
    try {
      await attempt(encoder);
      return encoder;
    } catch (err) {
      if (encoder === 'libx264' || signal?.aborted === true) throw err;
      // per-file fallback: one retry with software before copy-unprocessed
      await fs.rm(dest, { force: true });
      await attempt('libx264');
      return 'libx264';
    }
  }

  async function runTask(task: Task): Promise<void> {
    const { file } = task;
    onProgress({ type: 'file-start', relPath: file.relPath, kind: file.kind });
    if (task.action === 'copy') {
      await copyOriginal(file, task.reason ?? 'unprocessable');
      return;
    }
    // Output keeps the EXACT original name (downstream CSV matching); HEIC/HEIF
    // are the one exception (the web app does not take them, so they become .jpg).
    const dest = toOutPath(outDir, task.outRelPath ?? file.relPath);
    try {
      if (task.action === 'image') {
        await processImage(file.absPath, dest, {
          ...(options.imageMaxDimension !== undefined ? { maxDimension: options.imageMaxDimension } : {}),
          ...(options.jpegQuality !== undefined ? { quality: options.jpegQuality } : {}),
        });
        imagesProcessed += 1;
        onProgress({ type: 'file-done', relPath: file.relPath, outcome: 'processed' });
      } else {
        const videoOptions: VideoOptions = {
          tonemapSupported,
          ...(options.videoMaxHeight !== undefined ? { maxHeight: options.videoMaxHeight } : {}),
          ...(options.videoCrf !== undefined ? { crf: options.videoCrf } : {}),
          ...(options.keepAudio !== undefined ? { keepAudio: options.keepAudio } : {}),
        };
        const encoderUsed = await encodeVideoWithFallback(file, dest, chosenEncoder, videoOptions);
        videosProcessed += 1;
        encoderUsage[encoderUsed] = (encoderUsage[encoderUsed] ?? 0) + 1;
        onProgress({ type: 'file-done', relPath: file.relPath, outcome: 'processed', encoderUsed });
      }
    } catch (err) {
      await fs.rm(dest, { force: true }); // drop any partial output before copying
      // a kill caused by cancellation is not a per-file failure — don't copy
      if (signal?.aborted === true) return;
      await copyOriginal(file, `${task.action} processing failed: ${errorMessage(err)}`);
    }
  }

  const videoTasks = tasks.filter((t) => t.action === 'video');
  const otherTasks = tasks.filter((t) => t.action !== 'video');
  await Promise.all([
    pool(otherTasks, options.imageConcurrency ?? DEFAULT_IMAGE_CONCURRENCY, runTask, signal),
    pool(videoTasks, 1, runTask, signal),
  ]);
  throwIfCancelled(signal); // partial output stays; the caller deletes it

  const outputBytes = await treeBytes(outDir);

  if (zipPath !== undefined) {
    onProgress({ type: 'zip-start', zipPath });
    await zipOutput(outDir, zipPath, inputName);
    onProgress({ type: 'zip-done', zipPath });
  }

  const inputBytes = scan.totalBytes;
  const summary: ShrinkSummary = {
    imagesProcessed,
    videosProcessed,
    encoderUsage,
    copiedUnprocessed,
    inputBytes,
    outputBytes,
    percentSaved: inputBytes > 0 ? ((inputBytes - outputBytes) / inputBytes) * 100 : 0,
    elapsedMs: Date.now() - startedAt,
    outputPath: outDir,
  };
  if (zipPath !== undefined) summary.zipPath = zipPath;
  return summary;
}

function planTasks(files: ScannedFile[], heicOk: boolean, ffmpegOk: boolean): Task[] {
  // Lower-cased: the default macOS volume does not tell "A.JPG" from "a.jpg".
  const taken = new Set(files.filter((f) => !isHeifName(f.relPath)).map((f) => f.relPath.toLowerCase()));
  return files.map((file): Task => {
    if (file.kind === 'image') {
      if (isHeifName(file.relPath)) {
        if (!heicOk) return { file, action: 'copy', reason: 'HEIC/HEIF decoding not available in this sharp build' };
        const outRelPath = outputRelPath(file.relPath);
        const key = outRelPath.toLowerCase();
        if (taken.has(key)) {
          return { file, action: 'copy', reason: `${path.posix.basename(outRelPath)} already exists in this folder — the JPEG copy would overwrite it` };
        }
        taken.add(key);
        return { file, action: 'image', outRelPath };
      }
      return { file, action: 'image' as const };
    }
    if (file.kind === 'video') {
      if (!ffmpegOk) {
        return { file, action: 'copy' as const, reason: 'bundled ffmpeg binary unavailable' };
      }
      return { file, action: 'video' as const };
    }
    return { file, action: 'copy' as const, reason: 'not a supported image or video type' };
  });
}

function toOutPath(outDir: string, relPosix: string): string {
  return path.join(outDir, ...relPosix.split('/'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Iron rule: originals are never written to. The output tree must be fully
 * disjoint from the input tree, and --overwrite must never be able to
 * rm -rf the input, its ancestors, $HOME, or a filesystem root.
 */
function assertSafeOutput(inputDir: string, outDir: string): void {
  if (outDir === inputDir) {
    throw new ShrinkError('UNSAFE_OUTPUT', 'output folder must not be the input folder itself');
  }
  if (isInside(inputDir, outDir)) {
    throw new ShrinkError('UNSAFE_OUTPUT', `output folder must not be inside the input folder: ${outDir}`);
  }
  if (isInside(outDir, inputDir)) {
    throw new ShrinkError('UNSAFE_OUTPUT', `output folder must not contain the input folder: ${outDir}`);
  }
  if (outDir === path.parse(outDir).root || outDir === os.homedir()) {
    throw new ShrinkError('UNSAFE_OUTPUT', `refusing to use ${outDir} as an output folder`);
  }
}

async function checkDiskSpace(location: string, inputBytes: number, withZip: boolean): Promise<void> {
  const estimated = Math.ceil(inputBytes * OUTPUT_ESTIMATE_RATIO) * (withZip ? 2 : 1) + DISK_MARGIN_BYTES;
  let freeBytes: number;
  try {
    const stats = await fs.statfs(location);
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    return; // free space unknown on this platform/filesystem — do not block the run
  }
  if (freeBytes < estimated) {
    throw new ShrinkError(
      'INSUFFICIENT_DISK',
      `not enough free disk space at ${location}: ~${Math.ceil(estimated / 1e6)} MB needed, ` +
        `${Math.floor(freeBytes / 1e6)} MB free`,
    );
  }
}

async function treeBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) total += await treeBytes(abs);
    else if (entry.isFile()) total += (await fs.stat(abs)).size;
  }
  return total;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n')[0] ?? message).slice(0, 300);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ShrinkError('CANCELLED', 'run cancelled');
}

async function pool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted === true) return; // stop scheduling new files
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}
