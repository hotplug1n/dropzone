import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { ProcessingError, TimeoutError } from '../errors/downloader-errors.js';

const STDERR_TAIL_LIMIT = 4000;

/**
 * Runs an executable (ffmpeg/ffprobe) via spawn() with an argv array —
 * never through a shell, so user-controlled strings (titles, URLs) can
 * never be interpreted as shell syntax. Applies a hard timeout, captures
 * stderr for diagnostics, and guarantees the child process is not left
 * orphaned. Also honors an external AbortSignal, so a caller can cancel a
 * running ffmpeg job (e.g. the browser disconnected) without waiting for
 * the full timeout.
 *
 * @param {string} cmdPath
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.label]
 * @param {AbortSignal} [opts.signal]
 * @param {(line: string) => void} [opts.onStdoutLine] - called per stdout line, for progress parsing.
 */
function runProcess(cmdPath, args, { timeoutMs = 300_000, label = cmdPath, signal, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    let stderrTail = '';
    let stdoutBuf = '';
    let settled = false;
    let killTimer;
    let killReason = null; // 'timeout' | 'abort'

    let child;
    try {
      child = spawn(cmdPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      reject(new ProcessingError(`Failed to spawn ${label}`, { context: { cmdPath }, cause }));
      return;
    }

    const kill = (reason) => {
      if (settled) return;
      killReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
    };

    const timeoutTimer = setTimeout(() => kill('timeout'), timeoutMs);

    const onAbort = () => kill('abort');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (onStdoutLine) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', onStdoutLine);
    } else {
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        if (stdoutBuf.length > 10 * 1024 * 1024) stdoutBuf = stdoutBuf.slice(-1024 * 1024);
      });
    }

    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
      }
    });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProcessingError(`${label} process failed to start or crashed`, {
        context: { cmdPath, args: redactArgs(args) },
        cause,
      }));
    });

    child.on('close', (exitCode, nodeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (killReason === 'timeout' || nodeSignal === 'SIGTERM' || nodeSignal === 'SIGKILL') {
        if (killReason === 'abort') {
          reject(new ProcessingError(`${label} was cancelled`, { context: { cmdPath, stderrTail } }));
        } else {
          reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms and was killed`, {
            context: { cmdPath, timeoutMs, stderrTail },
          }));
        }
        return;
      }
      if (killReason === 'abort') {
        reject(new ProcessingError(`${label} was cancelled`, { context: { cmdPath, stderrTail } }));
        return;
      }

      if (exitCode !== 0) {
        reject(new ProcessingError(`${label} exited with code ${exitCode}`, {
          context: { cmdPath, exitCode, stderrTail, args: redactArgs(args) },
        }));
        return;
      }

      resolve({ stdout: stdoutBuf, stderr: stderrTail });
    });
  });
}

// Avoid leaking full remote URLs (which may embed tokens) into logs/errors.
function redactArgs(args) {
  return args.map((a) => (typeof a === 'string' && /^https?:\/\//.test(a) ? '[url redacted]' : a));
}

export async function checkFfmpegAvailable(ffmpegPath = 'ffmpeg') {
  try {
    const result = await new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawn(ffmpegPath, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (cause) {
        reject(new ProcessingError('Failed to spawn ffmpeg', { cause }));
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.on('error', (cause) => { clearTimeout(timer); reject(new ProcessingError('ffmpeg not available', { cause })); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { reject(new ProcessingError(`ffmpeg -version exited with code ${code}`)); return; }
        resolve(out);
      });
    });
    const versionLine = result.split('\n')[0] || '';
    return { available: true, version: versionLine.trim() };
  } catch (err) {
    return { available: false, error: err };
  }
}

/** Parses ffmpeg `-progress pipe:1` key=value lines into a 0-100 percent, given a known total duration. */
function makeProgressParser(totalDurationSeconds, onProgress) {
  return (line) => {
    const match = /^out_time_ms=(-?\d+)/.exec(line) || /^out_time_us=(-?\d+)/.exec(line);
    if (match && totalDurationSeconds > 0) {
      const seconds = Number(match[1]) / 1_000_000;
      const percent = Math.max(0, Math.min(100, (seconds / totalDurationSeconds) * 100));
      onProgress(percent);
      return;
    }
    if (line.startsWith('progress=end')) {
      onProgress(100);
    }
  };
}

function progressArgs({ totalDurationSeconds, onProgress }) {
  if (!onProgress || !totalDurationSeconds) return { extraArgs: [], onStdoutLine: undefined };
  return {
    extraArgs: ['-progress', 'pipe:1', '-nostats'],
    onStdoutLine: makeProgressParser(totalDurationSeconds, onProgress),
  };
}

/**
 * Muxes a separate video and audio stream into a single MP4 file without
 * re-encoding (stream copy), mapping video/audio explicitly by index —
 * mirroring a real bug fixed upstream in cobalt (commit d3793c7) where
 * implicit mapping silently dropped video/audio when extra streams were
 * present.
 */
export async function muxToMp4({
  videoPath, audioPath, outPath, ffmpegPath = 'ffmpeg', timeoutMs, signal,
  totalDurationSeconds, onProgress,
}) {
  const { extraArgs, onStdoutLine } = progressArgs({ totalDurationSeconds, onProgress });
  const args = [
    '-y',
    '-loglevel', 'error',
    ...extraArgs,
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-f', 'mp4',
    outPath,
  ];
  await runProcess(ffmpegPath, args, { timeoutMs, label: 'ffmpeg (mux mp4)', signal, onStdoutLine });
  return outPath;
}

/** Remuxes a single input file into an MP4 container without re-encoding. */
export async function remuxToMp4({
  inputPath, outPath, ffmpegPath = 'ffmpeg', timeoutMs, signal,
  totalDurationSeconds, onProgress,
}) {
  const { extraArgs, onStdoutLine } = progressArgs({ totalDurationSeconds, onProgress });
  const args = [
    '-y',
    '-loglevel', 'error',
    ...extraArgs,
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-f', 'mp4',
    outPath,
  ];
  await runProcess(ffmpegPath, args, { timeoutMs, label: 'ffmpeg (remux mp4)', signal, onStdoutLine });
  return outPath;
}

const BITRATE_TO_FLAG = { 128: '128k', 192: '192k', 256: '256k', 320: '320k' };

/** Extracts/transcodes the audio track of an input file into an MP3 at the given bitrate. */
export async function extractToMp3({
  inputPath, outPath, bitrateKbps, ffmpegPath = 'ffmpeg', timeoutMs, signal,
  totalDurationSeconds, onProgress,
}) {
  const flag = BITRATE_TO_FLAG[Number(bitrateKbps)];
  if (!flag) {
    throw new ProcessingError(`Unsupported MP3 bitrate: ${bitrateKbps}`, { context: { bitrateKbps } });
  }

  const { extraArgs, onStdoutLine } = progressArgs({ totalDurationSeconds, onProgress });
  const args = [
    '-y',
    '-loglevel', 'error',
    ...extraArgs,
    '-i', inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', flag,
    '-f', 'mp3',
    outPath,
  ];
  await runProcess(ffmpegPath, args, { timeoutMs, label: 'ffmpeg (mp3)', signal, onStdoutLine });
  return outPath;
}

/** Probes a media file with ffprobe and returns structured stream/format info. */
export async function probeFile(filePath, { ffprobePath = 'ffprobe', timeoutMs = 30_000 } = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  const { stdout } = await runProcess(ffprobePath, args, { timeoutMs, label: 'ffprobe' });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new ProcessingError('ffprobe returned malformed JSON', { context: { filePath }, cause });
  }

  return {
    formatName: parsed.format?.format_name || '',
    durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : null,
    sizeBytes: parsed.format?.size ? Number(parsed.format.size) : null,
    streams: (parsed.streams || []).map((s) => ({
      codecType: s.codec_type,
      codecName: s.codec_name,
    })),
  };
}

export async function validateMp4File(filePath, { expectAudio = true, ffprobePath } = {}) {
  const info = await probeFile(filePath, { ffprobePath });

  const hasVideo = info.streams.some((s) => s.codecType === 'video');
  const hasAudio = info.streams.some((s) => s.codecType === 'audio');

  if (!info.formatName.includes('mp4')) {
    throw new ProcessingError('Output file is not a valid MP4 container', { context: { filePath, info } });
  }
  if (!hasVideo) {
    throw new ProcessingError('Output MP4 has no video stream', { context: { filePath, info } });
  }
  if (expectAudio && !hasAudio) {
    throw new ProcessingError('Output MP4 has no audio stream (expected one)', { context: { filePath, info } });
  }
  if (!info.durationSeconds || info.durationSeconds <= 0) {
    throw new ProcessingError('Output MP4 has invalid or zero duration', { context: { filePath, info } });
  }

  return info;
}

export async function validateMp3File(filePath, { ffprobePath } = {}) {
  const info = await probeFile(filePath, { ffprobePath });

  const audioStream = info.streams.find((s) => s.codecType === 'audio');

  if (!audioStream) {
    throw new ProcessingError('Output MP3 has no audio stream', { context: { filePath, info } });
  }
  if (!/mp3/.test(info.formatName) && audioStream.codecName !== 'mp3') {
    throw new ProcessingError('Output file is not a valid MP3', { context: { filePath, info } });
  }
  if (!info.durationSeconds || info.durationSeconds <= 0) {
    throw new ProcessingError('Output MP3 has invalid or zero duration', { context: { filePath, info } });
  }

  return info;
}

export { runProcess };
