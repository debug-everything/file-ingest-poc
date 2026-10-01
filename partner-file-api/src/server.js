import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseRange } from './range.js';
import { PURPOSE, configuredVariants, dataDir, fileId } from './variants.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.PARTNER_TOKEN;
const DEFAULT_VARIANT = process.env.DEFAULT_VARIANT ?? '100mb';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_DOWNLOADS ?? 2);
const READ_HWM = 64 * 1024;

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

if (!TOKEN) {
  log({ msg: 'PARTNER_TOKEN is required' });
  process.exit(1);
}

// Metadata comes from the sidecars once at startup. Requests never hash or stat.
function loadFiles() {
  const dir = dataDir();
  const byId = new Map();
  const byVariant = new Map();
  for (const variant of configuredVariants()) {
    const id = fileId(variant);
    const csvPath = path.join(dir, `${id}.csv`);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      if (fs.statSync(csvPath).size !== meta.size) throw new Error('size does not match sidecar');
    } catch (err) {
      log({ msg: 'test file missing or stale, run `pnpm generate` first', variant, error: err.message });
      process.exit(1);
    }
    const entry = { meta, csvPath };
    byId.set(id, entry);
    byVariant.set(variant, entry);
  }
  return { byId, byVariant };
}

const files = loadFiles();
const tokenBuf = Buffer.from(`Bearer ${TOKEN}`);
let activeDownloads = 0;

function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
  return payload.length;
}

// Counts bytes, and paces them when ?throttle_kbps=N (kilobits per second) is set.
function meter(ctx, kbps) {
  const bytesPerMs = kbps > 0 ? (kbps * 1000) / 8 / 1000 : 0;
  return new Transform({
    highWaterMark: READ_HWM,
    transform(chunk, _enc, cb) {
      ctx.bytesSent += chunk.length;
      if (!bytesPerMs) return cb(null, chunk);
      sleep(chunk.length / bytesPerMs).then(() => cb(null, chunk));
    },
  });
}

async function sendContents(req, res, url, entry, ctx) {
  const { meta, csvPath } = entry;
  const range = parseRange(req.headers.range, meta.size);
  if (range === 'unsatisfiable') {
    return sendJson(res, 416, { error: 'range not satisfiable' }, { 'content-range': `bytes */${meta.size}` });
  }
  if (activeDownloads >= MAX_CONCURRENT) {
    return sendJson(res, 429, { error: 'too many concurrent downloads' }, { 'retry-after': '5' });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? meta.size - 1;
  const headers = {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    etag: `"${meta.sha256}"`,
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
  // No Content-Encoding, whatever Accept-Encoding says. Compression would wreck the measurements.
  res.writeHead(range ? 206 : 200, headers);

  const kbps = Number(url.searchParams.get('throttle_kbps')) || 0;
  activeDownloads += 1;
  try {
    await pipeline(fs.createReadStream(csvPath, { start, end, highWaterMark: READ_HWM }), meter(ctx, kbps), res);
  } catch (err) {
    ctx.aborted = true;
    ctx.error = err.code ?? err.message;
  } finally {
    activeDownloads -= 1;
  }
}

async function route(req, res, url, ctx) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });

  if (url.pathname === '/v1/files') {
    const variant = url.searchParams.get('variant') ?? DEFAULT_VARIANT;
    const entry = url.searchParams.get('purpose') === PURPOSE ? files.byVariant.get(variant) : undefined;
    return entry ? sendJson(res, 200, entry.meta) : sendJson(res, 404, { error: 'no file for purpose/variant' });
  }

  const m = /^\/v1\/files\/([A-Za-z0-9_]+)(\/contents)?$/.exec(url.pathname);
  const entry = m && files.byId.get(m[1]);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (!m[2]) return sendJson(res, 200, entry.meta);
  return sendContents(req, res, url, entry, ctx);
}

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url, 'http://partner.local');
  const headerId = req.headers['x-request-id'];
  const reqId = /^[A-Za-z0-9_-]{1,64}$/.test(headerId ?? '') ? headerId : randomUUID();
  const ctx = { bytesSent: 0, aborted: false };

  try {
    const jsonBytes = await route(req, res, url, ctx);
    if (typeof jsonBytes === 'number') ctx.bytesSent = jsonBytes;
  } catch (err) {
    ctx.error = err.message;
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }

  log({
    reqId,
    path: url.pathname,
    range: req.headers.range ?? null,
    status: res.statusCode,
    bytesSent: ctx.bytesSent,
    durationMs: Math.round(performance.now() - t0),
    aborted: ctx.aborted,
    ...(ctx.error && { error: ctx.error }),
  });
});

server.listen(PORT, () => {
  log({ msg: 'partner-file-api listening', port: PORT, variants: [...files.byVariant.keys()], maxConcurrent: MAX_CONCURRENT });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
