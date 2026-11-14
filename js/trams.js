// ---- trams.js: the Prague trams running round the player --------------------------
// js/realtransit.js fetches the route files and hands every tram route to
// addRoute (its onTramRoute hook). Each is built into a LINE (js/tramlines.js)
// only while the player is near it and forgotten when they are far, so a far
// line holds no memory and nothing here pins tile data: the registry is the
// route records by relation id, the lines are rebuilt from them on demand.
//
// WHAT IS SHARED. Trip k of a line is the tram 'tram:<id>:<k>', its nose at
// tramlines.arcAt(line, now - departure): the same arc on every co-op client
// whatever files they loaded first, because there is nothing else in it.
// Nothing local feeds back into that arc. The one local thing is a HOLD: a
// tram whose way is blocked by a player's car stands short of it on this
// screen (rendered arc = min(shared arc, hold)) and catches up at no more
// than CATCH_UP over its timetable pace once the rail is free.
//
// What the rest of the city sees (js/tramyield.js): the hulls, as points the
// traffic brakes for, and the crossings a tram is about to take, which cars
// stop short of and walkers will not step onto.

import { routeNear, MODE_TRAM } from './tiledata.js';
import { buildTramLine, arcAt, departOf, tripRuns, tripRange, kindOf, inTunnel, pathAtExt } from './tramlines.js';
import { consistLen, consistOf, TRAM_BODY } from './trambody.js';
import { hourAt, isNightService } from './dayrhythm.js';
import { TramYield } from './tramyield.js';

const REACH = 1500;            // m: a trip whose nose is this close to the player runs
const BUILD_REACH = 1900;      // m: a line whose box is this close is built
const FORGET = 3200;           // m: a line whose box is this far is forgotten
const DRAW = 1100;             // m: trams further than this are not drawn
const SCAN_DT = 0.5;
const BUILDS_PER_SCAN = 6;
const Y_STEP = 4;              // m between samples of a line's rail height
const Y_RETRY = 6;             // s before a height sampled over an unloaded chunk is asked again
const CATCH_UP = 2;            // m/s over the timetable a held tram may make up
const JUMP = 45;               // s between two scans that can only be a stepped clock
const OFF_DUTY_R = 260;        // m: a night tram this close at dawn stays until it is further

// Prague's network (the PID relations, operated by DPP): Olomouc's trams are in
// the route files too but wear another livery and are not drawn here
const isPrague = (r) => /Pražsk/.test(r.nw ?? '') || /Prahy/.test(r.op ?? '');

export class Trams {
  /**
   * { scene, draw (a TramDraw, or null headless), groundY(x, z), loadedAt(x, z),
   *   traffic, clock () => shared second, nightK () => 0..1 }
   */
  constructor({ draw = null, groundY = null, loadedAt = null, traffic = null, clock, nightK = null }) {
    this.draw = draw;
    this.groundY = groundY;
    this.loadedAt = loadedAt;
    this.clock = clock;
    this.nightK = nightK;
    this.routes = new Map();        // relation id -> { file, route, line }
    this.live = new Map();          // 'tram:id:k' -> tram
    this.list = [];                 // the live trams, for whoever reads (window.trams)
    this.enabled = true;
    this.ms = 0;                    // last frame's cost
    this._t = 0;
    this._wt = NaN;
    this._seen = 0;
    this._at = { s: 0, v: 0, i: 0, stop: false };
    this._p = { x: 0, z: 0, dx: 0, dz: 0 };
    this.yield = new TramYield(traffic);
  }

  now() { return this.clock(); }

  /** A tram route from a route file (realtransit's onTramRoute). Once per id is enough; more is harmless. */
  addRoute(file, route) {
    if (route?.m !== MODE_TRAM || !isPrague(route) || this.routes.has(route.id)) return;
    if (!route.s || route.s.length < 2) return;
    // Keep only the legs and stops this route reads (tiledata routePath and
    // routeStops index them), never the route file itself: a released file
    // must be free to go, and the line is rebuilt from these alone.
    const view = { legs: [], stops: [] };
    for (const ref of route.p ?? []) if (ref) view.legs[Math.abs(ref) - 1] = file.legs[Math.abs(ref) - 1];
    for (const i of route.s) view.stops[i] = file.stops[i];
    this.routes.set(route.id, { file: view, route, line: null });
  }

  // ---- the rail under a line ------------------------------------------------------
  // Heights are sampled every Y_STEP metres of the line's path the first time a
  // tram needs them, from the same surface the walkers stand on (the tram panel
  // is LAYER_Y.road + 0.03 over the street deck, js/city.js heightAt), and kept.
  yAt = (line, a) => {
    const g = line.g;
    if (a < 0) a = 0; else if (a > line.P.L) a = line.P.L;
    const u = a / Y_STEP, i = Math.floor(u), f = u - i;
    const y0 = this._sample(line, g, i), y1 = f > 1e-4 ? this._sample(line, g, i + 1) : y0;
    return y0 + (y1 - y0) * f;
  };

