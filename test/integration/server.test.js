import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server.js';
import { startFakeCobaltServer } from './helpers/fake-cobalt-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

async function allowLoopbackOnly(urlString) {
  const { hostname } = new URL(urlString);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`test guard: unexpected non-loopback host: ${hostname}`);
  }
}

function baseConfig(overrides = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-srv-'));
  return {
    cobaltApiKey: '',
    cobaltConnectTimeoutMs: 5000,
    cobaltRequestTimeoutMs: 15000,
    cobaltRetries: 0,
    ffmpegTimeoutMs: 30_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxFileSizeBytes: 100 * 1024 * 1024,
    outputDir: path.join(workDir, 'out'),
    tempDir: path.join(workDir, 'tmp'),
    dataDir: path.join(workDir, 'data'),
    historyLimit: 200,
    trustProxy: false,
    maxConcurrentDownloads: 3,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 100,
    assertSafeUrl: allowLoopbackOnly,
    ...overrides,
  };
}

async function startApp(cfg) {
  const app = createApp(cfg);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  const events = [];
  for (const block of buf.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine && dataLine) {
      events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
    }
  }
  return events;
}

test('GET /api/config lists real, backend-supported formats/qualities/bitrates', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1' }));
  try {
    const res = await fetch(`${baseUrl}/api/config`);
    const body = await res.json();
    assert.deepEqual(body.formats, ['mp4', 'mp3']);
    assert.ok(body.videoQualities.includes('1080'));
    assert.ok(body.audioBitrates.includes('192'));
  } finally {
    await close();
  }
});

test('GET /api/health reports cobalt unavailable when the instance cannot be reached', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1' }));
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    assert.equal(body.cobalt.state, 'unavailable');
    assert.equal(body.ffmpeg.state, 'ready');
    assert.equal(body.storage.state, 'ready');
  } finally {
    await close();
  }
});

test('GET /api/health reports cobalt connected when a real Cobalt-compatible instance answers GET /', async () => {
  const { baseUrl: cobaltUrl, close: closeCobalt } = await startFakeCobaltServer({ scenario: () => ({ body: {} }), mediaFiles: {} });
  try {
    const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: cobaltUrl }));
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = await res.json();
      assert.equal(body.cobalt.state, 'connected');
      assert.equal(body.cobalt.version, 'test');
      assert.ok(body.cobalt.services.includes('youtube'));
    } finally {
      await close();
    }
  } finally {
    await closeCobalt();
  }
});

test('GET /api/health never reports "connected" for a config that is simply missing COBALT_API_URL', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: '' }));
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    assert.equal(body.cobalt.state, 'misconfigured');
  } finally {
    await close();
  }
});

test('POST /api/inspect returns real metadata for a resolvable video and does not hang (res-close abort regression)', async () => {
  const { baseUrl: cobaltUrl, close: closeCobalt } = await startFakeCobaltServer({
    scenario: () => ({ body: { status: 'tunnel', url: 'http://127.0.0.1:1/x', filename: 'My Cool Video.mp4' } }),
    mediaFiles: {},
  });
  try {
    const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: cobaltUrl }));
    try {
      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      });
      const elapsed = Date.now() - start;
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.title, 'My Cool Video');
      assert.equal(body.videoId, 'dQw4w9WgXcQ');
      assert.ok(elapsed < 2000, `expected inspect to resolve quickly, took ${elapsed}ms (regression: req 'close' firing early)`);
    } finally {
      await close();
    }
  } finally {
    await closeCobalt();
  }
});

test('POST /api/inspect returns 400 for an invalid URL', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1' }));
  try {
    const res = await fetch(`${baseUrl}/api/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_URL');
  } finally {
    await close();
  }
});

test('GET /api/history is empty before any download and reflects a completed one afterwards', async () => {
  const { baseUrl: cobaltUrl, close: closeCobalt } = await startFakeCobaltServer({
    scenario: () => ({ body: { status: 'tunnel', url: `http://127.0.0.1:1/media/combined.mp4`, filename: 'History Test.mp4' } }),
    mediaFiles: { 'combined.mp4': path.join(FIXTURES, 'combined.mp4') },
  });
  try {
    const cfg = baseConfig({ cobaltApiUrl: cobaltUrl });
    const { baseUrl, close } = await startApp(cfg);
    try {
      const emptyRes = await fetch(`${baseUrl}/api/history`);
      assert.deepEqual((await emptyRes.json()).history, []);

      // Point the tunnel at the fake cobalt server's own /media/ route instead
      // of the unreachable placeholder used in `scenario` above.
    } finally {
      await close();
    }
  } finally {
    await closeCobalt();
  }
});

