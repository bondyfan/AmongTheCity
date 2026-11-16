# Among The City: co-op server

A neutral relay so multiplayer does not run on a host **player's** browser.
Among The City v1 is client-authoritative: every client runs its own world and
the server relays player state (10 Hz blobs), one-shot events (rocket
detonations) and the world snapshot between everyone in the ONE shared room,
`PARDUBICE`.

The same room and protocol logic runs on two hosts:

| host | where | what for |
|------|-------|----------|
| Cloudflare Worker + Durable Object | `worker/` | **the live server**, `https://among-the-city-coop.digifycz.workers.dev` |
| Node + `ws` | `index.js` | local play without Cloudflare tooling, and the fast test bed |

Shared, host-independent code: `protocol.js` (wire format, limits),
`room.js` (the room), `hub.js` (admission, hello and uid takeover, rate
limits, lanes, PING/PONG, leaving, deadlines). The hosts are thin transports:
`index.js` for Node, `worker/src/coop.js` for the Durable Object (with
`worker/src/conn.js` adapting the Workers WebSocket, which has no
`bufferedAmount` or `terminate()`).

Both answer the same two routes, which is all the client calls:

- `GET /health`: JSON. The main menu (`js/menuhealth.js`) polls it and only
  enables **Multiplayer (server)** while it answers `{"ready":true}`. It also
  reports `players` (seated), `sockets` (open, including ones that have not
  said hello yet) and `capacity`. The Worker adds `created`, `budget` and
  `account`, and when the budget is used up answers
  `{"ready":false,"reason":"limit","scope":"own"|"account","resetsAt":...}`
  (or `"reason":"unmeasured"` while the account guard cannot measure).
- `WebSocket /ws`: the game transport (see `protocol.js`, mirrors
  `js/netcity.js`).

## Run locally

Node relay (port 8081):

```bash
cd server-city
npm install          # just `ws`
npm start
npm test             # ~17 s: reconnect, spoofing and every abuse ceiling
```

The Worker (port 8787), with wrangler 4 on the machine:

```bash
cd server-city/worker
npx wrangler dev --local     # no login needed, nothing leaves the machine
cd .. && npm run test:worker # ~35 s, see "Tests"
```

Point `server-config.js` (repo root) at the one you run:
`http://localhost:8787` (Worker) or `http://localhost:8081` (Node). Then
`npm run dev` in the repo root and open the game in two browser windows.

Two tabs of one browser are two players: `js/identity.js` mints the uid as
`base:tab`, and the tab half lives in `sessionStorage`. A reload of the same
tab keeps the uid, which the server treats as a reconnect (below).

## Reconnect (uid takeover)

`hello` with a uid that is already seated **replaces** the old socket instead of
adding a second seat:

1. the new socket takes the seat and inherits the previous `lastState`, so
   peers never see the avatar vanish and reappear,
2. the old socket is closed with `4001 replaced`,
3. the old socket's close is a **no-op**: leaving only vacates a seat the
   closing socket still owns.

Step 3 is the whole point. Without the ownership check the stale close deleted
the player who had just reconnected: everyone else still saw you, you saw an
empty city, forever. Test case F1 pins it down on both hosts.

The client itself never reconnects automatically: a dropped session stays
dropped until the player picks Multiplayer again, so no close can become a
reconnect loop.

## Limits (the server is public and unauthenticated)

Anyone who can reach `/ws` is a player, and the relay amplifies one inbound
frame into up to `MAX_PLAYERS - 1` outbound ones, so every lane has a ceiling
(`LIMITS` in `protocol.js`, enforced in `hub.js` on both hosts):

| what | value | why |
|------|-------|-----|
| frame size | 64 KiB (closes with 1009) | one huge blob x 19 peers is a free DoS |
| per-lane frame size | state/event 4 KiB, meta 1 KiB, snap 64 KiB | oversized frames are dropped before they can reach `lastState` |
| message rate | 120/s, 96 KiB/s | bursts are dropped, 3 over-budget seconds in a row close the socket |
| hello timeout | 10 s (4008) | a socket that never joins is not a player |
| back-pressure (Node) | drop over 256 KiB buffered, terminate over 1 MiB | a stalled reader must not grow the heap |
| sockets / IP | 10 (4029 in Node, HTTP 429 on the Worker) | handshake floods |
| sockets | 60 (3 per seat) | every open socket can keep sending billable frames |
| seats / IP | 6 | one machine must not be able to fill all 20 seats |
| seats | 20 | the shared world |
| meta | authority-only, whitelisted keys | `host` and `created` stay server-owned |
| snap | authority-only | a guest cannot dictate the shared world |
| `ev.from` | stamped by the server | a client cannot sign an event with someone else's uid |
| uid | `[A-Za-z0-9_:-]`, at most 40 chars | it ends up in a nametag texture |

