// ==========================================================================
// Road law: the limit of the road you are on, and the police who watch it
//
// Frank, 21 Nov 2026: "musi to ukazovat max povolenou rychlost vpravo dole"
// and "kdyz je v blizkosti 50m policie a jedu vic nez 50% rychlosti max
// povolene tak mi to dat 1 hvezdicku. To stejne kdyz jedu na cervenou."
//
// THE LIMIT is the one the AI drivers already obey: every directed edge of the
// traffic graph carries `speed` (m/s), the posted maxspeed from the tile where
// OSM has one and the Czech class default where it does not (traffic.js
// defaultV and _addEdge). So the sign on the HUD and the drivers around you can
// never disagree about a street. Which edge you are on is the nearest one whose
// carriageway you are inside (half its width plus REACH), preferring the one
// pointing the way you face: the two directions of a street are two edges, and
// at a junction the crossing street is just as near but points across you.
//
// "MORE THAN 50 %" is read as more than 50 % OVER the limit: past 75 km/h in a
// 50, past 135 in a 90. The literal reading ("faster than half the limit")
// would make 26 km/h in a 50 a crime, which nobody would believe.
//
// THE WITNESS is the police and nobody else: a patrol car in the traffic, a
// pursuit unit, or an officer on foot within WITNESS_R (50 m). No police, no
// star, the same rule as every other crime here (no star without a witness).
//
// A RED LIGHT is the stop line of a signal that shows red for your approach,
// read from the same controller and the same shared clock the AI drivers stop
// for (traffic.lightOf). Once you are on an approach before its line the edge
// is WATCHED, projected every step, so the line cannot be skipped when the
// nearest edge flips to the crossing street inside a big junction box.
//
// ONE STAR, NO MORE. A traffic offence tops the heat up to STAR_CAP (inside
// the first star's band, js/wanted.js STAR_AT 18..45) and never past it: a
// police unit comes for you and nobody shoots (js/policetune.js: nothing is
// fired below three stars). Speeding past three patrols in a row is still one
// star, kept fresh. Already wanted for worse, it adds nothing.
//
// LOCAL STATE ONLY. Like the whole wanted level, this is about what YOU did on
// your screen: it reads the shared world (edges, lights, patrols) and writes
// only your own heat, so co-op has nothing to agree about.
// ==========================================================================

const LANE_DT = 0.1;          // s between lane lookups; the stop line is watched every step
const REACH = 3;              // m past a carriageway's half width that still counts as on it
const ALIGN = 0.35;           // cos: within about 70° of the lane's own direction
const OVER = 1.5;             // more than 50 % over the limit
const OVER_HOLD = 0.6;        // s it has to last (a bump over a crest is not speeding)
export const WITNESS_R = 50;  // m: police nearer than this saw it
const EYES_DT = 0.25;         // s between police scans while speeding
const RED_V = 2;              // m/s: rolling through, not creeping onto the line
// m past the AI's hold point that counts as through the light. The hold point
// (traffic.js sigStop) is a couple of metres short of the painted line, so a
// player who stops with the bumper on the paint is not charged; 3 m past it
// the car's middle is over the line and its nose in the crossing.
const RED_PAST = 3;
const WATCH_D = 12;           // m off the watched approach that ends the watch
const LAW_CD = 8;             // s between two charges of the same offence
export const STAR_CAP = 30;   // heat a traffic offence tops up to: one star
const LIMIT_HOLD = 0.25;      // s a new limit must last before the sign changes
const LIMIT_KEEP = 3;         // s the sign survives with no road under you

export const OFFENCES = Object.freeze({
  rychlost: Object.freeze({ key: 'rychlost', heat: 26, say: 'Policie tě viděla: překročení rychlosti' }),
  cervena: Object.freeze({ key: 'cervena', heat: 26, say: 'Policie tě viděla: jízda na červenou' }),
});

/** km/h on the sign for an edge of the traffic graph (its `speed` is m/s). */
export function limitKmh(e) {
  const v = e?.speed;
  return v > 0 ? Math.round(v * 3.6) : 0;
}

