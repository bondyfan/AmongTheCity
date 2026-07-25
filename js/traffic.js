// ---- Traffic: AI cars commuting on the real Pardubice street grid (v3) ----
// The drivable OSM ways (d=1) become a directed graph: way endpoints plus any
// point shared between two drivable ways are nodes, and ways are split into
// edges between consecutive nodes. AI cars then just walk edges — pick an
// outgoing edge at each node, hug the right side of the road, brake for
// corners ahead, for red lights and for the car in front. Visuals come from
// vehicles.add(); we are only the brain, writing x/z/heading/speed and the
// mesh transform directly (no driveStep physics — rail-following is cheaper
// and never wanders off the asphalt).
//
// v3: the graph GROWS — city.onTileLoaded streams 4.8 km region tiles in and
// addTile() ingests their roads/signals incrementally (node keys are rounded
// coordinates, so a way clipped at a tile border reconnects to its other half
// simply by hashing to the same node). Traffic LIGHTS cluster the OSM
// highway=traffic_signals points into 2-phase junction controllers with real
// pole meshes, and cars the player rams (vehicles.js sets _rammedT) go limp,
// slide out on friction, then re-snap onto their rail and drive on.

import * as THREE from 'three';
import { TRAFFIC, CAR_COLORS } from './config.js';
import { bridgeElevation, distPointToSegment } from './geo.js';
import { CAR_KINDS } from './vehicles.js';

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
const SPAWN_R = 460;          // v3 contract widens the ring past config's 400 —
                              // config.js is not ours to edit, so the override lives here
const RAM_FRICTION = 4.0;     // m/s² a rammed (AI-suspended) car scrubs while sliding out
const FAST_EDGE = 50 / 3.6;   // commercial traffic only bothers with ≥50 km/h roads

// kind pools as indices into vehicles' CAR_KINDS = [sedan,hatch,kombi,suv,van,truck,bus]:
// everyday metal dominates everywhere; vans/trucks/buses exist but ONLY roll on fast
// edges — a bus threading a 30 km/h residential loop looks wrong and corners terribly
const COMMON = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3];
const BIG = [4, 4, 5, 6];
const BIG_CHANCE = 0.22;      // roughly every 5th spawn on a main road is commercial

// ---- traffic-light tuning ----
const SIG_CLUSTER = 30;       // signal points within 30 m share one junction controller
const SIG_EDGE_R = 30;        // edges ENDING this close to a junction center are governed
const SIG_MIN_EDGE = 14;      // shorter edges live INSIDE the junction box (dual-carriageway
                              // stubs) — governing them would stop cars mid-crossing
const SIG_GREEN = 11, SIG_AMBER = 1.5;
const SIG_CYCLE = 2 * (SIG_GREEN + SIG_AMBER);  // 25 s: green+amber per phase, alternating
const SIG_STOP = 5;           // cars hold this many meters short of the junction node
const SIG_VIS2 = 800 * 800;   // pole meshes render within 800 m of the player (frustum
                              // culling handles the rest; a region's worth of poles never
                              // all draw at once)

// 10 cm snapping welds shared OSM nodes without gluing near-misses — ways that
// meet at a junction repeat the exact same coordinate, so toFixed(1) is safe.
// This is ALSO what stitches tiles: build-region clips ways at tile borders,
// and both halves carry the border point, so they hash to the same node.
const keyOf = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);
// normalize any angle (or angle difference) into (-π, π] — branchless and
// immune to accumulated drift, worth the two trig calls at 120 cars
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// v = sqrt(a_lat · R): treat a polyline corner of angle `ang` as an arc taken
// over ~7 m, so R ≈ 7/ang and with a_lat 4.5 → v = sqrt(31.5/ang). A 90° city
// corner comes out ~4.5 m/s, a lane kink barely registers.
const cornerSpeed = (ang) => Math.max(2.2, Math.sqrt(31.5 / Math.max(ang, 0.06)));
// cheap deterministic 0..1 hash from junction coords — desynchronizes light
// cycles across the city so it doesn't blink like a Christmas tree in lockstep
const hash01 = (x, z) => { const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return h - Math.floor(h); };

