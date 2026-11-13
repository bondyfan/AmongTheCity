// ---- public transport: buses on lines, to a timetable --------------------------
// js/buslines.js derives the lines; this module runs them. A bus is not a
// simulation of its own: it is an ordinary traffic schedule (js/traffic.js
// addFixed) whose route is the line instead of a hashed wander and which
// dwells at the line's stops. Everything the traffic already promises it gets
// for free: it stops at red lights, queues, gives way, never pops into view,
// and is the same bus in the same place on every co-op screen, because
//
//   trip k of a line leaves its first stop at   phase + k x HEADWAY
//
// and from there its position is the schedule's pure function of shared time.
// No bus is ever "spawned near the player".
//
// WHERE THE LINES COME FROM, AND WHEN. The world is diced into REGION-metre
// squares. A region's lines start at the stops inside it and may run HALO
// metres beyond, and they are derived only once every map tile under that
// larger box has loaded: the same lines, then, whatever order the tiles came
// in. A region whose box reaches under a tile that is not loaded yet simply
// has no buses yet (it is at least a kilometre and a half away).
//
// Passengers: pedestrians.js asks eta() when it plans a walker's day (so the
// wait at the stop ends when a bus is due) and standingAt() when somebody is
// ready to step on or off (so nobody boards a bus that is not there).
//
// REAL LINES FIRST. Where the route files have the real network (Pardubice,
// Hradec Králové, Prague and the country between), js/realtransit.js runs it:
// the real numbers, the real calls in their order, trolleybuses on the
// trolleybus routes. The lines derived here are what is left for the places
// OSM has stops and no route relation: a stop within reach of a real call is
// taken off the table before a region derives its lines, and a region waits
// for the route files of its tiles as it waits for the tiles themselves, so
// which stops are left is a fact about the map and not about who asked when.

import { worldT } from './worldclock.js';
import { hourAt, isNightService } from './dayrhythm.js';
import { deriveLines, hopKey, outranks, SHARE_MIN } from './buslines.js';
import { RealLines } from './realtransit.js';

const REGION = 1600, HALO = 800;
const HEADWAY = 330;          // s between departures of one line: five and a half
                              // minutes real, which with the lines that share a
                              // main street is a bus past any stop every minute or two
const DWELL = 9, DWELL_TERMINUS = 16;   // s the doors stand open
const BUS_VK = 0.86;          // a bus holds a little under the limit
const BUS_RED = 0xb5271f;     // the fleet colour (vehicles.js gives the bus its livery)
const REACH = 1500;           // m: lines with a stop this close to the player run
const SCAN_DT = 0.5;
const EGRID = 64;             // js/traffic.js Buckets pitch (its _egrid)
// m from a region's centre within which a tile's route files must be in before
// the region derives: the half diagonal of its halo box (2263 m) and the reach
// of a real stop over a derived one
const REAL_REACH = 2500;

const q10 = (v) => Math.round(v * 10);

