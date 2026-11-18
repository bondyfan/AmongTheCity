// ---- express.js: the R train Pardubice - Praha, and the skip (round 8) ----
// js/trains.js runs a fleet of RANDOM trains (Math.random spawn and
// direction, free, nothing says where one goes). This adds the one train a
// player can plan on: "R Pardubice - Praha", leaving Pardubice hl.n. every
// hour of GAME time (at half past, the clock's own phase), calling at Přelouč, Kolín, Český Brod and Praha-Libeň,
// and running into Praha hl.n. over the 6.2 km the chainer could not join
// (js/railstitch.js). A ticket is charged on boarding (main.js), and because
// one game hour is one real minute, a rider can skip to the next station
// (N): fade out, the train is moved there with the tiles loaded, fade in.
//
// CO-OP. The departure is a pure function of the shared clock (worldT) and
// station NAMES, never of route arc length (routes assemble in tile order):
// every client offers the same departure. The skip never touches the clock;
// it moves this client's train, which is local state like every train.
//
// THE HEADWAY is one game hour, not the brief's twenty minutes: at DAY_LENGTH
// 1440 s a game minute is one real second, a platform stand is 25 s, and a
// set is 144 m long, so a train every 20 s would arrive on top of the one
// just leaving. An hour (one real minute) clears the platform with room.

import { worldT, tod } from './worldclock.js';
import { DAY_LENGTH } from './config.js';
import { tilesReady } from './startplace.js';
import { stitchPath } from './railstitch.js';
import { gradedPath } from './trains.js';
import { HLN, posAt, transferRoute, towardPrague } from './expressroute.js';
import { untiledAt, throughHole, loaded, until, sleep } from './expresshole.js';

export const EXPRESS_NAME = 'R Pardubice – Praha';
const ORIGIN = 'Pardubice hlavní nádraží';
/** The stations the express calls at after Pardubice (exact OSM names). */
export const EXPRESS_STOPS = Object.freeze(['Přelouč', 'Kolín', 'Český Brod', 'Praha-Libeň', 'Praha hlavní nádraží']);
const STOP_SET = new Set(EXPRESS_STOPS);
const calls = (name) => STOP_SET.has(name);
const GAME_MIN = DAY_LENGTH / 1440;        // real seconds per game minute
export const HEADWAY = 60 * GAME_MIN;      // s of worldT between departures
const STAND = 25;                           // s at Pardubice with the doors open
const NEAR = 2500;                          // m: the express is set up when the player is this near
const CARS = 5;
const MAIN_MIN = 4000;                      // m: shorter is a platform track or a siding
// the end of line 010 in the tiles (the Libeň yard) and the station it should reach
const LIBEN_END = [-89177, -7618];
const STITCH_TAIL = 2500;                   // m of route end the splice may start back along
const STITCH_EVERY = 3;                     // s between tries while it has not worked
const JUMP = 2000;                          // m per skip step: inside TILE_REACH (2600 m)

/** The next departure from Pardubice at or after world time `t` (s). */
export function nextDeparture(t) { return Math.ceil(t / HEADWAY) * HEADWAY; }
/** "14:00": the game clock at world time `dep`, given the clock now. */
export function clockAt(dep, nowT, nowTod) {
  const m = ((nowTod + (dep - nowT) / DAY_LENGTH) % 1 + 1) % 1 * 1440;
  const mm = Math.round(m) % 1440;
  return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}

export class Express {
  constructor(trains, city, player = null) {
    this.trains = trains;
    this.city = city;
    this.player = player;       // the rider's body: a skip puts its feet down (see _land)
    this.train = null;          // the express standing or running, if any
    this._dep = -1;             // the departure it was set up for
    this._t = 0;
    this._stitchT = 0;
    this._stitched = new Set(); // route ids spliced into Praha hl.n.
    this.skipping = false;
    this.fade = screenFade;     // the fade a pass through the untiled ground runs under
  }

