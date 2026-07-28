/**
 * milair-history-proxy  (self-built history edition)
 * ---------------------------------------------------
 * A Cloudflare Worker that builds and serves its OWN historical flight
 * database for the browser-only MilAir Watch app (adsb-planes-mil).
 *
 * Why this design:
 *   - adsb.lol serves LIVE data freely (allowed, no CORS/IP issues) but has NO
 *     history endpoint. OpenSky has history but blocks datacenter IPs and its
 *     licence forbids automated re-serving. So instead of proxying a third
 *     party's history, we accumulate our OWN from a permitted live source.
 *   - A Cron trigger polls adsb.lol every couple of minutes for military /
 *     emergency / special aircraft over the app's region, stores each position
 *     in Cloudflare D1 (SQLite), and prunes rows older than the retention
 *     window. The app then reads a full multi-day track from OUR database.
 *
 * Endpoints (all GET, all JSON, CORS-enabled):
 *   /history?icao24=4b1806[&hours=24]
 *       One aircraft's stored track (most recent `hours`, default 24, max 720).
 *       Returns { icao24, count, path:[{t,lat,lon,alt,track,gs,flight}] }.
 *   /recent[&minutes=15]
 *       Distinct aircraft seen in the last `minutes` (default 15). Handy for a
 *       "what has history available" list.
 *   /stats
 *       Row counts + oldest/newest timestamp + retention config.
 *   /health
 *       Liveness check; reports whether the D1 binding is present.
 *
 * Storage:
 *   D1 binding `DB` (see wrangler.toml). Table `positions` created lazily.
 *
 * Config vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN   CORS allow-origin. Default "*". Lock to your Pages origin.
 *   REGION_BBOX      "west,south,east,north". Default Northern Europe.
 *   RETENTION_DAYS   How long to keep positions. Default "30".
 *   DEDUP_MIN_METERS Minimum movement to store a new point. Default "200".
 *   DEDUP_MIN_SECONDS Always store if this many seconds passed. Default "60".
 */

const ADSB_MIL = 'https://api.adsb.lol/v2/mil';
// Area query: /v2/lat/{lat}/lon/{lon}/dist/{nm}. We derive lat/lon/dist from
// the region bbox at poll time.
const ADSB_AREA_BASE = 'https://api.adsb.lol/v2';

const DEFAULT_BBOX = [-10.0, 50.0, 40.0, 70.0]; // Northern Europe [W,S,E,N]

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

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
            mode: 'self-built-history',
            dbConfigured: Boolean(env.DB),
            retentionDays: Number(env.RETENTION_DAYS || 30),
          },
          200,
          cors
        );
      }

      // Live area proxy — no DB needed. Server-side proxy of adsb.lol's area
      // endpoint so the browser gets one reliable CORS-enabled hop instead of
      // flaky public CORS proxies (which rate-limit and drop most calls).
      if (path === '/live') return await handleLive(url, cors);

      if (!env.DB) {
        return json({ error: 'D1 database not bound. Add [[d1_databases]] in wrangler.toml.' }, 500, cors);
      }
      await ensureSchema(env);

      if (path === '/history') return await handleHistory(url, env, cors);
      if (path === '/recent') return await handleRecent(url, env, cors);
      if (path === '/stats') return await handleStats(env, cors);
      if (path === '/daily-stats') return await handleDailyStats(env, cors);
      if (path === '/type-stats') return await handleTypeStats(env, cors);
      if (path === '/top-aircraft') return await handleTopAircraft(url, env, cors);
      if (path === '/dashboard' || path === '') return await handleDashboard(env, cors);

      return json({ error: 'Not found', path }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String((err && err.message) || err) }, 500, cors);
    }
  },

  /**
   * Cron trigger. Configured in wrangler.toml [triggers] crons.
   * Polls adsb.lol, stores positions with movement dedup, prunes old rows.
   */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(pollAndStore(env));
  },
};

/* ---------------- Cron: poll + store ---------------- */

