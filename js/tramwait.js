// ---- tramwait.js: people waiting at the tram stops, getting on and off ----------
// The crowd (js/pedestrians.js) already knows how to use a bus: a walker whose
// beat passes a STOP site may stand there for a while, a boarder waits for the
// next bus the timetable has due (peds.busEta), walks to its door when it
// stands there (peds.busAt) and is gone with it; an alighter appears at the
// door of the bus that has just called. Tram stops are not in the tiles as
// pois, so none of that happened at them. This module gives the crowd the same
// three answers for trams and the sites to ask them at:
//
//   SITES  one STOP site per platform of every built line (js/trams.js builds
//          the lines within 1.9 km of the player): on the mapped platform where
//          there is one, else a step to the right of the rail (doors open on
//          the right), never on a carriageway (pushed to the kerb beyond it, as
//          js/crowdsites.js stopSpot does for a bus). Like the bus stops the
//          sites only ever grow: they are plain positions from the route files,
//          the same on every client that has the files.
//   ETA    the shared second the next tram calls at a platform, from the
//          timetable alone (js/tramlines.js): pure, so a walker's day, which is
//          planned from it, is the same on every screen.
//   AT     the tram standing at a platform with its doors open, as a stand-in
//          of the shape the crowd walks a boarder to (x, z, heading, len, wid,
//          speed: its "front door" is one of the tram's real doors, a different
//          one for each boarder in turn). Local, like the late tram it may be.

import { SITE } from './crowdsites.js';
import { pathAtExt, departOf, tripRuns, boards, DWELL, DWELL_FIRST } from './tramlines.js';
import { TRAM_BODY, consistOf } from './trambody.js';
import { doorsOf } from './transitbody.js';

const RIGHT = 2.4;             // m right of the rail where no platform is mapped (js/tramstops.js stands its post there)
const PLATFORM_R = 12;         // m: a mapped platform further from the rail than this is somebody else's
const KERB = 1.1;              // m behind a carriageway's edge a waiting crowd stands
const PUSH_MAX = 12;           // m a spot is pushed off a carriageway at most; beyond that, no site
const DOORS_LEFT = 2;          // s of dwell left below which the doors are closing
const NEAR_R = 260;            // m of rail within which a late tram "is coming" (js/buses.js approaching)
// m: platforms this near the player are put down as sites. The crowd plans a
// walker's day once, for every beat within PHANTOM_R (751 m, js/pedestrians.js)
// of the player, from the sites there at that moment: a platform put down
// later than the beat beside it was planned is missing from that walker's day
// on this screen and not on one that put it down sooner. So every platform a
// plannable beat can pass (TRAM_STOP_R, 24 m, beside it) is down first.
const PLACE_R = 800;

const keyOf = (x, z) => Math.round(x * 2) + ',' + Math.round(z * 2);
const _at = { x: 0, z: 0, dx: 0, dz: 0 };

export class TramWait {
  /** trams (js/trams.js), peds (js/pedestrians.js: its sites and its carriageway index) */
  constructor(trams, peds) {
    this.trams = trams;
    this.peds = peds;
    this.plat = new Map();         // stop key and heading -> { ax, az, hd, x, z, site, calls: [{ id, i }] }
    this._bySite = new Map();      // site key (spot) -> the platform
    this._rr = 0;
    this._placeN = 0;
    const prev = trams.onLine;
    trams.onLine = (line) => { prev?.(line); this.addLine(line); };
    const gone = trams.onGone;
    trams.onGone = (tr) => { gone?.(tr); if (tr._stand) for (const c of tr._stand) c.speed = 99; };   // (a boarder walking to it gives up)
  }

  // ---- the platforms --------------------------------------------------------------

  // Where people wait at platform p: the mapped platform, or a step to the
  // right of the rail, off any carriageway. Null when there is no such place.
  // Everything it reads belongs to the stop node, not to a line (the node's
  // own position, its mapped platform if any line maps one, the heading in to
  // a degree), so whichever line put the platform down, and in whatever order
  // a client built its lines, the place is the same.
  _spot(p) {
    const dx = Math.sin(p.hd), dz = Math.cos(p.hd), rx = -dz, rz = dx;      // right of travel
    let x, z;
    if (Number.isFinite(p.px) && Math.hypot(p.px - p.ax, p.pz - p.az) < PLATFORM_R) { x = p.px; z = p.pz; }
    else { x = p.ax + rx * RIGHT; z = p.az + rz * RIGHT; }
    // never on the asphalt of a street the rail runs along: behind its kerb
    const drive = this.peds.drive;
    for (let n = 0; drive && n < 4; n++) {
      const rd = drive.nearest(x, z, 20);
      if (!rd || rd.d >= rd.hw + KERB - 0.05) break;
      const push = rd.hw + KERB - rd.d;
      x += rx * push; z += rz * push;
      if (Math.hypot(x - p.ax, z - p.az) > PUSH_MAX + RIGHT) return null;
    }
    // facing the rail (to the left of travel), spread along it
    return { x, z, fx: -rx, fz: -rz, ax: dx, az: dz };
  }

