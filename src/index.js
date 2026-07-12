/**
 * milair-history-proxy
 * ---------------------
 * A tiny Cloudflare Worker that lets a browser-only app (MilAir Watch) read
 * HISTORICAL flight data from the OpenSky Network.
 *
 * Why this exists:
 *   - OpenSky requires OAuth2 (client credentials) since 2026-03-18. The secret
 *     must NOT live in frontend code, so the token is fetched and cached here.
 *   - OpenSky sets no CORS headers, so a browser cannot call it directly. This
 *     Worker adds the CORS headers the app needs.
 *   - OpenSky is rate-limited by credits (HTTP 429 when exhausted). We surface
 *     the retry-after hint so the client can back off cleanly.
 *
 * Endpoints (all GET, all JSON):
 *   /tracks?icao24=4b1806[&time=UNIX_SECONDS]
 *       One aircraft's flight path. time=0 (default) = most recent track.
 *       History up to ~30 days back is supported by OpenSky for /tracks.
 *   /flights?icao24=4b1806&begin=UNIX&end=UNIX
 *       All flights flown by one aircraft in a time window (max 30 days span).
 *   /health
 *       Liveness check; also reports whether credentials are configured.
 *
 * Secrets (set via `wrangler secret put`):
 *   OPENSKY_CLIENT_ID       OAuth2 client id      (from OpenSky account)
 *   OPENSKY_CLIENT_SECRET   OAuth2 client secret
 *
 * Optional vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN  CORS allow-origin. Default "*". Set to your Pages origin
 *                   (e.g. https://joachimth.github.io) to lock it down.
 */

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const API_BASE = 'https://opensky-network.org/api';

// In-memory token cache. A Worker isolate is reused across requests, so this
// avoids re-fetching a token on every call. Tokens live ~30 min; we refresh
// a little early to stay safe.
let cachedToken = null; // { value: string, expiresAt: number(ms) }

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/health' || path === '/') {
        return json(
          {
            ok: true,
            service: 'milair-history-proxy',
            credentialsConfigured: Boolean(
              env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET
            ),
          },
          200,
          cors
        );
      }

      if (path === '/tracks') {
        return await handleTracks(url, env, cors);
      }

      if (path === '/flights') {
        return await handleFlights(url, env, cors);
      }

      return json({ error: 'Not found', path }, 404, cors);
    } catch (err) {
      // Pass through OpenSky rate-limit info if we have it.
      if (err && err.rateLimited) {
        return json(
          { error: 'Rate limited by OpenSky', retryAfterSeconds: err.retryAfter },
          429,
          { ...cors, 'Retry-After': String(err.retryAfter || 60) }
        );
      }
      return json({ error: 'Proxy error', detail: String(err && err.message || err) }, 502, cors);
    }
  },
};

/* ---------------- Route handlers ---------------- */

async function handleTracks(url, env, cors) {
  const icao24 = normHex(url.searchParams.get('icao24'));
  if (!icao24) return json({ error: 'Missing or invalid icao24' }, 400, cors);

  // time=0 means "most recent track"; otherwise a Unix-seconds timestamp
  // within the last ~30 days.
  const time = url.searchParams.get('time') || '0';
  if (!/^\d+$/.test(time)) {
    return json({ error: 'time must be Unix seconds (integer) or 0' }, 400, cors);
  }

  const target = `${API_BASE}/tracks/all?icao24=${icao24}&time=${time}`;
  const data = await openskyGet(target, env);
  return json(data, 200, cors);
}

async function handleFlights(url, env, cors) {
  const icao24 = normHex(url.searchParams.get('icao24'));
  if (!icao24) return json({ error: 'Missing or invalid icao24' }, 400, cors);

  const begin = url.searchParams.get('begin');
  const end = url.searchParams.get('end');
  if (!/^\d+$/.test(begin || '') || !/^\d+$/.test(end || '')) {
    return json({ error: 'begin and end must be Unix seconds (integers)' }, 400, cors);
  }
  if (Number(end) <= Number(begin)) {
    return json({ error: 'end must be greater than begin' }, 400, cors);
  }
  // OpenSky caps the /flights window at 30 days.
  if (Number(end) - Number(begin) > 30 * 24 * 3600) {
    return json({ error: 'Time window too large (max 30 days)' }, 400, cors);
  }

  const target = `${API_BASE}/flights/aircraft?icao24=${icao24}&begin=${begin}&end=${end}`;
  const data = await openskyGet(target, env);
  return json(data, 200, cors);
}

/* ---------------- OpenSky plumbing ---------------- */

async function getToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) {
    throw new Error('OpenSky credentials not configured (set OPENSKY_CLIENT_ID/SECRET)');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.OPENSKY_CLIENT_ID,
    client_secret: env.OPENSKY_CLIENT_SECRET,
  });

  // The OpenSky auth server can be slow or briefly drop connections (surfacing
  // as a Cloudflare 522). Give it a generous timeout and retry once on a
  // network-level failure or 5xx before giving up.
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      // Retry transient upstream 5xx once; return anything else immediately.
      if (res.status >= 500 && res.status < 600 && attempt === 0) {
        lastErr = new Error(`token upstream ${res.status}`);
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      // network error / timeout — retry once, then rethrow
      if (attempt === 1) {
        throw new Error(`Token request network failure: ${String(e && e.message || e)}`);
      }
    }
  }

  if (!res) {
    throw new Error(`Token request failed: ${String(lastErr && lastErr.message || lastErr)}`);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Token request failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const tok = await res.json();
  const ttlMs = (tok.expires_in ? tok.expires_in : 1800) * 1000;
  cachedToken = {
    value: tok.access_token,
    // Refresh a bit early to avoid using an about-to-expire token.
    expiresAt: now + ttlMs - 120_000,
  };
  return cachedToken.value;
}

async function openskyGet(target, env) {
  const token = await getToken(env);
  let res = await fetch(target, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // A stale/invalid token → refresh once and retry.
  if (res.status === 401) {
    cachedToken = null;
    const fresh = await getToken(env);
    res = await fetch(target, {
      headers: { Authorization: `Bearer ${fresh}`, Accept: 'application/json' },
    });
  }

  if (res.status === 429) {
    const retryAfter = Number(
      res.headers.get('X-Rate-Limit-Retry-After-Seconds') ||
        res.headers.get('Retry-After') ||
        60
    );
    const e = new Error('rate limited');
    e.rateLimited = true;
    e.retryAfter = retryAfter;
    throw e;
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenSky ${res.status}: ${txt.slice(0, 200)}`);
  }

  // OpenSky returns 200 with an empty body when there's no track for the query.
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/* ---------------- helpers ---------------- */

function normHex(v) {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return /^[0-9a-f]{6}$/.test(s) ? s : null;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