/** Strictly more than 50 % over the limit. */
export function speeding(kmh, limit) {
  return limit > 0 && kmh > limit * OVER;
}

/** What a traffic offence adds to `heat`: up to STAR_CAP, never more than its own price. */
export function topUp(heat, price, cap = STAR_CAP) {
  const room = cap - (heat > 0 ? heat : 0);
  return room > 0 ? Math.min(price, room) : 0;
}

/**
 * The closest point of edge e's polyline to (x, z): out.d its distance, out.s
 * the arclength there, (out.dx, out.dz) the unit direction of that segment.
 */
export function projectEdge(e, x, z, out) {
  const p = e.pts;
  let best = Infinity, bs = 0, bdx = 0, bdz = 0, run = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], vx = p[i + 1][0] - ax, vz = p[i + 1][1] - az;
    const L2 = vx * vx + vz * vz;
    if (L2 < 1e-9) continue;
    const L = Math.sqrt(L2);
    let t = ((x - ax) * vx + (z - az) * vz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + vx * t - x, ez = az + vz * t - z, d2 = ex * ex + ez * ez;
    if (d2 < best) { best = d2; bs = run + L * t; bdx = vx / L; bdz = vz / L; }
    run += L;
  }
  out.d = Math.sqrt(best); out.s = bs; out.dx = bdx; out.dz = bdz;
  return out;
}

// the edge's bounding box, cached on it (edges never move)
function bb(e) {
  if (e._lawBB) return e._lawBB;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of e.pts) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (e._lawBB = [a, b, c, d]);
}

const _p = { d: 0, s: 0, dx: 0, dz: 0 };
// the visitor's state: module scratch rather than a closure per lookup
const _q = { x: 0, z: 0, fx: 0, fz: 0, best: null, score: Infinity, s: 0, d: 0, aligned: false };
function visit(e) {
  if (!e || !e.pts || e.pts.length < 2) return;
  const q = _q, half = (e.road?.w ?? 6) / 2 + REACH, box = bb(e);
  if (q.x < box[0] - half || q.x > box[2] + half || q.z < box[1] - half || q.z > box[3] + half) return;
  projectEdge(e, q.x, q.z, _p);
  if (_p.d > half) return;
  const aligned = q.fx * _p.dx + q.fz * _p.dz >= ALIGN;
  const sc = _p.d + (aligned ? 0 : 100);
  if (sc < q.score) { q.score = sc; q.best = e; q.s = _p.s; q.d = _p.d; q.aligned = aligned; }
}
/**
 * The lane under (x, z) for a driver facing (fx, fz). `edgesNear(x, z, fn)`
 * calls fn for every candidate edge (traffic.edgesNear). Writes
 * { e, s, d, aligned } into out and returns it, or returns null off every
 * carriageway.
 */
export function nearestLane(edgesNear, x, z, fx, fz, out) {
  const q = _q;
  q.x = x; q.z = z; q.fx = fx; q.fz = fz; q.best = null; q.score = Infinity;
  edgesNear(x, z, visit);
  const best = q.best;
  q.best = null;
  if (!best) return null;
  out.e = best; out.s = q.s; out.d = q.d; out.aligned = q.aligned;
  return out;
}

