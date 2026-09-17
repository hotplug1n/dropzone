import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../errors/downloader-errors.js';

function historyFilePath(dataDir) {
  return path.join(dataDir, 'history.json');
}

async function readHistory(dataDir) {
  try {
    const raw = await fs.readFile(historyFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // A corrupted history file must never crash downloads; start fresh
    // rather than silently pretending history doesn't exist elsewhere.
    return [];
  }
}

/**
 * Appends a completed download to the on-disk history log (capped to
 * `limit` most recent entries). Best-effort: a failure to persist history
 * must never fail the download itself, so callers should not await this
 * on the critical path without a try/catch — see server.js.
 */
export async function recordDownload(dataDir, entry, limit = 200) {
  await fs.mkdir(dataDir, { recursive: true });
  const history = await readHistory(dataDir);
  history.unshift({
    timestamp: new Date().toISOString(),
    filename: entry.filename,
    format: entry.format,
    quality: entry.quality || null,
    bitrate: entry.bitrate || null,
    sizeBytes: entry.sizeBytes,
  });
  const trimmed = history.slice(0, limit);

  try {
    const tmpPath = `${historyFilePath(dataDir)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(trimmed, null, 2), 'utf8');
    await fs.rename(tmpPath, historyFilePath(dataDir));
  } catch (cause) {
    throw new FileSystemError('Could not persist download history', { cause });
  }
}

export async function listHistory(dataDir) {
  return readHistory(dataDir);
}
