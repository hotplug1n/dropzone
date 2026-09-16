import { InvalidOptionsError } from '../errors/downloader-errors.js';

export const OUTPUT_FORMATS = Object.freeze({
  MP4: 'mp4',
  MP3: 'mp3',
});

// Qualities exposed to the UI. "best" maps to Cobalt's "max".
export const VIDEO_QUALITIES = Object.freeze([
  '144', '360', '480', '720', '1080', '1440', '2160', 'best',
]);

export const AUDIO_BITRATES = Object.freeze(['128', '192', '256', '320']);

export function validateSelection({ format, quality, bitrate }) {
  if (!Object.values(OUTPUT_FORMATS).includes(format)) {
    throw new InvalidOptionsError(`Unsupported output format: ${format}`, {
      context: { format, allowed: Object.values(OUTPUT_FORMATS) },
    });
  }

  if (format === OUTPUT_FORMATS.MP4) {
    if (!VIDEO_QUALITIES.includes(String(quality))) {
      throw new InvalidOptionsError(`Unsupported video quality: ${quality}`, {
        context: { quality, allowed: VIDEO_QUALITIES },
      });
    }
  }

  if (format === OUTPUT_FORMATS.MP3) {
    if (!AUDIO_BITRATES.includes(String(bitrate))) {
      throw new InvalidOptionsError(`Unsupported audio bitrate: ${bitrate}`, {
        context: { bitrate, allowed: AUDIO_BITRATES },
      });
    }
  }
}

/**
 * Builds the request body for a Cobalt-compatible API, matching the schema
 * documented in cobalt's docs/api.md (POST /). Only fields relevant to
 * MP4/MP3 YouTube downloads are set; everything else is left at the
 * server's documented defaults.
 */
export function buildCobaltPayload({ normalizedUrl, format, quality, bitrate }) {
  validateSelection({ format, quality, bitrate });

  if (format === OUTPUT_FORMATS.MP4) {
    return {
      url: normalizedUrl,
      downloadMode: 'auto',
      videoQuality: quality === 'best' ? 'max' : quality,
      youtubeVideoCodec: 'h264',
      youtubeVideoContainer: 'mp4',
    };
  }

  // MP3
  return {
    url: normalizedUrl,
    downloadMode: 'audio',
    audioFormat: 'mp3',
    audioBitrate: bitrate,
  };
}
