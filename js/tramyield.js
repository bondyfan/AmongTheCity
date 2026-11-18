// ---- tramyield.js: the right of way of a tram ----------------------------------
// A tram does not give way. Its arc is the shared timetable (js/tramlines.js)
// and no AI car may change it, or two co-op screens would disagree. So the
// city gives way to it, and this module tells the city where:
//
//   HULLS     points every HULL_STEP metres along each live tram body near the
//             player, pushed into traffic.blockers (main.js, after it fills the
//             list and before traffic.update, like js/cyclists.js blockInto):
//             a car behind a street-running tram queues behind it, and nobody
//             drives through its side.
//   CROSSINGS where the rail crosses a carriageway of the traffic graph, found
//             once per line from the edges round it (js/traffic.js _egrid),
//             and while a tram is due there (inside its braking distance plus a
//             margin, or on it) a record in traffic.railCross, which the
//             traffic reads with a copy of its walker-yield loop WITHOUT the
//             patience: a driver stands short of the track until it is clear.
//   WALKERS   threatens(): a walker does not step onto a crossing a tram is on
//             or bearing down on (citylife.js wraps peds.roadBusy with it).
//   HOLD      the one thing a tram does for others, and only on this screen:
//             a player's car (or a peer's, traffic.actors) standing on the rail
//             ahead makes it stop short (trams.js renders min(arc, hold)).

import { projectOnPath } from './realines.js';
import { BRAKE, pathAtExt } from './tramlines.js';
import { spacingHold } from './tramspacing.js';
import { sameLevel } from './levelsep.js';
import { deckLevel } from './roadpose.js';
import { LAYER_Y } from './config.js';

const HULL_STEP = 5.5, HULL_HALF = 3.0;
const HULL_R = 420;            // m: no traffic car is further from the player than this
const CROSS_R = 700;           // m: crossings are looked for on the path this close to the player
const CROSS_MARGIN = 28;       // m beyond its braking distance a tram is "due" at a crossing
const CROSS_SEG_PER_SCAN = 220;    // path segments tested per scan (a scan per half second)
const TRACK_CLEAR = 1.7;       // m from the rail centreline a car's nose stays
const HOLD_LOOK = 14;          // m past braking distance a tram looks for a car on its rail
const HOLD_LAT = 2.2;          // m off the rail a car's centre blocks it
const HOLD_LAT_CAR = 1.9;      // …an AI car's (one in the lane beside a street-running tram is 2.5 m off)
const WALK_AHEAD = 40;         // m ahead of a tram a crossing is not walked onto

const PIN_SLACK = 0.5, PIN_V = 0.5;   // m, m/s: a standing car against the nose (see the hold)
const PIN_CLEAR = 2.5;         // m round a pinned car's body that the tram's hull leaves free
const _q = { d: 0, a: 0 }, _pt = { x: 0, z: 0, dx: 0, dz: 0 };

