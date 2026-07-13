# milair-history-proxy

A [Cloudflare Worker](https://workers.cloudflare.com/) that **builds and serves
its own historical flight database** for the browser-only **MilAir Watch** app
([adsb-planes-mil](https://github.com/joachimth/adsb-planes-mil)).

## Why this design

MilAir Watch shows live military / emergency / special aircraft over Northern
Europe from [adsb.lol](https://adsb.lol/). adsb.lol serves **live** data freely,
but has **no history endpoint** — you only ever get the current snapshot.

The obvious answer (proxy OpenSky's history) turned out to be a dead end:

- OpenSky's auth server **blocks datacenter IPs** — a Cloudflare Worker's
  request to it just times out (surfaces as a `522`). A normal browser reaches
  it fine, but a Worker cannot.
- OpenSky's terms **forbid automated re-serving** of their data without a
  written licence.

So instead of re-serving someone else's history, this Worker **accumulates its
own** from a source that *is* permitted for live access:

1. A **Cron trigger** polls adsb.lol every 2 minutes for military / emergency /
   special aircraft inside the region bounding box.
2. Each position is stored in **Cloudflare D1** (SQLite), with **movement
   dedup** so parked/stationary aircraft don't spam rows.
3. Rows older than `RETENTION_DAYS` are pruned (once per hour, to spare the
   free-tier write budget).
4. The app reads a full multi-day track for any aircraft from **our** database.

The history starts empty and grows: after ~24h you have a full day per aircraft,
after `RETENTION_DAYS` you have the full window.

> **Note:** The old OpenSky OAuth2 code was removed — it never worked from
> Cloudflare (see above). Git history has it if you ever want a licensed path.

---

## Endpoints

All `GET`, all JSON, all CORS-enabled.

| Endpoint | Returns |
|---|---|
| `GET /history?icao24=4b1806&hours=24` | One aircraft's stored track. `hours` default 24, max 720 (30d). `{ icao24, count, path:[{t,lat,lon,alt,track,gs,flight}] }` |
| `GET /recent?minutes=15` | Distinct aircraft seen in the last `minutes` (which aircraft have history available). |
| `GET /stats` | Row count, distinct aircraft, oldest/newest timestamp, retention config. |
| `GET /health` | Liveness + whether the D1 binding is present. |

Timestamps (`t`) are **Unix seconds** (UTC).

---

## Setup

### 1. Create the D1 database

```bash
wrangler d1 create milair-history
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_WITH_DATABASE_ID`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "milair-history"
database_id = "the-id-that-was-printed"
```

(The table + indexes are created automatically on first request/poll — no
migration step needed.)

### 2. Deploy

**Option A — Automated (recommended):** Push to GitHub.

```bash
git push origin main
```

The included GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys
automatically on every push to `main`. Set one secret in your repo
settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token with Workers + D1 edit permissions |

**Option B — Manual (local CLI):**

```bash
wrangler deploy
```

The Cron trigger (`*/2 * * * *`) starts polling immediately. There
are **no secrets** to set — adsb.lol needs no auth.

### 3. Verify

```bash
curl "https://<your-worker>.workers.dev/health"     # { ok:true, dbConfigured:true, ... }
# wait a few minutes for the cron to run a few times, then:
curl "https://<your-worker>.workers.dev/stats"      # rows should be climbing
curl "https://<your-worker>.workers.dev/recent"     # aircraft currently being tracked
```

Pick an `icao24` from `/recent`, then:

```bash
curl "https://<your-worker>.workers.dev/history?icao24=<hex>&hours=24"
```

---

## Configuration (`wrangler.toml` `[vars]`)

| Var | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS allow-origin. Lock to `https://joachimth.github.io` in prod. |
| `REGION_BBOX` | `-10,50,40,70` | Area to collect, as `west,south,east,north`. Default = Northern Europe. |
| `RETENTION_DAYS` | `30` | How long to keep positions. |
| `DEDUP_MIN_METERS` | `200` | Store a new point only if the aircraft moved at least this far… |
| `DEDUP_MIN_SECONDS` | `60` | …or at least this many seconds passed since its last stored point. |

---

## Free-tier budget

Cloudflare D1 free tier: **5 GB storage**, **~5M rows read/day**,
**~100k rows written/day** (INSERT/UPDATE/DELETE all count).

- **Storage:** ~30 days of Northern-Europe special traffic ≈ a few hundred MB.
  Comfortably within 5 GB.
- **Writes:** poll every 2 min = 720 polls/day. With movement dedup, typically
  well under the 100k/day write budget. If you ever approach it, raise
  `DEDUP_MIN_METERS` / `DEDUP_MIN_SECONDS`, poll less often, or shrink
  `REGION_BBOX`.
- **Reads:** never a concern at app scale.

Check real numbers any time with `GET /stats`.

---

## Licence

MIT. adsb.lol data is used under its open terms; MilAir Watch is open-source and
non-commercial.
