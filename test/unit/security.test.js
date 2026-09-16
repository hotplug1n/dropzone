import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeRemoteUrl } from '../../src/utils/security.js';
import { SecurityError } from '../../src/errors/downloader-errors.js';

test('rejects loopback IPv4 literal (SSRF)', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://127.0.0.1/'), SecurityError);
});

test('rejects loopback IPv6 literal (SSRF)', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://[::1]/'), SecurityError);
});

test('rejects RFC1918 private IPv4 ranges (SSRF)', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://10.0.0.5/'), SecurityError);
  await assert.rejects(() => assertSafeRemoteUrl('http://172.16.0.5/'), SecurityError);
  await assert.rejects(() => assertSafeRemoteUrl('http://192.168.1.5/'), SecurityError);
});

test('rejects link-local addresses, incl. cloud metadata endpoint (SSRF)', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://169.254.169.254/latest/meta-data/'), SecurityError);
});

test('rejects the "localhost" hostname', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://localhost/'), SecurityError);
});

test('rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('file:///etc/passwd'), SecurityError);
  await assert.rejects(() => assertSafeRemoteUrl('ftp://example.com/'), SecurityError);
});

test('rejects malformed URLs', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('not a url'), SecurityError);
});

test('allows a normal public hostname', async () => {
  await assert.doesNotReject(() => assertSafeRemoteUrl('https://example.com/video.mp4'));
});

test('allows a normal public IPv4 literal', async () => {
  await assert.doesNotReject(() => assertSafeRemoteUrl('http://1.1.1.1/x'));
});
