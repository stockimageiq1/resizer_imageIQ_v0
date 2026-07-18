import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, SETTING_RANGES, Settings } from '../shared/ipc';

let cache: Settings | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function clampInt(value: unknown, range: { min: number; max: number }): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * Accept only known keys with the right types — the patch crosses IPC.
 * Numeric values are clamped to their documented ranges.
 */
function sanitize(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};
  if (typeof patch.createZip === 'boolean') clean.createZip = patch.createZip;
  if (typeof patch.keepAudio === 'boolean') clean.keepAudio = patch.keepAudio;
  if (typeof patch.hardwareAcceleration === 'boolean') clean.hardwareAcceleration = patch.hardwareAcceleration;
  if (patch.outputParentDir === null || typeof patch.outputParentDir === 'string') {
    clean.outputParentDir = patch.outputParentDir;
  }
  const imageMaxDimension = clampInt(patch.imageMaxDimension, SETTING_RANGES.imageMaxDimension);
  if (imageMaxDimension !== undefined) clean.imageMaxDimension = imageMaxDimension;
  const jpegQuality = clampInt(patch.jpegQuality, SETTING_RANGES.jpegQuality);
  if (jpegQuality !== undefined) clean.jpegQuality = jpegQuality;
  const videoMaxHeight = clampInt(patch.videoMaxHeight, SETTING_RANGES.videoMaxHeight);
  if (videoMaxHeight !== undefined) clean.videoMaxHeight = videoMaxHeight;
  const videoCrf = clampInt(patch.videoCrf, SETTING_RANGES.videoCrf);
  if (videoCrf !== undefined) clean.videoCrf = videoCrf;
  return clean;
}

export async function getSettings(): Promise<Settings> {
  if (cache !== null) return cache;
  try {
    const raw: unknown = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    cache = { ...DEFAULT_SETTINGS, ...sanitize(raw as Partial<Settings>) };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...sanitize(patch) };
  cache = next;
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
