// ---- Traffic: AI cars commuting on the real Pardubice street grid ----
// The drivable OSM ways (d=1) become a directed graph ONCE at construction:
// way endpoints plus any point shared between two drivable ways are nodes,
// and ways are split into edges between consecutive nodes. AI cars then just
// walk edges — pick an outgoing edge at each node, hug the right side of the
// road, brake for corners ahead and for the car in front. Visuals come from
// vehicles.add(); we are only the brain, writing x/z/heading/speed and the
// mesh transform directly (no driveStep physics — rail-following is cheaper
// and never wanders off the asphalt).

import { TRAFFIC, CAR_COLORS } from './config.js';
import { bridgeElevation } from './geo.js';

// AI-local tuning (config.js owns the player-facing numbers)
const ACCEL = 4.0;            // gentle m/s² — commuters, not street racers
const BRAKE = 5.0;            // planning decel: the anticipation envelope
const BRAKE_SOFT = 7.0;       // actual decel when above target (catches up)
const BRAKE_HARD = 14.0;      // slam when something fills the stop gap
const TURN_RATE = 7.0;        // heading exponential-smoothing rate (1/s)
const CORNER_LOOK = 16;       // meters of polyline scanned ahead for curves
const LAT_GATE = 2.0;         // half-width of the follow corridor (m) — an
                              // oncoming car in the opposite lane sits wider
const HEAD_GATE = 0.61;       // ±35° same-direction test for AI-AI following
const STRAIGHT = Math.PI / 6; // ±30° reads as "carrying straight on"
const SPAWN_MIN = 60;         // don't pop a car into existence at arm's length
const KINDS = ['sedan', 'sedan', 'hatch', 'hatch', 'van'];

// 10 cm snapping welds shared OSM nodes without gluing near-misses — ways that
// meet at a junction repeat the exact same coordinate, so toFixed(1) is safe.
const keyOf = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);
// normalize any angle (or angle difference) into (-π, π] — branchless and
// immune to accumulated drift, worth the two trig calls at 45 cars
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// v = sqrt(a_lat · R): treat a polyline corner of angle `ang` as an arc taken
// over ~7 m, so R ≈ 7/ang and with a_lat 4.5 → v = sqrt(31.5/ang). A 90° city
// corner comes out ~4.5 m/s, a lane kink barely registers.
const cornerSpeed = (ang) => Math.max(2.2, Math.sqrt(31.5 / Math.max(ang, 0.06)));

// shared scratch — update paths never allocate
const _pose = { x: 0, z: 0, dx: 0, dz: 0, seg: 0 };
const _cand = [], _straight = [];

// point + direction at arc-length s along an edge. `seg` is the caller's
// cached segment index — s only ever grows within an edge, so the while loop
// amortizes to O(1) per frame.
function poseAt(edge, s, seg) {
  const { pts, cum } = edge;
  const last = pts.length - 2;
  while (seg < last && s > cum[seg + 1]) seg++;
  const a = pts[seg], b = pts[seg + 1];
  const L = (cum[seg + 1] - cum[seg]) || 1e-6;
  const t = Math.max(0, Math.min(1, (s - cum[seg]) / L));
  _pose.x = a[0] + (b[0] - a[0]) * t;
  _pose.z = a[1] + (b[1] - a[1]) * t;
  _pose.dx = (b[0] - a[0]) / L;
  _pose.dz = (b[1] - a[1]) / L;
  _pose.seg = seg;
  return _pose;
}

export class Traffic {
  constructor(city, vehicles) {
    this.city = city;
    this.vehicles = vehicles;
    this.cars = new Set();          // public — minimap reads this
    this.edges = [];                // every DIRECTED edge (reverse twins too)
    this._nodes = new Map();        // keyOf(x,z) → { x, z, out: [] }
    this._near = [];                // spawn candidates around the player
    this._nearX = 1e9; this._nearZ = 1e9; this._nearT = 0;
    this._spawnT = 0;
    this._buildGraph(city.roads ?? []);
  }

  // ---- graph construction (once) ----

