import { Agent, request } from 'undici';

const MAX_REDIRECTS = 3;
const dispatcher = new Agent({ connect: { timeout: 10_000 } });

export class NotFoundError extends Error {}

export class UpstreamError extends Error {
  constructor(message, upstreamStatus = null) {
    super(message);
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * GET with manual redirect following, so the redirect hop can be timed and every hop is checked
 * against the host allowlist. Range and the other headers are re-sent on each hop.
 * Authorization is dropped when the redirect leaves the original origin.
 */
export async function openUpstream(url, { headers = {}, signal, checkUrl, highWaterMark } = {}) {
  let current = new URL(url);
  let hopHeaders = headers;
  let redirectMs = 0;
  for (let hop = 0; ; hop += 1) {
    checkUrl?.(current);
    const t0 = performance.now();
    let res;
    try {
      res = await request(current, { method: 'GET', headers: hopHeaders, signal, dispatcher, highWaterMark });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`upstream connect failed: ${err.code ?? err.message}`);
    }
    const location = res.headers.location;
    if (res.statusCode < 300 || res.statusCode >= 400 || !location) {
      return { ...res, redirectMs: Math.round(redirectMs), hops: hop };
    }
    await res.body.dump().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new UpstreamError('too many upstream redirects', res.statusCode);
    redirectMs += performance.now() - t0;
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([k]) => k.toLowerCase() !== 'authorization'));
    }
    current = next;
  }
}

async function getJson(url, opts) {
  const res = await openUpstream(url, opts);
  if (res.statusCode === 404) {
    await res.body.dump().catch(() => {});
    throw new NotFoundError('partner has no such file');
  }
  if (res.statusCode !== 200) {
    await res.body.dump().catch(() => {});
    throw new UpstreamError(`partner lookup returned ${res.statusCode}`, res.statusCode);
  }
  try {
    return await res.body.json();
  } catch {
    throw new UpstreamError('partner lookup returned invalid JSON', res.statusCode);
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function apiPartner({ baseUrl, token }) {
  if (!baseUrl || !token) throw new Error('PARTNER_MODE=api needs PARTNER_BASE_URL and PARTNER_TOKEN');
  const base = new URL(baseUrl);
  const auth = { authorization: `Bearer ${token}` };
  return {
    mode: 'api',
    async resolveLatest({ purpose, variant, runId, signal }) {
      const lookup = new URL('/v1/files', base);
      lookup.searchParams.set('purpose', purpose);
      if (variant) lookup.searchParams.set('variant', variant);
      lookup.searchParams.set('latest', 'true');
      const meta = await getJson(lookup, { headers: { ...auth, 'x-request-id': runId }, signal });
      if (!SAFE_ID.test(meta.id ?? '')) throw new UpstreamError('partner returned an unusable file id');
      return {
        id: meta.id,
        size: meta.size,
        url: new URL(`/v1/files/${encodeURIComponent(meta.id)}/contents`, base),
        headers: auth,
      };
    },
  };
}

function staticPartner({ manifestUrl, ttlMs, allowedHosts, defaultVariant }) {
  if (!manifestUrl) throw new Error('PARTNER_MODE=static needs PARTNER_MANIFEST_URL');
  let cached = null;
  let cachedAt = 0;

  // Manifest URLs and redirect targets are data, so every hop has to be on the allowlist.
  // A leading dot means "this domain and any subdomain".
  const hostAllowed = (host) =>
    allowedHosts.some((h) => (h.startsWith('.') ? host === h.slice(1) || host.endsWith(h) : host === h));
  const checkUrl = (u) => {
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UpstreamError('upstream URL must be https');
    if (!hostAllowed(u.hostname)) throw new UpstreamError(`upstream host not allowed: ${u.hostname}`);
  };

  async function manifest(signal) {
    if (!cached || Date.now() - cachedAt > ttlMs) {
      cached = await getJson(manifestUrl, { headers: { 'accept-encoding': 'identity' }, signal, checkUrl });
      cachedAt = Date.now();
    }
    return cached;
  }

  return {
    mode: 'static',
    checkUrl,
    async resolveLatest({ purpose, variant, signal }) {
      const m = await manifest(signal);
      const entry = m.purpose === purpose ? m.latest?.[variant ?? defaultVariant] : undefined;
      if (!entry) throw new NotFoundError('manifest has no such file');
      if (!SAFE_ID.test(entry.id ?? '')) throw new UpstreamError('manifest has an unusable file id');
      return { id: entry.id, size: entry.size, url: new URL(entry.url), headers: {} };
    },
  };
}

export function createPartner(env = process.env) {
  const mode = env.PARTNER_MODE ?? 'api';
  if (mode === 'api') return apiPartner({ baseUrl: env.PARTNER_BASE_URL, token: env.PARTNER_TOKEN });
  if (mode === 'static') {
    return staticPartner({
      manifestUrl: env.PARTNER_MANIFEST_URL,
      ttlMs: Number(env.MANIFEST_TTL_MS ?? 300_000),
      allowedHosts: (env.PARTNER_ALLOWED_HOSTS ?? 'github.com,.githubusercontent.com').split(',').map((h) => h.trim()).filter(Boolean),
      defaultVariant: env.DEFAULT_VARIANT ?? '100mb',
    });
  }
  throw new Error(`unknown PARTNER_MODE: ${mode}`);
}
