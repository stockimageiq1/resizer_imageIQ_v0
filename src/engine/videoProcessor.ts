import { spawn } from 'node:child_process';
import * as path from 'node:path';
import ffmpegBinary from 'ffmpeg-static';

export const VIDEO_MAX_WIDTH = 1280;
export const VIDEO_MAX_HEIGHT = 720;
export const DEFAULT_VIDEO_CRF = 27;

export type VideoEncoder = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';

export interface VideoOptions {
  /** Max output height in px; width scales to match (16:9 bound). Default VIDEO_MAX_HEIGHT. */
  maxHeight?: number;
  /** Quality on the libx264 CRF scale; mapped per encoder (see encoderArgs). Default DEFAULT_VIDEO_CRF. */
  crf?: number;
  /** Keep the audio track (re-encoded AAC) instead of stripping it. Default false. */
  keepAudio?: boolean;
  /** Encoder to use. Default libx264. Callers should pick via detectVideoEncoding(). */
  encoder?: VideoEncoder;
  /** Whether the bundled ffmpeg supports the zscale+tonemap chain (from detection). */
  tonemapSupported?: boolean;
}

export interface VideoEncodingCapabilities {
  /** Best usable encoder on this machine (first usable candidate). */
  encoder: VideoEncoder;
  /** Every probed candidate with its probe outcome. */
  probedEncoders: { encoder: VideoEncoder; usable: boolean }[];
  /** zscale+tonemap HDR→SDR chain usable in the bundled ffmpeg build. */
  hdrTonemap: boolean;
}

export interface VideoAnalysis {
  /** HDR/wide-gamut source (smpte2084/arib-std-b67 transfer or bt2020 primaries). */
  hdr: boolean;
  /** Variable frame rate source (fps vs tbr mismatch heuristic). */
  vfr: boolean;
  /** Parsed average fps when available (CFR target for VFR sources). */
  fps: number | null;
}

export function ffmpegPath(): string | null {
  if (ffmpegBinary === null) return null;
  // Packaged Electron: binaries cannot be spawned from inside the asar
  // archive. ffmpeg-static is asarUnpack'd, but its module resolves the
  // virtual asar path — rewrite to the real unpacked location. No-op in dev.
  return ffmpegBinary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * Encoder + rate-control settings live in this one function (per-encoder).
 *
 * The configured quality value is on the libx264 CRF scale (18–35 in the UI).
 * CRF only exists for libx264; for hardware encoders it is mapped to each
 * encoder's rate-control idiom, aiming for visually comparable output:
 *
 * - libx264:            -crf N. The reference scale.
 * - h264_videotoolbox:  no CRF support; constant-quality via -q:v 1–100
 *                       (higher = better). Mapped q = 100 − 2·CRF
 *                       (18→64, 27→46, 35→30) — an approximately linear
 *                       parity heuristic in the 18–35 band.
 * - h264_nvenc:         -rc vbr -cq N -b:v 0. NVENC's CQ shares the 0–51
 *                       shape of CRF; the same number lands close to x264,
 *                       so CQ = CRF.
 * - h264_qsv:           -global_quality N (enables ICQ mode), also a
 *                       CRF-like scale → global_quality = CRF.
 * - h264_amf:           -rc cqp -qp_i N -qp_p N. Constant QP; QP ≈ CRF is a
 *                       rough proxy (AMF has no true CRF/ICQ mode).
 */
export function encoderArgs(crf: number = DEFAULT_VIDEO_CRF, encoder: VideoEncoder = 'libx264'): string[] {
  switch (encoder) {
    case 'libx264':
      return ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox': {
      const q = Math.max(1, Math.min(100, 100 - 2 * crf));
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(q), '-pix_fmt', 'yuv420p'];
    }
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(crf), '-pix_fmt', 'yuv420p'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p'];
  }
}