  /** A line was built: its platforms are noted, and put down near the player (update). */
  addLine(line) {
    for (let i = 0; i < line.stops.length; i++) {
      const st = line.stops[i];
      // the heading the tram comes in on, to a degree: two directions (or two
      // approaches) at one stop node are two platforms
      pathAtExt(line.P, st.d - 0.5, _at);
      const deg = Math.round(Math.atan2(_at.dx, _at.dz) * 180 / Math.PI);
      const k = keyOf(st.x, st.z) + ':' + deg;
      st.wk = k;
      // (kind 1 and 3 are the stop position on the rail, kind 3 with its
      // platform beside it; kind 2 is the platform alone)
      const px = st.k === 3 ? st.px : st.k === 2 ? st.x : NaN, pz = st.k === 3 ? st.pz : st.z;
      let p = this.plat.get(k);
      if (!p) {
        p = { ax: st.x, az: st.z, hd: deg * Math.PI / 180, px, pz, x: st.x, z: st.z, calls: [], site: null, done: false };
        this.plat.set(k, p);
      }
      // a platform one line maps is the platform of every line calling there
      // (it is put down later, once all the lines round the player are in)
      if (!Number.isFinite(p.px) && Number.isFinite(px)) { p.px = px; p.pz = pz; }
      if (!p.calls.some((c) => c.id === line.id && c.i === i)) p.calls.push({ id: line.id, i });
    }
  }

  // A platform becomes a site once the ground (and the streets round it) under
  // it are loaded and the player is near enough for anybody to walk there:
  // where its crowd stands depends on the carriageways beside it.
  // Not while lines round the player are still being built (js/trams.js
  // pending): eta answers from the lines that call at a platform, and a walker
  // planned against half of them waits for a different tram than the same
  // walker on a screen that had them all.
  _place(pos) {
    if (this.trams.pending > 0) return;
    const loaded = this.trams.loadedAt;
    for (const p of this.plat.values()) {
      if (p.done || (p.ax - pos.x) ** 2 + (p.az - pos.z) ** 2 > PLACE_R * PLACE_R) continue;
      if (loaded && !loaded(p.ax, p.az)) continue;
      p.done = true;
      const spot = this._spot(p);
      if (!spot) continue;
      p.x = spot.x; p.z = spot.z;
      p.site = this.peds.sites?.add(SITE.STOP, spot.x, spot.z, null, { spot, tram: true }) ?? null;
      this._bySite.set(keyOf(spot.x, spot.z), p);
    }
  }

  _platAt(x, z) { return this._bySite.get(keyOf(x, z)) ?? null; }

  // ---- what the crowd asks ------------------------------------------------------------

  /** The shared second the next tram calls at the platform at (x, z) at or after t, or Infinity. */
  eta(x, z, t) {
    const p = this._platAt(x, z);
    if (!p) return Infinity;
    let best = Infinity;
    for (const c of p.calls) {
      const line = this.trams.routes.get(c.id)?.line;
      if (!line || !boards(line, c.i)) continue;
      const Ni = line.N[c.i], H = line.headway;
      const k0 = Math.ceil((t - Ni) / H - line.phase);
      for (let k = k0; k < k0 + 4; k++) {
        if (!tripRuns(line, k)) continue;
        const due = departOf(line, k) + Ni;
        if (due < t) continue;              // (k0 rounded a hair short of t)
        if (due < best) best = due;
        break;
      }
    }
    return best;
  }

  /** The tram standing at the platform at (x, z) with its doors open, as a stand-in, or null. */
  standingAt(x, z) {
    const p = this._platAt(x, z);
    if (!p) return null;
    const wt = this.trams.now();
    for (const tr of this.trams.list) {
      if (!tr.stop || tr.hidden) continue;
      const st = tr.line.stops[tr.i];
      if (!st || this.plat.get(st.wk) !== p) continue;
      const since = wt - departOf(tr.line, tr.k) - tr.delay;
      const left = tr.line.N[tr.i] + (tr.i === 0 ? DWELL_FIRST : DWELL) - since;
      if (left < DOORS_LEFT) continue;
      const stand = this._standIns(tr);
      return stand[(this._rr++) % stand.length];
    }
    return null;
  }

  /** Is a tram whose next call is the platform at (x, z) on its way, within NEAR_R of rail? */
  approaching(x, z) {
    const p = this._platAt(x, z);
    if (!p) return false;
    for (const tr of this.trams.list) {
      const stops = tr.line.stops;
      const j = tr.stop ? tr.i : tr.i + 1;
      const st = stops[j];
      if (!st || this.plat.get(st.wk) !== p) continue;
      const d = st.d - tr.sr;
      if (d > -3 && d < NEAR_R) return true;
    }
    return false;
  }

  // One stand-in per door of the consist, kept up to date while the tram lives
  // (update): what pedestrians.js _boardStep walks to is `len / 2 - front`
  // ahead of the stand-in, so a stand-in whose len is twice its front door sits
  // ON the door.
  _standIns(tr) {
    if (tr._stand) return tr._stand;
    const front = doorsOf(null).front;
    const out = [];
    for (const car of consistOf(tr.kind)) {
      const B = TRAM_BODY[car.body];
      for (const d of B.doors) out.push({ x: 0, z: 0, y: 0, heading: 0, speed: 0, len: front * 2, wid: B.wid, kind: 'bus', tram: true, door: car.off + d });
    }
    tr._stand = out;
    this._poseStand(tr);
    return out;
  }

  _poseStand(tr) {
    for (const c of tr._stand) {
      pathAtExt(tr.line.P, tr.sr - c.door, _at);
      c.x = _at.x; c.z = _at.z;
      c.heading = Math.atan2(-_at.dx, -_at.dz);
      c.speed = tr.v;
    }
  }

  /** Per frame, after the trams moved: the stand-ins handed out follow their trams; now and then new platforms are put down. */
  update(pos) {
    for (const tr of this.trams.list) if (tr._stand) this._poseStand(tr);
    if (pos && --this._placeN <= 0) { this._placeN = 30; this._place(pos); }
  }
}

export const _test = { keyOf };