  _sample(line, g, i) {
    if (i >= g.y.length) i = g.y.length - 1;
    const t = g.t[i];
    if (t >= 0 && (t === Infinity || this._wtNow - t < Y_RETRY)) return g.y[i];
    pathAtExt(line.P, i * Y_STEP, this._p);
    const x = this._p.x, z = this._p.z;
    const y = this.groundY ? this.groundY(x, z) : 0;
    g.y[i] = Number.isFinite(y) ? y : 0;
    g.t[i] = !this.loadedAt || this.loadedAt(x, z) ? Infinity : this._wtNow;
    return g.y[i];
  }

  _build(e) {
    const line = buildTramLine(e.file, e.route);
    if (!line) { e.line = false; return; }
    const n = Math.ceil(line.P.L / Y_STEP) + 2;
    line.g = { y: new Float32Array(n), t: new Float64Array(n).fill(-1) };   // (t holds shared seconds: 2.7e7 is beyond a float32)
    e.line = line;
  }

  // ---- the scan: which trips are near ----------------------------------------------
  _scan(pos, wt) {
    let builds = BUILDS_PER_SCAN;
    const seen = ++this._seen, R2 = REACH * REACH;
    for (const e of this.routes.values()) {
      const r = e.route;
      if (e.line && !routeNear(r, pos.x, pos.z, FORGET)) { e.line = null; continue; }
      if (e.line === null && builds > 0 && routeNear(r, pos.x, pos.z, BUILD_REACH)) { builds--; this._build(e); }
      const line = e.line;
      if (!line || !routeNear(r, pos.x, pos.z, REACH)) continue;
      const [k0, k1] = tripRange(line, wt);
      // A night line is in service only while the night lasts. Its trips run
      // far longer than the game's 330 s night, so by day they are not shown,
      // except one already in sight, which runs on until it is out of it.
      const offDuty = line.night && !isNightService(hourAt(wt));
      for (let k = k0; k <= k1; k++) {
        if (!tripRuns(line, k)) continue;
        const a = arcAt(line, wt - departOf(line, k), this._at);
        if (!a) continue;
        pathAtExt(line.P, a.s, this._p);
        const d2 = (this._p.x - pos.x) ** 2 + (this._p.z - pos.z) ** 2;
        if (d2 > R2) continue;
        const key = 'tram:' + line.id + ':' + k;
        let tr = this.live.get(key);
        if (offDuty && (!tr || d2 > OFF_DUTY_R * OFF_DUTY_R)) continue;
        if (!tr) {
          const kind = kindOf(line, k);
          tr = { key, line, k, kind, len: consistLen(kind), ref: line.ref, s: a.s, sr: a.s, v: 0, stop: true,
            x: this._p.x, z: this._p.z, hx: this._p.dx, hz: this._p.dz, hold: Infinity, pin: null, seen };
          this.live.set(key, tr);
        }
        tr.seen = seen;
      }
    }
    for (const [key, tr] of this.live) {
      // a line that was forgotten takes its trams with it
      if (tr.seen !== seen || !this.routes.get(tr.line.id)?.line) this.live.delete(key);
    }
  }

  // ---- per frame ---------------------------------------------------------------------

