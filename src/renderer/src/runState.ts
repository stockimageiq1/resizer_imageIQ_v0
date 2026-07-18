import type { FileKind } from '../../engine/types';
import type { RunProgressMessage } from '../../shared/ipc';

export interface RunState {
  totalFiles: number;
  totalBytes: number;
  filesDone: number;
  bytesDone: number;
  imagesDone: number;
  videosDone: number;
  othersDone: number;
  copied: number;
  kinds: Record<string, FileKind>;
  activeVideo: { relPath: string; percent: number } | null;
  zipping: boolean;
  startedAt: number;
}

export function initialRunState(now: number): RunState {
  return {
    totalFiles: 0,
    totalBytes: 0,
    filesDone: 0,
    bytesDone: 0,
    imagesDone: 0,
    videosDone: 0,
    othersDone: 0,
    copied: 0,
    kinds: {},
    activeVideo: null,
    zipping: false,
    startedAt: now,
  };
}

export type RunAction = RunProgressMessage | { reset: number };

export function reduceRunState(state: RunState, action: RunAction): RunState {
  if ('reset' in action) return initialRunState(action.reset);
  const message = action;
  const { event } = message;
  const next: RunState = {
    ...state,
    filesDone: message.filesDone,
    bytesDone: message.bytesDone,
    totalFiles: message.totalFiles,
    totalBytes: message.totalBytes,
  };
  switch (event.type) {
    case 'scan':
      break;
    case 'file-start':
      next.kinds = { ...state.kinds, [event.relPath]: event.kind };
      if (event.kind === 'video') next.activeVideo = { relPath: event.relPath, percent: 0 };
      break;
    case 'video-progress':
      next.activeVideo = { relPath: event.relPath, percent: event.percent };
      break;
    case 'file-done': {
      const kind = state.kinds[event.relPath] ?? 'other';
      if (kind === 'image') next.imagesDone = state.imagesDone + 1;
      else if (kind === 'video') next.videosDone = state.videosDone + 1;
      else next.othersDone = state.othersDone + 1;
      if (event.outcome === 'copied-unprocessed') next.copied = state.copied + 1;
      if (state.activeVideo?.relPath === event.relPath) next.activeVideo = null;
      break;
    }
    case 'zip-start':
      next.zipping = true;
      break;
    case 'zip-done':
      next.zipping = false;
      break;
  }
  return next;
}

/** Files done / total, with the active video contributing its own percent. */
export function overallFraction(state: RunState): number {
  if (state.totalFiles === 0) return 0;
  const units = state.filesDone + (state.activeVideo !== null ? state.activeVideo.percent / 100 : 0);
  return Math.min(1, units / state.totalFiles);
}

/** Rough ETA extrapolated from bytes processed; null until it means something. */
export function etaMs(state: RunState, nowMs: number): number | null {
  const elapsed = nowMs - state.startedAt;
  if (elapsed < 2000 || state.bytesDone <= 0 || state.totalBytes <= 0) return null;
  const rate = state.bytesDone / elapsed;
  if (rate <= 0) return null;
  return (state.totalBytes - state.bytesDone) / rate;
}
