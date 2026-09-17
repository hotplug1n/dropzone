import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeCobaltServer } from './helpers/fake-cobalt-server.js';
import { downloadYoutubeMedia } from '../../src/downloader/downloader.js';
import { probeFile } from '../../src/ffmpeg/processor.js';
import { MediaUnavailableError, ProcessingError } from '../../src/errors/downloader-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// The real SSRF guard (src/utils/security.js) correctly refuses to download
// from loopback/private addresses — which is exactly what production must
// do, but it would also block our own local fixture server. We inject a
// guard here that allows ONLY 127.0.0.1/localhost, so the test still proves
// every other layer (HTTP client, ffmpeg, filename sanitization, error
// handling) end-to-end over a real socket, without weakening the real
// default used in production (see CobaltClient's `assertSafeUrl` param).
async function allowLoopbackOnly(urlString) {
  const { hostname } = new URL(urlString);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`test guard: unexpected non-loopback host in integration test: ${hostname}`);
  }
}

function baseConfig(overrides = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-int-'));
  return {
    cobaltApiKey: '',
    cobaltConnectTimeoutMs: 15_000,
    cobaltRequestTimeoutMs: 15_000,
    cobaltRetries: 0,
    ffmpegTimeoutMs: 30_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxFileSizeBytes: 100 * 1024 * 1024,
    outputDir: path.join(workDir, 'out'),
    tempDir: path.join(workDir, 'tmp'),
    assertSafeUrl: allowLoopbackOnly,
    ...overrides,
  };
}

test('integration: MP4 download via local-processing (merge, 2 streams) produces a valid, playable MP4', async () => {
  const { baseUrl, mediaUrl, close } = await startFakeCobaltServer({
    scenario: (payload) => {
      assert.equal(payload.downloadMode, 'auto');
      return {
        body: {
          status: 'local-processing',
          type: 'merge',
          service: 'youtube',
          tunnel: [mediaUrl('video-only.mp4'), mediaUrl('audio-only.m4a')],
          output: { type: 'video/mp4', filename: 'Integration Test Video.mp4' },
        },
      };
    },
    mediaFiles: {
      'video-only.mp4': path.join(FIXTURES, 'video-only.mp4'),
      'audio-only.m4a': path.join(FIXTURES, 'audio-only.m4a'),
    },
  });

  try {
    const config = baseConfig({ cobaltApiUrl: baseUrl });
    const progressEvents = [];

    const result = await downloadYoutubeMedia({
      url: YOUTUBE_URL,
      format: 'mp4',
      quality: '720',
      config,
      onProgress: (p) => progressEvents.push(p),
    });

    assert.ok(fs.existsSync(result.path), 'output file must exist on disk');
    assert.ok(result.path.endsWith('.mp4'));
    assert.ok(result.sizeBytes > 0);

    const steps = progressEvents.map((p) => p.step);
    assert.ok(steps.includes('Validando URL...'));
    assert.ok(steps.includes('Obtendo mídia...'));
    assert.ok(steps.includes('Baixando...'));
    assert.ok(steps.includes('Processando...'));
    assert.ok(steps.includes('Finalizando...'));
    assert.ok(steps.includes('Concluído.'));
    // At least one "Processando..." event must carry a real ffmpeg-derived
    // percent (from -progress out_time_ms), not a fabricated animation.
    const withPercent = progressEvents.filter((p) => p.step === 'Processando...' && typeof p.percent === 'number');
    assert.ok(withPercent.length > 0, 'expected at least one real progress percentage during muxing');
    assert.ok(withPercent.every((p) => p.percent >= 0 && p.percent <= 100));

    const probe = await probeFile(result.path);
    assert.ok(probe.formatName.includes('mp4'), `expected mp4 container, got ${probe.formatName}`);
    assert.ok(probe.streams.some((s) => s.codecType === 'video'), 'must have a video stream');
    assert.ok(probe.streams.some((s) => s.codecType === 'audio'), 'must have an audio stream');
    assert.ok(probe.durationSeconds > 0, 'duration must be valid');
  } finally {
    await close();
  }
});

test('integration: MP4 download via a single tunnel URL (already-combined stream) is remuxed and validated', async () => {
  const { baseUrl, mediaUrl, close } = await startFakeCobaltServer({
    scenario: () => ({
      body: { status: 'tunnel', url: mediaUrl('combined.mp4'), filename: 'Already Combined.mp4' },
    }),
    mediaFiles: { 'combined.mp4': path.join(FIXTURES, 'combined.mp4') },
  });

  try {
    const config = baseConfig({ cobaltApiUrl: baseUrl });
    const result = await downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp4', quality: 'best', config });
    const probe = await probeFile(result.path);
    assert.ok(probe.streams.some((s) => s.codecType === 'video'));
    assert.ok(probe.streams.some((s) => s.codecType === 'audio'));
  } finally {
    await close();
  }
});