async function pollAndStore(env) {
  await ensureSchema(env);
  const bbox = parseBbox(env.REGION_BBOX) || DEFAULT_BBOX;

  // 1) Gather aircraft: military (global, filtered to bbox) + everything in the
  //    area (so we also catch emergency squawks & special-tagged craft the app
  //    shows). Dedup by hex, preferring the area copy (fresher position).
  const byHex = new Map();

  const mil = await fetchJson(ADSB_MIL);
  if (mil && Array.isArray(mil.ac)) {
    for (const ac of mil.ac) {
      if (inBbox(ac.lat, ac.lon, bbox)) byHex.set(ac.hex, tag(ac, 'mil'));
    }
  }

  const area = await fetchArea(bbox);
  if (area && Array.isArray(area.ac)) {
    for (const ac of area.ac) {
      if (!isSpecial(ac)) continue;
      if (!inBbox(ac.lat, ac.lon, bbox)) continue;
      byHex.set(ac.hex, tag(ac, byHex.get(ac.hex)?._kind || kindOf(ac)));
    }
  }

  if (byHex.size === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const dedupMeters = Number(env.DEDUP_MIN_METERS || 200);
  const dedupSeconds = Number(env.DEDUP_MIN_SECONDS || 60);

  // 2) Load each aircraft's last stored point in ONE query to decide dedup.
  const hexes = [...byHex.keys()];
  const lastByHex = await lastPositions(env, hexes);

  // 3) Build a batch of rows to insert (only those that moved enough / aged).
  const rows = [];
  for (const [hex, ac] of byHex) {
    if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') continue;
    const last = lastByHex.get(hex);
    if (last) {
      const movedM = haversineMeters(last.lat, last.lon, ac.lat, ac.lon);
      const aged = nowSec - last.t;
      if (movedM < dedupMeters && aged < dedupSeconds) continue; // skip: parked/stale
    }
    rows.push({
      icao24: hex,
      t: nowSec,
      lat: ac.lat,
      lon: ac.lon,
      alt: numOrNull(ac.alt_baro === 'ground' ? 0 : ac.alt_baro),
      track: numOrNull(ac.track),
      gs: numOrNull(ac.gs),
      flight: (ac.flight || '').trim() || null,
      kind: ac._kind || null,
    });
  }

  // 4) Batch insert (chunked to stay well under SQL variable limits).
  if (rows.length) {
    const CHUNK = 50; // 9 cols * 50 = 450 bound params, safely under 100-var stmt limits per row-group
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const binds = [];
      for (const r of slice) {
        binds.push(r.icao24, r.t, r.lat, r.lon, r.alt, r.track, r.gs, r.flight, r.kind);
      }
      await env.DB.prepare(
        `INSERT INTO positions (icao24,t,lat,lon,alt,track,gs,flight,kind) VALUES ${placeholders}`
      ).bind(...binds).run();
    }
  }

  // 5) Prune once per hour (cheap heuristic: only when minute < 2) to keep
  //    DELETE writes minimal against the free-tier writes/day budget.
  const minute = new Date().getUTCMinutes();
  if (minute < 2) {
    const retentionDays = Number(env.RETENTION_DAYS || 30);
    const cutoff = nowSec - retentionDays * 86400;
    await env.DB.prepare('DELETE FROM positions WHERE t < ?').bind(cutoff).run();
  }
}

async function fetchArea(bbox) {
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;
  // Radius (nm) to cover the bbox from its centre; adsb.lol caps at 250nm.
  const latNM = ((n - s) / 2) * 60;
  const lonNM = ((e - w) / 2) * 60 * Math.cos((lat * Math.PI) / 180);
  let dist = Math.ceil(Math.sqrt(latNM * latNM + lonNM * lonNM));
  if (dist > 250) dist = 250;
  const target = `${ADSB_AREA_BASE}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${dist}`;
  return await fetchJson(target);
}

/* ---------------- Live area proxy ---------------- */

/**
 * GET /live?lat=&lon=&dist=  — proxy adsb.lol's area endpoint server-side.
 * Returns adsb.lol's raw response ({ ac: [...], now, ... }) with CORS headers.
 * dist is clamped to adsb.lol's 250 NM max. Short edge-cached to spread load.
 */
async function handleLive(url, cors) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  let dist = Number(url.searchParams.get('dist') || 250);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'lat and lon are required numbers' }, 400, cors);
  }
  if (!Number.isFinite(dist) || dist <= 0) dist = 250;
  dist = Math.min(Math.round(dist), 250); // adsb.lol hard max

  const target = `${ADSB_AREA_BASE}/lat/${lat}/lon/${lon}/dist/${dist}`;
  const resp = await fetch(target, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'milair-history-proxy/1.0' },
    // Edge-cache each unique area for 15s so repeated polls share a fetch.
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!resp.ok) {
    return json({ error: 'adsb.lol upstream error', status: resp.status }, 502, cors);
  }
  const data = await resp.json();
  return json(data, 200, { ...cors, 'Cache-Control': 'public, max-age=10' });
}