  /** Where Pardubice hl.n. is on the main line through it, or null. The
   *  station has platform tracks and sidings chained as routes of their own
   *  (1.3 km, measured in game): the longest route that calls there is line
   *  010, and it must already run a few km west, toward Prague. */
  _origin() {
    let best = null;
    for (const R of this.trains.routes) {
      if (R.len < MAIN_MIN || (best && R.len <= best.R.len)) continue;
      const st = R.stops.find((s) => s.name === ORIGIN);
      if (st) best = { R, st };
    }
    return best;
  }

  update(dt, focus) {
    // the rider stands on the train, every frame: main.js keeps the body on
    // the ground under it, and where line 010 leaves the world's tiles the
    // ground drops 200 m to the untiled plane (Kolín); the walk physics fell
    // that and vitals billed it as a fatal fall (seen in game)
    const rt = this.trains.riding;
    if (rt) this._land(rt);
    // …and where the line runs over ground no tile covers (line 010 from
    // west of Prelouc to Kolin, d11left (d)), the ride is not shown: the
    // screen fades and the train is skipped on to tiled ground (see through)
    if (rt && !this.skipping && !rt.halted && !rt.hold && untiledAt(this.city, rt.x, rt.z)) {
      this.through(this.fade).catch(() => {});
    }
    this._t -= dt;
    this._stitchT -= dt;
    if (this._stitchT <= 0) { this._stitchT = STITCH_EVERY; this._stitch(); }
    if (this.train && !this.trains.trains.has(this.train)) this.train = null;
    if (this._t > 0 || !focus) return;
    this._t = 0.5;
    // the express (and whatever train the player rides) does not reverse at a
    // seam of the chainer: standing at the end of its route, it changes onto
    // the line that runs on from there (see transfer)
    for (const t of [this.train, this.trains.riding]) {
      if (t && t.halted && t.turning && !t.station && !t.hold && this.transfer(t)) {
        t.turning = false;
        t.dwellT = Math.min(t.dwellT, 1.5);
      }
    }
    // …and at each of its stations the express takes the line toward Prague:
    // at Kolín the chainer's straightest route runs on to Kutná Hora (seen in
    // game: the express left Kolín south-east)
    const ex = this.train;
    if (ex && ex.halted && ex.station && ex._chose !== ex.station && !ex.hold) {
      ex._chose = ex.station;
      this.towardPrague(ex);
    }
    const o = this._origin();
    if (!o || Math.hypot(o.st.x - focus.x, o.st.z - focus.z) > NEAR) return;
    const now = worldT(), dep = nextDeparture(now);
    if (dep === this._dep || dep - now > STAND || dep - now < 3) return;
    this._spawn(o.R, o.st, dep, now, focus);
  }

  _spawn(R, st, dep, now, focus) {
    const tr = this.trains;
    // toward Prague = west: the direction in which x falls along the route
    const probe = Math.min(R.len, st.s + 200), back = Math.max(0, st.s - 200);
    const pf = posAt(R, probe), pb = posAt(R, back);
    const dir = pf[0] < pb[0] ? 1 : -1;
    // the platform must be free: a random train standing there is taken off
    // unless the player can see it (then this departure is skipped)
    for (const o of tr.trains) {
      if (o.route !== R || o === tr.riding) continue;
      if (Math.abs(o.s - st.s) > 400) continue;
      if (Math.hypot(o.x - focus.x, o.z - focus.z) < 250) return;
      tr._remove(o);
    }
    const t = tr._spawn(R, st.s, dir, CARS);
    if (!t) return;
    this._dep = dep;
    t.express = dep;
    t.label = EXPRESS_NAME;
    t.only = calls;
    t.s = Math.max(tr._sLo(t), Math.min(tr._sHi(t), st.s));
    tr._halt(t, st, dep - now);
    tr._place(t, 0);
    this.train = t;
  }

  /** The departure hint for someone standing near Pardubice hl.n., or null. */
  hintAt(x, z) {
    const o = this._origin();
    if (!o || Math.hypot(o.st.x - x, o.st.z - z) > 160) return null;
    const now = worldT(), dep = nextDeparture(now);
    const left = Math.max(0, Math.round((dep - now) / GAME_MIN));
    return EXPRESS_NAME + ' · odjezd ' + clockAt(dep, now, tod()) + ' (za ' + left + ' min)';
  }