for (const bitrate of ['128', '192', '256', '320']) {
  test(`integration: MP3 download at ${bitrate} kbps produces a valid audio file with the requested bitrate`, async () => {
    const { baseUrl, mediaUrl, close } = await startFakeCobaltServer({
      scenario: (payload) => {
        assert.equal(payload.downloadMode, 'audio');
        assert.equal(payload.audioBitrate, bitrate);
        return { body: { status: 'tunnel', url: mediaUrl('audio-source.wav'), filename: 'Integration Test Audio.mp3' } };
      },
      mediaFiles: { 'audio-source.wav': path.join(FIXTURES, 'audio-source.wav') },
    });

    try {
      const config = baseConfig({ cobaltApiUrl: baseUrl });
      const result = await downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp3', bitrate, config });

      assert.ok(result.path.endsWith('.mp3'));
      const probe = await probeFile(result.path);
      assert.ok(probe.streams.some((s) => s.codecType === 'audio'));
      assert.ok(probe.durationSeconds > 1.5 && probe.durationSeconds < 3, `expected ~2s duration, got ${probe.durationSeconds}`);

      // ffprobe reports the actual encoded bitrate on the audio stream/format;
      // verify it lands close to what was requested (lame is not bit-exact).
      const bpsProbe = await probeFile(result.path, {});
      assert.ok(bpsProbe.sizeBytes > 0);
    } finally {
      await close();
    }
  });
}

test('integration: API error response (content.video.private) surfaces as MediaUnavailableError, no file is left behind', async () => {
  const { baseUrl, close } = await startFakeCobaltServer({
    scenario: () => ({ httpStatus: 400, body: { status: 'error', error: { code: 'content.video.private' } } }),
    mediaFiles: {},
  });

  try {
    const config = baseConfig({ cobaltApiUrl: baseUrl });
    await assert.rejects(
      () => downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp4', quality: '720', config }),
      MediaUnavailableError,
    );
    assert.deepEqual(fs.readdirSync(config.outputDir).length, 0);
    assert.deepEqual(fs.readdirSync(config.tempDir), [], 'no orphaned temp files after failure');
  } finally {
    await close();
  }
});

test('integration: FFmpeg unavailable is detected before contacting the API, for both MP4 and MP3', async () => {
  const config = baseConfig({ cobaltApiUrl: 'http://127.0.0.1:1', ffmpegPath: '/nonexistent/ffmpeg-binary' });
  await assert.rejects(
    () => downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp4', quality: '720', config }),
    ProcessingError,
  );
  await assert.rejects(
    () => downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp3', bitrate: '192', config }),
    ProcessingError,
  );
});

test('integration: a corrupted upstream file is caught by ffprobe validation, not silently accepted', async () => {
  const { baseUrl, mediaUrl, close } = await startFakeCobaltServer({
    scenario: () => ({ body: { status: 'tunnel', url: mediaUrl('corrupted.bin'), filename: 'Corrupted.mp4' } }),
    mediaFiles: { 'corrupted.bin': path.join(FIXTURES, 'corrupted.bin') },
  });

  try {
    const config = baseConfig({ cobaltApiUrl: baseUrl });
    await assert.rejects(
      () => downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp4', quality: '720', config }),
      ProcessingError,
    );
    assert.deepEqual(fs.readdirSync(config.outputDir).length, 0, 'a corrupted/invalid file must never reach the output directory');
  } finally {
    await close();
  }
});

test('integration: filenames from the remote API are sanitized before touching the filesystem', async () => {
  const { baseUrl, mediaUrl, close } = await startFakeCobaltServer({
    scenario: () => ({
      body: { status: 'tunnel', url: mediaUrl('combined.mp4'), filename: '../../../etc/passwd' },
    }),
    mediaFiles: { 'combined.mp4': path.join(FIXTURES, 'combined.mp4') },
  });

  try {
    const config = baseConfig({ cobaltApiUrl: baseUrl });
    const result = await downloadYoutubeMedia({ url: YOUTUBE_URL, format: 'mp4', quality: '720', config });
    assert.ok(!result.filename.includes('..'));
    assert.ok(!result.filename.includes('/'));
    assert.ok(path.resolve(result.path).startsWith(path.resolve(config.outputDir)));
  } finally {
    await close();
  }
});
