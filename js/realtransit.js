// ---- real transit: the lines of the route files, run to a timetable ------------
// Phase one put the real network into the data (public/data/routes, one file
// per owner tile, docs/TILE-FORMAT.md). This module loads the files round the
// player, turns each bus and trolleybus route into a LINE, and keeps the trips
// that are due near the player on the road as traffic schedules
// (js/traffic.js addFixed), exactly as js/buses.js does for its derived lines.
//
// WHAT IS SHARED, AND WHY IT DOES NOT DEPEND ON WHO LOADED WHAT.
//   trip k of a line is due at call i at   (phase + k) x headway + N[i]
// and every term is arithmetic on the route record (js/realines.js): the id
// gives the phase, the mode the headway, the metres between calls the N. A
// client that has never seen the first half of line 13 still knows when the
// 13 is due at Masarykovo náměstí. The bus itself is a traffic schedule begun
// at the call the trip is at when it comes within reach, and it HOLDS at every
// call until the timetable lets it go, so two schedules of one trip begun at
// different calls are the same bus from the first call they share.
//
// A trip runs on the part of its line the road graph covers (a chain of
// js/realines.js). Tiles stream in, so that part grows: a trip whose road ran
// out at the edge of what was loaded is handed the rest as it arrives
// (traffic.extendFixed) and never has to stop at a border nobody can see.

import { worldT } from './worldclock.js';
import { hourAt, isNightService } from './dayrhythm.js';
import { routePath, routeStops, routeNear, MODE_TRAM, MODE_TROLLEYBUS, CALL_EXIT_ONLY } from './tiledata.js';
import { indexPath, matchPath, chainTrip, nominalTimes, headwayOf, phaseOf, DWELL, DWELL_TERMINUS } from './realines.js';
import { TRANSIT_BODY } from './transitbody.js';

const REACH = 1500;           // m: a trip whose current call is this close to the player runs
const FILE_REACH = 1900;      // m: route files of tiles this close are fetched
const SCAN_DT = 0.5;
const EGRID = 64;             // js/traffic.js Buckets pitch (its _egrid)
const BUS_VK = 0.86;          // a bus holds a little under the limit
const BUS_RED = 0xb5271f;
const DWELL_MIN = 4;          // s the doors stand open even when the bus is late
const LEAD = 3;               // s before its first call's time a schedule starts rolling
const GRACE = 240;            // s past its last call's time a trip may still be on the road
const COVER_R = 130;          // m round a real stop where a derived line has no business
const COVER_G = 256;
const MATCH_PER_SCAN = 4;     // routes laid onto the graph per scan (about a millisecond each)
const JUMP = 45;              // s between two scans that can only be a stepped clock

const q10 = (v) => Math.round(v * 10);
// Every route file this page has read, by URL. A file is the same for whoever
// asks, so a second timetable (a reset, a test that asks a fresh one what the
// running one says) takes it from here at once instead of fetching it again
// and answering "no bus" until it arrives.
const FILES = new Map();
const stopKey = (x, z) => q10(x) + ',' + q10(z);