  update(dt, pos, t01) {
    if (!pos) return;
    // the dev switch (window.trams.enabled = false): no trams at all, nothing
    // drawn and nothing for the traffic to give way to
    if (!this.enabled) {
      this.list.length = 0;
      this.draw?.begin(); this.draw?.end(0);
      this.yield.update(this, dt, pos);
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const wt = this.now();
    this._wtNow = wt;
    // a stepped clock (a co-op join): the trams of the old hour are not now
    if (Math.abs(wt - this._wt) > JUMP) { this.live.clear(); this._t = 0; }
    // (the shared seconds since the last frame, not the frame's dt: a slow
    // frame's dt is clamped and the timetable is not)
    const dwt = Math.max(0, Math.min(JUMP, wt - this._wt || 0));
    this._wt = wt;
    this._t -= dt;
    if (this._t <= 0) { this._t = SCAN_DT; this._scan(pos, wt); }
    const list = this.list;
    list.length = 0;
    const draw = this.draw;
    draw?.begin();
    const D2 = DRAW * DRAW;
    for (const [key, tr] of this.live) {
      const line = tr.line;
      const a = arcAt(line, wt - departOf(line, tr.k), this._at);
      if (!a) { this.live.delete(key); continue; }
      // the shared arc, and the local one: held short of a car on the rail,
      // never ahead of the timetable, catching up gently once free
      // (the shared arc's own progress since the last frame, plus the
      // catch-up allowance: an unheld tram is exactly on its timetable)
      const lim = Math.min(a.s, tr.hold);
      let sr = tr.sr;
      if (lim < sr || !(Math.abs(a.s - sr) < 60)) sr = lim;           // (a reset, or a hold in front)
      else sr = Math.min(lim, sr + Math.max(0, a.s - tr.s) + CATCH_UP * dwt);
      tr.sr = sr; tr.s = a.s; tr.v = sr < a.s - 0.05 ? Math.min(a.v, CATCH_UP) : a.v; tr.stop = a.stop; tr.i = a.i;
      pathAtExt(line.P, sr, this._p);
      tr.x = this._p.x; tr.z = this._p.z; tr.hx = this._p.dx; tr.hz = this._p.dz;
      tr.hidden = inTunnel(line, sr - tr.len / 2);
      // (beyond the traffic's reach a hull stops nobody, and is not pushed)
      tr.far = (tr.x - pos.x) ** 2 + (tr.z - pos.z) ** 2 > 450 * 450;
      list.push(tr);
      if (!draw || tr.hidden) continue;
      if ((tr.x - pos.x) ** 2 + (tr.z - pos.z) ** 2 > D2) continue;
      draw.pose(line, tr.kind, sr, this.yAt, draw.signs.rowOf(line));
    }
    draw?.end(this.nightK ? this.nightK(t01) : 0);
    this.yield.update(this, dt, pos);
    if (typeof performance !== 'undefined') this.ms = performance.now() - t0;
  }

  /** Is a tram on, or about to be on, the crossing at (cx, cz)? (walkers, js/citylife.js) */
  threatens(cx, cz, hw) { return this.yield.threatens(this, cx, cz, hw); }

  /** Hull points along every live tram, for the traffic to brake for (main.js, before traffic.update). */
  blockInto(list) { this.yield.blockInto(this, list); }

  /**
   * The sections of the trams near (x, z) as stand-ins of the shape
   * js/vehicles.js carCarPass collides the player's car with (main.js
   * _crashList): a section is a long heavy body, so a car that hits a tram
   * bounces off it and is dented. The stand-ins are rewritten every call, so
   * whatever the collision does to one never moves a tram.
   */
  crashInto(out, x, z) {
    const pool = this._crash ?? (this._crash = []);
    let n = 0;
    for (const tr of this.list) {
      if (tr.hidden || (tr.x - x) ** 2 + (tr.z - z) ** 2 > (tr.len + 30) ** 2) continue;
      for (const car of consistOf(tr.kind)) {
        const B = TRAM_BODY[car.body];
        for (const sec of B.sections) {
          pathAtExt(tr.line.P, tr.sr - car.off - B.bogies[sec.b0], this._p);
          const ax = this._p.x, az = this._p.z;
          pathAtExt(tr.line.P, tr.sr - car.off - B.bogies[sec.b1], this._p);
          const L = Math.hypot(ax - this._p.x, az - this._p.z) || 1;
          const ux = (ax - this._p.x) / L, uz = (az - this._p.z) / L;     // forward along the section
          const mx = (ax + this._p.x) / 2, mz = (az + this._p.z) / 2;
          const b0 = B.bogies[sec.b0], b1 = B.bogies[sec.b1], mid = (b0 + b1) / 2;
          // a car-length piece at a time: the two-disc body of carCarPass and
          // world.collide leaves a gap in the middle of anything longer
          const len = sec.z1 - sec.z0, k = Math.ceil(len / 4.4), pl = len / k;
          for (let q = 0; q < k; q++) {
            const along = sec.z0 + pl * (q + 0.5) - mid;      // metres back from the bogies' middle
            const o = pool[n] ?? (pool[n] = { x: 0, z: 0, y: 0, heading: 0, speed: 0, len: 0, wid: 0, kind: 'bus', tram: true, damage: 0, _rammedT: 0 });
            n++;
            o.x = mx - ux * along; o.z = mz - uz * along;
            o.heading = Math.atan2(-ux, -uz);
            o.speed = tr.sr < tr.s - 0.05 ? 0 : tr.v;
            o.len = pl; o.wid = B.wid;
            o.y = this.yAt(tr.line, tr.sr);
            out.push(o);
          }
        }
      }
    }
  }

  /** Live trams, for checks: [{ key, ref, s, kind, x, z }]. */
  snapshot() { return this.list.map((t) => ({ key: t.key, ref: t.ref, s: t.s, sr: t.sr, kind: t.kind, x: t.x, z: t.z, stop: t.stop })); }
}

export const _test = { REACH, Y_STEP };
