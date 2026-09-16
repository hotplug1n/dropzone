import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { assertSafeRemoteUrl } from '../utils/security.js';
import {
  ApiError,
  AuthenticationError,
  RateLimitError,
  MediaUnavailableError,
  DownloadError,
  TimeoutError,
  ConfigurationError,
  SecurityError,
} from '../errors/downloader-errors.js';

// Cobalt error codes are namespaced strings such as "error.api.auth.key.missing",
// "content.video.private", "youtube.no_matching_format" (confirmed by reading
// api/src/processing/request.js and api/src/processing/services/youtube.js in
// the imputnet/cobalt repository). We classify by prefix/substring rather than
// hard-coding every code, since the exact catalogue can grow.
function classifyApiError(code, httpStatus) {
  const c = String(code || '');

  if (httpStatus === 401 || c.includes('auth')) {
    return new AuthenticationError(`Cobalt API authentication error: ${c}`, {
      context: { code: c, httpStatus },
    });
  }
  if (httpStatus === 429 || c.includes('rate')) {
    return new RateLimitError(`Cobalt API rate limit: ${c}`, {
      context: { code: c, httpStatus },
    });
  }
  if (
    c.startsWith('content.') ||
    c.includes('private') ||
    c.includes('unavailable') ||
    c.includes('age') ||
    c.includes('region') ||
    c.includes('live') ||
    c.includes('drm') ||
    c.includes('too_long')
  ) {
    return new MediaUnavailableError(`Media unavailable: ${c}`, {
      context: { code: c, httpStatus },
    });
  }
  return new ApiError(`Cobalt API error: ${c || 'unknown'}`, {
    context: { code: c, httpStatus },
  });
}