/** Is a policeman or a police car within r of (x, z)? */
export function policeNear(x, z, r, traffic, police) {
  const r2 = r * r;
  let dx = 0, dz = 0;
  if (traffic?.patrols) for (const c of traffic.patrols) {
    if (!c) continue;
    dx = c.x - x; dz = c.z - z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  const units = police?.units;
  if (units) for (const u of units) {
    if (!u) continue;
    dx = (typeof u.x === 'number' ? u.x : u.car?.x) - x;
    dz = (typeof u.z === 'number' ? u.z : u.car?.z) - z;
    if (dx * dx + dz * dz <= r2) return true;       // (NaN from an unreadable unit fails)
  }
  const out = police?.officers?.out;
  if (out) for (const o of out) {
    if (!o || o.state === 'down') continue;
    dx = o.x - x; dz = o.z - z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

const _lane = { e: null, s: 0, d: 0, aligned: false };

export class RoadLaw {
  /**
   * traffic  js/traffic.js (edgesNear, lightOf, patrols)
   * police   js/police.js (units, officers.out), optional
   * wanted   js/wanted.js's namespace (heat, stars, add)
   * toast    (text, opts) for the one line that says why the star came
   */
  constructor({ traffic = null, police = null, wanted = null, toast = null } = {}) {
    this.traffic = traffic;
    this.police = police;
    this.wanted = wanted;
    this.toast = toast;
    this.limit = 0;           // km/h on the sign, 0 = no sign
    this._t = 0;
    this._laneAt = 0;
    this._laneT = -1e9;       // when we last stood on a road
    this._cand = 0; this._candT = 0;
    this._overT = 0; this._eyesAt = 0;
    this._watch = null;
    this._cd = { rychlost: -1e9, cervena: -1e9 };
    this._near = (x, z, fn) => this.traffic?.edgesNear(x, z, fn);   // made once
  }

  /** One step. `car` is the car you drive, or null on foot, as a passenger, in the air. */
  update(dt, car) {
    const step = dt > 0 ? dt : 0;
    this._t += step;
    if (!car || !this.traffic?.edgesNear) {
      this.limit = 0; this._watch = null; this._overT = 0; this._cand = 0;
      return;
    }
    const fx = -Math.sin(car.heading ?? 0), fz = -Math.cos(car.heading ?? 0);
    if (this._t >= this._laneAt) {
      this._laneAt = this._t + LANE_DT;
      const lane = nearestLane(this._near, car.x, car.z, fx, fz, _lane);
      if (lane) {
        this._laneT = this._t;
        this._sign(limitKmh(lane.e));
        const e = lane.e;
        if (lane.aligned && e.sig && lane.s < e.sigStop && this._watch !== e) this._watch = e;
      } else if (this._t - this._laneT > LIMIT_KEEP) { this.limit = 0; this._cand = 0; }
    }

    // ---- the stop line of a watched approach ----
    const e = this._watch;
    if (e) {
      projectEdge(e, car.x, car.z, _p);
      if (_p.d > WATCH_D) this._watch = null;
      else if (_p.s >= e.sigStop + RED_PAST && car.speed > RED_V && this.traffic.lightOf?.(e) === 2) {
        this._watch = null;
        this._offence('cervena', car);
      }
    }

    // ---- more than 50 % over the limit ----
    const kmh = (car.vGround ?? Math.abs(car.speed ?? 0)) * 3.6;
    if (speeding(kmh, this.limit)) this._overT += step;
    else this._overT = 0;
    if (this._overT >= OVER_HOLD && this._t >= this._eyesAt) {
      this._eyesAt = this._t + EYES_DT;
      this._offence('rychlost', car);
    }
  }

  // the sign changes only once a new limit has lasted LIMIT_HOLD (the first at once)
  _sign(lim) {
    if (lim === this.limit) { this._cand = 0; return; }
    if (this.limit === 0) { this.limit = lim; this._cand = 0; return; }
    if (this._cand !== lim) { this._cand = lim; this._candT = this._t; return; }
    if (this._t - this._candT >= LIMIT_HOLD) { this.limit = lim; this._cand = 0; }
  }

  /** Charge one offence if the police are there to see it. Returns the heat added. */
  _offence(kind, car) {
    if (this._t < this._cd[kind]) return 0;
    if (!policeNear(car.x, car.z, WITNESS_R, this.traffic, this.police)) return 0;
    this._cd[kind] = this._t + LAW_CD;
    const W = this.wanted;
    if (!W) return 0;
    const before = W.stars?.() ?? 0;
    const amt = topUp(W.heat?.() ?? 0, OFFENCES[kind].heat);
    if (amt <= 0) return 0;
    const got = W.add(amt, kind) || 0;
    if (got > 0 && before === 0) this.toast?.(OFFENCES[kind].say, { icon: '🚓', kind: 'warn', ms: 3200 });
    return got;
  }
}