  _buildGraph(roads) {
    // pass 1 — count DISTINCT drivable ways touching each snapped point. A
    // point can repeat inside one way (loops); comparing the last way ref
    // keeps that from inflating the count.
    const usage = new Map();
    const drivable = [];
    for (const r of roads) {
      if (r.d !== 1 || !r.p || r.p.length < 2) continue;
      drivable.push(r);
      for (const [x, z] of r.p) {
        const k = keyOf(x, z);
        const u = usage.get(k);
        if (!u) usage.set(k, { n: 1, last: r });
        else if (u.last !== r) { u.n++; u.last = r; }
      }
    }
    // pass 2 — split each way at nodes: both ends, plus interior points that
    // another drivable way also uses (that's where junctions live in OSM).
    // startOff tracks meters from the WAY start to the edge start, so bridge
    // ramps can later ask "how far along the whole way am I?"
    for (const r of drivable) {
      const p = r.p;
      let start = 0, startOff = 0, dist = 0;
      for (let i = 1; i < p.length; i++) {
        dist += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if (i === p.length - 1 || usage.get(keyOf(p[i][0], p[i][1])).n >= 2) {
          this._addEdge(r, p.slice(start, i + 1), startOff);
          start = i; startOff = dist;
        }
      }
      if (r._len == null) r._len = dist; // loadCity sets it; tests may not
    }
  }

  _node(x, z) {
    const k = keyOf(x, z);
    let n = this._nodes.get(k);
    if (!n) this._nodes.set(k, n = { x, z, out: [] });
    return n;
  }

