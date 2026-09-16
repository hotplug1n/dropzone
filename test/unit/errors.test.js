import test from 'node:test';
import assert from 'node:assert/strict';
import * as Errors from '../../src/errors/downloader-errors.js';

const subclasses = [
  'InvalidUrlError', 'UnsupportedUrlError', 'InvalidOptionsError', 'ApiError',
  'AuthenticationError', 'RateLimitError', 'MediaUnavailableError', 'ProcessingError',
  'DownloadError', 'FileSystemError', 'TimeoutError', 'ConfigurationError', 'SecurityError',
];

for (const name of subclasses) {
  test(`${name} extends DownloaderError and carries code/message/context`, () => {
    const Cls = Errors[name];
    const cause = new Error('root cause');
    const err = new Cls('technical detail', { context: { foo: 'bar' }, cause });

    assert.ok(err instanceof Errors.DownloaderError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, name);
    assert.ok(typeof err.code === 'string' && err.code.length > 0);
    assert.ok(typeof err.friendlyMessage === 'string' && err.friendlyMessage.length > 0);
    assert.deepEqual(err.context, { foo: 'bar' });
    assert.equal(err.cause, cause);
    assert.equal(err.message, 'technical detail');
  });
}

test('toJSON() never leaks a stack trace or raw cause to clients', () => {
  const err = new Errors.ProcessingError('internal stack detail /home/user/secret/path', {
    context: { exitCode: 1 },
    cause: new Error('internal cause'),
  });
  const json = err.toJSON();
  assert.deepEqual(Object.keys(json).sort(), ['code', 'context', 'message']);
  assert.ok(!('stack' in json));
  assert.ok(!('cause' in json));
});

test('default friendly message is used when none is provided', () => {
  const err = new Errors.DownloaderError('raw');
  assert.equal(err.code, 'DOWNLOADER_ERROR');
  assert.ok(err.friendlyMessage.length > 0);
});