The Worker adds:

| what | value | why |
|------|-------|-----|
| handshakes / IP | 30 per minute per isolate (HTTP 429) | refused in the Worker, before the Durable Object is billed |
| silence | 5 min without any frame (4003 `silent`) | dead or frozen tabs; a background tab still pings about once a minute |
| idle | 30 min seated without moving (4002) | a forgotten tab must not burn the month (an owner decision, see below) |
| socket caps | counted from `ctx.getWebSockets()` | a peer that ignores our close frame stays open (no `terminate()` on Workers) and still holds its slot |
| client IP | `CF-Connecting-IP`, set by Cloudflare | the Worker overwrites whatever the client sent |
| `/health` | cached 30 s in the Worker isolate | a menu left open does not wake the object on every poll |

Node: behind a reverse proxy every socket's `remoteAddress` is `127.0.0.1`,
so `X-Forwarded-For` is trusted by default. If the port is exposed directly,
set `TRUST_PROXY=0`.

Close codes the client tells apart (`hub.js CLOSE`, `js/netnotice.js`): `4001` replaced, `4002` idle,
`4003` silent, `4402` budget used up, `4503` budget cannot be measured; `4000` protocol error, `4008`
hello timeout, `4029` too many sockets.

Open for the owner to decide:

- The 30-minute idle close (4002) is new; the VPS never did it. A player who
  parks for half an hour, or whose tab sits in the background that long,
  drops to solo until he picks Multiplayer again. It protects against a
  forgotten foreground tab sending 10 Hz all night (about 1,800 requests an
  hour). `IDLE_MS = "0"` turns it off; a longer value softens it.
- The client never reconnects by itself. Cloudflare drops every socket on a
  deploy and on its own runtime updates, more often than a VPS restarted, so
  players will see "Server spadl" now and then. The server side is ready for
  a bounded retry (uid takeover keeps the seat); it is not built.

## Cost guard (the Worker)

The owner pays the Workers Paid subscription and nothing on top. Per month
(the cycle runs from the 13th to the 13th) the subscription includes, shared
by ALL the account's Workers:

- 1,000,000 Durable Object requests: every fetch and alarm is one, an inbound
  WebSocket message is 1/20 (outbound messages are free);
- 400,000 GB-s of Durable Object duration: 128 MB per object, billed while
  the object is awake.

Over that: 0.15 USD per million requests and 12.50 USD per million GB-s,
each rounded UP to a whole million. Measured from the account analytics on
16 Nov 2026, Chat Motor alone uses about 80 % of the duration and about all of
the requests this cycle.

What co-op costs, as this server counts it (deliberately high): one player at
10 Hz is 36,000 messages = 1,800 requests an hour; the object is awake the
whole time anyone is connected, 3,600 s x 0.125 GB = 450 GB-s an hour,
however many players there are. An empty room costs nothing: no timers, no
alarms, and the hibernated sockets of a quiet room are not billed. A menu
poll of an empty room is charged 0.1 s, not the gap since the last event
(nothing keeps an object without sockets awake after its handler).

### The own budget (always on)

`worker/src/budget.js`. The Durable Object counts its own use per billing
cycle and keeps the count in its SQLite storage, written at most about once a
minute. It counts HIGH on purpose: every event is charged the time since the
previous one (up to 10 s, the hibernation delay) and the first event after a
wake a full 10 s; every inbound message counts, dropped and refused ones
included, and so does every close, fetch and alarm. A wake from hibernation
loses what was not written yet, so every write already includes a reservation
for the next minute at the current rate, and an early write happens when the
unwritten part outgrows it: after a wake the count can only come out high.

Caps, `[vars]` in `worker/wrangler.toml`: `BUDGET_GBS = 50000` (about 111
connected hours) and `BUDGET_REQUESTS = 300000` (about 166 player-hours),
`CYCLE_DAY = 13` (00:00 UTC). When a cap is reached every socket is closed
with **4402 `limit`** (after an ERROR frame with `code: 'limit'`), new sockets
are refused the same way, and `/health` answers `ready: false, reason:
'limit'` until the next cycle. The Worker isolate remembers the limit for up
to 5 minutes and refuses sockets itself meanwhile, so a reconnecting crowd
does not keep waking the object. The menu then reads "Server má tento měsíc
vyčerpaný limit (znovu od 13. 12.)" and a running game says so in a toast.

