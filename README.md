# Dropzone

A YouTube downloader (MP4 video / MP3 audio) built by `hotplug1n`.

Dropzone does **not** extract media from YouTube itself. It is a thin,
security-conscious client + local FFmpeg post-processing layer in front of a
[Cobalt](https://github.com/imputnet/cobalt)-compatible API instance that you
run yourself or are explicitly authorized to use. Point `COBALT_API_URL` at
that instance (see [`docs/run-an-instance.md`](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
in the Cobalt repo to self-host one) — Dropzone never defaults to, or talks
to, any public instance on its own.

Use it only to download content you own or are otherwise authorized to
download. It implements no DRM bypass, no paywall bypass, and no
authentication bypass.

## Architecture

```
public/index.html            simple web form (MP4/MP3, quality, bitrate)
        |
src/server.js                Express server, SSE progress, no direct HTTP to Cobalt
        |
src/services/youtube.js      validates & normalizes the YouTube URL
src/downloader/formats.js    validates the format/quality/bitrate selection
src/downloader/downloader.js orchestrates the whole flow
        |
src/api/cobalt-client.js     the ONLY module that talks HTTP to the Cobalt API
        | (tunnel / local-processing / redirect / picker / error)
src/utils/security.js        SSRF guard on every remote URL before download
        |
src/ffmpeg/processor.js      spawn()-based ffmpeg/ffprobe wrapper, validation
        |
downloads/                   finished, sanitized-filename output files
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Purpose |
|---|---|
| `COBALT_API_URL` | Your Cobalt-compatible instance. Required. |
| `COBALT_API_KEY` | Optional `Api-Key` credential. |
| `DOWNLOAD_TIMEOUT` / `FFMPEG_TIMEOUT` | Timeouts in ms. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Binary paths. |
| `MAX_FILE_SIZE` | Hard cap per file, in bytes. |
| `OUTPUT_DIR` / `TEMP_DIR` | Where files are written. |

Never commit a real `.env` file.

## Running

```sh
npm install
npm start
```

## Testing

```sh
npm test               # unit tests (mocked Cobalt API)
npm run test:integration  # full pipeline against a local fixture server + real ffmpeg
```

The integration suite exercises the entire download → ffmpeg → validation
pipeline end-to-end over a real local HTTP server and real FFmpeg binary,
using synthetic media fixtures. It does not contact YouTube or any Cobalt
instance over the public internet — see the project's technical report for
why, and what that means for coverage.

## Cobalt attribution

Dropzone's architecture (proxy-style tunnel client, `spawn()`-only FFmpeg
invocation, explicit stream mapping, allowlisted metadata) is inspired by the
design of [imputnet/cobalt](https://github.com/imputnet/cobalt), licensed
under AGPL-3.0. No source code from that repository is copied or vendored
here; only architectural concepts were reused, reimplemented independently
under this project's own license.
