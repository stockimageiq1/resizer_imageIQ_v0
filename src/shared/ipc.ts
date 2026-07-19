import type { ProgressEvent, ShrinkErrorCode, ShrinkSummary } from '../engine/types';

/** Channel names used by main + preload. Renderer never sees these. */
export const IpcChannels = {
  scanPreview: 'scan:preview',
  resolveOutDir: 'scan:resolveOutDir',
  startRun: 'run:start',
  cancelRun: 'run:cancel',
  runProgress: 'run:progress',
  runDone: 'run:done',
  selectFolder: 'dialog:selectFolder',
  openPath: 'shell:openPath',
  showItemInFolder: 'shell:showItemInFolder',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  isDirectory: 'fs:isDirectory',
  capabilities: 'app:capabilities',
} as const;

export interface Settings {
  /** "Create ZIP for upload" toggle. */
  createZip: boolean;
  /** Parent folder for the "{name}_lowres" output; null = sibling of the input. */
  outputParentDir: string | null;
  /** Longest image side in px (256–4096). */
  imageMaxDimension: number;
  /** JPEG output quality (40–95). */
  jpegQuality: number;
  /** Max video height in px (240–2160); width scales to match. */
  videoMaxHeight: number;
  /** x264 CRF (18–35); lower = higher quality. */
  videoCrf: number;
  /** Keep the audio track instead of stripping it. */
  keepAudio: boolean;
  /** Use the probed hardware encoder (auto-fallback to software). OFF forces libx264. */
  hardwareAcceleration: boolean;
  /** Theme: dark = Frame Picker navy gradient (default), light = webapp-aligned, system = follow OS. */
  appearance: 'dark' | 'light' | 'system';
}

export const SETTING_RANGES = {
  imageMaxDimension: { min: 256, max: 4096 },
  jpegQuality: { min: 40, max: 95 },
  videoMaxHeight: { min: 240, max: 2160 },
  videoCrf: { min: 18, max: 35 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  createZip: true,
  outputParentDir: null,
  imageMaxDimension: 1024,
  jpegQuality: 80,
  videoMaxHeight: 720,
  videoCrf: 27,
  keepAudio: false,
  hardwareAcceleration: true,
  appearance: 'dark',
};

export interface Capabilities {
  heicSupported: boolean;
  ffmpegAvailable: boolean;
  /** Probed best video encoder (e.g. "h264_videotoolbox" or "libx264"). */
  videoEncoder: string;
  /** Bundled ffmpeg supports the HDR→SDR tonemap chain. */
  hdrTonemap: boolean;
  /** App version from package.json (shown in the sidebar). */
  appVersion: string;
}

export interface ScanPreview {
  inputDir: string;
  folderName: string;
  imageCount: number;
  videoCount: number;
  otherCount: number;
  totalFiles: number;
  totalBytes: number;
  /** ~5% of input, same estimate the engine's disk check uses. */
  estimatedOutputBytes: number;
  resolvedOutDir: string;
  unreadableCount: number;
}

/**
 * The save location and ZIP choice are made on the preview screen and travel
 * with the request ("Remember this choice" additionally writes them to the
 * Settings store as the new defaults). Processing parameters (dimensions,
 * quality, encoders…) still come from the persisted store, read by main at
 * start time — so settings changes apply to the NEXT run, never a run
 * already in progress.
 */
export interface StartRunRequest {
  inputDir: string;
  /** Parent folder for "{name}_lowres"; null = next to the source folder. */
  outputParentDir: string | null;
  createZip: boolean;
}

export type StartRunResult =
  | { started: true; outDir: string }
  | { started: false; reason: 'run-active' | 'user-cancelled' | 'error'; message?: string };

/** Engine ProgressEvent enriched by main with byte/file totals for ETA + weighting. */
export interface RunProgressMessage {
  event: ProgressEvent;
  bytesDone: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
}

export type RunDoneMessage =
  | { status: 'done'; summary: ShrinkSummary }
  | { status: 'cancelled' }
  | { status: 'error'; code: ShrinkErrorCode | 'UNKNOWN'; message: string };

/** The typed bridge preload exposes as window.iqShrink. */
export interface RendererApi {
  scanPreview(inputDir: string, outputParentDir: string | null): Promise<ScanPreview>;
  resolveOutDir(inputDir: string, outputParentDir: string | null): Promise<string>;
  startRun(request: StartRunRequest): Promise<StartRunResult>;
  cancelRun(): Promise<void>;
  onProgress(callback: (message: RunProgressMessage) => void): () => void;
  onDone(callback: (message: RunDoneMessage) => void): () => void;
  selectFolder(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  isDirectory(path: string): Promise<boolean>;
  getCapabilities(): Promise<Capabilities>;
  /** Sync: resolves a dropped File to its absolute path (Electron webUtils). */
  getPathForFile(file: File): string;
}
