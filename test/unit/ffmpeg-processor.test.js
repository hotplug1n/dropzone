import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkFfmpegAvailable, runProcess, extractToMp3, probeFile } from '../../src/ffmpeg/processor.js';
import { ProcessingError, TimeoutError } from '../../src/errors/downloader-errors.js';

test('checkFfmpegAvailable reports a version when ffmpeg is installed', async () => {
  const result = await checkFfmpegAvailable('ffmpeg');
  assert.equal(result.available, true);
  assert.match(result.version, /ffmpeg version/);
});

test('checkFfmpegAvailable reports unavailable for a nonexistent binary', async () => {
  const result = await checkFfmpegAvailable('/nonexistent/ffmpeg-binary-xyz');
  assert.equal(result.available, false);
  assert.ok(result.error instanceof ProcessingError);
});

test('runProcess enforces a timeout and kills the child process (no orphan)', async () => {
  const start = Date.now();
  await assert.rejects(
    () => runProcess('sleep', ['5'], { timeoutMs: 200, label: 'sleep' }),
    TimeoutError,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `expected timeout to fire well before natural completion, took ${elapsed}ms`);
});

test('runProcess rejects with ProcessingError on nonzero exit code, capturing stderr', async () => {
  await assert.rejects(async () => {
    try {
      await runProcess('ffmpeg', ['-y', '-i', '/nonexistent/input-file-xyz.mp4', '-f', 'null', '-'], { timeoutMs: 10_000 });
    } catch (err) {
      assert.ok(err instanceof ProcessingError);
      assert.ok(err.context.stderrTail.length > 0);
      throw err;
    }
  }, ProcessingError);
});

test('args containing shell metacharacters are never interpreted by a shell', async () => {
  // If this were run through a shell (e.g. exec("ffmpeg " + input)), the
  // semicolon would start a second command. With spawn() + argv array, the
  // whole string is just one (invalid) filename argument to -i.
  const maliciousPath = '/tmp/does-not-exist; touch /tmp/dropzone-pwned-test';
  await assert.rejects(
    () => runProcess('ffmpeg', ['-y', '-i', maliciousPath, '-f', 'null', '-'], { timeoutMs: 10_000 }),
    ProcessingError,
  );
  assert.equal(fs.existsSync('/tmp/dropzone-pwned-test'), false, 'command injection succeeded — shell interpreted the malicious argument');
});

test('extractToMp3 rejects an unsupported bitrate before spawning ffmpeg', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-'));
  await assert.rejects(
    () => extractToMp3({ inputPath: path.join(tmpDir, 'in.wav'), outPath: path.join(tmpDir, 'out.mp3'), bitrateKbps: '999' }),
    ProcessingError,
  );
});

test('probeFile raises ProcessingError for a nonexistent file', async () => {
  await assert.rejects(() => probeFile('/nonexistent/file.mp4'), ProcessingError);
});

test('probeFile raises ProcessingError for a corrupted/non-media file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-test-'));
  const fakeFile = path.join(tmpDir, 'fake.mp4');
  fs.writeFileSync(fakeFile, 'this is definitely not a video file');
  await assert.rejects(() => probeFile(fakeFile), ProcessingError);
});