  // ---- the last 6 km into Praha hl.n. --------------------------------------
  _stitch() {
    const tr = this.trains, city = this.city;
    for (const R of tr.routes) {
      if (this._stitched.has(R.id)) continue;
      const a = R.pts[0], b = R.pts[R.pts.length - 1];
      const da = Math.hypot(a[0] - LIBEN_END[0], a[1] - LIBEN_END[1]);
      const db = Math.hypot(b[0] - LIBEN_END[0], b[1] - LIBEN_END[1]);
      if (Math.min(da, db) > 40) continue;
      // the station's tiles must be in (else there is nothing to find yet)
      if (!tilesReady(city, HLN[0], HLN[1], 50)) return;
      // the Libeň end becomes the route's END (trains.js keeps every train
      // and stop valid through a reversal)
      if (da < db) tr._reverseRoute(R);
      const tail = tailOf(R, STITCH_TAIL);
      const res = stitchPath(city.rails, tail.pts, HLN[0], HLN[1]);
      if (!res) { this._stitched.add(R.id); return; }   // once per route: nothing to find
      const cut = tail.base + res.cut;
      // never cut away rail a train stands on (tried again in a moment)
      for (const t of tr.trains) if (t.route === R && t.s > R.cum[cut] - t.length) return;
      this._stitched.add(R.id);
      R.pts.length = cut + 1; R.ys.length = cut + 1;
      if (R.wy) { R.wy.length = cut + 1; R.ws.length = cut + 1; }
      // graded like the rest of the line (round 10): the rail's own level and
      // its decks, sampled every 10 m, not the bare ground under each vertex
      // (the splice rode 12 m under the Nove spojeni viaduct's deck)
      const g = gradedPath(res.pts, res.at ?? res.pts.map(() => null), R.ys[cut]);
      tr._append(R, g, false);   // re-measures, re-profiles, rescans stops
      for (const w of res.ways) { w._trDone = true; if (w._id !== undefined) tr._wids?.set(w._id, R); }
      return;
    }
  }

  // ---- changing routes (js/expressroute.js) ---------------------------------
  /** At the end of its route, go on along another (see transferRoute). */
  transfer(t) { return transferRoute(this.trains, t); }
  /** At a station, take the route that leads to Praha hl.n. (see towardPrague). */
  towardPrague(t) { return towardPrague(this.trains, t); }

  /** Fade through ground no tile covers to tiled ground again (js/expresshole.js). */
  through(fade) { return throughHole(this, fade); }

  // ---- the skip -------------------------------------------------------------
  /** Skip the ridden train to its next station. Resolves true when it got there. */
  async skip(fade) {
    const tr = this.trains, t = tr.riding;
    if (!t || t.halted || this.skipping) return false;
    this.skipping = true;
    t.hold = true;
    let ok = false;
    // keep the body's feet on the train the whole time, not only after each
    // jump: while the tiles stream the ground under it changes, and any drop
    // the walk physics sees is billed as a fall (10 HP at Přelouč otherwise)
    const pin = setInterval(() => this._land(t), 100);
    try {
      await fade?.(1);
      for (let i = 0; i < 60 && tr.riding === t; i++) {
        const st = tr._nextStop(t);
        const end = t.dir > 0 ? tr._sHi(t) : tr._sLo(t);
        const goal = st ? Math.max(tr._sLo(t), Math.min(tr._sHi(t), st.s)) : end;
        const step = Math.max(-JUMP, Math.min(JUMP, goal - t.s));
        t.s += step;
        tr._place(t, 0);
        tr._syncRide();
        this._land(t);
        this.city.ensureTiles?.(t.x, t.z)?.catch?.(() => {});
        await until(() => loaded(this.city, t.x, t.z, 800), 25000);
        await sleep(250);                       // trains.update ingests the new rails
        tr._reheight?.();                       // and the track there stands on the ground now known
        tr._place(t, 0); tr._syncRide();
        this._land(t);
        if (Math.abs(goal - t.s) > 0.5) continue;
        if (st) {
          // the line ON from here must be in before the doors close, or the
          // train would run to the end of the known route 76 m on and turn
          // back (seen at Přelouč): load the tiles ahead and wait for track
          await this._trackAhead(t, AHEAD);
          tr._halt(t, st, 14); ok = true;
          // the platform the express leaves from, chosen while the screen is
          // still dark (a change of platform track would show as a jump)
          if (t.express) { t._chose = t.station; this.towardPrague(t); }
          break;
        }
        // the end of the route as known: give the tiles here a moment to add
        // track (trains.update chains and joins it), then it is the end of
        // the line and the train turns there as it would have
        tr._pending = true;
        const grown = () => Math.abs((t.dir > 0 ? tr._sHi(t) : tr._sLo(t)) - t.s) >= 1 || !!tr._nextStop(t);
        await until(grown, 4000);
        if (!grown() && this.transfer(t)) continue;   // the line runs on in another route
        if (!grown()) { tr._halt(t, null, 9); t.turning = true; ok = true; break; }
      }
    } finally {
      clearInterval(pin);
      this._land(t);
      t.hold = false;
      await fade?.(0);
      this.skipping = false;
    }
    return ok;
  }
}

