import { heicSupported } from './imageProcessor';
import { detectVideoEncoding, ffmpegPath, VideoEncoder } from './videoProcessor';

export interface EngineCapabilities {
  heicSupported: boolean;
  ffmpegAvailable: boolean;
  /** Best usable video encoder on this machine (probed with a real encode). */
  videoEncoder: VideoEncoder;
  probedEncoders: { encoder: VideoEncoder; usable: boolean }[];
  /** HDR→SDR tonemap chain (zscale+tonemap) usable in the bundled ffmpeg. */
  hdrTonemap: boolean;
}

/**
 * Full engine capability report; encoder probes run once per process and are
 * cached (detectVideoEncoding).
 */
export async function engineCapabilities(): Promise<EngineCapabilities> {
  const ffmpegAvailable = ffmpegPath() !== null;
  const video = ffmpegAvailable
    ? await detectVideoEncoding()
    : { encoder: 'libx264' as VideoEncoder, probedEncoders: [], hdrTonemap: false };
  return {
    heicSupported: heicSupported(),
    ffmpegAvailable,
    videoEncoder: video.encoder,
    probedEncoders: video.probedEncoders,
    hdrTonemap: video.hdrTonemap,
  };
}