export class Buses {
  constructor(city, traffic) {
    this.city = city;
    this.traffic = traffic;
    this.lines = [];
    this.clock = null;              // test seam, like traffic.clock
    this._regions = new Map();      // "rx,rz" -> lines[] (derived) | undefined
    this._byStop = new Map();       // "x10,z10" -> [{ line, i }]
    this._times = new Map();        // "lineId:k" -> Float64Array of nominal arrivals
    this._hops = new Map();         // "stopId>stopId" -> the lines that run that hop
    this._tally = new Map();        // scratch for _claim
    this._gen = 0;                  // bumped when a tile loads: a region may have become derivable
    this._t = 0;
    this._dirty = true;
    city.onTileLoaded?.(() => { this._dirty = true; this._gen++; });
    // the real network (js/realtransit.js); a route file arriving is, for a
    // region that was waiting for it, what a tile arriving is
    this.real = new RealLines(city, traffic);
    this.real.onLines = () => { this._dirty = true; this._gen++; };
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---- derivation ----------------------------------------------------------

  // Is every map tile under this box loaded? (No manifest: one legacy city
  // file or a test fixture, where everything there will ever be is loaded.)
  _loaded(x0, z0, x1, z1) {
    const tiles = this.city.manifestTiles, T = this.city.tile;
    if (!tiles || !T) return true;
    for (const t of tiles) {
      if ((t.tx + 1) * T <= x0 || t.tx * T >= x1 || (t.tz + 1) * T <= z0 || t.tz * T >= z1) continue;
      if (!(t.state >= 2)) return false;
    }
    return true;
  }

  _derive(rx, rz) {
    const key = rx + ',' + rz;
    if (this._regions.has(key)) return false;
    const x0 = rx * REGION - HALO, x1 = (rx + 1) * REGION + HALO;
    const z0 = rz * REGION - HALO, z1 = (rz + 1) * REGION + HALO;
    if (!this._loaded(x0, z0, x1, z1)) return false;
    // …and the route files of every tile a real stop near this box could be
    // in: until they are here nobody can say which stops are left to derive from
    if (!this.real.ready((rx + 0.5) * REGION, (rz + 0.5) * REGION, REAL_REACH)) return false;
    const stops = [];
    for (const poi of this.city.pois ?? []) {
      if (poi.t !== 'bus_stop' || !poi.p) continue;
      const x = poi.p[0], z = poi.p[1];
      if (x >= x0 && x < x1 && z >= z0 && z < z1 && !this.real.covers(x, z)) stops.push({ x, z, n: poi.n });
    }
    const grid = this.traffic._egrid.m;
    const near = (x, z) => {
      const out = [];
      const ci = Math.floor(x / EGRID), cj = Math.floor(z / EGRID);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const a = grid.get((ci + i) + ',' + (cj + j));
        if (a) for (const e of a) out.push(e);
      }
      return out;
    };
    const inBox = (e) => e.mx >= x0 && e.mx < x1 && e.mz >= z0 && e.mz < z1;
    const isSeed = (s) => s.x >= rx * REGION && s.x < (rx + 1) * REGION
      && s.z >= rz * REGION && s.z < (rz + 1) * REGION;
    const lines = stops.length >= 3 ? deriveLines({ stops, near, inBox, isSeed }) : [];
    this._regions.set(key, lines);
    for (const line of lines) {
      line.maxDur = line.len / 4 + line.stops.length * 25 + 90;
      line.rx = rx; line.rz = rz;
      // what its displays say: OSM gave it no number, so it wears one made
      // of its identity, and the name of its last stop
      line.ref = String(40 + (line.id >>> 0) % 50);
      line.dest = line.stops[line.stops.length - 1].n || '';
      line.shadow = false;          // retired: a line that outranks it runs the same kerbs
      line.settled = false;         // every region that could retire it has been derived
      line.gen = -1;
      this._claim(line);
      this.lines.push(line);
      line.stops.forEach((st, i) => {
        const k = q10(st.x) + ',' + q10(st.z);
        const l = this._byStop.get(k) ?? [];
        l.push({ line, i });
        this._byStop.set(k, l);
      });
    }
    return true;
  }

  // ONE LINE PER KERB, ACROSS REGIONS TOO (js/buslines.js has the story). Each
  // new line is checked against every line already known that runs one of its
  // hops; of two that share SHARE_MIN or more, the one the other outranks is
  // retired: it stays in `lines`, runs no trips and answers no eta(). The test
  // is "does ANY line that outranks it share its kerbs", whether or not that
  // one is itself retired, so a line's fate depends only on the regions beside
  // its own and never on a chain of decisions reaching across the map; and a
  // retired line is never brought back, so the order the regions were derived
  // in cannot change who ends up running.
  _claim(line) {
    const seen = this._tally, st = line.stops;
    seen.clear();
    for (let i = 0; i + 1 < st.length; i++) {
      const k = hopKey(st[i], st[i + 1]);
      let l = this._hops.get(k);
      if (!l) this._hops.set(k, l = []);
      for (const o of l) seen.set(o, (seen.get(o) ?? 0) + 1);
      l.push(line);
    }
    for (const [o, n] of seen) if (n >= SHARE_MIN) (outranks(o, line) ? line : o).shadow = true;
    seen.clear();
  }