// segment-segment intersection: the parameter along a-b, or -1
function cross2(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

export class TramYield {
  constructor(traffic) {
    this.traffic = traffic;
    this.cross = [];               // the live records (traffic.railCross)
    this._pool = [];
    this._scanT = 0;
    if (traffic) traffic.railCross = this.cross;
  }

  // ---- the crossings of a line -------------------------------------------------------
  // Found segment by segment over the part of the path near the player, a few
  // hundred segments a scan; re-looked when the traffic graph grows (a tile
  // arrived), which the edge count says.
  _crossings(line, pos) {
    const tr = this.traffic, grid = tr?._egrid;
    if (!grid) return;
    const P = line.P, p = P.pts;
    let c = line.cross;
    const nEdges = tr.edges?.length ?? 0;
    if (!c || c.edges !== nEdges) {
      c = line.cross = { edges: nEdges, done: new Uint8Array(Math.max(1, P.n - 1)), list: [], cursor: 0 };
    }
    let budget = CROSS_SEG_PER_SCAN;
    const R2 = CROSS_R * CROSS_R;
    for (let n = 0; n < P.n - 1 && budget > 0; n++) {
      const i = (c.cursor + n) % (P.n - 1);
      if (c.done[i]) continue;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      if ((ax - pos.x) ** 2 + (az - pos.z) ** 2 > R2 && (bx - pos.x) ** 2 + (bz - pos.z) ** 2 > R2) continue;
      budget--;
      c.done[i] = 1;
      const L = P.cum[i + 1] - P.cum[i];
      if (L < 1e-6) continue;
      const seen = new Set();
      const look = (mx, mz) => grid.near(mx, mz, (e) => {
        if (seen.has(e) || !e.pts || !e.road) return;
        seen.add(e);
        const pts = e.pts;
        for (let j = 0; j < pts.length - 1; j++) {
          const t = cross2(ax, az, bx, bz, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
          if (t < 0) continue;
          const ex = pts[j + 1][0] - pts[j][0], ez = pts[j + 1][1] - pts[j][1], el = Math.hypot(ex, ez) || 1;
          const sin = Math.abs(((bx - ax) * ez - (bz - az) * ex) / (L * el));
          if (sin < 0.35) continue;          // running along the street, not across it (the hulls see to that)
          const a = P.cum[i] + t * L, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          // A road that crosses the track on a bridge, or under the tram's
          // own, is not a level crossing: nobody waits there for a tram on
          // another level (js/levelsep.js).
          const yT = this._yAt ? this._yAt(line, a) : NaN;
          if (yT === yT && e.cum) {
            const yR = deckLevel(e.road, (e.off0 ?? 0) + (e.offSign ?? 1) * (e.cum[j] + Math.hypot(x - pts[j][0], z - pts[j][1])), tr.world?.terrain);
            if (yR !== null && !sameLevel(yT, yR + LAYER_Y.road)) continue;
          }
          // one record per road crossing: the two directed edges of a road meet here twice
          if (c.list.some((q) => Math.abs(q.a - a) < 4 && q.road === e.road)) continue;
          c.list.push({ a, x, z, rdx: ex / el, rdz: ez / el, hw: e.road.w / 2, clr: Math.min(6, TRACK_CLEAR / sin), road: e.road });
        }
      });
      // (a long segment crosses many cells: look along it)
      const steps = Math.max(1, Math.ceil(L / 48));
      for (let s = 0; s <= steps; s++) look(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps);
    }
    c.cursor = (c.cursor + 97) % Math.max(1, P.n - 1);
    c.list.sort((u, v) => u.a - v.a);
  }

  _rec() {
    const r = this._pool.pop() ?? { cx: 0, cz: 0, rdx: 0, rdz: 0, hw: 0, clr: 0, must: true, x: 0, z: 0, body: false, stale: false, rail: true };
    this.cross.push(r);
    return r;
  }

  update(trams, dt, pos) {
    this._yAt = trams.yAt;                     // the trams' own level along a line (crossings ask it)
    // the records of the last frame back in the pool
    for (const r of this.cross) this._pool.push(r);
    this.cross.length = 0;
    this._scanT -= dt;
    const scan = this._scanT <= 0;
    if (scan) { this._scanT = 0.5; this._stamp = (this._stamp ?? 0) + 1; }
    const actors = this.traffic?.actors;
    for (const tr of trams.list) {
      const line = tr.line;
      // (once a scan per line, however many of its trams are about)
      if (scan && this.traffic && line._crossStamp !== this._stamp) { line._crossStamp = this._stamp; this._crossings(line, pos); }
      // ---- the hold: a car standing on the rail ahead of this tram (local only)
      tr.hold = Infinity;
      const look = tr.v * tr.v / (2 * BRAKE) + HOLD_LOOK;
      const trY = trams.yAt ? trams.yAt(line, tr.sr) : NaN;
      if (actors) for (const o of actors) {
        if (!Number.isFinite(o?.x)) continue;
        const dx = o.x - tr.x, dz = o.z - tr.z;
        if (dx * dx + dz * dz > (look + 20) ** 2) continue;
        if (!sameLevel(trY, o.y, 30)) continue;       // under the tram's bridge, or on one over the track
        projectOnPath(line.P, o.x, o.z, tr.sr - 1, tr.sr + look, _q);
        if (_q.d > HOLD_LAT) continue;
        const h = _q.a - (o.half ?? 2.3) - 0.8;
        if (h < tr.hold) tr.hold = Math.max(tr.sr, h);
      }
      // …and an AI car on the rail ahead (one queued over the track in the
      // street, one still in a crossing): the tram does not drive through it.
      // Local, like the rest of the hold, and never fed to the shared arc.
      // A car the nose is already against (the hold would be behind where the
      // tram stands) and that stands still is waiting for the TRAM: its hull
      // points are a wall in front of it. Held for, both would wait for ever,
      // so it is PINNED: blockInto leaves this tram's hull points round it out
      // of traffic.blockers until it has driven off the rail (sticky while it
      // pulls away, or the points would come back and stop it again).
      const cars = this.traffic?.cars;
      let pin = null;
      if (cars && !tr.far) for (const o of cars) {
        const dx = o.x - tr.x, dz = o.z - tr.z;
        if (dx * dx + dz * dz > (look + 12) ** 2) continue;
        if (!sameLevel(trY, o.y, 30)) continue;
        projectOnPath(line.P, o.x, o.z, tr.sr - 1, tr.sr + look, _q);
        if (_q.d > HOLD_LAT_CAR) continue;
        const h = _q.a - (o.len ?? 4.6) / 2 - 1.2;
        if (h < tr.hold) tr.hold = Math.max(tr.sr, h);
        if (h <= tr.sr + PIN_SLACK && (o === tr.pin || Math.abs(o.speed ?? 0) < PIN_V)) pin = o;
      }
      tr.pin = pin;
      // ---- the other trams: one on a piece of track at a time (js/tramspacing.js)
      const h = spacingHold(tr, trams.list);
      if (h < tr.hold) tr.hold = h;
      // ---- the crossings it is due at
      const c = line.cross?.list;
      if (!c || !c.length || (tr.x - pos.x) ** 2 + (tr.z - pos.z) ** 2 > HULL_R * HULL_R) continue;
      const ahead = tr.v * tr.v / (2 * BRAKE) + CROSS_MARGIN + (tr.stop ? 0 : 6);
      const back = tr.sr - tr.len - 2;
      for (const q of c) {
        if (q.a < back) continue;
        // (nor past a car it is held behind: that car has to be let go first,
        // or it would wait for this tram and this tram for it)
        if (q.a > tr.sr + ahead || q.a > tr.hold + 2) break;
        const r = this._rec();
        r.cx = r.x = q.x; r.cz = r.z = q.z; r.rdx = q.rdx; r.rdz = q.rdz; r.hw = q.hw; r.clr = q.clr;
      }
    }
  }

  /** Points along every tram body near the player, as traffic.blockers wants them. */
  blockInto(trams, list) {
    if (!list) return;
    const p = this._p ?? (this._p = { x: 0, z: 0, dx: 0, dz: 0 });
    const pool = this._hulls ?? (this._hulls = []);
    let n = 0;
    for (const tr of trams.list) {
      if (tr.hidden || tr.far) continue;
      const P = tr.line.P;
      // (the last point is the tail itself, whatever the step leaves over)
      for (let d = 0; d < tr.len + HULL_STEP; d += HULL_STEP) {
        pathAtExt(P, tr.sr - Math.min(d, tr.len), p);
        const pc = tr.pin;
        if (pc) {
          const r = HULL_HALF + (pc.len ?? 4.6) / 2 + PIN_CLEAR;
          if ((p.x - pc.x) ** 2 + (p.z - pc.z) ** 2 < r * r) continue;
        }
        const b = pool[n] ?? (pool[n] = { x: 0, z: 0, half: HULL_HALF, tram: true, y: NaN });
        n++;
        b.x = p.x; b.z = p.z;
        b.y = trams.yAt ? trams.yAt(tr.line, tr.sr - Math.min(d, tr.len)) : NaN;   // (its level: js/levelsep.js)
        list.push(b);
      }
    }
  }

  /**
   * Is a tram on, or bearing down on, the crossing at (cx, cz) of a road of
   * half width hw? What a walker asks before stepping out.
   */
  threatens(trams, cx, cz, hw) {
    for (const tr of trams.list) {
      const dx = cx - tr.x, dz = cz - tr.z;
      if (dx * dx + dz * dz > (tr.len + WALK_AHEAD + 20) ** 2) continue;
      projectOnPath(tr.line.P, cx, cz, tr.sr - tr.len - 1, tr.sr + (tr.stop ? 4 : WALK_AHEAD), _q);
      if (_q.d < hw + 1.8) return true;
    }
    return false;
  }
}
