import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CobaltClient } from '../../src/api/cobalt-client.js';
import {
  ApiError,
  AuthenticationError,
  RateLimitError,
  MediaUnavailableError,
  TimeoutError,
  DownloadError,
  ConfigurationError,
  SecurityError,
} from '../../src/errors/downloader-errors.js';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function makeClient(fetchImpl, extra = {}) {
  return new CobaltClient({ baseUrl: 'http://cobalt.internal.test', apiKey: '', timeoutMs: 2000, fetchImpl, ...extra });
}

test('missing COBALT_API_URL throws ConfigurationError', () => {
  assert.throws(() => new CobaltClient({ baseUrl: '' }), ConfigurationError);
});

test('tunnel response is parsed correctly', async () => {
  const client = makeClient(async () => jsonResponse(200, { status: 'tunnel', url: 'https://cdn.test/x', filename: 'a.mp4' }));
  const r = await client.requestDownload({ url: 'https://www.youtube.com/watch?v=x' });
  assert.equal(r.kind, 'tunnel');
  assert.deepEqual(r.urls, ['https://cdn.test/x']);
  assert.equal(r.filename, 'a.mp4');
});

test('redirect response is parsed correctly', async () => {
  const client = makeClient(async () => jsonResponse(200, { status: 'redirect', url: 'https://cdn.test/y', filename: 'b.mp4' }));
  const r = await client.requestDownload({ url: 'https://www.youtube.com/watch?v=x' });
  assert.equal(r.kind, 'redirect');
  assert.deepEqual(r.urls, ['https://cdn.test/y']);
});

test('local-processing (merge) response is parsed correctly', async () => {
  const client = makeClient(async () => jsonResponse(200, {
    status: 'local-processing',
    type: 'merge',
    service: 'youtube',
    tunnel: ['https://cdn.test/v', 'https://cdn.test/a'],
    output: { type: 'video/mp4', filename: 'c.mp4' },
  }));
  const r = await client.requestDownload({ url: 'https://www.youtube.com/watch?v=x' });
  assert.equal(r.kind, 'local-processing');
  assert.equal(r.type, 'merge');
  assert.deepEqual(r.urls, ['https://cdn.test/v', 'https://cdn.test/a']);
  assert.equal(r.filename, 'c.mp4');
});

test('picker response with no items raises MediaUnavailableError', async () => {
  const client = makeClient(async () => jsonResponse(200, { status: 'picker', picker: [] }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), MediaUnavailableError);
});

test('picker response with items is parsed', async () => {
  const client = makeClient(async () => jsonResponse(200, {
    status: 'picker',
    picker: [{ type: 'video', url: 'https://cdn.test/p1' }],
  }));
  const r = await client.requestDownload({ url: 'https://x' });
  assert.equal(r.kind, 'picker');
  assert.equal(r.items[0].url, 'https://cdn.test/p1');
});

test('error status with auth code maps to AuthenticationError', async () => {
  const client = makeClient(async () => jsonResponse(401, { status: 'error', error: { code: 'error.api.auth.key.missing' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), AuthenticationError);
});

test('HTTP 401 without explicit auth code still maps to AuthenticationError', async () => {
  const client = makeClient(async () => jsonResponse(401, { status: 'error', error: { code: 'error.something' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), AuthenticationError);
});

test('HTTP 403 generic error maps to ApiError', async () => {
  const client = makeClient(async () => jsonResponse(403, { status: 'error', error: { code: 'error.api.generic' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), ApiError);
});

test('HTTP 429 maps to RateLimitError', async () => {
  const client = makeClient(async () => jsonResponse(429, { status: 'error', error: { code: 'error.api.rate_exceeded' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), RateLimitError);
});

test('content.* error code maps to MediaUnavailableError', async () => {
  const client = makeClient(async () => jsonResponse(400, { status: 'error', error: { code: 'content.video.private' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), MediaUnavailableError);
});

test('HTTP 500 generic error maps to ApiError', async () => {
  const client = makeClient(async () => jsonResponse(500, { status: 'error', error: { code: 'error.api.fetch.critical.core' } }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), ApiError);
});

test('network timeout raises TimeoutError', async () => {
  const client = makeClient((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }), { timeoutMs: 50 });
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), TimeoutError);
});

test('malformed (non-JSON) response raises ApiError', async () => {
  const client = makeClient(async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => { throw new Error('not json'); },
  }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), ApiError);
});

test('response missing status field raises ApiError', async () => {
  const client = makeClient(async () => jsonResponse(200, { url: 'https://cdn.test/x' }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), ApiError);
});

test('unknown status value raises ApiError', async () => {
  const client = makeClient(async () => jsonResponse(200, { status: 'mystery' }));
  await assert.rejects(() => client.requestDownload({ url: 'https://x' }), ApiError);
});

test('validateUrl rejects non-http(s) protocols before sending the request', () => {
  const client = makeClient(async () => { throw new Error('should not be called'); });
  assert.throws(() => client.validateUrl('ftp://x'), ApiError);
});

test('downloadToFile refuses a URL that resolves to a private/loopback address (SSRF)', async () => {
  const client = makeClient(async () => { throw new Error('fetch should never be called'); });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-')), 'out.bin');
  await assert.rejects(() => client.downloadToFile('http://127.0.0.1/secret', tmp), SecurityError);
  await assert.rejects(() => client.downloadToFile('http://localhost/secret', tmp), SecurityError);
});

test('downloadToFile enforces the configured max size via Content-Length', async () => {
  const client = makeClient(async () => ({
    status: 200,
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? '99999999' : null) },
    body: null,
  }), { maxFileSizeBytes: 100 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-')), 'out.bin');
  await assert.rejects(() => client.downloadToFile('https://example.com/big.mp4', tmp), DownloadError);
});

test('downloadToFile surfaces a non-2xx status as DownloadError', async () => {
  const client = makeClient(async () => ({
    status: 404,
    ok: false,
    headers: { get: () => null },
    body: null,
  }));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-')), 'out.bin');
  await assert.rejects(() => client.downloadToFile('https://example.com/missing.mp4', tmp), DownloadError);
});