  // Is every region derived that could have grown a line over SHARE_MIN of
  // this one's hops? Those are the regions (its own neighbours) whose box
  // holds both stops of that many hops. Derives up to `budget` of the missing
  // ones and returns how many it did. Until a line is settled it runs as it
  // always did: a region whose tiles have not arrived cannot be derived by
  // anybody, and buses do not wait for a tile four kilometres away.
  _settle(line, budget) {
    if (line.gen === this._gen) return 0;        // nothing has loaded since it last looked
    let spent = 0, later = false, never = false;
    const st = line.stops;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const rx = line.rx + i, rz = line.rz + j;
      if (this._regions.has(rx + ',' + rz)) continue;
      const x0 = rx * REGION - HALO, x1 = (rx + 1) * REGION + HALO;
      const z0 = rz * REGION - HALO, z1 = (rz + 1) * REGION + HALO;
      let n = 0, was = false;
      for (let q = 0; q < st.length; q++) {
        const s = st[q], inb = s.x >= x0 && s.x < x1 && s.z >= z0 && s.z < z1;
        if (inb && was) n++;
        was = inb;
      }
      if (n < SHARE_MIN) continue;
      if (spent >= budget) later = true;
      else if (this._derive(rx, rz)) spent++;
      else never = true;                         // its tiles are not here yet
    }
    if (!later && !never) line.settled = true;
    else if (!later) line.gen = this._gen;       // wait for a tile before asking again
    return spent;
  }

  // ---- the timetable ---------------------------------------------------------

  /** Does trip k of a line run? Every departure by day, every other at night. */
  runs(line, k) {
    const t = this.depart(line, k);
    return !(isNightService(hourAt(t)) && (k & 1));
  }
  depart(line, k) { return (line.phase + k) * HEADWAY; }

  _spec(line, k) {
    const t0 = this.depart(line, k);
    return {
      key: 'bus:' + (line.id >>> 0) + ':' + k, seed: (line.id ^ Math.imul(k, 0x9e3779b1)) | 0,
      t0, tEnd: t0 + line.maxDur, vK: BUS_VK, kind: 'bus', color: BUS_RED,
      route: line.route.map((r) => ({ e: r.e, base: r.base, turnIn: r.turnIn, turnOut: r.turnOut })),
      startS: line.startS, len: line.len, tag: line,
      stops: line.stops.map((s, i) => ({ arc: s.arc, x: s.x, z: s.z, n: s.n,
        dwell: (i === 0 || i === line.stops.length - 1) ? DWELL_TERMINUS : DWELL })),
    };
  }

  // When trip k is DUE at each of its stops: the schedule's own answer, got by
  // running the schedule (red lights and all) with no car attached. Pure, so
  // it is cached for good.
  _tripTimes(line, k) {
    const key = line.id + ':' + k;
    let t = this._times.get(key);
    if (!t) {
      t = this.traffic.fixedTimes(this._spec(line, k));
      this._times.set(key, t);
      if (this._times.size > 600) this._times.delete(this._times.keys().next().value);
    }
    return t;
  }

  // WHO SERVES A STOP IS A FACT ABOUT THE MAP, NOT ABOUT WHEN IT WAS ASKED.
  // Regions are derived one per pass round the player, and a walker's whole day
  // (board here, or step off a bus there) is decided the moment they are born,
  // by asking eta(). A walker born before the region next door had been derived
  // got "no bus calls here" where a client who had been standing in that region
  // got a boarder: two screens disagreed about the same person for as long as
  // they lived. So the question derives what it needs first: every region whose
  // box (with its halo) holds the stop, now. That is a few tens of milliseconds
  // once per region, nearly always under the boot overlay, and after it the
  // answer is the same whoever asks and whenever. (A region whose tiles are
  // still on their way cannot be derived by anybody; that is the streaming
  // frontier, where the road graph itself is not yet shared.)
  _ensureFor(x, z) {
    const r0 = Math.floor((x - HALO) / REGION), r1 = Math.floor((x + HALO) / REGION);
    const s0 = Math.floor((z - HALO) / REGION), s1 = Math.floor((z + HALO) / REGION);
    for (let rx = r0; rx <= r1; rx++) for (let rz = s0; rz <= s1; rz++) {
      if (!this._regions.has(rx + ',' + rz)) this._derive(rx, rz);
    }
    // ...and whether a line that calls here RUNS is a fact about the map too:
    // settle each one, so that a line a neighbouring region retires is retired
    // before the first walker is told about it, not after.
    const at = this._byStop.get(q10(x) + ',' + q10(z));
    if (at) for (let i = 0; i < at.length; i++) {
      const line = at[i].line;
      if (!line.shadow && !line.settled) this._settle(line, Infinity);
    }
    return at;                                         // who calls here, for eta()
  }

  /** The shared second the next bus is due at the stop at (x, z), at or after t. */
  eta(x, z, t) {
    const at = this._ensureFor(x, z);
    let best = this.real.eta(x, z, t);
    if (!at) return best;
    for (const { line, i } of at) {
      if (line.shadow) continue;                       // retired: another line has these kerbs
      if (i === line.stops.length - 1) continue;       // nobody boards at the terminus
      const k0 = Math.floor((t - line.maxDur) / HEADWAY - line.phase);
      for (let k = k0; k <= k0 + Math.ceil(line.maxDur / HEADWAY) + 3; k++) {
        if (!this.runs(line, k)) continue;
        const due = this._tripTimes(line, k)[i];
        if (due >= t && due < best) { best = due; break; }
      }
    }
    return best;
  }

  /** The bus standing at the stop at (x, z) with its doors open, or null. */
  standingAt(x, z) {
    const wt = this.now();
    for (const car of this.traffic.cars) {
      const p = car.ai;
      if (!p || !p.fixed || p.atStop < 0) continue;
      const at = this.traffic.standingAt(p, wt);
      if (!at || at.left < 2) continue;                // not there, or doors closing
      if ((at.stop.x - x) ** 2 + (at.stop.z - z) ** 2 > 4) continue;
      return car;
    }
    return null;
  }

  /**
   * Is a bus whose next call is the stop at (x, z) on its way there IN PERSON,
   * within `reach` metres of road? What a boarder whose timetable has run out
   * asks before giving up: a bus thirty seconds late is late, not cancelled.
   */
  approaching(x, z, reach = 260) {
    for (const car of this.traffic.cars) {
      const p = car.ai;
      if (!p || !p.fixed || !p.stops || p.stand >= p.stops.length) continue;
      const st = p.stops[p.stand];
      if ((st.x - x) ** 2 + (st.z - z) ** 2 > 4) continue;
      const d = st.arc - p.sR;
      if (d > -3 && d < reach) return true;
    }
    return false;
  }

  // ---- per frame -------------------------------------------------------------

  update(dt, pos) {
    this.real.clock = this.clock;
    this.real.update(dt, pos);
    this._t -= dt;
    if (this._t > 0 || !pos) return;
    this._t = SCAN_DT;
    const rx = Math.floor(pos.x / REGION), rz = Math.floor(pos.z / REGION);
    let spare = 1;
    if (this._dirty) {
      // one region per pass: a derivation is tens of milliseconds
      this._dirty = false;
      let did = false;
      for (let i = -1; i <= 1 && !did; i++) for (let j = -1; j <= 1 && !did; j++) did = this._derive(rx + i, rz + j);
      if (did) { this._dirty = true; spare = 0; }      // there may be more
    }
    if (this._rx !== rx || this._rz !== rz) { this._rx = rx; this._rz = rz; this._dirty = true; }
    const wt = this.now();
    for (const line of this.lines) {
      if (line.shadow) continue;
      let nearLine = false;
      for (const s of line.stops) {
        if ((s.x - pos.x) ** 2 + (s.z - pos.z) ** 2 < REACH * REACH) { nearLine = true; break; }
      }
      if (!nearLine) continue;
      // the pass's one derivation, if the scan above did not spend it, goes to
      // a region that could retire a line about to put a bus on the road
      if (!line.settled) {
        if (spare > 0) spare -= this._settle(line, spare);
        // ...and until those regions are in, its buses WAIT, a pass or two.
        // Started at once, the trips of a line retired a second later stayed
        // on the road to the end of their run, a quarter of an hour, on this
        // client only: the twins again, and different ones on every screen,
        // since which lines got out first depended on where each player
        // booted. Only a line whose missing regions nobody can derive yet
        // (line.gen: their tiles are not here) runs unsettled.
        if (line.shadow || (!line.settled && line.gen !== this._gen)) continue;
      }
      const k1 = Math.floor(wt / HEADWAY - line.phase);
      for (let k = k1 - Math.ceil(line.maxDur / HEADWAY); k <= k1; k++) {
        if (!this.runs(line, k)) continue;
        const t0 = this.depart(line, k);
        if (wt < t0 || wt > t0 + line.maxDur) continue;
        const key = 'bus:' + (line.id >>> 0) + ':' + k;
        if (!this.traffic.hasSlot(key)) this.traffic.addFixed(this._spec(line, k));
      }
    }
  }
}