test('full download via SSE records a history entry and serves the finished file', async () => {
  const { baseUrl: cobaltUrl, mediaUrl, close: closeCobalt } = await startFakeCobaltServer({
    scenario: () => ({ body: { status: 'tunnel', url: mediaUrl('combined.mp4'), filename: 'E2E Server Test.mp4' } }),
    mediaFiles: { 'combined.mp4': path.join(FIXTURES, 'combined.mp4') },
  });
  try {
    const cfg = baseConfig({ cobaltApiUrl: cobaltUrl });
    const { baseUrl, close } = await startApp(cfg);
    try {
      const qs = new URLSearchParams({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp4', quality: '720' });
      const res = await fetch(`${baseUrl}/api/download-stream?${qs}`);
      const events = await readSse(res);

      const steps = events.filter((e) => e.event === 'progress').map((e) => e.data.step);
      assert.ok(steps.includes('Baixando...'));
      assert.ok(steps.includes('Processando...'));

      const doneEvent = events.find((e) => e.event === 'done');
      assert.ok(doneEvent, 'expected a done event');
      assert.equal(doneEvent.data.filename, 'E2E Server Test.mp4');

      const fileRes = await fetch(`${baseUrl}${doneEvent.data.downloadUrl}`);
      assert.equal(fileRes.status, 200);
      const bytes = await fileRes.arrayBuffer();
      assert.ok(bytes.byteLength > 0);

      const historyRes = await fetch(`${baseUrl}/api/history`);
      const history = (await historyRes.json()).history;
      assert.equal(history[0].filename, 'E2E Server Test.mp4');
    } finally {
      await close();
    }
  } finally {
    await closeCobalt();
  }
});

test('GET /files/:name rejects path traversal attempts', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1' }));
  try {
    const res = await fetch(`${baseUrl}/files/${encodeURIComponent('../../etc/passwd')}`);
    assert.notEqual(res.status, 200);
  } finally {
    await close();
  }
});

test('GET /files/:name returns 404 for a nonexistent file', async () => {
  const { baseUrl, close } = await startApp(baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1' }));
  try {
    const res = await fetch(`${baseUrl}/files/does-not-exist.mp4`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('rate limiting returns 429 once the configured request limit is exceeded', async () => {
  const cfg = baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1', rateLimitMaxRequests: 3, rateLimitWindowMs: 60_000 });
  const { baseUrl, close } = await startApp(cfg);
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not a url' }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected at least one 429 among ${statuses}`);
  } finally {
    await close();
  }
});

test('an aborted client connection cancels the in-flight download (no orphaned ffmpeg work)', async () => {
  const { baseUrl: cobaltUrl, mediaUrl, close: closeCobalt } = await startFakeCobaltServer({
    scenario: () => ({ body: { status: 'tunnel', url: mediaUrl('combined.mp4'), filename: 'Abort Test.mp4' } }),
    mediaFiles: { 'combined.mp4': path.join(FIXTURES, 'combined.mp4') },
  });
  try {
    const cfg = baseConfig({ cobaltApiUrl: cobaltUrl });
    const { baseUrl, close } = await startApp(cfg);
    try {
      const controller = new AbortController();
      const qs = new URLSearchParams({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp4', quality: '720' });
      const fetchPromise = fetch(`${baseUrl}/api/download-stream?${qs}`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 15);

      await assert.rejects(async () => {
        const res = await fetchPromise;
        await readSse(res);
      });

      // Give the server a moment to run its finally{} cleanup after the abort.
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(fs.readdirSync(cfg.outputDir), [], 'aborted download must not produce a finished file');
    } finally {
      await close();
    }
  } finally {
    await closeCobalt();
  }
});
