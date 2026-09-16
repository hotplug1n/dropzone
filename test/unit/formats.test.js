import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSelection, buildCobaltPayload, VIDEO_QUALITIES, AUDIO_BITRATES } from '../../src/downloader/formats.js';
import { InvalidOptionsError } from '../../src/errors/downloader-errors.js';

test('accepts every documented mp4 quality', () => {
  for (const quality of VIDEO_QUALITIES) {
    assert.doesNotThrow(() => validateSelection({ format: 'mp4', quality }));
  }
});

test('accepts every documented mp3 bitrate', () => {
  for (const bitrate of AUDIO_BITRATES) {
    assert.doesNotThrow(() => validateSelection({ format: 'mp3', bitrate }));
  }
});

test('rejects unsupported format', () => {
  assert.throws(() => validateSelection({ format: 'avi' }), InvalidOptionsError);
});

test('rejects unsupported mp4 quality', () => {
  assert.throws(() => validateSelection({ format: 'mp4', quality: '4320' }), InvalidOptionsError);
  assert.throws(() => validateSelection({ format: 'mp4', quality: 'ultra' }), InvalidOptionsError);
});

test('rejects unsupported mp3 bitrate', () => {
  assert.throws(() => validateSelection({ format: 'mp3', bitrate: '64' }), InvalidOptionsError);
  assert.throws(() => validateSelection({ format: 'mp3', bitrate: '999' }), InvalidOptionsError);
});

test('mp4 payload maps "best" to cobalt "max" and forces h264/mp4', () => {
  const payload = buildCobaltPayload({ normalizedUrl: 'https://www.youtube.com/watch?v=x', format: 'mp4', quality: 'best' });
  assert.equal(payload.videoQuality, 'max');
  assert.equal(payload.youtubeVideoCodec, 'h264');
  assert.equal(payload.youtubeVideoContainer, 'mp4');
  assert.equal(payload.downloadMode, 'auto');
});

test('mp4 payload preserves a specific quality', () => {
  const payload = buildCobaltPayload({ normalizedUrl: 'https://www.youtube.com/watch?v=x', format: 'mp4', quality: '720' });
  assert.equal(payload.videoQuality, '720');
});

test('mp3 payload sets audio-only download mode and bitrate', () => {
  const payload = buildCobaltPayload({ normalizedUrl: 'https://www.youtube.com/watch?v=x', format: 'mp3', bitrate: '320' });
  assert.equal(payload.downloadMode, 'audio');
  assert.equal(payload.audioFormat, 'mp3');
  assert.equal(payload.audioBitrate, '320');
});

test('buildCobaltPayload rejects an invalid combination instead of building a bad request', () => {
  assert.throws(() => buildCobaltPayload({ normalizedUrl: 'https://www.youtube.com/watch?v=x', format: 'mp3', bitrate: '1000' }), InvalidOptionsError);
});