/* ---------------- Read handlers ---------------- */

async function handleHistory(url, env, cors) {
  const icao24 = normHex(url.searchParams.get('icao24'));
  if (!icao24) return json({ error: 'Missing or invalid icao24' }, 400, cors);

  let hours = Number(url.searchParams.get('hours') || 24);
  if (!Number.isFinite(hours) || hours <= 0) hours = 24;
  if (hours > 720) hours = 720; // cap at 30 days

  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const res = await env.DB.prepare(
    `SELECT t, lat, lon, alt, track, gs, flight
       FROM positions
      WHERE icao24 = ? AND t >= ?
      ORDER BY t ASC`
  ).bind(icao24, since).all();

  const path = (res.results || []).map((r) => ({
    t: r.t,
    lat: r.lat,
    lon: r.lon,
    alt: r.alt,
    track: r.track,
    gs: r.gs,
    flight: r.flight,
  }));

  return json({ icao24, hours, count: path.length, path }, 200, cors);
}

async function handleRecent(url, env, cors) {
  let minutes = Number(url.searchParams.get('minutes') || 15);
  if (!Number.isFinite(minutes) || minutes <= 0) minutes = 15;
  if (minutes > 1440) minutes = 1440;

  const since = Math.floor(Date.now() / 1000) - Math.round(minutes * 60);
  const res = await env.DB.prepare(
    `SELECT icao24,
            MAX(t) AS last_t,
            COUNT(*) AS points,
            MAX(flight) AS flight,
            MAX(kind) AS kind
       FROM positions
      WHERE t >= ?
      GROUP BY icao24
      ORDER BY last_t DESC`
  ).bind(since).all();

  return json(
    { minutes, count: (res.results || []).length, aircraft: res.results || [] },
    200,
    cors
  );
}