export class CobaltClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Base URL of a Cobalt-compatible instance.
   * @param {string} [opts.apiKey] - Optional Api-Key credential.
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxFileSizeBytes]
   * @param {typeof fetch} [opts.fetchImpl] - Injectable for testing.
   * @param {(url: string) => Promise<void>} [opts.assertSafeUrl] - Injectable
   *   SSRF guard, defaults to the real DNS/IP-range check. Only ever
   *   overridden in tests (e.g. to exercise the pipeline against a local
   *   loopback fixture server); production code must keep the default.
   */
  constructor({
    baseUrl, apiKey = '', timeoutMs = 120_000, maxFileSizeBytes = 1024 ** 3,
    fetchImpl = fetch, assertSafeUrl = assertSafeRemoteUrl,
  }) {
    if (!baseUrl) {
      throw new ConfigurationError('COBALT_API_URL is not configured. Point it at your own, self-hosted or explicitly authorized Cobalt-compatible instance.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.fetchImpl = fetchImpl;
    this.assertSafeUrl = assertSafeUrl;
  }

  /** Syntactic validation of a media source URL before sending it to the API. */
  validateUrl(urlString) {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (cause) {
      throw new ApiError('Invalid source URL', { context: { urlString }, cause });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ApiError('Source URL must be http(s)', { context: { urlString } });
    }
    return true;
  }

  async requestDownload(payload) {
    this.validateUrl(payload.url);

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Api-Key ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause.name === 'AbortError') {
        throw new TimeoutError('Timed out waiting for Cobalt API response', {
          context: { url: this.baseUrl, timeoutMs: this.timeoutMs },
          cause,
        });
      }
      throw new ApiError('Network error while contacting Cobalt API', {
        context: { url: this.baseUrl },
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    let body;
    try {
      body = await res.json();
    } catch (cause) {
      throw new ApiError('Cobalt API returned a non-JSON or malformed response', {
        context: { httpStatus: res.status },
        cause,
      });
    }

    return this.parseResponse(res.status, body);
  }

  parseResponse(httpStatus, body) {
    if (!body || typeof body !== 'object' || !body.status) {
      throw new ApiError('Cobalt API response is missing a status field', {
        context: { httpStatus, body },
      });
    }

    switch (body.status) {
      case 'tunnel':
        return this.handleTunnel(body);
      case 'local-processing':
        return this.handleLocalProcessing(body);
      case 'redirect':
        return this.handleRedirect(body);
      case 'picker':
        return this.handlePicker(body);
      case 'error':
        return this.handleError(body, httpStatus);
      default:
        throw new ApiError(`Unknown Cobalt API response status: ${body.status}`, {
          context: { httpStatus, body },
        });
    }
  }

  handleTunnel(body) {
    if (!body.url || !body.filename) {
      throw new ApiError('Malformed tunnel response (missing url or filename)', { context: { body } });
    }
    return { kind: 'tunnel', urls: [body.url], filename: body.filename };
  }

  handleRedirect(body) {
    if (!body.url) {
      throw new ApiError('Malformed redirect response (missing url)', { context: { body } });
    }
    return { kind: 'redirect', urls: [body.url], filename: body.filename };
  }

  handleLocalProcessing(body) {
    if (!Array.isArray(body.tunnel) || body.tunnel.length === 0 || !body.output?.filename) {
      throw new ApiError('Malformed local-processing response', { context: { body } });
    }
    return {
      kind: 'local-processing',
      type: body.type, // merge | mute | audio | gif | remux
      urls: body.tunnel,
      filename: body.output.filename,
      audio: body.audio,
      metadata: body.output.metadata,
      isHLS: !!body.isHLS,
    };
  }

  handlePicker(body) {
    if (!Array.isArray(body.picker) || body.picker.length === 0) {
      throw new MediaUnavailableError('Cobalt returned an empty picker (no downloadable items)', {
        context: { body },
      });
    }
    return {
      kind: 'picker',
      items: body.picker,
      audio: body.audio,
      audioFilename: body.audioFilename,
    };
  }

  handleError(body, httpStatus) {
    throw classifyApiError(body.error?.code, httpStatus);
  }

  /**
   * Downloads a remote URL to a local file, enforcing SSRF protections and a
   * hard size cap. Used for tunnel/redirect/local-processing URLs, which
   * originate from the (trusted-but-verified) Cobalt-compatible backend.
   */
  async downloadToFile(urlString, destPath) {
    await this.assertSafeUrl(urlString);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await this.fetchImpl(urlString, { signal: controller.signal });
    } catch (cause) {
      if (cause.name === 'AbortError') {
        throw new TimeoutError('Timed out downloading media file', {
          context: { urlString, timeoutMs: this.timeoutMs },
          cause,
        });
      }
      throw new DownloadError('Network error while downloading media file', {
        context: { urlString },
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new DownloadError(`Media server responded with HTTP ${res.status}`, {
        context: { urlString, httpStatus: res.status },
      });
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > this.maxFileSizeBytes) {
      throw new DownloadError('Remote file exceeds the configured maximum size', {
        context: { urlString, contentLength, maxFileSizeBytes: this.maxFileSizeBytes },
      });
    }

    if (!res.body) {
      throw new DownloadError('Response has no body to stream', { context: { urlString } });
    }

    let bytesWritten = 0;
    const maxSize = this.maxFileSizeBytes;
    const sizeGuard = new Transform({
      transform(chunk, _enc, cb) {
        bytesWritten += chunk.length;
        if (bytesWritten > maxSize) {
          cb(new DownloadError('Download exceeded the configured maximum size while streaming', {
            context: { urlString, maxFileSizeBytes: maxSize },
          }));
          return;
        }
        cb(null, chunk);
      },
    });

    const nodeReadable = Readable.fromWeb(res.body);

    try {
      await pipeline(nodeReadable, sizeGuard, fs.createWriteStream(destPath));
    } catch (cause) {
      if (cause instanceof DownloadError) throw cause;
      throw new DownloadError('Failed while streaming media file to disk', {
        context: { urlString, destPath },
        cause,
      });
    }

    return { path: destPath, bytes: bytesWritten };
  }
}

export { classifyApiError, SecurityError };
