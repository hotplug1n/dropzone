import { ConfigurationError } from '../errors/downloader-errors.js';

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new ConfigurationError(`Environment variable ${name} must be an integer, got "${raw}"`, {
      context: { variable: name, value: raw },
    });
  }
  return n;
}

export function loadConfig(env = process.env) {
  return {
    // Base URL of a Cobalt-compatible API instance. Must be a self-hosted or
    // explicitly authorized instance — never defaults to a public one.
    cobaltApiUrl: env.COBALT_API_URL || '',
    cobaltApiKey: env.COBALT_API_KEY || '',

    downloadTimeoutMs: intFromEnv('DOWNLOAD_TIMEOUT', 120_000),
    ffmpegTimeoutMs: intFromEnv('FFMPEG_TIMEOUT', 300_000),

    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',

    maxFileSizeBytes: intFromEnv('MAX_FILE_SIZE', 1024 * 1024 * 1024), // 1 GiB default
    outputDir: env.OUTPUT_DIR || './downloads',
    tempDir: env.TEMP_DIR || './tmp',

    port: intFromEnv('PORT', 8080),

    maxConcurrentDownloads: intFromEnv('MAX_CONCURRENT_DOWNLOADS', 3),
    rateLimitWindowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMaxRequests: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 10),
  };
}

export const config = loadConfig();
