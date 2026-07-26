# Among The City — dedicated co-op server

A neutral relay server so multiplayer doesn't run on a host **player's**
browser. Ported from `../AmongTheWoods/server` **minus** the server-side
simulation — Among The City v1 is client-authoritative: every client runs its
own world and the server relays player state (10 Hz blobs) and one-shot events
(rocket detonations) between everyone in the ONE shared room, `PARDUBICE`.

- `GET /health` → JSON liveness. The main menu polls this and only enables the
  **Multiplayer (server)** button when it answers `{"ready":true}`.
- `WebSocket /ws` → the game transport (see `protocol.js`, mirrors
  `js/netcity.js`).

## Run locally

```bash
cd server-city
npm install
npm start            # listens on :8081  (PORT env to change)
curl localhost:8081/health
```

The client's `server-config.js` (repo root) defaults to
`http://localhost:8081`, so `npm run dev` in the repo root + `npm start` here
is a complete local multiplayer setup — open two browser tabs and pick
**Multiplayer (server)** in both.

## Deploy

Same recipe as `../AmongTheWoods/server/README.md` (Node 20 + systemd + Caddy
for TLS), except: start `index.js` directly (no `boot.mjs` — there is no sim
importing three), and point `server-config.js` at `https://your.domain`. The
site is served over HTTPS, so the server **must** be behind TLS in production.

## Environment knobs

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `8081` | listen port |
| `HOST` | `0.0.0.0` | bind address (`127.0.0.1` behind a reverse proxy) |
| `MAIN_ROOM_CODE` | `PARDUBICE` | name of the single shared room |
| `MAX_PLAYERS` | `20` | shared-world seat cap |
| `EMPTY_ROOM_TTL_MS` | `120000` | how long a (non-main) empty room lingers |
