# Among The City — dedicated co-op server

A neutral relay server so multiplayer doesn't run on a host **player's**
browser. Ported from `../AmongTheWoods/server` **minus** the server-side
simulation — Among The City v1 is client-authoritative: every client runs its
own world and the server relays player state (10 Hz blobs) and one-shot events
(rocket detonations) between everyone in the ONE shared room, `PARDUBICE`.

- `GET /health` → JSON liveness. The main menu polls this and only enables the
  **Multiplayer (server)** button when it answers `{"ready":true}`.
  It also reports `players` (seated), `sockets` (open, including ones that
  haven't said hello yet) and `capacity` — the three numbers worth watching.
- `WebSocket /ws` → the game transport (see `protocol.js`, mirrors
  `js/netcity.js`).

## Run locally

```bash
cd server-city
npm install
npm start            # listens on :8081  (PORT env to change)
npm test             # ~8 s: reconnect, spoofing, and every abuse ceiling
curl localhost:8081/health
```

The client's `server-config.js` (repo root) defaults to
`http://localhost:8081`, so `npm run dev` in the repo root + `npm start` here
is a complete local multiplayer setup — open two browser tabs and pick
**Multiplayer (server)** in both.

### Testing with two tabs — read this

Both tabs of the same browser share `localStorage`, so they share the uid
(`atc-uid`) and the server sees **one player reconnecting**, not two. That is a
legitimate scenario — it is the same code path as a Wi-Fi drop — and it now
works: the new socket takes over the seat, the old one is closed with code
`4001`, and the player keeps their position (see "Reconnect" below). But the
two tabs are one player: they never see each other, and `/health` will report
`players: 1`.

To test with two *separate* players on one machine, make the second tab a
different uid:

- open the second tab in a **private/incognito window** (separate storage), or
- run `localStorage.setItem('atc-uid','u-test2')` in the second tab's console
  and reload.

`/health` should then show `players: 2`.

## Reconnect (uid takeover)

`hello` with a uid that is already seated **replaces** the old socket instead of
adding a second seat:

1. the new socket takes the seat and inherits the previous `lastState`, so
   peers never see the avatar vanish and reappear,
2. the old socket is closed with `4001 replaced`,
3. the old socket's close is a **no-op** — `leave()` only vacates a seat the
   closing socket still owns.

Step 3 is the whole point. Without the ownership check the stale close deleted
the player who had just reconnected: everyone else still saw you, you saw an
empty city, forever. That is what `npm test` case F1 pins down.

## Limits (the server is public and unauthenticated)

Anyone who can reach `/ws` is a player, and the relay amplifies one inbound
frame into up to `MAX_PLAYERS - 1` outbound ones, so every lane has a ceiling
(`LIMITS` in `protocol.js`):

| what | value | why |
|------|-------|-----|
| `maxPayload` | 64 KiB | ws defaults to **100 MiB**; a 1 MiB blob × 19 peers was a free DoS |
| per-lane frame size | state/event 4 KiB, meta 1 KiB, snap 64 KiB | oversized frames are dropped before they can reach `lastState` |
| message rate | 120/s, 96 KiB/s | bursts are dropped, 3 over-budget seconds in a row close the socket |
| hello timeout | 10 s | a socket that never joins is not a player |
| back-pressure | drop over 256 KiB buffered, terminate over 1 MiB | a stalled reader must not grow the server's heap |
| sockets / IP | 10 | handshake floods |
| seats / IP | 6 | one machine must not be able to fill all 20 seats |
| meta | authority-only, whitelisted keys | `host` and `created` stay server-owned |
| snap | authority-only | a guest cannot dictate the shared world |
| `ev.from` | stamped by the server | a client cannot sign an event with someone else's uid |
| uid | `[A-Za-z0-9_-]`, ≤ 40 chars | it ends up in a nametag texture |

Compression is off (`perMessageDeflate: false`): no zlib heap per socket and no
compression bombs.

## Deploy

Same recipe as `../AmongTheWoods/server/README.md` (Node 20 + systemd + Caddy
for TLS), except: start `index.js` directly (no `boot.mjs` — there is no sim
importing three), and point `server-config.js` at `https://your.domain`. The
site is served over HTTPS, so the server **must** be behind TLS in production.

Behind Caddy every socket's `remoteAddress` is `127.0.0.1`, which would make the
per-IP caps apply to *everyone at once*, so `X-Forwarded-For` is trusted by
default. **If you ever expose the port directly, set `TRUST_PROXY=0`** — an
untrusted client can forge that header and slip the per-IP caps.

## Environment knobs

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `8081` | listen port |
| `HOST` | `0.0.0.0` | bind address (`127.0.0.1` behind a reverse proxy) |
| `MAIN_ROOM_CODE` | `PARDUBICE` | name of the single shared room |
| `MAX_PLAYERS` | `20` | shared-world seat cap |
| `EMPTY_ROOM_TTL_MS` | `120000` | how long a (non-main) empty room lingers |
| `MAX_SOCKETS` | `200` | total open sockets, joined or not |
| `MAX_SOCKETS_PER_IP` | `10` | open sockets from one address |
| `MAX_PLAYERS_PER_IP` | `6` | seats one address may hold |
| `HELLO_TIMEOUT_MS` | `10000` | grace period for a socket to say `hello` |
| `TRUST_PROXY` | `1` | read the client IP from `X-Forwarded-For` (set `0` if not behind a proxy) |
