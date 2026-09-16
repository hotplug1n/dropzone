import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config/index.js';
import { downloadYoutubeMedia } from './downloader/downloader.js';
import { VIDEO_QUALITIES, AUDIO_BITRATES, OUTPUT_FORMATS } from './downloader/formats.js';
import { resolveSafePath } from './utils/filenames.js';
import { createRateLimiter, Semaphore } from './utils/rate-limiter.js';
import { DownloaderError } from './errors/downloader-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(cfg = config) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const limiter = createRateLimiter({
    windowMs: cfg.rateLimitWindowMs,
    max: cfg.rateLimitMaxRequests,
  });
  const downloadSemaphore = new Semaphore(cfg.maxConcurrentDownloads);

  app.get('/api/config', (_req, res) => {
    res.json({
      formats: Object.values(OUTPUT_FORMATS),
      videoQualities: VIDEO_QUALITIES,
      audioBitrates: AUDIO_BITRATES,
    });
  });

  app.get('/api/download-stream', limiter, async (req, res) => {
    const { url, format, quality, bitrate } = req.query;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    await downloadSemaphore.acquire();
    try {
      const result = await downloadYoutubeMedia({
        url: String(url || ''),
        format: String(format || ''),
        quality: quality ? String(quality) : undefined,
        bitrate: bitrate ? String(bitrate) : undefined,
        config: cfg,
        onProgress: (step) => send('progress', { step }),
      });

      send('done', {
        filename: result.filename,
        sizeBytes: result.sizeBytes,
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

  app.get('/files/:name', (req, res) => {
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
