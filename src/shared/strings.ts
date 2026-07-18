import type { ShrinkErrorCode } from '../engine/types';

/**
 * ALL user-facing strings (renderer UI + main-process native dialogs).
 * A Slovenian translation is a single-file change: translate this file.
 */
export const STR = {
  appName: 'IQ Shrink',
  tagline: 'lowres proxies for STOCK IMAGEIQ',

  banners: {
    noHeic: 'HEIC decoding is unavailable on this machine — HEIC files will be copied unprocessed.',
    noFfmpeg: 'Bundled ffmpeg is missing — videos will be copied unprocessed.',
  },

  drop: {
    title: 'Drag your project folder here',
    subtitle: 'The folder name becomes the project name.',
    chooseFolder: 'Choose Folder…',
    scanning: 'Scanning…',
    singleFolderHint: 'Drop a single folder — the folder name becomes the project name.',
    readError: (detail: string): string => `Could not read that folder: ${detail}`,
  },

  preview: {
    back: '← choose a different folder',
    images: 'Images',
    videos: 'Videos',
    otherFiles: 'Other files',
    totalSize: 'Total size',
    estimatedOutput: 'Estimated output',
    files: 'Files',
    estimatedPrefix: '~',
    unreadableNote: (count: number): string =>
      `${count} ${count === 1 ? 'entry' : 'entries'} (symlinks/special files) will be reported, not processed.`,
    createZip: 'Create ZIP for upload',
    outputLabel: 'Output:',
    changeLocation: 'Change…',
    resetLocation: 'Reset to default',
    start: 'Prepare for upload',
    emptyFolder: 'This folder has no processable files.',
  },

  running: {
    filesLine: (done: number, total: number, percent: number): string => `${done}/${total} files · ${percent}%`,
    elapsedLine: (elapsed: string, eta: string | null): string =>
      `${elapsed} elapsed${eta !== null ? ` · ~${eta} left` : ''}`,
    imagesLine: (done: number, total: number): string => `Images: ${done}/${total}`,
    othersLine: (done: number, total: number): string => `other files: ${done}/${total}`,
    copiedLine: (count: number): string => `copied unprocessed: ${count}`,
    videosLine: (done: number, total: number): string => `Videos: ${done}/${total}`,
    zipping: 'Creating ZIP…',
    cancelling: 'Cancelling — cleaning up partial output…',
    cancel: 'Cancel',
    cancelConfirm: 'Stop the run and delete the partial output?',
    cancelYes: 'Yes, cancel',
    cancelNo: 'Keep going',
  },

  done: {
    headline: (from: string, to: string, percent: string): string => `${from} → ${to} (${percent}% smaller)`,
    elapsed: (duration: string): string => `Done in ${duration}`,
    counts: (images: number, videos: number): string => `${images} images · ${videos} videos processed`,
    copiedWarningTitle: 'These files could not be converted and were copied as-is',
    showInFolder: 'Show in Folder',
    startAnother: 'Start another',
  },

  cancelled: {
    title: 'Run cancelled',
    body: 'The partial lowres output was deleted. Your originals are untouched.',
    back: 'Back to start',
  },

  errors: {
    title: 'Something went wrong',
    back: 'Back to start',
    technicalDetail: (raw: string): string => `Technical detail: ${raw}`,
    map: {
      INPUT_NOT_FOUND: {
        message: 'That folder can’t be found anymore.',
        action: 'Check that the folder still exists (and isn’t on a disconnected drive), then try again.',
      },
      INPUT_NOT_DIRECTORY: {
        message: 'The selected item isn’t a folder.',
        action: 'Choose the project folder itself, not a file inside it.',
      },
      OUTPUT_EXISTS: {
        message: 'The output folder or ZIP already exists.',
        action: 'Start again and choose Overwrite or Keep Both when asked.',
      },
      UNSAFE_OUTPUT: {
        message: 'The output location would overlap the source folder.',
        action: 'Pick an output location outside the folder you are converting (Settings → Default output location).',
      },
      INSUFFICIENT_DISK: {
        message: 'There isn’t enough free disk space at the output location.',
        action: 'Free up some space or choose a different output location, then run again.',
      },
      CANCELLED: {
        message: 'The run was cancelled.',
        action: 'Start the run again when you are ready.',
      },
      UNKNOWN: {
        message: 'Something unexpected went wrong.',
        action: 'Try again; if it keeps happening, check the technical detail below.',
      },
    } satisfies Record<ShrinkErrorCode | 'UNKNOWN', { message: string; action: string }>,
  },

  settings: {
    open: 'Settings',
    title: 'Settings',
    sectionImages: 'Images',
    sectionVideos: 'Videos',
    sectionOutput: 'Output',
    imageMaxDimension: 'Max dimension (px)',
    imageMaxDimensionHint: 'Longest side, 256–4096. Images are never upscaled.',
    jpegQuality: 'JPEG quality',
    jpegQualityHint: '40–95.',
    videoMaxHeight: 'Max height (px)',
    videoMaxHeightHint: '240–2160 — width scales to match (16:9 bound).',
    videoCrf: 'CRF (quality)',
    videoCrfHint: '18–35 — lower means higher quality and larger files.',
    keepAudio: 'Keep audio track',
    hardwareAcceleration: 'Hardware acceleration',
    hardwareAccelerationHint: 'Uses the GPU encoder when available; falls back to software automatically.',
    createZipDefault: 'Create ZIP by default',
    outputLocation: 'Default output location',
    outputLocationDefault: 'Next to the source folder',
    changeLocation: 'Change…',
    resetLocation: 'Reset',
    appliesNextRun: 'Changes apply to the next run.',
    resetAll: 'Reset to defaults',
    save: 'Save',
    cancel: 'Cancel',
  },

  dialogs: {
    collision: {
      message: (name: string): string => `“${name}” already exists`,
      detail:
        'Overwrite deletes the existing lowres output (and zip) and recreates it from scratch. ' +
        'Keep Both writes to a numbered folder instead. Your originals are never touched.',
      overwrite: 'Overwrite',
      keepBoth: 'Keep Both',
      cancel: 'Cancel',
    },
    runActive: 'A run is already in progress.',
    notAFolder: (path: string): string => `Not a folder: ${path}`,
    folderNotFound: (path: string): string => `Folder not found: ${path}`,
    unsafeOutput: 'The output location must be outside the input folder. Pick a different output location.',
    startFailed: 'Could not start the run.',
  },
} as const;
