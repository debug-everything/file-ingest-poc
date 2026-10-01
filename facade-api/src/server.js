import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createPartner } from './partner.js';
import { getRun, listRuns } from './runs.js';
import { handleFile } from './stream.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.FACADE_TOKEN;
const config = {
  metricsIntervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 1000),
  bufferModeMaxBytes: Number(process.env.BUFFER_MODE_MAX_BYTES ?? 150 * 1024 * 1024),
};

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

if (!TOKEN) {
  log({ msg: 'FACADE_TOKEN is required' });
  process.exit(1);
}
const partner = createPartner();
const tokenBuf = Buffer.from(`Bearer ${TOKEN}`);

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let now = Date.now();
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = B32[now % 32] + time;
    now = Math.floor(now / 32);
  }
  return time + [...randomBytes(16)].map((b) => B32[b & 31]).join('');
}

function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function route(req, res, url, runId) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });

  if (url.pathname === '/runs') return sendJson(res, 200, listRuns());

  let m = /^\/runs\/([A-Za-z0-9_-]{1,64})\/metrics$/.exec(url.pathname);
  if (m) {
    const run = getRun(m[1]);
    return run ? sendJson(res, 200, run.samples) : sendJson(res, 404, { error: 'unknown run' });
  }

  m = /^\/files\/([a-z0-9_-]{1,32})$/.exec(url.pathname);
  if (m) return handleFile(req, res, { url, purpose: m[1], runId, partner, config, log });

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url, 'http://facade.local');
  const clientRunId = req.headers['x-run-id'];
  const runId = /^[A-Za-z0-9_-]{1,64}$/.test(clientRunId ?? '') ? clientRunId : ulid();
  try {
    await route(req, res, url, runId);
  } catch (err) {
    log({ runId, msg: 'unhandled error', error: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }
  log({ runId, msg: 'request', path: url.pathname, status: res.statusCode, durationMs: Math.round(performance.now() - t0) });
});

server.listen(PORT, () => log({ msg: 'facade-api listening', port: PORT, partnerMode: partner.mode, ...config }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