async function handleStats(env, cors) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS rows,
            COUNT(DISTINCT icao24) AS aircraft,
            MIN(t) AS oldest,
            MAX(t) AS newest
       FROM positions`
  ).first();
  return json(
    {
      rows: row?.rows ?? 0,
      aircraft: row?.aircraft ?? 0,
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
      retentionDays: Number(env.RETENTION_DAYS || 30),
    },
    200,
    cors
  );
}

/* ---------------- D1 helpers ---------------- */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS positions (icao24 TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, alt REAL, track REAL, gs REAL, flight TEXT, kind TEXT)'
  );
  await env.DB.exec(
    'CREATE INDEX IF NOT EXISTS idx_positions_icao_t ON positions (icao24, t)'
  );
  await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_positions_t ON positions (t)');
  schemaReady = true;
}

async function lastPositions(env, hexes) {
  const out = new Map();
  if (!hexes.length) return out;
  // Chunk the IN(...) list to keep the statement small.
  const CHUNK = 80;
  for (let i = 0; i < hexes.length; i += CHUNK) {
    const slice = hexes.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    // Latest row per icao24 within this slice.
    const res = await env.DB.prepare(
      `SELECT p.icao24, p.t, p.lat, p.lon
         FROM positions p
         JOIN (SELECT icao24, MAX(t) AS mt FROM positions
                WHERE icao24 IN (${placeholders}) GROUP BY icao24) m
           ON p.icao24 = m.icao24 AND p.t = m.mt`
    ).bind(...slice).all();
    for (const r of res.results || []) {
      out.set(r.icao24, { t: r.t, lat: r.lat, lon: r.lon });
    }
  }
  return out;
}

/* ---------------- adsb.lol / classification ---------------- */

function isSpecial(ac) {
  if (!ac) return false;
  // Military flag from dbFlags (bit 0), emergency squawk, or emergency field.
  const mil = (ac.dbFlags & 1) === 1;
  const sq = String(ac.squawk || '');
  const emergency =
    sq === '7500' || sq === '7600' || sq === '7700' ||
    (ac.emergency && ac.emergency !== 'none');
  // "special" = interesting dbFlags (PIA bit1, LADD bit2) also count.
  const special = (ac.dbFlags & 2) === 2 || (ac.dbFlags & 4) === 4;
  return mil || emergency || special;
}

function kindOf(ac) {
  const sq = String(ac.squawk || '');
  if (sq === '7500' || sq === '7600' || sq === '7700' || (ac.emergency && ac.emergency !== 'none')) {
    return 'emergency';
  }
  if ((ac.dbFlags & 1) === 1) return 'mil';
  return 'special';
}

function tag(ac, kind) {
  ac._kind = kind;
  return ac;
}

/* ---------------- Stats dashboard handlers ---------------- */

/**
 * GET /daily-stats — rows per day for the last 14 days.
 * Returns an array of { date, rows, aircraft } objects.
 */
async function handleDailyStats(env, cors) {
  const now = Math.floor(Date.now() / 1000);
  const fourteenDays = 14 * 86400;
  const since = now - fourteenDays;

  const res = await env.DB.prepare(
    `SELECT
        CAST(t / 86400 AS INTEGER) AS day_bucket,
        COUNT(*) AS rows,
        COUNT(DISTINCT icao24) AS aircraft
     FROM positions
     WHERE t >= ?
     GROUP BY day_bucket
     ORDER BY day_bucket ASC`
  ).bind(since).all();

  const baseDate = new Date(since * 1000);
  const startDay = Math.floor(since / 86400);

  // Build a complete 14-day series, filling gaps with zeros
  const dailyMap = new Map();
  for (const r of res.results || []) {
    dailyMap.set(r.day_bucket, { rows: r.rows, aircraft: r.aircraft });
  }

  const days = [];
  for (let i = 0; i < 14; i++) {
    const bucket = startDay + i;
    const d = new Date(bucket * 86400 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const data = dailyMap.get(bucket);
    days.push({
      date: dateStr,
      rows: data?.rows ?? 0,
      aircraft: data?.aircraft ?? 0,
    });
  }

  return json({ days }, 200, cors);
}

/**
 * GET /type-stats — breakdown by `kind` (mil, emergency, special).
 * Returns today's stats and all-time totals.
 */
async function handleTypeStats(env, cors) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = now - (now % 86400);

  // All-time totals
  const allTime = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS rows, COUNT(DISTINCT icao24) AS aircraft
     FROM positions
     WHERE kind IS NOT NULL
     GROUP BY kind
     ORDER BY rows DESC`
  ).all();

  // Today
  const today = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS rows, COUNT(DISTINCT icao24) AS aircraft
     FROM positions
     WHERE kind IS NOT NULL AND t >= ?
     GROUP BY kind
     ORDER BY rows DESC`
  ).bind(todayStart).all();

  // Unknown breakdown (kind IS NULL)
  const unknownAll = await env.DB.prepare(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT icao24) AS aircraft
     FROM positions
     WHERE kind IS NULL`
  ).first();

  const unknownToday = await env.DB.prepare(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT icao24) AS aircraft
     FROM positions
     WHERE kind IS NULL AND t >= ?`
  ).bind(todayStart).first();

  return json({
    allTime: {
      kinds: allTime.results || [],
      unknown: { rows: unknownAll?.rows ?? 0, aircraft: unknownAll?.aircraft ?? 0 },
    },
    today: {
      kinds: today.results || [],
      unknown: { rows: unknownToday?.rows ?? 0, aircraft: unknownToday?.aircraft ?? 0 },
    },
  }, 200, cors);
}

/**
 * GET /top-aircraft[?limit=20] — most frequently seen aircraft by position count.
 */
async function handleTopAircraft(url, env, cors) {
  let limit = Number(url.searchParams.get('limit') || 20);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  // Use a simpler query: count per icao24, no DISTINCT on days_seen to avoid
  // expensive GROUP BY on a 5000+ row table with D1's tight timeout.
  // We add a covering index on (icao24,t) which the count query can use.
  // Also grab a representative callsign + kind via MAX (text aggregation).
  const res = await env.DB.prepare(
    `SELECT icao24,
            COUNT(*) AS points,
            MAX(t) AS last_seen,
            MAX(flight) AS flight,
            MAX(kind) AS kind
     FROM positions
     GROUP BY icao24
     ORDER BY points DESC
     LIMIT ?`
  ).bind(limit).all();

  return json({ limit, aircraft: res.results || [] }, 200, cors);
}

/**
 * GET /dashboard — a self-contained HTML dashboard page.
 * Renders stats visually using inline SVG and client-side data fetching.
 */
async function handleDashboard(env, cors) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MilAir History — Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0b0f1a; color: #d4d8e0; padding: 20px; max-width: 1000px; margin: 0 auto;
  }
  h1 { font-size: 1.5rem; color: #8ba4d4; margin-bottom: 4px; }
  .subtitle { color: #6b7a94; font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card {
    background: #141a2e; border: 1px solid #1e2745; border-radius: 10px; padding: 16px;
  }
  .card h3 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7a94; margin-bottom: 4px; }
  .card .value { font-size: 1.6rem; font-weight: 600; color: #b4c8f0; }
  .card .unit { font-size: 0.8rem; color: #5a6a84; }
  .card-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .card-row .card { flex: 1; min-width: 120px; }
  h2 { font-size: 1rem; color: #8ba4d4; margin: 20px 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; color: #6b7a94; padding: 8px 8px 4px 0; border-bottom: 1px solid #1e2745; font-weight: 500; }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #141a2e; }
  .bar-chart { display: flex; align-items: end; gap: 2px; height: 80px; padding-top: 4px; }
  .bar { flex: 1; background: #2a3a6a; border-radius: 2px 2px 0 0; position: relative; min-width: 4px; transition: background 0.2s; }
  .bar:hover { background: #4a6aaa; }
  .bar .tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    background: #1e2745; border: 1px solid #2a3a6a; padding: 4px 8px; border-radius: 4px;
    font-size: 0.7rem; white-space: nowrap; z-index: 10; pointer-events: none; }
  .bar:hover .tooltip { display: block; }
  .bar-label { font-size: 0.55rem; color: #5a6a84; text-align: center; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7rem; font-weight: 500; }
  .tag-mil { background: #2a3a6a; color: #8cb4ff; }
  .tag-emergency { background: #6a2a2a; color: #ff8c8c; }
  .tag-special { background: #2a5a3a; color: #8cffb4; }
  .loading { color: #5a6a84; font-style: italic; font-size: 0.85rem; padding: 20px 0; }
  .error { color: #ff6b6b; font-size: 0.85rem; padding: 12px 0; }
  .last-updated { font-size: 0.7rem; color: #4a5a74; text-align: right; margin-top: 32px; }
  footer { font-size: 0.7rem; color: #3a4a64; text-align: center; margin-top: 40px; padding-top: 16px; border-top: 1px solid #141a2e; }
</style>
</head>
<body>

<h1>🛩️ MilAir History Dashboard</h1>
<div class="subtitle" id="subtitle">Loading...</div>

<div class="grid" id="stats-cards">
  <div class="card"><h3>Total positions</h3><div class="value" id="total-rows">—</div></div>
  <div class="card"><h3>Unique aircraft</h3><div class="value" id="total-ac">—</div></div>
  <div class="card"><h3>Retention</h3><div class="value" id="retention">—</div><div class="unit">days</div></div>
  <div class="card"><h3>Data coverage</h3><div class="value" id="coverage">—</div><div class="unit">days</div></div>
</div>

<h2>📊 Daily position count (last 14 days)</h2>
<div id="daily-chart" class="loading">Loading chart...</div>

<h2>🏷️ Aircraft type breakdown</h2>
<div class="card-row" id="type-cards"></div>

<h2>✨ Most seen aircraft <span style="font-size:0.7rem;color:#5a6a84;font-weight:400;">(all time)</span></h2>
<div id="top-table" class="loading">Loading...</div>

<p class="last-updated" id="last-updated"></p>

<footer>milair-history-proxy &middot; Data collected every 2 minutes from adsb.lol</footer>

<script>
const API = '';

async function loadAll() {
  try {
    const [stats, daily, typeStats, top] = await Promise.all([
      fetch(API + '/stats').then(r => r.json()),
      fetch(API + '/daily-stats').then(r => r.json()),
      fetch(API + '/type-stats').then(r => r.json()),
      fetch(API + '/top-aircraft?limit=50').then(r => r.json()),
    ]);
    renderStats(stats);
    renderDaily(daily);
    renderTypes(typeStats);
    renderTop(top);
    document.getElementById('last-updated').textContent = 'Last updated: ' + new Date().toLocaleString();
    document.getElementById('subtitle').textContent = 'Live from D1 database';
  } catch (e) {
    document.getElementById('subtitle').textContent = 'Error loading data';
    document.querySelectorAll('.loading').forEach(el => el.textContent = 'Failed to load. ' + e.message);
  }
}

function renderStats(s) {
  document.getElementById('total-rows').textContent = s.rows?.toLocaleString() ?? '—';
  document.getElementById('total-ac').textContent = s.aircraft?.toLocaleString() ?? '—';
  document.getElementById('retention').textContent = s.retentionDays ?? '—';

  if (s.oldest && s.newest) {
    const days = Math.round((s.newest - s.oldest) / 86400);
    document.getElementById('coverage').textContent = days;
  }
}

function renderDaily(d) {
  if (!d.days || d.days.length === 0) {
    document.getElementById('daily-chart').textContent = 'No daily data yet.';
    return;
  }
  let maxRows = 0;
  for (const day of d.days) if (day.rows > maxRows) maxRows = day.rows;
  if (maxRows === 0) maxRows = 1;

  let html = '<div class="bar-chart">';
  for (const day of d.days) {
    const pct = (day.rows / maxRows) * 100;
    const label = day.date.slice(5); // MM-DD
    html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;">';
    html += '<div class="bar" style="height:' + Math.max(pct, 2) + '%">';
    html += '<div class="tooltip">' + day.date + ': ' + day.rows + ' positions, ' + day.aircraft + ' aircraft</div>';
    html += '</div>';
    html += '<div class="bar-label">' + label + '</div>';
    html += '</div>';
  }
  html += '</div>';
  html += '<div style="font-size:0.7rem;color:#5a6a84;margin-top:4px;">Peak: ' + maxRows.toLocaleString() + ' positions in one day</div>';
  document.getElementById('daily-chart').innerHTML = html;
}

function renderTypes(ts) {
  const kinds = ts.allTime?.kinds ?? [];
  const unknown = ts.allTime?.unknown ?? { rows: 0 };
  const todayKinds = ts.today?.kinds ?? [];
  const todayUnknown = ts.today?.unknown ?? { rows: 0 };

  if (kinds.length === 0 && unknown.rows === 0) {
    document.getElementById('type-cards').innerHTML = '<div class="card">No type data</div>';
    return;
  }

  let html = '';
  const allEntries = [...kinds];
  if (unknown.rows > 0) allEntries.push({ kind: null, rows: unknown.rows, aircraft: unknown.aircraft });

  for (const entry of allEntries) {
    const kind = entry.kind || 'unknown';
    const tagClass = entry.kind === 'mil' ? 'tag-mil' : entry.kind === 'emergency' ? 'tag-emergency' : entry.kind === 'special' ? 'tag-special' : '';
    const todayEntry = todayKinds.find(k => k.kind === entry.kind);
    const todayRows = todayEntry?.rows ?? (entry.kind === null ? todayUnknown.rows : 0);

    html += '<div class="card">';
    html += '<h3><span class="tag ' + tagClass + '">' + kind + '</span></h3>';
    html += '<div class="value">' + (entry.rows ?? 0).toLocaleString() + '</div>';
    html += '<div class="unit">positions &middot; ' + (entry.aircraft ?? 0) + ' aircraft</div>';
    html += '<div class="unit" style="margin-top:2px;">Today: ' + todayRows + ' positions</div>';
    html += '</div>';
  }
  document.getElementById('type-cards').innerHTML = html;
}

function renderTop(top) {
  if (!top.aircraft || top.aircraft.length === 0) {
    document.getElementById('top-table').textContent = 'No data yet.';
    return;
  }

  let html = '<table><thead><tr><th>#</th><th>Callsign</th><th>ICAO24</th><th>Points</th><th>Days</th><th>Kind</th></tr></thead><tbody>';
  for (let i = 0; i < top.aircraft.length; i++) {
    const ac = top.aircraft[i];
    const callsign = ac.flight || '—';
    const lastSeen = ac.last_seen ? new Date(ac.last_seen * 1000).toLocaleString() : '—';
    const kindTag = ac.kind ? '<span class="tag tag-' + ac.kind + '">' + ac.kind + '</span>' : '<span style="color:#5a6a84;">—</span>';
    html += '<tr>';
    html += '<td style="color:#5a6a84;">' + (i + 1) + '</td>';
    html += '<td><strong>' + callsign + '</strong></td>';
    html += '<td style="font-family:monospace;color:#6b7a94;">' + ac.icao24 + '</td>';
    html += '<td>' + ac.points.toLocaleString() + '</td>';
    html += '<td>' + (ac.days_seen ?? '—') + '</td>';
    html += '<td>' + kindTag + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('top-table').innerHTML = html;
}

loadAll();
// Auto-refresh every 60 seconds
setInterval(loadAll, 60000);
</script>

</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...cors,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

/* ---------------- generic helpers ---------------- */

async function fetchJson(target) {
  const res = await fetch(target, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function parseBbox(s) {
  if (!s) return null;
  const parts = String(s).split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x))) return null;
  return parts; // [W,S,E,N]
}

function inBbox(lat, lon, bbox) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  const [w, s, e, n] = bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

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
