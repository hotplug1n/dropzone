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

// A failure is worth retrying only when it's plausibly transient: network
// errors, timeouts, and 5xx. 4xx (bad request, auth, media-not-found,
// rate-limited) are deterministic — retrying them just wastes time and, for
// rate limits, makes things worse.
function isRetryable(err) {
  if (err instanceof TimeoutError) return true;
  if (err instanceof ApiError) {
    const status = err.context?.httpStatus;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Merges an internal timeout AbortController with an optional caller-supplied signal. */
function combineSignals(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const onExternalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export class CobaltClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Base URL of a Cobalt-compatible instance.
   * @param {string} [opts.apiKey] - Optional Api-Key credential.
   * @param {number} [opts.connectTimeoutMs] - Timeout for the POST / and GET / calls.
   * @param {number} [opts.requestTimeoutMs] - Timeout for streaming a tunnel/redirect file.
   * @param {number} [opts.retries] - Retries for the metadata call on transient failures.
   * @param {number} [opts.maxFileSizeBytes]
   * @param {typeof fetch} [opts.fetchImpl] - Injectable for testing.
   * @param {(url: string) => Promise<void>} [opts.assertSafeUrl] - Injectable
   *   SSRF guard, defaults to the real DNS/IP-range check. Only ever
   *   overridden in tests (e.g. to exercise the pipeline against a local
   *   loopback fixture server); production code must keep the default.
   */
  constructor({
    baseUrl, apiKey = '', connectTimeoutMs = 10_000, requestTimeoutMs = 180_000, retries = 2,
    maxFileSizeBytes = 1024 ** 3, fetchImpl = fetch, assertSafeUrl = assertSafeRemoteUrl,
  }) {
    if (!baseUrl) {
      throw new ConfigurationError('COBALT_API_URL is not configured. Point it at your own, self-hosted or explicitly authorized Cobalt-compatible instance.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retries = retries;
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

  _authHeaders() {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Api-Key ${this.apiKey}`;
    return headers;
  }

  async _fetchJson(url, init, { signal: externalSignal } = {}) {
    const { signal, cleanup } = combineSignals(externalSignal, this.connectTimeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal });
      let body;
      try {
        body = await res.json();
      } catch (cause) {
        throw new ApiError('Cobalt API returned a non-JSON or malformed response', {
          context: { httpStatus: res.status },
          cause,
        });
      }
      return { status: res.status, body };
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (cause.name === 'AbortError' || signal.aborted) {
        throw new TimeoutError('Timed out contacting the Cobalt API', {
          context: { url, timeoutMs: this.connectTimeoutMs },
          cause,
        });
      }
      throw new ApiError('Network error while contacting Cobalt API', { context: { url }, cause });
    } finally {
      cleanup();
    }
  }

  async _withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === this.retries || !isRetryable(err)) throw err;
        await sleep(2 ** attempt * 250);
      }
    }
    throw lastErr;
  }

  /**
   * GET / — cobalt's "provides basic instance info" endpoint (docs/api.md).
   * Used both as a real health check and to confirm the configured instance
   * actually speaks the Cobalt API contract (has cobalt.version/services),
   * rather than assuming any 200 response means "connected".
   */
  async getInstanceInfo({ signal } = {}) {
    return this._withRetry(async () => {
      const { status, body } = await this._fetchJson(`${this.baseUrl}/`, {
        method: 'GET',
        headers: this._authHeaders(),
      }, { signal });

      if (status < 200 || status >= 300) {
        throw new ApiError(`Cobalt instance info request failed with HTTP ${status}`, {
          context: { httpStatus: status },
        });
      }
      if (!body?.cobalt?.version || !Array.isArray(body?.cobalt?.services)) {
        throw new ApiError('Response does not look like a Cobalt instance (missing cobalt.version/services)', {
          context: { body },
        });
      }
      return {
        version: body.cobalt.version,
        services: body.cobalt.services,
        url: body.cobalt.url,
        startTime: body.cobalt.startTime,
      };
    });
  }

  async requestDownload(payload, { signal } = {}) {
    this.validateUrl(payload.url);

    return this._withRetry(async () => {
      const { status, body } = await this._fetchJson(`${this.baseUrl}/`, {
        method: 'POST',
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { signal });

      return this.parseResponse(status, body);
    });
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
   * Never retried automatically: retrying a partially-written file from
   * scratch is the caller's decision, not something to hide silently.
   */
  async downloadToFile(urlString, destPath, { signal: externalSignal } = {}) {
    await this.assertSafeUrl(urlString);

    const { signal, cleanup } = combineSignals(externalSignal, this.requestTimeoutMs);

    let res;
    try {
      res = await this.fetchImpl(urlString, { signal });
    } catch (cause) {
      cleanup();
      if (cause.name === 'AbortError' || signal.aborted) {
        throw new TimeoutError('Timed out downloading media file', {
          context: { urlString, timeoutMs: this.requestTimeoutMs },
          cause,
        });
      }
      throw new DownloadError('Network error while downloading media file', {
        context: { urlString },
        cause,
      });
    }

    if (!res.ok) {
      cleanup();
      throw new DownloadError(`Media server responded with HTTP ${res.status}`, {
        context: { urlString, httpStatus: res.status },
      });
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > this.maxFileSizeBytes) {
      cleanup();
      throw new DownloadError('Remote file exceeds the configured maximum size', {
        context: { urlString, contentLength, maxFileSizeBytes: this.maxFileSizeBytes },
      });
    }

    if (!res.body) {
      cleanup();
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
      if (cause.name === 'AbortError' || signal.aborted) {
        throw new TimeoutError('Timed out downloading media file', {
          context: { urlString, timeoutMs: this.requestTimeoutMs },
          cause,
        });
      }
      throw new DownloadError('Failed while streaming media file to disk', {
        context: { urlString, destPath },
        cause,
      });
    } finally {
      cleanup();
    }

    return { path: destPath, bytes: bytesWritten };
  }
}

export { classifyApiError, isRetryable, SecurityError };
