import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHealthChecker } from '../../src/services/health.js';

function baseCfg(overrides = {}) {
  return {
    cobaltApiUrl: 'http://cobalt.internal.test',
    cobaltApiKey: '',
    cobaltConnectTimeoutMs: 2000,
    ffmpegPath: 'ffmpeg',
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dz-health-')),
    ...overrides,
  };
}

function fetchImplFor(cobaltBody, status = 200) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => cobaltBody,
  });
}

test('reports cobalt "connected" when the instance answers with youtube in its services', async () => {
  const cfg = baseCfg();
  const checkHealth = createHealthChecker(cfg, {
    fetchImpl: fetchImplFor({ cobalt: { version: '11.0.0', services: ['youtube', 'tiktok'] } }),
  });
  const health = await checkHealth();
  assert.equal(health.cobalt.state, 'connected');
  assert.equal(health.cobalt.version, '11.0.0');
  assert.equal(health.ffmpeg.state, 'ready');
  assert.equal(health.storage.state, 'ready');
});

test('reports cobalt "unsupported" when the instance does not have youtube enabled', async () => {
  const cfg = baseCfg();
  const checkHealth = createHealthChecker(cfg, {
    fetchImpl: fetchImplFor({ cobalt: { version: '11.0.0', services: ['tiktok'] } }),
  });
  const health = await checkHealth();
  assert.equal(health.cobalt.state, 'unsupported');
  assert.ok(health.cobalt.reason.includes('youtube'));
});

test('reports cobalt "unavailable" when the instance cannot be reached', async () => {
  const cfg = baseCfg();
  const checkHealth = createHealthChecker(cfg, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const health = await checkHealth();
  assert.equal(health.cobalt.state, 'unavailable');
});

test('reports cobalt "misconfigured" when COBALT_API_URL is missing, without making any network call', async () => {
  const cfg = baseCfg({ cobaltApiUrl: '' });
  let called = false;
  const checkHealth = createHealthChecker(cfg, {
    fetchImpl: async () => { called = true; throw new Error('should never be called'); },
  });
  const health = await checkHealth();
  assert.equal(health.cobalt.state, 'misconfigured');
  assert.equal(called, false);
});

test('reports ffmpeg unavailable for a nonexistent binary path', async () => {
  const cfg = baseCfg({ ffmpegPath: '/nonexistent/ffmpeg-binary-xyz' });
  const checkHealth = createHealthChecker(cfg, { fetchImpl: fetchImplFor({ cobalt: { version: '1', services: ['youtube'] } }) });
  const health = await checkHealth();
  assert.equal(health.ffmpeg.state, 'unavailable');
});

test('reports storage unavailable when the output path is not usable as a directory', async () => {
  // A path that already exists as a regular file can never become a
  // directory via mkdir(), regardless of privilege level — a reliable way
  // to force a real filesystem failure even when running as root (where
  // permission bits alone would not block the write).
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-health-'));
  const blockedPath = path.join(parent, 'this-is-a-file-not-a-dir');
  fs.writeFileSync(blockedPath, 'x');

  const cfg = baseCfg({ outputDir: blockedPath });
  const checkHealth = createHealthChecker(cfg, { fetchImpl: fetchImplFor({ cobalt: { version: '1', services: ['youtube'] } }) });
  const health = await checkHealth();
  assert.equal(health.storage.state, 'unavailable');
});

test('caches the cobalt check within cacheMs, avoiding repeated network calls', async () => {
  const cfg = baseCfg();
  let calls = 0;
  const checkHealth = createHealthChecker(cfg, {
    cacheMs: 10_000,
    fetchImpl: async () => { calls += 1; return fetchImplFor({ cobalt: { version: '1', services: ['youtube'] } })(); },
  });
  await checkHealth();
  await checkHealth();
  await checkHealth();
  assert.equal(calls, 1, 'expected the cobalt probe to be cached across calls within the cache window');
});