### The account-wide guard (optional)

`worker/src/account.js`. With the secret `CF_ANALYTICS_TOKEN` set, the object
asks the GraphQL Analytics API for the WHOLE account's cycle-to-date usage:
duration `durableObjectsPeriodicGroups.sum.activeTime` (microseconds x 0.125
GB) and requests from `durableObjectsInvocationsAdaptiveGroups.sum.requests`
and `durableObjectsPeriodicGroups.sum.inboundWebsocketMsgCount`. It asks once
when a cycle's first player joins (from an alarm a moment later) and then at
most hourly while players are connected. Each request times out after 10 s.
Over `ACCOUNT_GBS_LIMIT = 380000` or `ACCOUNT_REQUESTS_LIMIT = 950000` (95 %
of the included amounts) co-op closes exactly like the own cap, with `scope:
'account'`. Without the secret this code never runs.

How requests are counted. Per Cloudflare's metrics docs, an inbound message
on a HIBERNATED socket shows up in the invocations dataset one for one, while
billing counts it as 1/20 (the 20:1 ratio is not applied to analytics). No
documented dimension tells such a message from a fetch, so the guard takes
co-op's OWN messages (counted by its meter) out of the invocations and adds
them back at 1/20. Other Workers' hibernated messages (Chat Motor, if it
hibernates) stay counted one for one: the guard errs toward closing co-op
early, never toward overage. **Before setting the secret, run the query once
by hand with the token and compare it with the dashboard's billable usage.**
If Chat Motor's raw invocations are already near a million, the guard will
keep co-op closed for the rest of the cycle; that is the safe default.

It fails CLOSED: a failed check (HTTP error, GraphQL error such as a wrong
field name, a timeout) is retried after `ACCOUNT_RETRY_MS = 120000`, and
after `ACCOUNT_FAILS_TO_CLOSE = 2` failures in a row co-op closes with
**4503 `unmeasured`** and `/health` answers `reason: 'unmeasured'`. While it
is closed a menu poll of `/health` retries the check (at most every 2
minutes); the first success reopens co-op. An earlier "over" stays over.

What is promised, and what is not. Chat Motor already uses about all of the
included requests and about 80 % of the duration this cycle, so every
request and GB-s co-op adds can be overage. Without the secret the own caps
only limit how much: up to one rounded-up million requests (0.15 USD) and,
if the account's duration crosses a million-GB-s boundary, one million GB-s
(12.50 USD; real duration under hibernation is far below what the meter
counts, so this is unlikely but possible). "Nothing beyond the
subscription" therefore holds only with the account guard set and working,
or once Chat Motor's own use comes down. Between two hourly checks co-op can
add at most about 36,000 requests and 450 GB-s.

What no cap can stop: a Workers socket has no `terminate()`. A client that
ignores our close frame keeps the socket open, and every frame it sends is
billed (1/20 request) and wakes the object (duration), after a cap has
tripped too; the DO spending limit does not block messages on open sockets
either. The caps make that bounded: one address holds at most
`MAX_SOCKETS_PER_IP` sockets, closing ones included, and the object at most
`MAX_SOCKETS`; the object's own throughput (about 1,000 events a second)
is the ceiling. Not checked: whether Cloudflare's edge drops a peer that
never acknowledges a close. Test that before deploying (`worker/test/cost.js`
has the raw client); if it does not, a determined attacker can still run the
bill up, and only taking the Worker down stops it.

### Not counted, and why that is fine

The Worker's own requests (10 million included, the menu poll and the
handshakes, refused ones too: on `*.workers.dev` there is no WAF rule in
front of the Worker, so a curl loop from many machines is only limited by
the 10 million; serve the Worker on a custom domain in the owner's zone and
add a free rate-limiting rule for `/health` and `/ws` for real protection),
Workers CPU, the few SQLite rows (budget once a minute, the
snapshot and meta when they change; the per-socket data lives in the free
WebSocket attachments), outbound WebSocket messages (free). Workers Logs are
switched off in `wrangler.toml`: with hibernation every inbound message is an
invocation, and logs bill per event.

## Deploy (the integrator, with the owner's yes)

