import { InvalidUrlError, UnsupportedUrlError } from '../errors/downloader-errors.js';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(parsed) {
  const host = parsed.hostname.toLowerCase();

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return id || null;
  }

  if (parsed.pathname.startsWith('/shorts/')) {
    return parsed.pathname.split('/')[2] || null;
  }

  if (parsed.pathname.startsWith('/watch')) {
    return parsed.searchParams.get('v');
  }

  if (parsed.pathname.startsWith('/embed/')) {
    return parsed.pathname.split('/')[2] || null;
  }

  if (parsed.pathname.startsWith('/live/')) {
    return parsed.pathname.split('/')[2] || null;
  }

  return null;
}

/**
 * Validates and normalizes a YouTube URL.
 * Throws InvalidUrlError for malformed input, UnsupportedUrlError for
 * unsupported domains/paths.
 *
 * @param {string} rawUrl
 * @returns {{ normalizedUrl: string, videoId: string, isShorts: boolean }}
 */
export function validateYoutubeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new InvalidUrlError('URL is empty or not a string', { context: { rawUrl } });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (cause) {
    throw new InvalidUrlError('URL could not be parsed', { context: { rawUrl }, cause });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsupportedUrlError('Only http(s) URLs are supported', {
      context: { rawUrl, protocol: parsed.protocol },
    });
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new UnsupportedUrlError('Domain is not a supported YouTube domain', {
      context: { rawUrl, host },
    });
  }

  const isShorts = parsed.pathname.startsWith('/shorts/');
  const videoId = extractVideoId(parsed);

  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    throw new InvalidUrlError('Could not extract a valid video ID from the URL', {
      context: { rawUrl, extracted: videoId },
    });
  }

  return {
    normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    isShorts,
  };
}