// A jump of 2 km along the line lands the rider's body (main.js keeps it on
// the ground under the train) on ground up to tens of metres lower than it
// left: the walk physics fell that and vitals billed the fall (a skip from
// Pardubice to Přelouč cost 74 HP in game). Feet down, no fall speed.
Express.prototype._land = function (t) {
  const p = this.player;
  if (!p || typeof p.y !== 'number') return;
  p.y = t.y;
  if (typeof p.vy === 'number') p.vy = 0;
};

// ---- helpers ----------------------------------------------------------------
const AHEAD = 1600;                         // m of known track wanted past a station after a skip

Express.prototype._trackAhead = async function (t, need) {
  const tr = this.trains;
  const left = () => (t.dir > 0 ? tr._sHi(t) - t.s : t.s - tr._sLo(t));
  for (let k = 0; k < 4 && left() < need && tr.riding === t; k++) {
    // past the end of the known route, along its last segment
    const R = t.route, n = R.pts.length;
    const end = t.dir > 0 ? R.pts[n - 1] : R.pts[0], prev = t.dir > 0 ? R.pts[n - 2] : R.pts[1];
    const L = Math.hypot(end[0] - prev[0], end[1] - prev[1]) || 1;
    const px = end[0] + (end[0] - prev[0]) / L * 1500, pz = end[1] + (end[1] - prev[1]) / L * 1500;
    this.city.ensureTiles?.(px, pz)?.catch?.(() => {});
    const before = left();
    tr._pending = true;
    await until(() => left() > before + 1, 5000);
    if (left() <= before + 1) break;        // nothing more out there: the end of the line
  }
};


// the route's last `len` metres as stitch sources (travel = toward the end)
function tailOf(R, len) {
  const n = R.pts.length, out = [];
  let i = n - 1;
  while (i > 0 && R.cum[n - 1] - R.cum[i] < len) i--;
  const base = Math.max(1, i);
  for (let k = base; k < n; k++) {
    const a = R.pts[k - 1], b = R.pts[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push({ x: b[0], z: b[1], hx: (b[0] - a[0]) / L, hz: (b[1] - a[1]) / L });
  }
  return { base, pts: out };
}

// ---- the fade a skip runs under ----------------------------------------------
let _fadeEl = null;
/** Fade the screen to black (1) or back (0); resolves when done. */
export function screenFade(to) {
  if (typeof document === 'undefined') return Promise.resolve();
  if (!_fadeEl) {
    _fadeEl = document.createElement('div');
    _fadeEl.style.cssText = 'position:fixed;inset:0;background:#05070a;opacity:0;pointer-events:none;'
      + 'transition:opacity .4s ease;z-index:50;display:flex;align-items:center;justify-content:center;'
      + 'color:#cfd6df;font:600 15px system-ui,sans-serif;letter-spacing:.04em';
    document.body.appendChild(_fadeEl);
  }
  _fadeEl.textContent = to ? 'Jedete do další stanice…' : '';
  _fadeEl.style.opacity = to ? '1' : '0';
  return new Promise((r) => setTimeout(r, 420));
}
