# Dropzone

A YouTube downloader (MP4 video / MP3 audio) built by `hotplug1n`.

Dropzone does **not** extract media from YouTube itself. It is a thin,
security-conscious client + local FFmpeg post-processing layer in front of a
[Cobalt](https://github.com/imputnet/cobalt)-compatible API instance that you
run yourself or are explicitly authorized to use. Point `COBALT_API_URL` at
that instance (see [`docs/run-an-instance.md`](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
in the Cobalt repo to self-host one, or use `docker-compose.yml` in this
repo, which runs the official `ghcr.io/imputnet/cobalt:11` image) — Dropzone
never defaults to, or talks to, any public instance on its own, and refuses
to fake a "connected" status when it can't reach one (see `/api/health`).

Use it only to download content you own or are otherwise authorized to
download. It implements no DRM bypass, no paywall bypass, and no
authentication bypass.

## Architecture

```
public/{index.html,styles.css,app.js}   terminal-styled web UI (no build step)
        |
src/server.js                Express server: SSE progress, health, inspect,
        |                    history — no direct HTTP to Cobalt from here
src/services/youtube.js      validates & normalizes the YouTube URL
src/services/inspect.js      pre-download metadata probe (title/author/thumb)
src/services/health.js       real, cached liveness check (cobalt/ffmpeg/storage)
src/services/history.js      JSON-file-backed download history log
src/downloader/formats.js    validates the format/quality/bitrate selection
src/downloader/downloader.js orchestrates the whole flow, real ffmpeg progress
        |
src/api/cobalt-client.js     the ONLY module that talks HTTP to the Cobalt API
        | (tunnel / local-processing / redirect / picker / error, with retry)
src/utils/security.js        SSRF guard on every remote URL before download
        |
src/ffmpeg/processor.js      spawn()-based ffmpeg/ffprobe wrapper, validation,
        |                    real -progress-derived percentages, abortable
downloads/                   finished, sanitized-filename output files
data/history.json            download history log
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Purpose |
|---|---|
| `COBALT_API_URL` | Your Cobalt-compatible instance. Required — validated at startup, and `/api/health` reports `misconfigured` if missing/invalid. |
| `COBALT_API_KEY` | Optional `Api-Key` credential. |
| `COBALT_CONNECT_TIMEOUT` | Timeout (ms) for the metadata/tunnel-request call and health check. |
| `COBALT_REQUEST_TIMEOUT` | Timeout (ms) for streaming the actual media file. |
| `COBALT_RETRIES` | Retries for transient (network/timeout/5xx) metadata-call failures. Never retries a 4xx or a partial byte-stream download. |
| `FFMPEG_TIMEOUT` | FFmpeg processing timeout, in ms. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Binary paths. |
| `MAX_FILE_SIZE` | Hard cap per file, in bytes. |
| `OUTPUT_DIR` / `TEMP_DIR` / `DATA_DIR` | Where files, temp work, and history are stored. |
| `TRUST_PROXY` | Only set to `1` behind a trusted reverse proxy — see `.env.example`. |

Never commit a real `.env` file.

## Running

```sh
npm install
npm start
```

Or with Docker Compose (runs the official Cobalt image alongside Dropzone):

```sh
docker compose up --build
```

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Supported formats/qualities/bitrates + UI defaults. |
| `GET /api/health` | Real-time `{cobalt, ffmpeg, storage}` status — never fabricated. |
| `POST /api/inspect` | Resolves a YouTube URL via Cobalt (+ best-effort YouTube oEmbed enrichment) without downloading anything. |
| `GET /api/download-stream` | SSE stream of real progress events, ending in `done` or `error`. |
| `GET /api/history` | Recent completed downloads. |
| `GET /files/:name` | Serves a finished file. |

## Testing

```sh
npm test               # unit tests (mocked Cobalt API, no network/ffmpeg-heavy work)
npm run test:integration  # full pipeline + HTTP server against local fixtures + real ffmpeg
```

The integration suite exercises the entire download → ffmpeg → validation
pipeline, and the real Express HTTP/SSE layer, over local sockets with real
FFmpeg binaries and synthetic media fixtures — including SSRF enforcement,
rate limiting, path traversal protection, and cancellation on client
disconnect. It does not contact YouTube or a real Cobalt instance over the
public internet — see the project's technical report for why, and what that
means for coverage.

## Cobalt attribution

Dropzone's architecture (proxy-style tunnel client, `spawn()`-only FFmpeg
invocation, explicit stream mapping, allowlisted metadata) is inspired by the
design of [imputnet/cobalt](https://github.com/imputnet/cobalt), licensed
under AGPL-3.0. No source code from that repository is copied or vendored
here; only architectural concepts were reused, reimplemented independently
under this project's own license.
