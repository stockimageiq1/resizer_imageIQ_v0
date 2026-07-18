export { runShrink } from './engine';
export { engineCapabilities, type EngineCapabilities } from './capabilities';
export {
  heicSupported,
  processImage,
  MAX_IMAGE_DIMENSION,
  DEFAULT_JPEG_QUALITY,
  type ImageOptions,
} from './imageProcessor';
export {
  analyzeVideo,
  detectVideoEncoding,
  encoderArgs,
  encoderCandidates,
  ffmpegPath,
  processVideo,
  VIDEO_MAX_HEIGHT,
  VIDEO_MAX_WIDTH,
  DEFAULT_VIDEO_CRF,
  type VideoAnalysis,
  type VideoEncoder,
  type VideoEncodingCapabilities,
  type VideoOptions,
} from './videoProcessor';
export * from './types';
