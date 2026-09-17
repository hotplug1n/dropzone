import http from 'node:http';
import fs from 'node:fs';

/**
 * Minimal HTTP server implementing the subset of the Cobalt API contract
 * (POST / -> {status, ...}, GET / -> instance info, GET /media/* -> file
 * bytes) needed to exercise DropZone's full pipeline end-to-end over a real
 * socket, without depending on a real Cobalt deployment or on YouTube itself.
 *
 * `scenario` is a function (payload) => response-shape, letting each test
 * control exactly what the "API" replies with. `instanceInfo`, if provided,
 * controls the GET / response used for health checks; defaults to a
 * well-formed Cobalt instance info body.
 */
export function startFakeCobaltServer({ scenario, mediaFiles, instanceInfo }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const info = instanceInfo || {
        cobalt: { version: 'test', url: 'http://fake', startTime: '0', services: ['youtube'] },
        git: {},
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
      return;
    }

    if (req.method === 'POST' && req.url === '/') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: { code: 'error.api.bad_json' } }));
          return;
        }
        const { httpStatus = 200, body: responseBody } = scenario(payload);
        res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/media/')) {
      const key = req.url.replace('/media/', '');
      const filePath = mediaFiles[key];
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Length': String(stat.size) });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        mediaUrl: (key) => `http://127.0.0.1:${port}/media/${key}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
