import path from 'node:path';

import { validateYoutubeUrl } from './youtube.js';
import { CobaltClient } from '../api/cobalt-client.js';

const OEMBED_TIMEOUT_MS = 4000;

/**
 * Best-effort enrichment via YouTube's public, unauthenticated oEmbed
 * endpoint (documented for exactly this "preview a video" use case — no
 * auth, no DRM/paywall bypass). Never throws: a blocked or slow network
 * (e.g. a sandboxed/offline deployment) must degrade gracefully rather than
 * fail the whole inspect request, since Cobalt's own response is already
 * enough to tell the user whether the video is downloadable.
 */
async function fetchOEmbed(normalizedUrl, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`;
    const res = await fetchImpl(oembedUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      title: typeof body.title === 'string' ? body.title : null,
      author: typeof body.author_name === 'string' ? body.author_name : null,
      thumbnail: typeof body.thumbnail_url === 'string' ? body.thumbnail_url : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspects a YouTube URL without committing to a download: validates the
 * URL, asks the configured Cobalt instance to resolve it (the same POST /
 * call a real download would make, since Cobalt has no separate metadata
 * endpoint — confirmed against docs/api.md), and reports what can honestly
 * be known.
 *
 * Duration is intentionally NOT fabricated: neither Cobalt's documented
 * response schema nor YouTube's oEmbed endpoint expose video duration, so
 * `durationSeconds` is always null and `durationAvailable` is always false
 * until a real source for it is integrated.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.config
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for testing
 */
export async function inspectYoutubeUrl({ url, config, signal, fetchImpl = fetch }) {
  const { normalizedUrl, videoId, isShorts } = validateYoutubeUrl(url);

  const client = new CobaltClient({
    baseUrl: config.cobaltApiUrl,
    apiKey: config.cobaltApiKey,
    connectTimeoutMs: config.cobaltConnectTimeoutMs,
    retries: config.cobaltRetries,
    fetchImpl,
    ...(config.assertSafeUrl ? { assertSafeUrl: config.assertSafeUrl } : {}),
  });

  // Cheapest possible probe: smallest video quality, since we only need to
  // know whether the source resolves and what filename/metadata Cobalt
  // would use — not to actually transfer any bytes yet.
  const result = await client.requestDownload({
    url: normalizedUrl,
    downloadMode: 'auto',
    videoQuality: '144',
  }, { signal });

  let title = null;
  let author = null;

  // Priority: real metadata from Cobalt (local-processing responses only)
  // is the most trustworthy, since it reflects the exact resolved source.
  // A generic tunnel/redirect filename is a poor guess at the real title
  // (it can be just the video ID depending on the instance's filenameStyle
  // config), so it's used only as the LAST resort, after trying oEmbed's
  // real title — never before it.
  if (result.kind === 'local-processing' && result.metadata) {
    title = result.metadata.title || null;
    author = result.metadata.artist || null;
  }

  const oembed = await fetchOEmbed(normalizedUrl, fetchImpl);
  if (!title && oembed?.title) title = oembed.title;
  if (!author && oembed?.author) author = oembed.author;

  const fallbackFilename = result.filename || (result.kind === 'picker' ? result.audioFilename : null);
  if (!title && fallbackFilename) {
    title = path.basename(fallbackFilename, path.extname(fallbackFilename));
  }

  return {
    service: 'youtube',
    videoId,
    isShorts,
    title: title || '(título indisponível)',
    author: author || null,
    thumbnail: oembed?.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: null,
    durationAvailable: false,
    availability: 'available',
  };
}
