# milair-history-proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that lets the
browser-only **MilAir Watch** app read **historical** flight data from the
[OpenSky Network](https://opensky-network.org/).

It exists because OpenSky (a) requires OAuth2 with a secret that must not live
in frontend code, and (b) sends no CORS headers, so a browser cannot call it
directly. This Worker holds the secret, caches the token, and adds CORS.

> **Licence note:** OpenSky is free for research / non-commercial use. MilAir
> Watch is open-source and non-commercial, which fits. Keep it that way.

---

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /tracks?icao24=4b1806&time=0` | One aircraft's flight path. `time=0` = most recent. History up to ~30 days back. |
| `GET /flights?icao24=4b1806&begin=UNIX&end=UNIX` | All flights an aircraft flew in a time window (max 30-day span). |
| `GET /health` | Liveness + whether credentials are configured. |

`icao24` is the aircraft's ICAO 24-bit hex address — the same `hex` field
MilAir Watch already uses (e.g. `4b1806`). Timestamps are **Unix seconds**.

Responses are JSON with permissive CORS. On rate-limit the Worker returns
`429` with a `Retry-After` header and `{ "retryAfterSeconds": N }`.

---

## Setup — step by step

You need two things: an **OpenSky API client** (for credentials) and a
**Cloudflare account** (to host the Worker). ~15 minutes total.

### 1. Create an OpenSky API client

1. Go to <https://opensky-network.org/> and **register** a free account (or log
   in). Confirm your email.
2. Open your account page → **API Clients** (also reachable at
   <https://opensky-network.org/my-opensky/account>).
3. Create a new API client. OpenSky gives you a **client_id** and a
   **client_secret**. Copy both now — the secret is shown only once.
   - Since 2026-03-18 OpenSky uses OAuth2 *client credentials*; the old
     username/password basic-auth no longer works. These two values are what
     the Worker needs.

### 2. Install the Cloudflare tooling

You need Node.js installed, then Cloudflare's `wrangler` CLI:

```bash
npm install -g wrangler       # or: npm install (uses the devDependency here)
wrangler login                # opens a browser to authorise your Cloudflare account
```

If you don't have a Cloudflare account yet, `wrangler login` will walk you
through creating one (it's free).

### 3. Add your OpenSky secrets to the Worker

From this repo's folder:

```bash
wrangler secret put OPENSKY_CLIENT_ID
# paste the client_id when prompted

wrangler secret put OPENSKY_CLIENT_SECRET
# paste the client_secret when prompted
```

These are stored encrypted by Cloudflare and never appear in the code or repo.

### 4. Deploy

```bash
wrangler deploy
```

Wrangler prints the live URL, e.g.
`https://milair-history-proxy.<your-subdomain>.workers.dev`.

Test it:

```bash
curl "https://milair-history-proxy.<your-subdomain>.workers.dev/health"
# -> {"ok":true,...,"credentialsConfigured":true}

curl "https://milair-history-proxy.<your-subdomain>.workers.dev/tracks?icao24=4b1806&time=0"
```

### 5. Lock down CORS (recommended)

Once it works, edit `wrangler.toml` and set `ALLOWED_ORIGIN` to the app's
origin instead of `*`:

```toml
[vars]
ALLOWED_ORIGIN = "https://joachimth.github.io"
```

Then `wrangler deploy` again.

---

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your real client id/secret
wrangler dev                     # serves on http://localhost:8787
curl "http://localhost:8787/health"
```

`.dev.vars` is git-ignored — never commit it.

---

## Using it from MilAir Watch

Point the app at the Worker and fetch a track for the selected aircraft:

```js
const HISTORY_PROXY = 'https://milair-history-proxy.<your-subdomain>.workers.dev';

async function fetchHistory(hex) {
  const res = await fetch(`${HISTORY_PROXY}/tracks?icao24=${hex}&time=0`);
  if (res.status === 429) {
    const { retryAfterSeconds } = await res.json();
    console.warn(`Rate limited, retry in ${retryAfterSeconds}s`);
    return null;
  }
  if (!res.ok) return null;
  return res.json(); // { icao24, callsign, startTime, endTime, path: [[time,lat,lon,baroAlt,track,onGround], ...] }
}
```

The `path` array is a list of waypoints — feed the `[lat, lon]` pairs straight
into the existing Leaflet route polyline to draw a real historical track,
independent of what the client-side buffer happened to capture.

---

## Notes & limits

- **`/tracks/all` is experimental** on OpenSky's side and can be temporarily
  unavailable. The Worker handles empty/`null` responses gracefully.
- **Credits / rate limits:** anonymous ~400 requests/day, authenticated
  ~4000/day. When exhausted OpenSky returns `429`; the Worker forwards the
  retry-after hint. Cache aggressively on the client if you add area-wide
  queries later.
- **Token caching** is in-memory per Worker isolate — no external storage
  needed. Tokens refresh automatically ~2 min before expiry.
