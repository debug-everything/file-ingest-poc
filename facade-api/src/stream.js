import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSampler } from './metrics.js';
import { NotFoundError, UpstreamError, openUpstream } from './partner.js';
import { addSample, createRun } from './runs.js';

const DEFAULT_HWM = 64 * 1024;
const PASS_HEADERS = ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag'];

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** GET /files/:purpose. Resolves the latest file at the partner and streams it through. */
export async function handleFile(req, res, { url, purpose, runId, partner, config, log }) {
  const variant = url.searchParams.get('variant') ?? undefined;
  const mode = url.searchParams.get('mode') ?? 'stream';
  const hwmParam = url.searchParams.get('hwm');
  const hwm = hwmParam === null ? DEFAULT_HWM : Number(hwmParam);
  if (
    (variant !== undefined && !/^[a-z0-9]{1,16}$/.test(variant)) ||
    !['stream', 'buffer'].includes(mode) ||
    !Number.isInteger(hwm) || hwm < 1024 || hwm > 16 * 1024 * 1024
  ) {
    return sendJson(res, 400, { error: 'bad variant, mode or hwm' }, { 'x-run-id': runId });
  }

  const run = createRun(runId, { purpose, variant: variant ?? null, mode, partnerMode: partner.mode });
  const sampler = createSampler({
    runId,
    intervalMs: config.metricsIntervalMs,
    emit: (s) => {
      addSample(run, s);
      log(s);
    },
  });

  const controller = new AbortController();
  let clientAborted = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientAborted = true;
      controller.abort();
    }
  });
  // Backpressure: count res.write() calls that returned false, and time how long each one waits for 'drain'.
  let waitStart = null;
  const write = res.write.bind(res);
  res.write = (...args) => {
    const ok = write(...args);
    if (!ok && waitStart === null) {
      waitStart = performance.now();
      sampler.backpressure();
    }
    return ok;
  };
  res.on('drain', () => {
    if (waitStart !== null) sampler.addDrainWait(performance.now() - waitStart);
    waitStart = null;
  });

  sampler.start({ partnerMode: partner.mode, mode, variant: variant ?? null, hwm });
  const t0 = performance.now();
  try {
    const file = await partner.resolveLatest({ purpose, variant, runId, signal: controller.signal });
    const resolveMs = Math.round(performance.now() - t0);
    run.fileId = file.id;

    const upstreamHeaders = { ...file.headers, 'accept-encoding': 'identity', 'x-request-id': runId };
    if (req.headers.range) upstreamHeaders.range = req.headers.range;
    const upstream = await openUpstream(file.url, {
      headers: upstreamHeaders,
      signal: controller.signal,
      checkUrl: partner.checkUrl,
      highWaterMark: hwm,
    });

    if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
      await upstream.body.dump().catch(() => {});
      throw new UpstreamError(`partner contents returned ${upstream.statusCode}`, upstream.statusCode);
    }
    const encoding = upstream.headers['content-encoding'];
    if (encoding && encoding !== 'identity') {
      upstream.body.destroy();
      throw new UpstreamError(`upstream sent Content-Encoding: ${encoding}. Throughput numbers would be meaningless`, upstream.statusCode);
    }
    const length = Number(upstream.headers['content-length']);
    if (mode === 'buffer' && !(length <= config.bufferModeMaxBytes)) {
      upstream.body.destroy();
      run.status = 413;
      sampler.finish('error', { error: 'buffer mode refused' });
      return sendJson(res, 413, { error: 'too large for mode=buffer', limit: config.bufferModeMaxBytes }, { 'x-run-id': runId });
    }

    const headers = { 'x-run-id': runId, 'x-upstream-file-id': file.id, 'cache-control': 'no-store' };
    for (const name of PASS_HEADERS) {
      if (upstream.headers[name] !== undefined) headers[name] = upstream.headers[name];
    }
    run.status = upstream.statusCode;
    res.writeHead(upstream.statusCode, headers);

    let sawFirstByte = false;
    const count = (chunk) => {
      if (!sawFirstByte) {
        sawFirstByte = true;
        sampler.firstByte({ resolveMs, redirectMs: upstream.redirectMs, upstreamStatus: upstream.statusCode });
      }
      sampler.addBytes(chunk.length);
    };

    if (mode === 'buffer') {
      // The anti-pattern, on purpose: hold the whole body in memory, then respond.
      const chunks = [];
      for await (const chunk of upstream.body) {
        count(chunk);
        chunks.push(chunk);
      }
      await pipeline(Readable.from(chunks, { objectMode: false }), res);
    } else {
      // Pass-through meter. It hands the same chunk on and keeps no reference to it.
      const meter = new Transform({
        highWaterMark: hwm,
        transform(chunk, _enc, cb) {
          count(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(upstream.body, meter, res);
    }
    sampler.finish('end');
  } catch (err) {
    if (clientAborted) {
      sampler.finish('aborted');
      return;
    }
    const status = err instanceof NotFoundError ? 404 : err instanceof UpstreamError ? 502 : 500;
    sampler.finish('error', { error: err.message });
    if (res.headersSent) {
      // Too late for a status code. Killing the socket is the only signal left.
      log({ runId, msg: 'stream failed after headers were sent, destroying socket', error: err.message });
      res.destroy();
      return;
    }
    run.status = status;
    const headers = { 'x-run-id': runId };
    if (err.upstreamStatus) headers['x-upstream-status'] = String(err.upstreamStatus);
    sendJson(res, status, { error: status === 500 ? 'internal error' : err.message }, headers);
  }
}
