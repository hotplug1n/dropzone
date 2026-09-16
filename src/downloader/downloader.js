import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { validateYoutubeUrl } from '../services/youtube.js';
import { buildCobaltPayload, validateSelection, OUTPUT_FORMATS } from './formats.js';
import { CobaltClient } from '../api/cobalt-client.js';
import { sanitizeFilename, uniquePath } from '../utils/filenames.js';
import {
  checkFfmpegAvailable,
  muxToMp4,
  remuxToMp4,
  extractToMp3,
  validateMp4File,
  validateMp3File,
} from '../ffmpeg/processor.js';
import { MediaUnavailableError, ProcessingError, FileSystemError } from '../errors/downloader-errors.js';

const noop = () => {};

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function cleanupFiles(paths) {
  await Promise.all(
    paths.map((p) => fs.rm(p, { force: true }).catch(() => {})),
  );
}

/**
 * Orchestrates a full download: validate → request from Cobalt-compatible
 * API → download tunnel(s) → post-process with FFmpeg → validate output.
 * This is the only module that ties the other layers together; it never
 * makes HTTP calls itself (that's CobaltClient's job) and never spawns
 * processes itself (that's the ffmpeg processor's job).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {'mp4'|'mp3'} opts.format
 * @param {string} [opts.quality] - required for mp4
 * @param {string} [opts.bitrate] - required for mp3
 * @param {object} opts.config - loaded config (see src/config/index.js)
 * @param {(step: string) => void} [opts.onProgress]
 */
export async function downloadYoutubeMedia({ url, format, quality, bitrate, config, onProgress = noop }) {
  onProgress('Validando URL...');
  const { normalizedUrl } = validateYoutubeUrl(url);
  validateSelection({ format, quality, bitrate });

  const ffmpegStatus = await checkFfmpegAvailable(config.ffmpegPath);
  if (!ffmpegStatus.available) {
    throw new ProcessingError('FFmpeg is not available on this system', {
      context: { ffmpegPath: config.ffmpegPath },
      cause: ffmpegStatus.error,
    });
  }

  await ensureDir(config.tempDir);
  await ensureDir(config.outputDir);

  const client = new CobaltClient({
    baseUrl: config.cobaltApiUrl,
    apiKey: config.cobaltApiKey,
    timeoutMs: config.downloadTimeoutMs,
    maxFileSizeBytes: config.maxFileSizeBytes,
    // Only ever set by tests, to allow a loopback fixture server; production
    // config never sets this, so the real SSRF guard always applies.
    ...(config.assertSafeUrl ? { assertSafeUrl: config.assertSafeUrl } : {}),
  });

  onProgress('Obtendo mídia...');
  const payload = buildCobaltPayload({ normalizedUrl, format, quality, bitrate });
  let result = await client.requestDownload(payload);

  if (result.kind === 'picker') {
    const wanted = format === OUTPUT_FORMATS.MP4 ? 'video' : 'video';
    const item = result.items.find((i) => i.type === wanted) || result.items[0];
    if (!item?.url) {
      throw new MediaUnavailableError('No usable item found in Cobalt picker response', {
        context: { items: result.items },
      });
    }
    result = { kind: 'redirect', urls: [item.url], filename: result.audioFilename || `${crypto.randomUUID()}` };
  }

  const jobId = crypto.randomUUID();
  const tempPaths = [];

  try {
    onProgress('Baixando...');
    const downloaded = [];
    for (let i = 0; i < result.urls.length; i++) {
      const tempPath = path.join(config.tempDir, `${jobId}-src${i}`);
      tempPaths.push(tempPath);
      await client.downloadToFile(result.urls[i], tempPath);
      downloaded.push(tempPath);
    }

    const baseName = sanitizeFilename(
      path.basename(result.filename || 'download', path.extname(result.filename || '')),
      format,
    );
    const finalPath = uniquePath(config.outputDir, baseName);
    const workingOutPath = path.join(config.tempDir, `${jobId}-out.${format}`);
    tempPaths.push(workingOutPath);

    if (format === OUTPUT_FORMATS.MP4) {
      onProgress('Processando...');
      if (downloaded.length === 2) {
        await muxToMp4({
          videoPath: downloaded[0],
          audioPath: downloaded[1],
          outPath: workingOutPath,
          ffmpegPath: config.ffmpegPath,
          timeoutMs: config.ffmpegTimeoutMs,
        });
      } else if (downloaded.length === 1) {
        await remuxToMp4({
          inputPath: downloaded[0],
          outPath: workingOutPath,
          ffmpegPath: config.ffmpegPath,
          timeoutMs: config.ffmpegTimeoutMs,
        });
      } else {
        throw new ProcessingError(`Unexpected number of source streams for MP4: ${downloaded.length}`, {
          context: { count: downloaded.length },
        });
      }

      onProgress('Finalizando...');
      await validateMp4File(workingOutPath, { ffprobePath: config.ffprobePath, expectAudio: true });
    } else {
      onProgress('Convertendo...');
      if (downloaded.length !== 1) {
        throw new ProcessingError(`Unexpected number of source streams for MP3: ${downloaded.length}`, {
          context: { count: downloaded.length },
        });
      }
      await extractToMp3({
        inputPath: downloaded[0],
        outPath: workingOutPath,
        bitrateKbps: bitrate,
        ffmpegPath: config.ffmpegPath,
        timeoutMs: config.ffmpegTimeoutMs,
      });

      onProgress('Finalizando...');
      await validateMp3File(workingOutPath, { ffprobePath: config.ffprobePath });
    }

    try {
      await fs.rename(workingOutPath, finalPath);
    } catch (cause) {
      throw new FileSystemError('Could not move finished file into the output directory', {
        context: { finalPath },
        cause,
      });
    }

    const stat = await fs.stat(finalPath);
    onProgress('Concluído.');
    return { path: finalPath, filename: path.basename(finalPath), sizeBytes: stat.size };
  } finally {
    await cleanupFiles(tempPaths);
  }
}
