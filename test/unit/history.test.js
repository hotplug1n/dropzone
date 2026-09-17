import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordDownload, listHistory } from '../../src/services/history.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dz-history-'));
}

test('listHistory returns an empty array when no history file exists yet', async () => {
  const dir = tmpDataDir();
  assert.deepEqual(await listHistory(dir), []);
});

test('recordDownload persists an entry retrievable via listHistory', async () => {
  const dir = tmpDataDir();
  await recordDownload(dir, { filename: 'a.mp4', format: 'mp4', quality: '1080', sizeBytes: 123 });
  const history = await listHistory(dir);
  assert.equal(history.length, 1);
  assert.equal(history[0].filename, 'a.mp4');
  assert.equal(history[0].format, 'mp4');
  assert.equal(history[0].quality, '1080');
  assert.equal(history[0].sizeBytes, 123);
  assert.ok(history[0].timestamp);
});

test('recordDownload prepends newest entries first', async () => {
  const dir = tmpDataDir();
  await recordDownload(dir, { filename: 'first.mp4', format: 'mp4', sizeBytes: 1 });
  await recordDownload(dir, { filename: 'second.mp4', format: 'mp4', sizeBytes: 2 });
  const history = await listHistory(dir);
  assert.deepEqual(history.map((h) => h.filename), ['second.mp4', 'first.mp4']);
});

test('recordDownload caps history at the configured limit', async () => {
  const dir = tmpDataDir();
  for (let i = 0; i < 5; i++) {
    await recordDownload(dir, { filename: `f${i}.mp4`, format: 'mp4', sizeBytes: i }, 3);
  }
  const history = await listHistory(dir);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.filename), ['f4.mp4', 'f3.mp4', 'f2.mp4']);
});

test('listHistory recovers gracefully from a corrupted history file instead of throwing', async () => {
  const dir = tmpDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.json'), 'not valid json{{{');
  const history = await listHistory(dir);
  assert.deepEqual(history, []);
});

test('recordDownload stores mp3 bitrate entries correctly', async () => {
  const dir = tmpDataDir();
  await recordDownload(dir, { filename: 'song.mp3', format: 'mp3', bitrate: '320', sizeBytes: 999 });
  const history = await listHistory(dir);
  assert.equal(history[0].bitrate, '320');
  assert.equal(history[0].quality, null);
});
