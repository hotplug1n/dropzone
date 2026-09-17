import { ConfigurationError } from '../errors/downloader-errors.js';

function intFromEnv(name, fallback, { min } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new ConfigurationError(`Environment variable ${name} must be an integer, got "${raw}"`, {
      context: { variable: name, value: raw },
    });
  }
  if (min !== undefined && n < min) {
    throw new ConfigurationError(`Environment variable ${name} must be >= ${min}, got ${n}`, {
      context: { variable: name, value: n, min },
    });
  }
  return n;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(env = process.env) {
  return {
    // Base URL of a Cobalt-compatible API instance. Must be a self-hosted or
    // explicitly authorized instance — never defaults to a public one.
    cobaltApiUrl: env.COBALT_API_URL || '',
    cobaltApiKey: env.COBALT_API_KEY || '',

    // Timeout for the metadata/tunnel-request call (POST / and the health
    // check GET /) — this is a small JSON exchange, so it should fail fast.
    cobaltConnectTimeoutMs: intFromEnv('COBALT_CONNECT_TIMEOUT', 10_000, { min: 1 }),
    // Timeout for actually transferring the media file(s) from the tunnel/
    // redirect URL — this can legitimately take much longer than the
    // metadata call for large/long videos, so it gets its own budget.
    cobaltRequestTimeoutMs: intFromEnv('COBALT_REQUEST_TIMEOUT', 180_000, { min: 1 }),
    // Number of retries for the metadata call only (network errors, timeouts,
    // 5xx). Byte-streaming downloads are never blindly retried mid-transfer.
    cobaltRetries: intFromEnv('COBALT_RETRIES', 2, { min: 0 }),

    ffmpegTimeoutMs: intFromEnv('FFMPEG_TIMEOUT', 600_000, { min: 1 }),

    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',

    maxFileSizeBytes: intFromEnv('MAX_FILE_SIZE', 1024 * 1024 * 1024, { min: 1 }), // 1 GiB default
    outputDir: env.OUTPUT_DIR || './downloads',
    tempDir: env.TEMP_DIR || './tmp',
    dataDir: env.DATA_DIR || './data',
    historyLimit: intFromEnv('HISTORY_LIMIT', 200, { min: 1 }),

    port: intFromEnv('PORT', 8080, { min: 1 }),
    // Set to 1/true only when Dropzone runs behind a trusted reverse proxy
    // that sets X-Forwarded-For; otherwise req.ip stays the real socket
    // address and cannot be spoofed by a client-supplied header.
    trustProxy: boolFromEnv('TRUST_PROXY', false),

    maxConcurrentDownloads: intFromEnv('MAX_CONCURRENT_DOWNLOADS', 3, { min: 1 }),
    rateLimitWindowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1 }),
    rateLimitMaxRequests: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 10, { min: 1 }),
  };
}

/**
 * Validates configuration that is only knowable at startup (as opposed to
 * shape/type checks already done by loadConfig). Returns a list of
 * human-readable problems instead of throwing, so the server can still
 * start and report a clear status via /api/health rather than crashing
 * silently or refusing to serve the UI at all.
 */
export function validateConfig(cfg) {
  const problems = [];

  if (!cfg.cobaltApiUrl) {
    problems.push('COBALT_API_URL não está configurada. Aponte para uma instância Cobalt própria ou explicitamente autorizada.');
  } else {
    try {
      const parsed = new URL(cfg.cobaltApiUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`COBALT_API_URL deve usar http(s), recebido: ${parsed.protocol}`);
      }
    } catch {
      problems.push(`COBALT_API_URL não é uma URL válida: "${cfg.cobaltApiUrl}"`);
    }
  }

  return problems;
}

export const config = loadConfig();
