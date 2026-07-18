import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { runShrink } from '../engine';
import { scanInput } from '../engine/scanner';
import { ShrinkError } from '../engine/types';
import type { ProgressEvent } from '../engine/types';
import {
  IpcChannels,
  RunDoneMessage,
  RunProgressMessage,
  ScanPreview,
  StartRunRequest,
  StartRunResult,
} from '../shared/ipc';
import { STR } from '../shared/strings';
import { getSettings } from './settings';

interface ActiveRun {
  controller: AbortController;
  outDir: string;
  zipPath: string | null;
  inputDir: string;
}

let active: ActiveRun | null = null;

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function resolveOutDir(inputDir: string, outputParentDir: string | null): string {
  const resolved = path.resolve(inputDir);
  const parent = outputParentDir ?? path.dirname(resolved);
  return path.join(parent, `${path.basename(resolved)}_lowres`);
}

export async function scanPreview(inputDir: string, outputParentDir: string | null): Promise<ScanPreview> {
  const resolved = path.resolve(inputDir);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`not a folder: ${resolved}`);
  const scan = await scanInput(resolved);
  let imageCount = 0;
  let videoCount = 0;
  let otherCount = 0;
  for (const file of scan.files) {
    if (file.kind === 'image') imageCount += 1;
    else if (file.kind === 'video') videoCount += 1;
    else otherCount += 1;
  }
  return {
    inputDir: resolved,
    folderName: path.basename(resolved),
    imageCount,
    videoCount,
    otherCount,
    totalFiles: scan.files.length,
    totalBytes: scan.totalBytes,
    estimatedOutputBytes: Math.ceil(scan.totalBytes * 0.05),
    resolvedOutDir: resolveOutDir(resolved, outputParentDir),
    unreadableCount: scan.unreadable.length,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function zipPathFor(outDir: string): string {
  return path.join(path.dirname(outDir), `${path.basename(outDir)}.zip`);
}

async function hasCollision(outDir: string, withZip: boolean): Promise<boolean> {
  if (await exists(outDir)) return true;
  return withZip && (await exists(zipPathFor(outDir)));
}

/** First free "{name}_lowres_2", "_3", … (folder AND zip must both be free). */
async function firstFreeVariant(defaultOutDir: string, withZip: boolean): Promise<string> {
  for (let n = 2; ; n += 1) {
    const candidate = `${defaultOutDir}_${n}`;
    if (!(await hasCollision(candidate, withZip))) return candidate;
  }
}

function send(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

export async function startRun(win: BrowserWindow, request: StartRunRequest): Promise<StartRunResult> {
  if (active !== null) {
    return { started: false, reason: 'run-active', message: STR.dialogs.runActive };
  }

  // Settings are read HERE, once — changes made while a run is active only
  // ever affect the next run.
  const settings = await getSettings();

  const inputDir = path.resolve(request.inputDir);
  try {
    const stat = await fs.stat(inputDir);
    if (!stat.isDirectory()) return { started: false, reason: 'error', message: STR.dialogs.notAFolder(inputDir) };
  } catch {
    return { started: false, reason: 'error', message: STR.dialogs.folderNotFound(inputDir) };
  }

  let outDir = resolveOutDir(inputDir, settings.outputParentDir);
  if (outDir === inputDir || isInside(inputDir, outDir) || isInside(outDir, inputDir)) {
    return { started: false, reason: 'error', message: STR.dialogs.unsafeOutput };
  }

  let overwrite = false;
  if (await hasCollision(outDir, settings.createZip)) {
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [STR.dialogs.collision.overwrite, STR.dialogs.collision.keepBoth, STR.dialogs.collision.cancel],
      defaultId: 0,
      cancelId: 2,
      message: STR.dialogs.collision.message(path.basename(outDir)),
      detail: STR.dialogs.collision.detail,
    });
    if (choice.response === 2) return { started: false, reason: 'user-cancelled' };
    if (choice.response === 0) overwrite = true;
    else outDir = await firstFreeVariant(resolveOutDir(inputDir, settings.outputParentDir), settings.createZip);
  }

  // Pre-scan for the byte map that powers weighted progress + ETA. Also the
  // authoritative totals forwarded with every progress message.
  const scan = await scanInput(inputDir);
  const bytesByRel = new Map(scan.files.map((f) => [f.relPath, f.bytes]));
  const totalBytes = scan.totalBytes;
  const totalFiles = scan.files.length;
  let bytesDone = 0;
  let filesDone = 0;

  const controller = new AbortController();
  const zipPath = settings.createZip ? zipPathFor(outDir) : null;
  active = { controller, outDir, zipPath, inputDir };

  const forward = (event: ProgressEvent): void => {
    if (event.type === 'file-done') {
      filesDone += 1;
      bytesDone += bytesByRel.get(event.relPath) ?? 0;
    }
    let effectiveBytes = bytesDone;
    if (event.type === 'video-progress') {
      effectiveBytes += ((bytesByRel.get(event.relPath) ?? 0) * event.percent) / 100;
    }
    const message: RunProgressMessage = {
      event,
      bytesDone: Math.round(effectiveBytes),
      totalBytes,
      filesDone,
      totalFiles,
    };
    send(win, IpcChannels.runProgress, message);
  };

  void runShrink({
    inputDir,
    outDir,
    zip: settings.createZip,
    overwrite,
    imageMaxDimension: settings.imageMaxDimension,
    jpegQuality: settings.jpegQuality,
    videoMaxHeight: settings.videoMaxHeight,
    videoCrf: settings.videoCrf,
    keepAudio: settings.keepAudio,
    hardwareAcceleration: settings.hardwareAcceleration,
    signal: controller.signal,
    onProgress: forward,
  })
    .then((summary): Promise<RunDoneMessage> | RunDoneMessage => ({ status: 'done', summary }))
    .catch(async (err: unknown): Promise<RunDoneMessage> => {
      if (err instanceof ShrinkError && err.code === 'CANCELLED') {
        await cleanupPartialOutput(inputDir, outDir, zipPath);
        return { status: 'cancelled' };
      }
      if (err instanceof ShrinkError) return { status: 'error', code: err.code, message: err.message };
      return { status: 'error', code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
    })
    .then((message) => {
      // clear BEFORE notifying, so a renderer reacting to "done" can start the next run
      active = null;
      send(win, IpcChannels.runDone, message);
    });

  return { started: true, outDir };
}

export function cancelRun(): void {
  active?.controller.abort();
}

export function anyRunActive(): boolean {
  return active !== null;
}

/** No half-finished _lowres tree survives a cancel. */
async function cleanupPartialOutput(inputDir: string, outDir: string, zipPath: string | null): Promise<void> {
  // paranoia: never recursively delete anything that touches the input tree
  if (outDir === inputDir || isInside(inputDir, outDir) || isInside(outDir, inputDir)) return;
  await fs.rm(outDir, { recursive: true, force: true });
  if (zipPath !== null && !isInside(inputDir, zipPath)) await fs.rm(zipPath, { force: true });
}