export class RealLines {
  constructor(city, traffic) {
    this.city = city;
    this.traffic = traffic;
    this.clock = null;                // test seam, like traffic.clock
    this.load = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); });
    this.files = new Map();           // url -> 'loading' | 'ok' | 'failed'
    this.lines = [];
    this._byId = new Map();           // relation id -> line
    this._byStop = new Map();         // "x10,z10" -> [{ line, i }]
    this._cover = new Map();          // coarse cell -> [x, z, ...] of every real stop
    this._live = new Map();           // trip key -> { line, k, i0, i1, n }
    this._gen = 0;                    // bumped when a tile loads: the graph has grown
    this._t = 0; this._tf = 0;
    this._wt = NaN;                   // the shared second of the last scan
    this._budget = 0;
    this.onLines = null;              // () => a file arrived (js/buses.js re-derives round it)
    city.onTileLoaded?.(() => { this._gen++; });
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---- the files ---------------------------------------------------------------

  /** Are the route files of every tile within `reach` of (x, z) in? */
  ready(x, z, reach) {
    const need = this.city.routeFilesNear?.(x, z, reach);
    if (!need) return true;
    let ok = true;
    for (const url of need) {
      const st = this.files.get(url);
      if (st === undefined) { this._fetch(url); ok = false; } else if (st !== 'ok') ok = false;
    }
    return ok;
  }

  _fetch(url) {
    if (this.files.has(url) && this.files.get(url) !== 'failed') return;
    if (FILES.has(url)) { this.addFile(url, FILES.get(url)); return; }
    this.files.set(url, 'loading');
    let p;
    try { p = this.load(url); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then((file) => { this.addFile(url, file); },
      () => { this.files.set(url, 'failed'); });       // asked for again on a later pass
  }

  /** One route file, decoded into lines. Trams are not ours (they have rails). */
  addFile(url, file) {
    this.files.set(url, 'ok');
    if (file) FILES.set(url, file);
    for (const r of file?.routes ?? []) {
      if (r.m === MODE_TRAM || this._byId.has(r.id) || !r.s || r.s.length < 2) continue;
      const calls = routeStops(file, r);
      const stops = calls.map((c) => ({ x: c.px, z: c.pz, n: c.n, d: c.d, f: c.f }));
      const last = stops[stops.length - 1];
      const N = nominalTimes(stops.map((s) => s.d));
      const line = {
        id: r.id, ref: String(r.ref ?? ''), mode: r.m, trolley: r.m === MODE_TROLLEYBUS,
        name: r.n ?? '', dest: last.n || r.to || '', from: stops[0].n || r.fr || '',
        stops, N, dur: N[N.length - 1] + DWELL_TERMINUS,
        headway: headwayOf(r), phase: phaseOf(r), bb: r.bb, real: true,
        _file: file, _route: r, P: null, chains: null, gen: -1, whole: false,
      };
      this._byId.set(r.id, line);
      this.lines.push(line);
      stops.forEach((s, i) => {
        const k = stopKey(s.x, s.z);
        let l = this._byStop.get(k);
        if (!l) this._byStop.set(k, l = []);
        l.push({ line, i });
        const ck = Math.floor(s.x / COVER_G) + ',' + Math.floor(s.z / COVER_G);
        let c = this._cover.get(ck);
        if (!c) this._cover.set(ck, c = []);
        c.push(s.x, s.z);
      });
    }
    // stable whatever order the files came in
    this.lines.sort((a, b) => a.id - b.id);
    this.onLines?.();
  }

  /** Does a real line call within COVER_R of (x, z)? What retires a derived stop. */
  covers(x, z) {
    const ci = Math.floor(x / COVER_G), cj = Math.floor(z / COVER_G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this._cover.get((ci + i) + ',' + (cj + j));
      if (!c) continue;
      for (let q = 0; q < c.length; q += 2) {
        if ((c[q] - x) ** 2 + (c[q + 1] - z) ** 2 < COVER_R * COVER_R) return true;
      }
    }
    return false;
  }

  /** The lines calling at the stop at (x, z): [{ line, i }] or undefined. */
  callsAt(x, z) { return this._byStop.get(stopKey(x, z)); }

  // ---- the timetable -------------------------------------------------------------

  depart(line, k) { return (line.phase + k) * line.headway; }
  /** Does trip k run? Every departure by day, every other at night. */
  runs(line, k) { return !(isNightService(hourAt(this.depart(line, k))) && (k & 1)); }

  /** The shared second the next real bus is due at the stop at (x, z), at or after t. */
  eta(x, z, t) {
    const at = this._byStop.get(stopKey(x, z));
    if (!at) return Infinity;
    let best = Infinity;
    for (const { line, i } of at) {
      if (i === line.stops.length - 1 || (line.stops[i].f & CALL_EXIT_ONLY)) continue;   // nobody boards here
      const H = line.headway;
      let k = Math.ceil((t - line.N[i]) / H - line.phase);
      for (let n = 0; n < 4; n++, k++) {
        if (!this.runs(line, k)) continue;
        const due = this.depart(line, k) + line.N[i];
        if (due >= t) { if (due < best) best = due; break; }
      }
    }
    return best;
  }

  // ---- the road under a line ---------------------------------------------------

  _near = (x, z) => {
    const out = this._nearOut;
    out.length = 0;
    const grid = this.traffic._egrid.m;
    const ci = Math.floor(x / EGRID), cj = Math.floor(z / EGRID);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = grid.get((ci + i) + ',' + (cj + j));
      if (a) for (let q = 0; q < a.length; q++) out.push(a[q]);
    }
    return out;
  };
  _nearOut = [];

  // nothing is loaded under this point: no use looking for a road there
  _unloaded = (x, z) => {
    const tiles = this.city.manifestTiles, T = this.city.tile;
    if (!tiles || !T) return false;
    const tx = Math.floor(x / T), tz = Math.floor(z / T);
    let t = this._tileAt;
    if (!t || t.tx !== tx || t.tz !== tz) {
      t = null;
      for (const q of tiles) if (q.tx === tx && q.tz === tz) { t = q; break; }
      this._tileAt = t ?? { tx, tz, state: 0 };
      t = this._tileAt;
    }
    return !(t.state >= 2);
  };

  // Lay the line onto the graph as it stands. Done again only when a tile has
  // arrived since and the line was not yet whole.
  _match(line) {
    if (line.gen === this._gen || line.whole) return true;
    if (this._budget <= 0) return line.chains !== null;
    this._budget--;
    if (!line.P) line.P = indexPath(routePath(line._file, line._route).pts);
    line.chains = matchPath(line.P, this._near, this._unloaded);
    line.gen = this._gen;
    const c = line.chains;
    line.whole = c.length === 1 && c[0].a0 <= line.stops[0].d + 0.5 && c[0].a1 >= line.stops[line.stops.length - 1].d - 0.5;
    return true;
  }

  _chainAt(line, d) {
    for (const c of line.chains ?? []) if (d >= c.a0 - 0.5 && d <= c.a1 + 0.5) return c;
    return null;
  }

  // the last call a chain still holds, from call i on
  _lastOn(line, c, i) {
    let j = i;
    while (j + 1 < line.stops.length && line.stops[j + 1].d <= c.a1 + 0.5) j++;
    return j;
  }

  _calls(line, k, arcs, i0, i1, from = i0) {
    const t0 = this.depart(line, k), out = [], n = line.stops.length;
    for (let i = from; i <= i1; i++) {
      const s = line.stops[i], end = i === n - 1;
      out.push({ arc: arcs[i - i0], x: s.x, z: s.z, n: s.n, dwell: DWELL_MIN,
        hold: t0 + line.N[i] + (end ? DWELL_TERMINUS : DWELL) });
    }
    return out;
  }

  _spec(line, k, i0) {
    const c = this._chainAt(line, line.stops[i0].d);
    if (!c) return null;
    const i1 = this._lastOn(line, c, i0);
    if (i1 <= i0) return null;                       // one call is not a trip
    const kind = line.trolley ? 'trolleybus' : 'bus';
    const trip = chainTrip(c, line.stops, i0, i1, TRANSIT_BODY[kind].halt);
    if (!trip) return null;
    const t0 = this.depart(line, k);
    const key = 'bus:' + line.id + ':' + k;
    this._live.set(key, { line, k, i0, i1, n: trip.route.length, gen: line.gen });
    return {
      key, seed: (Math.imul(line.id | 0, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b)) | 0,
      t0: t0 + line.N[i0] - LEAD, tEnd: t0 + line.N[i1] + GRACE, vK: BUS_VK,
      kind, color: BUS_RED,
      route: trip.route, startS: trip.startS, len: trip.len, tag: line, trip: k,
      stops: this._calls(line, k, trip.arcs, i0, i1),
    };
  }

  // A live trip whose road ended short of its terminus: has the graph grown?
  _extend(key, lv) {
    const line = lv.line;
    if (lv.i1 >= line.stops.length - 1 || lv.gen === line.gen) return;
    lv.gen = line.gen;
    const c = this._chainAt(line, line.stops[lv.i0].d);
    if (!c) return;
    const i1 = this._lastOn(line, c, lv.i0);
    if (i1 <= lv.i1) return;
    const trip = chainTrip(c, line.stops, lv.i0, i1, TRANSIT_BODY[line.trolley ? 'trolleybus' : 'bus'].halt);
    if (!trip || trip.route.length < lv.n) return;
    const t0 = this.depart(line, lv.k);
    const ok = this.traffic.extendFixed(key, trip.route.slice(lv.n),
      this._calls(line, lv.k, trip.arcs, lv.i0, i1, lv.i1 + 1), trip.len, t0 + line.N[i1] + GRACE);
    if (ok) { lv.i1 = i1; lv.n = trip.route.length; }
  }

  // ---- per frame -----------------------------------------------------------------

  update(dt, pos) {
    this._t -= dt; this._tf -= dt;
    if (!pos) return;
    if (this._tf <= 0) {
      this._tf = 1;
      const need = this.city.routeFilesNear?.(pos.x, pos.z, FILE_REACH);
      if (need) for (const url of need) if (this.files.get(url) === undefined || this.files.get(url) === 'failed') this._fetch(url);
    }
    if (this._t > 0) return;
    this._t = SCAN_DT;
    this._budget = MATCH_PER_SCAN;
    const wt = this.now(), R2 = REACH * REACH;
    // THE CLOCK WAS STEPPED (a join re-anchors it, js/worldclock.js): every
    // trip on the road belongs to a timetable that is no longer now. They are
    // dropped and the trips of the new hour take their place.
    if (Math.abs(wt - this._wt) > JUMP) for (const key of this._live.keys()) this.traffic.dropFixed(key);
    this._wt = wt;
    for (const [key, lv] of this._live) {
      if (!this.traffic.hasSlot(key)) { this._live.delete(key); continue; }
      if (lv.i1 < lv.line.stops.length - 1 && this._match(lv.line)) this._extend(key, lv);
    }
    for (const line of this.lines) {
      if (!routeNear(line, pos.x, pos.z, REACH)) continue;
      const H = line.headway, st = line.stops, N = line.N;
      const k1 = Math.floor(wt / H - line.phase);
      for (let k = Math.floor((wt - line.dur) / H - line.phase) + 1; k <= k1; k++) {
        if (!this.runs(line, k)) continue;
        const since = wt - this.depart(line, k);
        if (since < -LEAD || since > line.dur) continue;
        const key = 'bus:' + line.id + ':' + k;
        if (this._live.has(key) || this.traffic.hasSlot(key)) continue;
        // the call the trip is at, or has last left
        let i = 0;
        while (i + 1 < st.length && N[i + 1] <= since) i++;
        if (i >= st.length - 1) continue;              // standing at its terminus: nothing left to drive
        const a = st[i], b = st[i + 1];
        if ((a.x - pos.x) ** 2 + (a.z - pos.z) ** 2 > R2 && (b.x - pos.x) ** 2 + (b.z - pos.z) ** 2 > R2) continue;
        if (!this._match(line)) continue;
        const spec = this._spec(line, k, i);
        if (spec) this.traffic.addFixed(spec);
      }
    }
  }
}
