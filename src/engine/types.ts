export type FileKind = 'image' | 'video' | 'other';

export interface ScannedFile {
  /** Absolute path of the source file. */
  absPath: string;
  /** Path relative to the input root, POSIX separators. */
  relPath: string;
  kind: FileKind;
  bytes: number;
}

export interface ScanResult {
  files: ScannedFile[];
  /** All non-junk directories (POSIX rel paths), so empty folders survive. */
  dirs: string[];
  /** Entries visible in the tree but not readable as regular files (broken/dir symlinks, fifos…). */
  unreadable: CopiedUnprocessed[];
  totalBytes: number;
}

export type ProgressEvent =
  | { type: 'scan'; totalFiles: number; totalBytes: number }
  | { type: 'file-start'; relPath: string; kind: FileKind }
  | { type: 'video-progress'; relPath: string; percent: number }
  | {
      type: 'file-done';
      relPath: string;
      outcome: 'processed' | 'copied-unprocessed';
      reason?: string;
      /** For processed videos: which encoder produced this output. */
      encoderUsed?: string;
    }
  | { type: 'zip-start'; zipPath: string }
  | { type: 'zip-done'; zipPath: string };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface CopiedUnprocessed {
  relPath: string;
  reason: string;
}

export interface ShrinkSummary {
  imagesProcessed: number;
  videosProcessed: number;
  /** Videos per encoder actually used, e.g. { h264_videotoolbox: 5, libx264: 1 }. */
  encoderUsage: Record<string, number>;
  copiedUnprocessed: CopiedUnprocessed[];
  inputBytes: number;
  outputBytes: number;
  percentSaved: number;
  elapsedMs: number;
  outputPath: string;
  zipPath?: string;
}

export interface ShrinkOptions {
  inputDir: string;
  /** Defaults to a sibling of inputDir named "{inputName}_lowres". */
  outDir?: string;
  zip?: boolean;
  overwrite?: boolean;
  /** Parallel image workers; videos always run one at a time. Default 4. */
  imageConcurrency?: number;
  /** Longest image side in px; never upscales. Default 1024. */
  imageMaxDimension?: number;
  /** JPEG output quality. Default 80. */
  jpegQuality?: number;
  /** Max video height in px; width scales to match (16:9 bound). Default 720. */
  videoMaxHeight?: number;
  /** x264 CRF; lower = higher quality. Default 27. */
  videoCrf?: number;
  /** Keep the audio track (re-encoded AAC) instead of stripping it. Default false. */
  keepAudio?: boolean;
  /**
   * Use the probed hardware encoder when available, with automatic per-file
   * fallback to libx264. Default true. false forces libx264.
   */
  hardwareAcceleration?: boolean;
  onProgress?: ProgressCallback;
  /**
   * Cooperative cancellation: aborting kills the active ffmpeg child, stops
   * scheduling new files, and makes runShrink reject with ShrinkError
   * code 'CANCELLED'. Partial output is left on disk — the CALLER is
   * responsible for deleting it (the Electron main process does).
   */
  signal?: AbortSignal;
}

export type ShrinkErrorCode =
  | 'INPUT_NOT_FOUND'
  | 'INPUT_NOT_DIRECTORY'
  | 'OUTPUT_EXISTS'
  | 'UNSAFE_OUTPUT'
  | 'INSUFFICIENT_DISK'
  | 'CANCELLED';

/** Run-level failure: the whole run aborts. Per-file failures never raise this. */
export class ShrinkError extends Error {
  constructor(
    readonly code: ShrinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShrinkError';
  }
}
