import test from 'node:test';
import assert from 'node:assert/strict';
import { validateYoutubeUrl } from '../../src/services/youtube.js';
import { InvalidUrlError, UnsupportedUrlError } from '../../src/errors/downloader-errors.js';

test('valid watch URL', () => {
  const r = validateYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
  assert.equal(r.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.isShorts, false);
});

test('valid youtu.be short link', () => {
  const r = validateYoutubeUrl('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
});

test('valid YouTube Shorts URL', () => {
  const r = validateYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
  assert.equal(r.isShorts, true);
});

test('URL with tracking parameters is normalized', () => {
  const r = validateYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123&feature=share&t=42s');
  assert.equal(r.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('mobile subdomain is accepted', () => {
  const r = validateYoutubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
});

test('invalid URL string throws InvalidUrlError', () => {
  assert.throws(() => validateYoutubeUrl('not a url at all'), InvalidUrlError);
});

test('empty URL throws InvalidUrlError', () => {
  assert.throws(() => validateYoutubeUrl(''), InvalidUrlError);
});

test('non-string input throws InvalidUrlError', () => {
  assert.throws(() => validateYoutubeUrl(null), InvalidUrlError);
  assert.throws(() => validateYoutubeUrl(undefined), InvalidUrlError);
});

test('unsupported domain throws UnsupportedUrlError', () => {
  assert.throws(() => validateYoutubeUrl('https://vimeo.com/12345'), UnsupportedUrlError);
});

test('lookalike domain (phishing-style) is rejected', () => {
  assert.throws(() => validateYoutubeUrl('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), UnsupportedUrlError);
  assert.throws(() => validateYoutubeUrl('https://youtube.com.attacker.net'), UnsupportedUrlError);
});

test('javascript: scheme is rejected', () => {
  assert.throws(() => validateYoutubeUrl('javascript:alert(1)'), UnsupportedUrlError);
});

test('file: scheme is rejected as unsupported protocol', () => {
  assert.throws(() => validateYoutubeUrl('file:///etc/passwd'), UnsupportedUrlError);
});

test('watch URL missing video id throws InvalidUrlError', () => {
  assert.throws(() => validateYoutubeUrl('https://www.youtube.com/watch?list=PL123'), InvalidUrlError);
});

test('malformed/too-short video id is rejected', () => {
  assert.throws(() => validateYoutubeUrl('https://www.youtube.com/watch?v=short'), InvalidUrlError);
});

test('URL with path traversal-like segments on the host path is still just unsupported/invalid', () => {
  assert.throws(() => validateYoutubeUrl('https://www.youtube.com/../../etc/passwd'));
});