  _addEdge(road, pts, off) {
    const n = pts.length;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++)
      cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const len = cum[n - 1];
    if (len < 0.5) return;                       // degenerate/duplicate points
    const speed = (road.v || 30) / 3.6;          // km/h → m/s
    const fwd = this._makeEdge(road, pts, cum, len, speed, off, 1);
    if (!road.ow) {
      // two-way street: a mirrored twin walks it the other way. off0 is the
      // way-offset of THIS direction's start, offSign walks it backwards, so
      // off0 + offSign·s is always true meters-from-way-start (bridge ramps).
      const rpts = pts.slice().reverse();
      const rcum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        rcum[i] = rcum[i - 1] + Math.hypot(rpts[i][0] - rpts[i - 1][0], rpts[i][1] - rpts[i - 1][1]);
      const rev = this._makeEdge(road, rpts, rcum, len, speed, off + len, -1);
      fwd.twin = rev; rev.twin = fwd;
    }
  }

  _makeEdge(road, pts, cum, len, speed, off0, offSign) {
    const n = pts.length;
    // interior turn angles, precomputed so the per-frame curve scan is a read
    const vertAng = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i][0] - pts[i - 1][0], az = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], bz = pts[i + 1][1] - pts[i][1];
      vertAng[i] = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    }
    const Lf = cum[1] || 1, Ll = (cum[n - 1] - cum[n - 2]) || 1;
    const m = pts[n >> 1];
    const e = {
      a: this._node(pts[0][0], pts[0][1]),
      b: this._node(pts[n - 1][0], pts[n - 1][1]),
      pts, cum, len, speed, oneway: !!road.ow, road, off0, offSign,
      fdx: (pts[1][0] - pts[0][0]) / Lf,  fdz: (pts[1][1] - pts[0][1]) / Lf,
      ldx: (pts[n - 1][0] - pts[n - 2][0]) / Ll, ldz: (pts[n - 1][1] - pts[n - 2][1]) / Ll,
      vertAng, mx: m[0], mz: m[1], twin: null,
    };
    e.a.out.push(e);
    this.edges.push(e);
    return e;
  }

  // ---- per-frame ----

  update(dt, playerPos, playerCar) {
    if (!this.edges.length || !playerPos) return;
    const px = playerPos.x, pz = playerPos.z;
    // refresh the spawn-candidate list when the player wanders — a linear
    // scan over all edges, but at 0.5 Hz, never per frame
    this._nearT -= dt;
    if (this._nearT <= 0 || Math.hypot(px - this._nearX, pz - this._nearZ) > 80) {
      this._nearT = 2.0; this._nearX = px; this._nearZ = pz;
      this._near.length = 0;
      const r2 = (TRAFFIC.spawnR - 10) ** 2;
      for (const e of this.edges) {
        const dx = e.mx - px, dz = e.mz - pz;
        if (dx * dx + dz * dz < r2) this._near.push(e);
      }
    }
    // cull cars the player left behind (deleting inside for..of a Set is safe)
    for (const car of this.cars)
      if (Math.hypot(car.x - px, car.z - pz) > TRAFFIC.despawnR) this._remove(car);
    // top up the population in small bursts — fills in a few seconds after
    // boot or a fast drive into fresh streets, without a single-frame spike
    this._spawnT -= dt;
    if (this._spawnT <= 0) {
      this._spawnT = 0.2;
      let tries = 6;
      while (this.cars.size < (this.maxCars ?? TRAFFIC.maxCars) && tries-- > 0) this._trySpawn(px, pz);
    }
    for (const car of this.cars) this._drive(car, dt, playerPos, playerCar);
  }

  _remove(car) {
    this.cars.delete(car);
    this.vehicles.remove(car);
  }

  // main calls this when the player yanks a door open: the car keeps its mesh
  // and state, we just stop driving it.
  steal(car) {
    this.cars.delete(car);
    car.ai = null;
    return car;
  }

  _trySpawn(px, pz) {
    if (!this._near.length) return;
    const e = this._near[(Math.random() * this._near.length) | 0];
    if (e.len < 6) return;                        // stub edges make sad spawns
    const s = 2 + Math.random() * (e.len - 4);
    const pose = poseAt(e, s, 0);
    const d = Math.hypot(pose.x - px, pose.z - pz);
    if (d < SPAWN_MIN || d > TRAFFIC.spawnR) return;
    for (const o of this.cars)                    // don't materialize inside a car
      if (Math.hypot(o.x - pose.x, o.z - pose.z) < 10) return;
    const heading = Math.atan2(-pose.dx, -pose.dz); // dir = (-sin h, -cos h)
    const laneOff = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    const kind = KINDS[(Math.random() * KINDS.length) | 0];
    const color = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
    // right of travel = (-dz, dx): facing north (0,-1) that's east — correct
    // side for right-hand traffic. Offset applied at birth so frame 1 doesn't
    // slide the car sideways into its lane.
    const car = this.vehicles.add(kind,
      pose.x - pose.dz * laneOff, pose.z + pose.dx * laneOff, heading, color);
    car.speed = e.speed * (0.4 + Math.random() * 0.4); // rolling, not parked
    car.ai = { edge: e, s, seg: pose.seg, next: this._pickNext(e), laneOff };
    const y = e.road.br ? bridgeElevation(e.off0 + e.offSign * s, e.road._len) : 0;
    car.mesh.position.set(car.x, y, car.z);
    car.mesh.rotation.y = heading;
    this.cars.add(car);
  }

  // choose the outgoing edge at the far node of `edge`. Oneways are already
  // respected by construction (a oneway never grew a reverse twin). U-turns
  // only when the node is otherwise a dead end.
  _pickNext(edge) {
    _cand.length = 0; _straight.length = 0;
    for (const o of edge.b.out) {
      if (o === edge.twin) continue;
      _cand.push(o);
      const dot = edge.ldx * o.fdx + edge.ldz * o.fdz;
      const crs = edge.ldx * o.fdz - edge.ldz * o.fdx;
      if (Math.abs(Math.atan2(crs, dot)) < STRAIGHT) _straight.push(o);
    }
    if (!_cand.length) return edge.twin ?? null;  // oneway trap → null → despawn
    // city traffic mostly flows through; side streets soak up the remainder
    const pool = (_straight.length && Math.random() < 0.7) ? _straight : _cand;
    return pool[(Math.random() * pool.length) | 0];
  }

  _drive(car, dt, playerPos, playerCar) {
    const ai = car.ai;
    if (!ai) return;                              // stolen mid-frame
    let e = ai.edge;

    // ---- target speed: limit, curves ahead, the junction, the car in front.
    // Curve/turn limits use the braking envelope v² = vc² + 2·b·d, so speed
    // bleeds off smoothly on approach instead of at the apex.
    let tgt = e.speed;
    for (let k = ai.seg + 1; k <= ai.seg + 3 && k < e.pts.length - 1; k++) {
      const d = e.cum[k] - ai.s;
      if (d > CORNER_LOOK) break;
      if (d < 0) continue;
      const a = e.vertAng[k];
      if (a > 0.06) tgt = Math.min(tgt, Math.sqrt(cornerSpeed(a) ** 2 + 2 * BRAKE * d));
    }
    const dEnd = e.len - ai.s;
    if (dEnd < CORNER_LOOK + 10) {
      let ang = Math.PI;                          // dead end → crawl into the U-turn
      if (ai.next) {
        const dot = e.ldx * ai.next.fdx + e.ldz * ai.next.fdz;
        const crs = e.ldx * ai.next.fdz - e.ldz * ai.next.fdx;
        ang = Math.abs(Math.atan2(crs, dot));
      }
      if (ang > 0.06)
        tgt = Math.min(tgt, Math.sqrt(cornerSpeed(ang) ** 2 + 2 * BRAKE * Math.max(dEnd, 0)));
    }

    // ---- follow whatever is ahead in our corridor. AI-AI additionally wants
    // similar heading (±35°) so the opposite lane doesn't gridlock us; the
    // player blocks at ANY orientation — parked across the road IS a wall.
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    let hard = false;
    for (const o of this.cars) {
      if (o === car) continue;
      const rx = o.x - car.x, rz = o.z - car.z;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > TRAFFIC.lookAhead) continue;
      if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
      if (Math.abs(angWrap(o.heading - car.heading)) > HEAD_GATE) continue;
      const gap = fwd - 3.9;                      // center distance → bumpers
      if (gap < TRAFFIC.stopGap) { tgt = 0; hard = true; }
      else tgt = Math.min(tgt, (gap - TRAFFIC.stopGap) / 2); // gap/2s rule
    }
    const ox = playerCar ? playerCar.x : playerPos.x;
    const oz = playerCar ? playerCar.z : playerPos.z;
    const rx = ox - car.x, rz = oz - car.z;
    const fwd = rx * fx + rz * fz;
    if (fwd > 0 && fwd < TRAFFIC.lookAhead && Math.abs(fx * rz - fz * rx) < LAT_GATE) {
      const gap = fwd - (playerCar ? 3.9 : 2.3);  // on foot the player is thin
      if (gap < TRAFFIC.stopGap) { tgt = 0; hard = true; }
      else tgt = Math.min(tgt, (gap - TRAFFIC.stopGap) / 2);
    }

    // ---- integrate speed, advance along the rail
    if (car.speed < tgt) car.speed = Math.min(tgt, car.speed + ACCEL * dt);
    else car.speed = Math.max(tgt, car.speed - (hard ? BRAKE_HARD : BRAKE_SOFT) * dt);
    ai.s += car.speed * dt;
    while (ai.s >= ai.edge.len) {
      const nxt = ai.next;
      if (!nxt) { this._remove(car); return; }    // oneway dead end — vanish
      ai.s -= ai.edge.len;
      ai.edge = nxt;
      ai.seg = 0;
      ai.next = this._pickNext(nxt);
    }
    e = ai.edge;

    // ---- pose: centerline point + smoothed heading + right-lane offset
    const pose = poseAt(e, ai.s, ai.seg);
    ai.seg = pose.seg;
    const targetH = Math.atan2(-pose.dx, -pose.dz);
    // exponential smoothing kills the heading snap at polyline corners and at
    // edge handoffs; wrap keeps the -π/π seam from spinning the car around
    car.heading = angWrap(car.heading + angWrap(targetH - car.heading) * Math.min(1, TURN_RATE * dt));
    // the lane offset rides on the SMOOTHED heading, so through a corner the
    // car sweeps across its lane instead of teleporting at each vertex; the
    // magnitude eases too because road width changes between edges
    const offTgt = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    ai.laneOff += (offTgt - ai.laneOff) * Math.min(1, 3 * dt);
    const hx = -Math.sin(car.heading), hz = -Math.cos(car.heading);
    car.x = pose.x - hz * ai.laneOff;             // right of heading = (-hz, hx)
    car.z = pose.z + hx * ai.laneOff;
    // off0 + offSign·s = meters from the WAY start (not the edge), which is
    // what the shared ramp math wants — decks rise only near the way's ends
    const y = e.road.br ? bridgeElevation(e.off0 + e.offSign * ai.s, e.road._len) : 0;
    car.mesh.position.set(car.x, y, car.z);
    car.mesh.rotation.y = car.heading;
  }
}