// shared scratch — update paths never allocate
const _pose = { x: 0, z: 0, dx: 0, dz: 0, seg: 0 };
const _cand = [], _straight = [];
const _snap = { x: 0, z: 0, t: 0 };

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

// ---- shared traffic-light assets (built lazily — headless tests never touch THREE) ----
// One geometry + material set for EVERY pole in the region; a light "changes"
// by swapping the material reference on its three lamp meshes, nothing else.
let _S = null;
function sigAssets() {
  if (_S) return _S;
  const pole = new THREE.CylinderGeometry(0.055, 0.09, 3.6, 6);
  pole.translate(0, 1.8, 0);                       // base at ground, per the group origin
  const head = new THREE.BoxGeometry(0.26, 0.66, 0.18);
  head.translate(0, 3.08, 0);                      // 3-lamp housing near the pole top
  const lamp = new THREE.BoxGeometry(0.13, 0.13, 0.06);
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  // lit lamps are overbright like the car lights (×2.2) so bloom bites at night
  const lit = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e, emissiveIntensity: 2.2 });
  _S = {
    pole, head, lamp,
    poleMat: mat(0x2e3134), headMat: mat(0x1f2224),
    redOff: mat(0x371313), ambOff: mat(0x38290f), grnOff: mat(0x11301a),
    redOn: lit(0xff3524, 0xff2418), ambOn: lit(0xffb02e, 0xffa018), grnOn: lit(0x3dff6a, 0x22ff55),
  };
  return _S;
}

export class Traffic {
  constructor(city, vehicles) {
    this.city = city;
    this.vehicles = vehicles;
    this.cars = new Set();          // public — minimap reads this
    this.edges = [];                // every DIRECTED edge (reverse twins too)
    this._nodes = new Map();        // keyOf(x,z) → { x, z, out: [] }
    this._usage = new Map();        // keyOf → {n, last}: PERSISTENT so later tiles
                                    // can still detect junctions against earlier ways
    this._junctions = [];           // traffic-light controllers (grow with tiles)
    this._near = [];                // spawn candidates around the player
    this._nearX = 1e9; this._nearZ = 1e9; this._nearT = 0;
    this._spawnT = 0;
    this._t = 0;                    // the shared signal clock (junction offsets desync it)
    // ingest whatever is already loaded (legacy whole-city file, or region tiles
    // that landed before we were constructed), then subscribe for the rest —
    // optional chaining because bare test fixtures pass {roads:[…]} without it
    this.addTile({ roads: city.roads ?? [], signals: city.signals ?? [] });
    city.onTileLoaded?.((t) => this.addTile(t));
  }

  // ---- incremental ingestion: roads → graph edges, signals → junctions ----

  // One region tile (or the initial city payload). Node keys are shared-map
  // rounded coordinates, so edges from THIS tile weld onto nodes older tiles
  // created at the border — no explicit stitching pass needed. New edges then
  // look for a governing junction and new junctions claim pre-existing edges.
  addTile({ roads, signals }) {
    const e0 = this.edges.length;
    this._growGraph(roads ?? []);
    const grown = this._growSignals(signals ?? []);
    // bind: every NEW edge scans all junctions; every new/updated junction
    // scans the OLD edges (new ones were just covered). _tryBind keeps the
    // nearest junction, so double visits are harmless. Cost is (edges ×
    // junctions) flat math per tile load — one-time, never per frame.
    for (let i = e0; i < this.edges.length; i++)
      for (const jn of this._junctions) this._tryBind(this.edges[i], jn);
    if (grown)
      for (const jn of grown)
        for (let i = 0; i < e0; i++) this._tryBind(this.edges[i], jn);
    this._nearT = 0;                // fresh streets join the spawn pool right away
  }