`worker/` has no package.json, so a bare `npx wrangler` would fetch the
newest wrangler from npm. Use the pinned version that was tested (4.163.0,
already in the npx cache on the owner's machine):

```bash
cd server-city/worker
npx wrangler@4.163.0 whoami              # the account b7117cdad0da911d200d1cff741dd934
npx wrangler@4.163.0 deploy              # creates among-the-city-coop and the CoopRoom class (migration v1)
curl https://among-the-city-coop.digifycz.workers.dev/health    # {"ready":true,...}
```

Optional account guard: create an API token (dash: My Profile, API Tokens,
Create Custom Token) with the single permission **Account, Account Analytics,
Read** for this account, then

```bash
npx wrangler@4.163.0 secret put CF_ANALYTICS_TOKEN    # paste the token
curl https://among-the-city-coop.digifycz.workers.dev/health    # "account": {...} appears
```

Then set the client: in `server-config.js`,
`export const SERVER_URL = 'https://among-the-city-coop.digifycz.workers.dev';`
and deploy the site (amongthecity.pages.dev) as usual. To change a cap, edit
`[vars]` and run `npx wrangler@4.163.0 deploy` again.

## Tests

- `npm test`: the Node relay, 22 cases over a real socket on a free port.
- `npm run test:worker`: spawns `wrangler dev --local` (six instances in
  parallel, plus one restarted on the same storage) with test vars and runs
  the same scenarios against the Durable Object, plus waking from
  hibernation, both budget guards (the account one against a stub GraphQL
  server, failing closed and surviving a hung request), the per-IP caps
  behind Cloudflare's address, peers that never answer a close, the
  handshake limiter, reaping by alarm, the `/health` cache and the menu-poll
  charge, a snapshot written before a wake, and a restart; the cycle
  arithmetic, the meter and the request formula are tested directly. Wrangler is found in
  `server-city/node_modules/.bin` or through `WRANGLER=/path/to/wrangler`.
  `TEST_ROOMS=1` (test only) lets `?room=` pick a room per test and enables
  `POST /__test/forget`, which drops the object's memory the way hibernation
  does.

## Environment knobs

| var | default | host | meaning |
|-----|---------|------|---------|
| `PORT` | `8081` | Node | listen port |
| `HOST` | `0.0.0.0` | Node | bind address |
| `TRUST_PROXY` | `1` | Node | read the client IP from `X-Forwarded-For` |
| `MAIN_ROOM_CODE` | `PARDUBICE` | both | name of the single shared room |
| `MAX_PLAYERS` | `20` | both | seat cap |
| `MAX_SOCKETS` | `3 x MAX_PLAYERS` | both | open sockets, joined or not |
| `MAX_SOCKETS_PER_IP` | `10` | both | open sockets from one address |
| `MAX_PLAYERS_PER_IP` | `6` | both | seats one address may hold |
| `HELLO_TIMEOUT_MS` | `10000` | both | grace period to say `hello` |
| `SILENCE_MS` | `300000` | Worker | no frame at all for this long closes the socket |
| `IDLE_MS` | `1800000` | Worker | seated and not moving for this long closes it (0 = off) |
| `BUDGET_GBS`, `BUDGET_REQUESTS` | `50000`, `300000` | Worker | own caps per cycle |
| `CYCLE_DAY` | `13` | Worker | billing cycle start day (00:00 UTC) |
| `CF_ANALYTICS_TOKEN` | (secret, unset) | Worker | turns on the account guard |
| `CF_ACCOUNT_ID` | the account | Worker | account the guard asks about |
| `ACCOUNT_GBS_LIMIT`, `ACCOUNT_REQUESTS_LIMIT` | `380000`, `950000` | Worker | account-wide limits |
| `ACCOUNT_CHECK_MS` | `3600000` | Worker | how often the guard asks while players are on |
| `ACCOUNT_RETRY_MS` | `120000` | Worker | retry after a failed check |
| `ACCOUNT_FAILS_TO_CLOSE` | `2` | Worker | failed checks in a row that close co-op (4503) |
| `ACCOUNT_TIMEOUT_MS` | `10000` | Worker | timeout of one analytics request |
| `DEAD_GRACE_MS` | `10000` | both | a closed socket stays on the hub's books this long |
| `HEALTH_TTL_MS` | `30000` | Worker | `/health` cache in the Worker isolate |
| `UPGRADES_PER_MIN` | `30` | Worker | handshakes per address per minute |
