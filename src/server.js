import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, validateConfig } from './config/index.js';
import { downloadYoutubeMedia } from './downloader/downloader.js';
import { VIDEO_QUALITIES, AUDIO_BITRATES, OUTPUT_FORMATS } from './downloader/formats.js';
import { resolveSafePath } from './utils/filenames.js';
import { createRateLimiter, Semaphore } from './utils/rate-limiter.js';
import { DownloaderError } from './errors/downloader-errors.js';
import { createHealthChecker } from './services/health.js';
import { inspectYoutubeUrl } from './services/inspect.js';
import { recordDownload, listHistory } from './services/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(cfg = config) {
  const app = express();

  if (cfg.trustProxy) app.set('trust proxy', true);

  const configProblems = validateConfig(cfg);
  if (configProblems.length > 0) {
    // Never crash on a bad/missing COBALT_API_URL: the UI must still load so
    // it can show a clear "cobalt :: misconfigured" status instead of dying
    // silently. Every download attempt will still fail fast and explicitly
    // (CobaltClient throws ConfigurationError), never pretending to work.
    for (const problem of configProblems) {
      console.error(`[dropzone] configuration problem: ${problem}`); // eslint-disable-line no-console
    }
  }

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const limiter = createRateLimiter({
    windowMs: cfg.rateLimitWindowMs,
    max: cfg.rateLimitMaxRequests,
  });
  const downloadSemaphore = new Semaphore(cfg.maxConcurrentDownloads);
  const checkHealth = createHealthChecker(cfg);

  app.get('/api/config', (_req, res) => {
    res.json({
      formats: Object.values(OUTPUT_FORMATS),
      videoQualities: VIDEO_QUALITIES,
      audioBitrates: AUDIO_BITRATES,
      defaults: { format: 'mp4', quality: 'best', bitrate: '192' },
    });
  });

  app.get('/api/health', async (_req, res) => {
    const health = await checkHealth();
    res.json(health);
  });

  app.post('/api/inspect', limiter, async (req, res) => {
    const controller = new AbortController();
    // res 'close' (not req 'close'!) fires when the underlying connection
    // ends. req 'close' fires as soon as the request body is fully read —
    // well before the response is sent — and would abort every request
    // almost immediately. The writableEnded guard distinguishes "client
    // actually disconnected early" from "we already finished normally".
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const info = await inspectYoutubeUrl({ url: String(req.body?.url || ''), config: cfg, signal: controller.signal });
      res.json(info);
    } catch (err) {
      if (err instanceof DownloaderError) {
        res.status(400).json(err.toJSON());
        return;
      }
      console.error('Unexpected error in /api/inspect:', err); // eslint-disable-line no-console
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Não foi possível inspecionar a URL.' });
    }
  });

  app.get('/api/history', async (_req, res) => {
    const history = await listHistory(cfg.dataDir);
    res.json({ history });
  });

  app.get('/api/download-stream', limiter, async (req, res) => {
    const { url, format, quality, bitrate } = req.query;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // If the browser closes the EventSource (navigates away, cancels),
    // abort in-flight Cobalt requests and ffmpeg processes instead of
    // burning CPU/bandwidth/disk on work nobody will ever see. Must be
    // res 'close' (guarded by writableEnded), not req 'close' — see the
    // /api/inspect handler above for why req 'close' fires far too early.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    await downloadSemaphore.acquire();
    try {
      const result = await downloadYoutubeMedia({
        url: String(url || ''),
        format: String(format || ''),
        quality: quality ? String(quality) : undefined,
        bitrate: bitrate ? String(bitrate) : undefined,
        config: cfg,
        signal: controller.signal,
        onProgress: (progress) => send('progress', progress),
      });

      try {
        await recordDownload(cfg.dataDir, result, cfg.historyLimit);
      } catch (historyErr) {
        // History is a convenience, not the point of the download — never
        // fail a successful download because the history log couldn't be
        // written, but never hide the problem either.
        console.error('Failed to record download history:', historyErr); // eslint-disable-line no-console
      }

      send('done', {
        filename: result.filename,
        sizeBytes: result.sizeBytes,
        format: result.format,
        quality: result.quality,
        bitrate: result.bitrate,
        downloadUrl: `/files/${encodeURIComponent(result.filename)}`,
      });
    } catch (err) {
      if (err instanceof DownloaderError) {
        send('error', err.toJSON());
      } else {
        // Never leak stack traces or internal details to the client.
        send('error', { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir o download.' });
        console.error('Unexpected error in /api/download-stream:', err); // eslint-disable-line no-console
      }
    } finally {
      downloadSemaphore.release();
      res.end();
    }
  });

  app.get('/files/:name', limiter, (req, res) => {
    let safePath;
    try {
      safePath = resolveSafePath(cfg.outputDir, req.params.name);
    } catch {
      res.status(400).json({ code: 'INVALID_FILENAME', message: 'Nome de arquivo inválido.' });
      return;
    }
    res.download(safePath, req.params.name, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Arquivo não encontrado.' });
      }
    });
  });

  // Centralized fallback error handler: never sends stack traces to clients.
  app.use((err, _req, res, _next) => {
    if (err instanceof DownloaderError) {
      res.status(400).json(err.toJSON());
      return;
    }
    console.error('Unhandled error:', err); // eslint-disable-line no-console
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Dropzone listening on http://localhost:${config.port}`); // eslint-disable-line no-console
  });
}