  _growGraph(roads) {
    // pass 1 — count DISTINCT drivable ways touching each snapped point, into
    // the PERSISTENT usage map (a T-junction whose main road came in an earlier
    // tile still reads n≥2 when the side street arrives). A point can repeat
    // inside one way (loops); comparing the last way ref keeps that from
    // inflating the count. _tg stamps guard against double ingestion if the
    // constructor's snapshot and a tile callback ever overlap.
    const drivable = [];
    for (const r of roads) {
      if (r.d !== 1 || !r.p || r.p.length < 2 || r._tg) continue;
      r._tg = 1;
      drivable.push(r);
      for (const [x, z] of r.p) {
        const k = keyOf(x, z);
        const u = this._usage.get(k);
        if (!u) this._usage.set(k, { n: 1, last: r });
        else if (u.last !== r) { u.n++; u.last = r; }
      }
    }
    // pass 2 — split each way at nodes: both ends, plus interior points that
    // another drivable way also uses (that's where junctions live in OSM).
    // startOff tracks meters from the WAY start to the edge start, so bridge
    // ramps can later ask "how far along the whole way am I?"
    // Known incremental blind spot, accepted: if a LATER tile's way crosses an
    // ALREADY-BUILT edge mid-polyline, that old edge is not retro-split (cars
    // on it drive past the new junction; cars arriving on the new way can only
    // continue along it). Cross-tile connections are overwhelmingly clipped
    // way ENDPOINTS — which are always nodes — so this stays a non-issue in
    // practice and spares us remapping the `s` of every car on a split edge.
    for (const r of drivable) {
      const p = r.p;
      let start = 0, startOff = 0, dist = 0;
      for (let i = 1; i < p.length; i++) {
        dist += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if (i === p.length - 1 || this._usage.get(keyOf(p[i][0], p[i][1])).n >= 2) {
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
      // traffic-light governance, bound later: the junction at our far node,
      // its distance (nearest wins), our phase bucket, and where to hold
      sig: null, sigD: 1e9, sigPh: 0, sigStop: 0,
    };
    e.a.out.push(e);
    this.edges.push(e);
    return e;
  }

  // ---- traffic lights: clustering, poles, per-frame phase machine ----

  // Fold a batch of [x,z] signal points into junction controllers. Points
  // within SIG_CLUSTER of an existing controller JOIN it (its center is the
  // running centroid — a big crossing's four poles pull the center into the
  // middle of the box); anything else founds a new controller with a hashed
  // phase offset. Returns the set of touched junctions (or null) so addTile
  // can re-run edge binding for them.
  _growSignals(list) {
    let grown = null;
    for (const pt of list) {
      const x = pt[0], z = pt[1];
      let jn = null, bd = SIG_CLUSTER;
      for (const j of this._junctions) {
        const d = Math.hypot(j.x - x, j.z - z);
        if (d < bd) { bd = d; jn = j; }
      }
      if (!jn) {
        jn = { x, z, n: 0, off: hash01(x, z) * SIG_CYCLE, st0: -1, st1: -1,
          sigs: [], group: new THREE.Group() };
        this.vehicles.scene?.add(jn.group);
        this._junctions.push(jn);
      }
      // duplicate guard — a re-delivered tile must not sprout twin poles
      let dup = false;
      for (const s of jn.sigs) if (Math.hypot(s.x - x, s.z - z) < 1) { dup = true; break; }
      if (dup) continue;
      jn.x = (jn.x * jn.n + x) / (jn.n + 1);
      jn.z = (jn.z * jn.n + z) / (jn.n + 1);
      jn.n++;
      jn.sigs.push(this._makePole(x, z, jn.group));
      jn.st0 = jn.st1 = -1;         // force a lamp refresh — new poles start unlit
      (grown ??= new Set()).add(jn);
    }
    return grown;
  }

  // Build one pole at a signal point: find the nearest drivable edge, stand
  // the pole on the RIGHT curb of that approach, face the lamps back down the
  // road at oncoming drivers, and derive the phase bucket from the road's
  // bearing (N-S-ish roads go on phase 0, E-W-ish on phase 1 — the classic
  // 2-phase crossing). One-time cost per signal; meshes freeze their matrices
  // because nothing about a pole ever moves again.
  _makePole(x, z, group) {
    const A = sigAssets();
    let best = null, bestD = 25, bestS = 0;
    for (const e of this.edges) {
      // manhattan gate: manhattan ≥ euclid, and any polyline point sits within
      // e.len of the middle vertex, so past e.len·1.42+36 the nearest point
      // cannot beat the 25 m cap — prunes the region to a handful of edges
      if (Math.abs(e.mx - x) + Math.abs(e.mz - z) > e.len * 1.42 + 36) continue;
      const p = e.pts;
      for (let i = 0; i < p.length - 1; i++) {
        const d = distPointToSegment(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], _snap);
        if (d < bestD) { bestD = d; best = e; bestS = e.cum[i] + _snap.t * (e.cum[i + 1] - e.cum[i]); }
      }
    }
    let px = x, pz = z, dx = 0, dz = -1;         // orphan fallback: face north in place
    if (best) {
      // of the two directions sharing this asphalt, pick the one whose END is
      // closer — signals stand at the stop line just before their junction,
      // so the approach with the junction ahead is the one this pole serves
      if (best.twin && bestS < best.len - bestS) { bestS = best.len - bestS; best = best.twin; }
      const pose = poseAt(best, bestS, 0);
      dx = pose.dx; dz = pose.dz;
      const w2 = (best.road.w || 6) * 0.5 + 0.7; // right curb: half width + shoulder
      px = pose.x - dz * w2;                     // right of travel = (-dz, dx)
      pz = pose.z + dx * w2;
    }
    const g = new THREE.Group();
    g.position.set(px, 0, pz);
    // lamps are authored on the head's −z face; forward of a mesh yawed by h
    // is (−sin h, −cos h), and we want that pointing AGAINST travel (at the
    // drivers rolling up), so sin h = dx, cos h = dz
    g.rotation.y = Math.atan2(dx, dz);
    const lamps = [];
    g.add(new THREE.Mesh(A.pole, A.poleMat), new THREE.Mesh(A.head, A.headMat));
    for (let i = 0; i < 3; i++) {                // red / amber / green, top down
      const L = new THREE.Mesh(A.lamp, i === 0 ? A.redOff : i === 1 ? A.ambOff : A.grnOff);
      L.position.set(0, 3.3 - i * 0.22, -0.10);  // poking through the head's front face
      g.add(L);
      lamps.push(L);
    }
    // hundreds of static poles: freeze every matrix once, render for free after
    for (const c of g.children) { c.updateMatrix(); c.matrixAutoUpdate = false; }
    g.updateMatrix(); g.matrixAutoUpdate = false;
    group.add(g);
    return { x, z, b: Math.abs(dz) >= Math.abs(dx) ? 0 : 1, lamps };
  }

  // govern edge `e` by junction `jn` if e ENDS at it and no closer junction
  // claimed it yet. The phase bucket comes from the edge's FINAL bearing (the
  // approach direction into the box), the hold point sits SIG_STOP short of
  // the node so stopped cars don't block the crossing itself.
  _tryBind(e, jn) {
    if (e.len < SIG_MIN_EDGE) return;
    const d = Math.hypot(jn.x - e.b.x, jn.z - e.b.z);
    if (d >= SIG_EDGE_R || d >= e.sigD) return;
    e.sig = jn; e.sigD = d;
    e.sigPh = Math.abs(e.ldz) >= Math.abs(e.ldx) ? 0 : 1;
    e.sigStop = Math.max(1, e.len - SIG_STOP);
  }

  // phase state for one bucket of a junction: 0 green, 1 amber, 2 red. The
  // whole city shares one clock (this._t); each junction's hashed offset
  // staggers it, and bucket 1 simply lives half a cycle out of phase — which
  // guarantees the two directions are NEVER green together (red covers the
  // other side's green AND amber).
  _phase(jn, bucket) {
    let t = (this._t + jn.off) % SIG_CYCLE;
    if (bucket) t = (t + SIG_CYCLE / 2) % SIG_CYCLE;
    return t < SIG_GREEN ? 0 : t < SIG_GREEN + SIG_AMBER ? 1 : 2;
  }

  // advance lamp visuals — pure arithmetic per junction per frame, material
  // swaps only on the ~11 s state flips, and only on ≤3 meshes per pole
  _tickSignals() {
    for (const jn of this._junctions) {
      const s0 = this._phase(jn, 0), s1 = this._phase(jn, 1);
      if (s0 === jn.st0 && s1 === jn.st1) continue;
      jn.st0 = s0; jn.st1 = s1;
      for (const sg of jn.sigs) {
        const st = sg.b ? s1 : s0;
        sg.lamps[0].material = st === 2 ? _S.redOn : _S.redOff;
        sg.lamps[1].material = st === 1 ? _S.ambOn : _S.ambOff;
        sg.lamps[2].material = st === 0 ? _S.grnOn : _S.grnOff;
      }
    }
  }

  // ---- per-frame ----

  update(dt, playerPos, playerCar) {
    if (!this.edges.length || !playerPos) return;
    this._t += dt;
    if (this._junctions.length) this._tickSignals();
    const px = playerPos.x, pz = playerPos.z;
    // refresh the spawn-candidate list when the player wanders — a linear
    // scan over all edges, but at 0.5 Hz, never per frame. Piggy-back the
    // junction visibility cull: distant pole meshes stop rendering entirely.
    this._nearT -= dt;
    if (this._nearT <= 0 || Math.hypot(px - this._nearX, pz - this._nearZ) > 80) {
      this._nearT = 2.0; this._nearX = px; this._nearZ = pz;
      this._near.length = 0;
      const r2 = (SPAWN_R - 10) ** 2;
      for (const e of this.edges) {
        const dx = e.mx - px, dz = e.mz - pz;
        if (dx * dx + dz * dz < r2) this._near.push(e);
      }
      for (const jn of this._junctions) {
        const dx = jn.x - px, dz = jn.z - pz;
        jn.group.visible = dx * dx + dz * dz < SIG_VIS2;
      }
    }
    // cull cars the player left behind (deleting inside for..of a Set is safe)
    for (const car of this.cars)
      if (Math.hypot(car.x - px, car.z - pz) > TRAFFIC.despawnR) this._remove(car);
    // settings may shrink the budget mid-game (120 → 30 → 0): bleed the excess
    // off farthest-first, two per frame, so the thinning happens off-screen
    // instead of as a visible mass despawn
    const max = this.maxCars ?? TRAFFIC.maxCars;
    for (let k = 0; k < 2 && this.cars.size > max; k++) {
      let worst = null, wd = -1;
      for (const c of this.cars) {
        const d = (c.x - px) ** 2 + (c.z - pz) ** 2;
        if (d > wd) { wd = d; worst = c; }
      }
      if (!worst) break;
      this._remove(worst);
    }
    // top up the population in small bursts — fills in a few seconds after
    // boot or a fast drive into fresh streets, without a single-frame spike
    this._spawnT -= dt;
    if (this._spawnT <= 0) {
      this._spawnT = 0.2;
      let tries = 6;
      while (this.cars.size < max && tries-- > 0) this._trySpawn(px, pz);
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
    if (d < SPAWN_MIN || d > SPAWN_R) return;
    for (const o of this.cars)                    // don't materialize inside a car
      if (Math.hypot(o.x - pose.x, o.z - pose.z) < 10) return;
    const heading = Math.atan2(-pose.dx, -pose.dz); // dir = (-sin h, -cos h)
    const laneOff = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    // vans/trucks/buses stay on the arterials — the FAST_EDGE gate keys off the
    // edge's speed limit, which is the cheapest "is this a real road" signal
    const pool = (e.speed >= FAST_EDGE && Math.random() < BIG_CHANCE) ? BIG : COMMON;
    const kind = CAR_KINDS[pool[(Math.random() * pool.length) | 0]];
    const color = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
    // right of travel = (-dz, dx): facing north (0,-1) that's east — correct
    // side for right-hand traffic. Offset applied at birth so frame 1 doesn't
    // slide the car sideways into its lane.
    const car = this.vehicles.add(kind,
      pose.x - pose.dz * laneOff, pose.z + pose.dx * laneOff, heading, color);
    car.speed = e.speed * (0.4 + Math.random() * 0.4); // rolling, not parked
    car.ai = { edge: e, s, seg: pose.seg, next: this._pickNext(e), laneOff };
    const y = e.road.br ? bridgeElevation(e.off0 + e.offSign * s, e.road._len) : 0;
    car.y = y;
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

  // A rammed car (vehicles.js stamped _rammedT on impact) is momentum, not
  // brain: the collision impulse already rewrote its speed and yawed it, so we
  // just let it slide along wherever it now points, scrubbing RAM_FRICTION of
  // speed per second, until the timer runs out — then snap back to the rail.
  _rammedStep(car, dt) {
    car._rammedT -= dt;
    const s = car.speed;
    car.speed = s > 0 ? Math.max(0, s - RAM_FRICTION * dt) : Math.min(0, s + RAM_FRICTION * dt);
    car.x += -Math.sin(car.heading) * car.speed * dt;
    car.z += -Math.cos(car.heading) * car.speed * dt;
    car.mesh.position.set(car.x, car.y, car.z);
    car.mesh.rotation.y = car.heading;
    if (car._rammedT > 0) return;
    // recovery: nearest point of the car's OWN edge — the shove rarely moves a
    // car more than a lane over, so its old rail is the right one. ai.s jumps
    // to the snap point; the normal pose write next frame eases position (lane
    // offset) and heading (TURN_RATE smoothing) back, which reads as the
    // driver collecting themselves and pulling away — no teleport pop.
    const e = car.ai.edge, p = e.pts;
    let bestD = 1e9, bestS = car.ai.s, bestSeg = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const d = distPointToSegment(car.x, car.z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], _snap);
      if (d < bestD) { bestD = d; bestSeg = i; bestS = e.cum[i] + _snap.t * (e.cum[i + 1] - e.cum[i]); }
    }
    car.ai.s = bestS;
    car.ai.seg = bestSeg;
    car.speed = Math.max(0, car.speed);           // rails only run forward
  }

  _drive(car, dt, playerPos, playerCar) {
    const ai = car.ai;
    if (!ai) return;                              // stolen mid-frame
    if (car._rammedT > 0) { this._rammedStep(car, dt); return; } // AI suspended
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

    // ---- traffic light on this edge: red or amber → the same braking-envelope
    // shape as corners aims v at 0 on the hold line, a linear term makes the
    // last meters a crawl instead of an exponential never-quite-stop. A car
    // already PAST the hold line (gap < 0) is committed and clears the box —
    // which also means a green→amber flip at speed gets run exactly like a
    // real driver in the dilemma zone would. Green just erases the constraint
    // and ACCEL pulls the queue away.
    if (e.sig && this._phase(e.sig, e.sigPh) > 0) {
      const gap = e.sigStop - ai.s;
      if (gap >= 0)
        tgt = gap < 0.6 ? 0 : Math.min(tgt, Math.sqrt(2 * BRAKE * gap), gap * 0.9);
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
    // what the shared ramp math wants — decks rise only near the way's ends.
    // car.y is kept in sync so vehicles.update() writing position from it
    // agrees with us regardless of update order in main.
    const y = e.road.br ? bridgeElevation(e.off0 + e.offSign * ai.s, e.road._len) : 0;
    car.y = y;
    car.mesh.position.set(car.x, y, car.z);
    car.mesh.rotation.y = car.heading;
  }
}
