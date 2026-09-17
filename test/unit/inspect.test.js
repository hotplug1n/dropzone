import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectYoutubeUrl } from '../../src/services/inspect.js';
import { InvalidUrlError, UnsupportedUrlError, MediaUnavailableError } from '../../src/errors/downloader-errors.js';

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body };
}

function baseConfig(overrides = {}) {
  return {
    cobaltApiUrl: 'http://cobalt.internal.test',
    cobaltApiKey: '',
    cobaltConnectTimeoutMs: 2000,
    cobaltRetries: 0,
    ...overrides,
  };
}

test('rejects an invalid URL before ever contacting Cobalt', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should not be called'); };
  await assert.rejects(() => inspectYoutubeUrl({ url: 'not a url', config: baseConfig(), fetchImpl }), InvalidUrlError);
  assert.equal(called, false);
});

test('rejects an unsupported domain before contacting Cobalt', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should not be called'); };
  await assert.rejects(() => inspectYoutubeUrl({ url: 'https://vimeo.com/123', config: baseConfig(), fetchImpl }), UnsupportedUrlError);
  assert.equal(called, false);
});

test('derives title from local-processing metadata when Cobalt provides it, without needing oEmbed', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('cobalt.internal.test')) {
      return jsonResponse({
        status: 'local-processing',
        type: 'merge',
        tunnel: ['https://cdn/a', 'https://cdn/b'],
        output: { filename: 'x.mp4', metadata: { title: 'Real Title From Cobalt', artist: 'Real Author' } },
      });
    }
    throw new Error('oEmbed should not be needed when Cobalt already provides a title');
  };
  const info = await inspectYoutubeUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', config: baseConfig(), fetchImpl });
  assert.equal(info.title, 'Real Title From Cobalt');
  assert.equal(info.author, 'Real Author');
  assert.equal(info.videoId, 'dQw4w9WgXcQ');
  assert.equal(info.durationSeconds, null, 'duration must never be fabricated');
  assert.equal(info.durationAvailable, false);
});

test('falls back to the tunnel filename as title when Cobalt has no metadata, without needing oEmbed to succeed', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('cobalt.internal.test')) {
      return jsonResponse({ status: 'tunnel', url: 'https://cdn/x.mp4', filename: 'My Cool Video.mp4' });
    }
    throw new Error('oembed unreachable'); // simulates a blocked/offline network — must degrade gracefully
  };
  const info = await inspectYoutubeUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', config: baseConfig(), fetchImpl });
  assert.equal(info.title, 'My Cool Video');
  assert.equal(info.author, null);
  assert.ok(info.thumbnail.includes('dQw4w9WgXcQ'), 'expected a deterministic i.ytimg.com fallback thumbnail');
});

test('enriches with oEmbed author/thumbnail when Cobalt has no metadata but oEmbed succeeds', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('cobalt.internal.test')) {
      return jsonResponse({ status: 'tunnel', url: 'https://cdn/x.mp4', filename: 'x.mp4' });
    }
    if (String(url).includes('oembed')) {
      return jsonResponse({ title: 'oEmbed Title', author_name: 'oEmbed Author', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/other.jpg' });
    }
    throw new Error('unexpected fetch target: ' + url);
  };
  const info = await inspectYoutubeUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', config: baseConfig(), fetchImpl });
  assert.equal(info.title, 'oEmbed Title');
  assert.equal(info.author, 'oEmbed Author');
  assert.equal(info.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/other.jpg');
});

test('propagates MediaUnavailableError for a private/unavailable video instead of returning fake info', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('cobalt.internal.test')) {
      return jsonResponse({ status: 'error', error: { code: 'content.video.private' } }, 400);
    }
    throw new Error('should not reach oEmbed');
  };
  await assert.rejects(() => inspectYoutubeUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', config: baseConfig(), fetchImpl }), MediaUnavailableError);
});
