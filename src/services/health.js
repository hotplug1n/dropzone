import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { CobaltClient } from '../api/cobalt-client.js';
import { checkFfmpegAvailable } from '../ffmpeg/processor.js';
import { validateConfig } from '../config/index.js';

const DEFAULT_CACHE_MS = 10_000;

async function checkStorage(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.health-${crypto.randomUUID()}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return { state: 'ready' };
  } catch (err) {
    return { state: 'unavailable', reason: err.message };
  }
}

async function checkCobalt(cfg, fetchImpl) {
  const configProblems = validateConfig(cfg);
  if (configProblems.length > 0) {
    return { state: 'misconfigured', reason: configProblems[0] };
  }

  try {
    const client = new CobaltClient({
      baseUrl: cfg.cobaltApiUrl,
      apiKey: cfg.cobaltApiKey,
      connectTimeoutMs: cfg.cobaltConnectTimeoutMs,
      retries: 0, // health checks must reflect the current instant, not a retried best-effort
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const info = await client.getInstanceInfo();
    const supportsYoutube = info.services.includes('youtube');
    return {
      state: supportsYoutube ? 'connected' : 'unsupported',
      version: info.version,
      services: info.services,
      reason: supportsYoutube ? undefined : 'A instância Cobalt configurada não tem o serviço "youtube" habilitado.',
    };
  } catch (err) {
    return { state: 'unavailable', reason: err.friendlyMessage || err.message };
  }
}

/**
 * Creates a health-check function with a short-lived cache for the Cobalt
 * probe (real network call), so a page load or status-bar poll doesn't
 * hammer the configured instance. FFmpeg/storage checks are cheap (local
 * process spawn / filesystem write) and are always run fresh.
 */
export function createHealthChecker(cfg, { cacheMs = DEFAULT_CACHE_MS, fetchImpl } = {}) {
  let cachedCobalt = null;
  let cachedAt = 0;

  return async function checkHealth() {
    const now = Date.now();
    if (!cachedCobalt || now - cachedAt > cacheMs) {
      cachedCobalt = await checkCobalt(cfg, fetchImpl);
      cachedAt = now;
    }

    const [ffmpeg, storage] = await Promise.all([
      checkFfmpegAvailable(cfg.ffmpegPath),
      checkStorage(cfg.outputDir),
    ]);

    return {
      cobalt: cachedCobalt,
      ffmpeg: ffmpeg.available ? { state: 'ready', version: ffmpeg.version } : { state: 'unavailable', reason: ffmpeg.error?.friendlyMessage },
      storage: storage.state === 'ready' ? { state: 'ready' } : storage,
    };
  };
}