/** Candidate chain per platform; libx264 is always the final fallback. */
export function encoderCandidates(platform: NodeJS.Platform = process.platform): VideoEncoder[] {
  if (platform === 'darwin') return ['h264_videotoolbox', 'libx264'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
  return ['libx264'];
}

/**
 * Output keeps the ORIGINAL extension (downstream CSV matching is keyed by
 * exact file name), so the muxer must be forced per extension — ffmpeg's
 * extension guess is wrong for some (".m4v" would pick the raw MPEG-4 muxer).
 */
const MUXER_BY_EXT: Record<string, { format: string; faststart: boolean }> = {
  '.mov': { format: 'mov', faststart: true },
  '.mp4': { format: 'mp4', faststart: true },
  '.m4v': { format: 'mp4', faststart: true },
  '.mkv': { format: 'matroska', faststart: false },
  '.avi': { format: 'avi', faststart: false },
  '.mts': { format: 'mpegts', faststart: false },
  '.m2ts': { format: 'mpegts', faststart: false },
};

// min(target, input) keeps smaller videos at their original resolution
// (never upscale); force_original_aspect_ratio picks the tighter fit;
// force_divisible_by=2 rounds to even dimensions, which H.264 yuv420p
// requires — this covers odd-dimension inputs on BOTH the HW and SW paths
// (the same -vf chain feeds every encoder). Width is derived from height at
// 16:9 so the default (720) stays exactly the original 1280x720 bound.
function scaleFilter(maxHeight: number): string {
  const maxWidth = Math.round((maxHeight * 16) / 9 / 2) * 2;
  return (
    `scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':` +
    'force_original_aspect_ratio=decrease:force_divisible_by=2'
  );
}

// HDR (PQ/HLG) or bt2020 → SDR bt709, the canonical zscale recipe: linearize
// (npl=100 nominal peak), go to float RGB, convert primaries to bt709,
// tonemap with hable, then set bt709 transfer/matrix/tv-range. Requires
// libzimg in the ffmpeg build — verified at detection time with a real
// filter run (probeTonemap); the naive single-zscale form fails on this
// build with "no path between colorspaces".
const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,' +
  'zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

// lavfi frames are untagged, which zscale rejects — the probe tags them as
// PQ/bt2020 first so it exercises the exact chain real HDR footage hits
const TONEMAP_PROBE_CHAIN =
  `setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,${TONEMAP_CHAIN}`;

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;

function hmsToSeconds(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function lastLines(text: string, n = 4): string {
  return text.trim().split('\n').slice(-n).join(' | ').slice(0, 400);
}

/** Run ffmpeg to completion, collecting stderr; kills on timeout. */
function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  const bin = ffmpegPath();
  if (bin === null) return Promise.reject(new Error('bundled ffmpeg binary not found'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16384);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * A tiny REAL encode: a few black frames through the actual encoder into the
 * null muxer. `-encoders` listing alone is not sufficient — an encoder can be
 * listed but fail at runtime without the right driver/hardware.
 */
async function probeEncoder(encoder: VideoEncoder): Promise<boolean> {
  try {
    const result = await runFfmpeg(
      [
        '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10:d=0.3',
        '-frames:v', '3',
        ...encoderArgs(DEFAULT_VIDEO_CRF, encoder),
        '-an', '-f', 'null', '-',
      ],
      10000,
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function probeTonemap(): Promise<boolean> {
  try {
    const result = await runFfmpeg(
      [
        '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=5:d=0.2',
        '-vf', TONEMAP_PROBE_CHAIN,
        '-frames:v', '1',
        '-f', 'null', '-',
      ],
      10000,
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

let detectionCache: Promise<VideoEncodingCapabilities> | null = null;

/**
 * Probe the platform's encoder candidates (real tiny encodes) and the HDR
 * tonemap chain. Cached for the process lifetime.
 */
export function detectVideoEncoding(): Promise<VideoEncodingCapabilities> {
  detectionCache ??= (async () => {
    const probedEncoders: { encoder: VideoEncoder; usable: boolean }[] = [];
    let selected: VideoEncoder = 'libx264';
    let found = false;
    for (const candidate of encoderCandidates()) {
      const usable = await probeEncoder(candidate);
      probedEncoders.push({ encoder: candidate, usable });
      if (usable && !found) {
        selected = candidate;
        found = true;
      }
    }
    return { encoder: selected, probedEncoders, hdrTonemap: await probeTonemap() };
  })();
  return detectionCache;
}

/**
 * Read stream properties from `ffmpeg -i` stderr (ffmpeg-static bundles no
 * ffprobe, and adding one would mean another binary to asarUnpack in the
 * packaged build — parsing stderr avoids that).
 */
export async function analyzeVideo(src: string): Promise<VideoAnalysis> {
  const result = await runFfmpeg(['-i', src], 8000); // exits non-zero (no output file); info is on stderr
  const videoLine = result.stderr.split('\n').find((line) => /Stream #.*Video:/.test(line)) ?? '';
  const hdr = /smpte2084|arib-std-b67|bt2020/.test(videoLine);
  const fpsMatch = /([\d.]+) fps/.exec(videoLine);
  const tbrMatch = /([\d.]+) tbr/.exec(videoLine);
  const fps = fpsMatch?.[1] !== undefined ? Number(fpsMatch[1]) : null;
  const tbr = tbrMatch?.[1] !== undefined ? Number(tbrMatch[1]) : null;
  // VFR heuristic: ffmpeg reports average fps and timebase-derived tbr;
  // a clear mismatch (beyond rounding noise) indicates variable frame rate.
  const vfr = fps !== null && tbr !== null && Math.abs(fps - tbr) > 0.05 * Math.max(fps, tbr);
  return { hdr, vfr, fps };
}

export function processVideo(
  src: string,
  dest: string,
  onPercent?: (percent: number) => void,
  signal?: AbortSignal,
  options?: VideoOptions,
): Promise<void> {
  const bin = ffmpegPath();
  if (bin === null) return Promise.reject(new Error('bundled ffmpeg binary not found'));

  const muxer = MUXER_BY_EXT[path.extname(dest).toLowerCase()];
  if (muxer === undefined) return Promise.reject(new Error(`no muxer mapping for ${dest}`));

  const encoder = options?.encoder ?? 'libx264';
  const audioArgs = options?.keepAudio === true ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'];

  return (async () => {
    const analysis = await analyzeVideo(src);
    if (signal?.aborted === true) throw new Error('cancelled');

    const applyTonemap = analysis.hdr && options?.tonemapSupported === true;
    const filterChain = applyTonemap
      ? `${scaleFilter(options?.maxHeight ?? VIDEO_MAX_HEIGHT)},${TONEMAP_CHAIN}`
      : scaleFilter(options?.maxHeight ?? VIDEO_MAX_HEIGHT);

    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i', src,
      '-vf', filterChain,
      ...encoderArgs(options?.crf ?? DEFAULT_VIDEO_CRF, encoder),
      // tag tonemapped output as the bt709 it now is
      ...(applyTonemap ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
      // VFR sources only: force CFR at the reported average rate so the
      // downstream thumbnail/AI pipeline sees constant timing. CFR inputs
      // pass through untouched — never blanket-forced.
      ...(analysis.vfr && analysis.fps !== null ? ['-fps_mode', 'cfr', '-r', String(Math.max(1, Math.round(analysis.fps)))] : []),
      ...(muxer.faststart ? ['-movflags', '+faststart'] : []),
      ...audioArgs,
      '-f', muxer.format,
      dest,
    ];

    await new Promise<void>((resolve, reject) => {
      // signal makes Node kill the ffmpeg child on abort and reject via 'error'
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(signal ? { signal } : {}) });
      let durationSec: number | null = null;
      let tail = '';

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        // keep a rolling tail so matches split across chunks still resolve,
        // and so failures can report ffmpeg's actual complaint
        tail = (tail + chunk).slice(-8192);
        if (durationSec === null) {
          const d = DURATION_RE.exec(tail);
          if (d?.[1] !== undefined && d[2] !== undefined && d[3] !== undefined) {
            durationSec = hmsToSeconds(d[1], d[2], d[3]);
          }
        }
        if (onPercent !== undefined && durationSec !== null && durationSec > 0) {
          let last: RegExpExecArray | null = null;
          TIME_RE.lastIndex = 0;
          for (let m = TIME_RE.exec(tail); m !== null; m = TIME_RE.exec(tail)) last = m;
          if (last?.[1] !== undefined && last[2] !== undefined && last[3] !== undefined) {
            const t = hmsToSeconds(last[1], last[2], last[3]);
            onPercent(Math.max(0, Math.min(100, (t / durationSec) * 100)));
          }
        }
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          onPercent?.(100);
          resolve();
        } else {
          reject(new Error(`ffmpeg (${encoder}) exited with code ${code}: ${lastLines(tail)}`));
        }
      });
    });
  })();
}
