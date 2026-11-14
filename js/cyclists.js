// ==========================================================================
// Cyclists: Pardubice on two wheels
//
// The game had cycle paths, bike racks and nobody riding. This module puts
// people on bicycles on the cycleways and shared paths, and on the kerb edge
// of quiet streets where that is how the cycle network carries on.
//
// It keeps the two rules the crowd and the traffic keep, for their reasons
// (js/pedestrians.js and js/traffic.js argue them at length):
//
//   1. POPULATION = f(CELL, TIME). The world is diced into the same 256 m
//      squares. A square owes the world riders in proportion to the cycleway
//      it carries. Slot k of square (i, j) is held by generation
//      g = floor((worldT + phase) / TRIP_T), and everything about that rider
//      is hash32(seed, i, j, k, g): who they are, which bicycle, what colour,
//      where the trip starts, every turn it takes (js/cyclenet.js) and the
//      whole timeline of it (js/cycleplan.js). Where they are is a lookup at
//      shared time. No Math.random, no accumulator: two co-op clients compute
//      the same cyclists from the same integers.
//
//   2. NOTHING APPEARS OR DISAPPEARS WHERE THE PLAYER CAN SEE IT. A rider gets
//      a body outside the camera's cone, or far enough off to be a few pixels;
//      a rider whose generation rolls while on screen rides on as a GHOST,
//      this client's alone, and goes when nobody is looking. The slot is
//      retired on time either way, so the shared population never waits on
//      one player's camera.
//
// WHAT IS LOCAL, and bounded: a rider may fall BEHIND the plan (a walker on
// the path, a car across the crossing, the player standing in the way) and
// catches up afterwards; never ahead of it (js/cyclistride.js). Being knocked
// off by a car is local: the rider is handed to the crowd as a free body, so
// the fall, the scream, the ambulance and the police are the crowd's own
// (js/pedestrians.js hurt()), and the slot stays empty until its generation
// rolls.
//
// main.js: build it after the crowd and the traffic, hand it the same viewer
// record they get, and call update() after theirs:
//
//   cyclists = new Cyclists(scene, city, world.footing, { peds, traffic, parked, playerCar, walker });
//   cyclists.blockInto(traffic.blockers);      // each frame, before traffic.update()
//   cyclists.setViewer(view); cyclists.update(dt, focus);   // …and after peds.update()
//
// The modules: cyclenet.js (which ways, which turns), cycleplan.js with
// cyclesurvey.js and cycletime.js (the line, its crossings, its timeline),
// cyclistmint.js (a schedule, and a body for it), cyclistride.js (one rider,
// one frame), cyclistsense.js (what they slow and steer for), cyclistknock.js
// (cars), bikemodel.js with bikeparts.js and bikefleet.js (the machines).
// ==========================================================================

import { worldT } from './worldclock.js';
import { hourAt, isWeekend, crowdK } from './dayrhythm.js';
import { hash32, rnd01, RoadIndex } from './crowdsites.js';
import { nightKOf } from './sky.js';
import { CycleNet } from './cyclenet.js';
import { planAt, planPose } from './cycleplan.js';
import { BikeFleet } from './bikefleet.js';
import { rideStep } from './cyclistride.js';
import { senseStep } from './cyclistsense.js';
import { hitStep, wreckStep } from './cyclistknock.js';
import { mintRide, mountRider, regraph, TRIP_T, V_MAX } from './cyclistmint.js';

const PCELL = 256;                 // the crowd's and the traffic's dice
const PCELL_HALF_DIAG = 181.02;
const MPW = 110;                   // m of cycleway per rider with the slider and the hour at full
const SLOT_MAX = 8;                // per square
const ATTACH_R = 215, DETACH_R = 290;
const NOTICE_R = 150, BLIND_R = 110, PERIPHERAL_R = 40;
const VIEW_MARGIN = 0.42, VIEW_COS_MIN = -0.9;
const HIDE_FOG_K = 0.88, HIDE_R_DFLT = 558, HIDE_R_MIN = 120, HIDE_R_MAX = 900;
const PHANTOM_R = ATTACH_R + V_MAX * TRIP_T + PCELL_HALF_DIAG;
const SWEEP_DT = 0.25;
const BIRTH_BUDGET = 3;            // plans built per sweep (about a third of a millisecond each)
const BODY_MAX = 9;                // bodies at the reference density (the medium preset's slider is 1.75 of it)
const BODY_CAP = 16;               // …and never more than this: a rider costs what a walker costs, one skinned mesh
const REF_MAX = 34;                // the crowd slider's reference value (js/pedestrians.js MAX_PEDS)
const GHOST_MAX = 90;              // s a watched ghost is given before it is taken anyway
const SKIP_MAX = 4, CLOSING = 55;   // s, and m/s: see _sweep
const SENSE_DT = 0.125;            // s between a rider's looks at what is ahead

const dist = (x, z) => Math.sqrt(x * x + z * z);
const _P = { x: 0, z: 0, dx: 0, dz: 0, curv: 0, leg: 0 };
const _N = { arc: 0, v: 0 };
const _hint = { k: 0, s: 0 };

function cmpWay(a, b) { return (a.wid - b.wid) || (a.mx - b.mx) || (a.mz - b.mz); }

export class Cyclists {
  /**
   * opt, each field optional:
   *   peds       the crowd: its road and site indexes are reused, riders slow
   *              for its walkers, and somebody knocked off a bike becomes one
   *              of its bodies
   *   traffic    lights (walkWait), gaps (threatens) and the cars themselves
   *   playerCar  () => the car the player is driving, or null
   *   walker     () => where the player stands when on foot ({ x, z }), or null
   *   parked     main.js's list of standing cars: a rider stops behind one left across a path
   */
  constructor(scene, city, ground = null, opt = {}) {
    this.scene = scene;
    this.city = city;
    this.ground = ground;
    this.peds = opt.peds ?? null;
    this.traffic = opt.traffic ?? null;
    this.playerCar = opt.playerCar ?? (() => null);
    this.parked = opt.parked ?? null;
    this.walker = opt.walker ?? null;   // () => where the player stands when on foot, or null
    this.net = new CycleNet();
    // the carriageways and the zebras: the crowd's own indexes where there is a crowd
    this.drive = this.peds?.drive ?? new RoadIndex();
    this._ownDrive = !this.peds?.drive;
    this._drv = new WeakSet();      // carriageways already in our own index (nothing is hung on the features)
    this.sites = this.peds?.sites ?? null;
    this.riders = [];               // LIVE bodies, on their schedule or ghosts
    this.wrecks = [];               // bicycles lying where their rider was knocked off
    this._cells = new Map();        // "ci,cj" -> { ci, cj, ways, len, sorted }
    this._pool = new Map();         // "ci,cj/k" -> schedule, with or without a body
    this._order = null;             // the squares, sorted (see _scanCells)
    this._dud = new Map();          // "ci,cj/k" -> shared second until which that slot has nothing to ride
    this._sweepT = 0;
    this._senseN = 0;
    this._densK = 1;
    this._dayK = 1;
    this.max = REF_MAX;             // main.js: the crowd slider
    this.rhythm = true;             // false: ignore the hour (tests)
    this.enabled = true;
    this.view = null;
    this.clock = null;              // test seam: () => shared seconds
    this.fleet = new BikeFleet(scene);
    this.lane = [];                 // riders in a traffic lane this frame: { x, z, half }
    this._night = 0;
    this.stats = { born: 0, attached: 0, knocked: 0, late: 0 };
    this._ingest(city.roads);
    // (…and a trip routed before these roads were there is minted again: js/cyclistmint.js regraph)
    city.onTileLoaded?.((t) => { this._ingest(t.roads); this._dud.clear(); regraph(this._pool, t.roads); });
    city.onTileReleased?.((t) => this.releaseTile(t));
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---------------------------------------------------------------- graph ----

  _ingest(roads) {
    if (!roads) return;
    if (this._ownDrive) for (const r of roads) if (r.d && r.p && r.p.length > 1 && !this._drv.has(r)) { this._drv.add(r); this.drive.add(r); }
    for (const w of this.net.add(roads)) {
      const ci = Math.floor(w.mx / PCELL), cj = Math.floor(w.mz / PCELL), key = ci + ',' + cj;
      let c = this._cells.get(key);
      if (!c) { this._cells.set(key, c = { ci, cj, ways: [], len: 0, sorted: null, keys: null }); this._order = null; }
      c.ways.push(w); c.sorted = null;
    }
  }

  // How many riders a square owes the world: the same on every client with the
  // same slider at the same shared hour (both quantised, like the crowd's).
  _slots(c) {
    const k = Math.round(this._densK * this._dayK * 32) / 32;
    if (k <= 0) return 0;
    if (!c.sorted) this._sort(c);
    const f = c.len * k / MPW;
    if (f >= SLOT_MAX) return SLOT_MAX;
    const n = Math.floor(f);
    return n + (rnd01(hash32(c.ci, c.cj, 0xb1ce)) < f - n ? 1 : 0);
  }

  // ----------------------------------------------------------- population ----

  // A square's ways in an order that is a fact about the map, and their
  // length ADDED UP IN THAT ORDER: a sum of floats depends on the order of its
  // terms, and added up as the tiles arrived, two clients got lengths that
  // differed in the last bit. Where that bit decided between seven slots and
  // eight, one of them had a rider the other did not.
  _sort(c) {
    c.sorted = c.ways.slice().sort(cmpWay);
    let len = 0;
    for (const w of c.sorted) len += w.len;
    c.len = len;
  }

  // Mint one rider's whole trip from hash32(cell, slot, generation) (js/cyclistmint.js).
  _birth(sk, c, k, wt) {
    if (!c.sorted) this._sort(c);
    const ways = c.sorted;
    if (!ways.length) return;
    const s = mintRide(this, sk, c, k, wt, ways);
    if (!s) return;
    this._pool.set(sk, s);
    this.stats.born++;
  }

  _signalWait = (x, z, rdx, rdz, t, crossT) => this.traffic.walkWait(x, z, rdx, rdz, t, crossT);

  _scanCells(wt, fx, fz) {
    const ci0 = Math.floor((fx - PHANTOM_R) / PCELL), ci1 = Math.floor((fx + PHANTOM_R) / PCELL);
    const cj0 = Math.floor((fz - PHANTOM_R) / PCELL), cj1 = Math.floor((fz + PHANTOM_R) / PCELL);
    let budget = BIRTH_BUDGET;
    // In an order that is a fact about the map, not about which tile came
    // first. When the hour steps the density, a tenth of the squares in reach
    // gain a slot at once and the sweep's few births take seconds to fill
    // them: in arrival order two clients filled different ones first.
    const order = (this._order ??= [...this._cells.values()].sort((a, b) => (a.ci - b.ci) || (a.cj - b.cj)));
    for (const c of order) {
      if (c.ci < ci0 || c.ci > ci1 || c.cj < cj0 || c.cj > cj1) continue;
      const cd = dist((c.ci + 0.5) * PCELL - fx, (c.cj + 0.5) * PCELL - fz) - PCELL_HALF_DIAG;
      if (cd > PHANTOM_R - PCELL_HALF_DIAG) continue;
      const slots = this._slots(c);
      for (let k = 0; k < slots; k++) {
        // (the slot's name, made once: this loop runs four times a second over every square in reach)
        const sk = (c.keys ??= [])[k] ??= c.ci + ',' + c.cj + '/' + k;
        if (this._pool.has(sk)) continue;
        // (asked BEFORE the budget is spent: a slot that has nothing to ride
        // this generation used one of the sweep's three births every sweep,
        // and three such slots at the head of the list starved every other)
        const dud = this._dud.get(sk);
        if (dud !== undefined && wt < dud) continue;
        if (budget-- <= 0) return;
        this._birth(sk, c, k, wt);
      }
    }
  }

  /** Where schedule s is at shared second wt: fills _P (and returns it), or null once the ride is over. */
  _where(s, wt, hint) {
    planAt(s.plan, wt, hint, _N);
    return planPose(s.plan, _N.arc, hint, _P);
  }

  // ------------------------------------------------------------ visibility ----

  /** The camera, in the shape js/traffic.js and js/pedestrians.js take it. */
  setViewer(v) {
    if (!v) { this.view = null; return; }
    let x = v.x, z = v.z, dx = v.dirX, dz = v.dirZ, fov = v.fovRad, aspect = v.aspect, y = v.y ?? 0;
    const cam = v.camera;
    if (cam) {
      x = cam.position?.x ?? x; z = cam.position?.z ?? z; y = cam.position?.y ?? y;
      const e = cam.matrixWorld?.elements;
      if (e) { dx = -e[8]; dz = -e[10]; }       // the camera looks down its own -z
      if (Number.isFinite(cam.fov)) fov = cam.fov * Math.PI / 180;
      if (Number.isFinite(cam.aspect)) aspect = cam.aspect;
    }
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(dl > 1e-6)) { this.view = null; return; }
    if (!Number.isFinite(fov) || fov <= 0) fov = 1.05;
    if (!Number.isFinite(aspect) || aspect <= 0) aspect = 16 / 9;
    const half = Math.atan(Math.tan(Math.min(fov, 3.0) / 2) * aspect) + VIEW_MARGIN;
    const hide = Math.max(HIDE_R_MIN, Math.min(HIDE_R_MAX,
      Number.isFinite(v.hideR) ? v.hideR : Number.isFinite(v.fogFar) ? v.fogFar * HIDE_FOG_K : HIDE_R_DFLT));
    const o = (this.view ??= { x: 0, y: 0, z: 0, dx: 0, dz: 0, cos: 0, hideR: 0 });
    o.x = x; o.y = y; o.z = z; o.dx = dx / dl; o.dz = dz / dl;
    o.cos = Math.max(VIEW_COS_MIN, Math.cos(half)); o.hideR = hide;
  }

  // Would the player fail to notice something happening here?
  _hidden(x, z, px, pz) {
    const v = this.view;
    if (!v) return dist(x - px, z - pz) > BLIND_R;
    const dx = x - v.x, dz = z - v.z, d = dist(dx, dz);
    if (d >= v.hideR || d >= NOTICE_R) return true;
    if (d <= PERIPHERAL_R) return false;
    return (dx * v.dx + dz * v.dz) / d < v.cos;
  }

  // ----------------------------------------------------------------- loop ----

  update(dt, focus) {
    if (!this.enabled) { if (this.riders.length || this.wrecks.length) this.clear(); return; }
    const wt = this.now(), fx = focus.x, fz = focus.z;
    this._sweepT -= dt;
    if (this._sweepT <= 0) {
      const since = SWEEP_DT - this._sweepT;
      this._sweepT = SWEEP_DT;
      const raw = (this.max ?? REF_MAX) / REF_MAX;
      this._densK = Math.max(0, Math.min(4, Math.round(raw * 8) / 8));
      this._dayK = this.rhythm ? crowdK(hourAt(wt), isWeekend(wt)) : 1;
      this._night = nightKOf(hourAt(wt) / 24);
      // (retire before minting, as the crowd does: a slot whose generation
      // rolled is refilled in the same tick)
      this._sweep(wt, fx, fz, since);
      this._scanCells(wt, fx, fz);
    }
    this.lane.length = 0;
    const v = this.view, cx = v ? v.x : fx, cz = v ? v.z : fz;
    this.fleet.begin(this._night);
    const pc = this.playerCar(), foot = this.walker ? this.walker() : null;
    // one rider in every SENSE_DT / dt looks ahead each frame, in turn
    const riders = this.riders, n = riders.length;
    const per = Math.max(1, Math.round(SENSE_DT / Math.max(dt, 1e-3)));
    this._senseN++;
    for (let i = n - 1; i >= 0; i--) {
      const r = riders[i];
      if ((i + this._senseN) % per === 0) senseStep(this, r, pc, foot);
      rideStep(this, r, dt, wt, cx, cz);
      if (hitStep(this, r, pc, (i + this._senseN) % per === 0)) riders.splice(i, 1);
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) wreckStep(this, this.wrecks[i], dt, cx, cz);
    this.fleet.end();
  }

  /** Put this frame's riders that are in a traffic lane into the traffic's blocker list. */
  blockInto(list) {
    if (list) for (let i = 0; i < this.lane.length; i++) list.push(this.lane[i]);
  }

  // Bodies and slots, four times a second, and never where it shows.
  _sweep(wt, fx, fz, since) {
    const cap = Math.min(BODY_CAP, Math.round(BODY_MAX * Math.min(2, this._densK) * (0.35 + 0.65 * this._dayK)) + 2);
    // ghosts first: no slot, so they go the moment nobody can see them go
    for (let i = this.riders.length - 1; i >= 0; i--) {
      const r = this.riders[i];
      if (!r.ghost) continue;
      r.ghostT += since;
      if (r.ghostT > GHOST_MAX || this._hidden(r.x, r.z, fx, fz)) this._drop(i);
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      if (w.t > w.life + 2 || (w.t > 20 && this._hidden(w.x, w.z, fx, fz))) this.wrecks.splice(i, 1);
    }
    let alive = 0;
    for (const r of this.riders) if (!r.ghost) alive++;
    for (const s of this._pool.values()) {
      const gen = Math.floor((wt + s.ph) / TRIP_T);
      const cd = dist((s.ci + 0.5) * PCELL - fx, (s.cj + 0.5) * PCELL - fz) - PCELL_HALF_DIAG;
      const stale = gen !== s.gen || cd > PHANTOM_R || s.regraph === 1 || s.k >= this._slots(s.cell);
      // a ride that ran out of map before its generation did: the slot stays
      // (and stays empty) until the generation rolls, or it would be minted
      // again four times a second
      const over = wt > s.plan.tEnd;
      const b = s.body;
      if (b) {
        const hidden = this._hidden(b.x, b.z, fx, fz);
        if (stale || over) {
          // the slot goes back to the world now; the body only if nobody is looking
          if (stale) this._pool.delete(s.key);
          if (hidden) this._drop(this.riders.indexOf(b)); else { b.ghost = true; b.ghostT = 0; }
          s.body = null;
          alive--;
        } else if (hidden && dist(b.x - fx, b.z - fz) > DETACH_R) {
          this._drop(this.riders.indexOf(b));
          alive--;
        }
        continue;
      }
      if (stale) { this._pool.delete(s.key); continue; }
      if (over || s.held || alive >= cap || wt < s.skip) continue;
      const p = this._where(s, wt, s.hint);
      const d = dist(p.x - fx, p.z - fz);
      if (d > ATTACH_R) {
        // Too far to matter yet, and for a while: nobody closes a gap faster
        // than a rider and a car together. Most schedules are a kilometre off,
        // and asking each of them where it is four times a second was most of
        // the sweep.
        s.skip = wt + Math.min(SKIP_MAX, (d - ATTACH_R) / CLOSING);
        continue;
      }
      if (!this._hidden(p.x, p.z, fx, fz)) continue;       // not in front of you, ever
      if (this._crowded(p.x, p.z)) continue;               // not on top of somebody (two riders at one red light)
      this._attach(s, wt);
      alive++;
    }
  }

  _crowded(x, z) {
    for (const r of this.riders) { const dx = r.x - x, dz = r.z - z; if (dx * dx + dz * dz < 2.6) return true; }
    return false;
  }

  // Give a schedule a body: a citizen on the bicycle its seed says (js/cyclistmint.js).
  _attach(s, wt) {
    const r = mountRider(this, s, wt);
    s.body = r;
    this.riders.push(r);
    this.stats.attached++;
    return r;
  }

  _drop(i) {
    if (i < 0) return;
    const r = this.riders[i];
    if (r.s && r.s.body === r) r.s.body = null;
    r.c.dispose();
    this.riders.splice(i, 1);
  }

  /** Take every body away (the slider at zero, a hard reset). The schedules stay. */
  clear() {
    for (let i = this.riders.length - 1; i >= 0; i--) this._drop(i);
    this.wrecks.length = 0;
    this.lane.length = 0;
    this.fleet.begin(0); this.fleet.end();
  }

  dispose() {
    this.clear();
    this.fleet.dispose();
  }

  // A far tile geo.js deep-evicted (RELEASE_GRAPHS): its ways leave the net,
  // the squares and, without a crowd, our own carriageway index. Every rider
  // and schedule is within PHANTOM_R of a viewer, far from them; one routed
  // across that tile still holds its plan, and the sweep retires it.
  releaseTile(t) {
    const roads = t?.roads;
    if (!roads?.length) return;
    const gone = new Set(this.net.remove(roads));
    if (this._ownDrive) {
      const drv = [];
      for (const r of roads) if (this._drv.has(r)) { this._drv.delete(r); drv.push(r); }
      if (drv.length) this.drive.remove?.(drv);
    }
    if (!gone.size) return;
    const keys = new Set();
    for (const w of gone) keys.add(Math.floor(w.mx / PCELL) + ',' + Math.floor(w.mz / PCELL));
    for (const k of keys) {
      const c = this._cells.get(k);
      if (!c) continue;
      const n0 = c.ways.length;
      c.ways = c.ways.filter((w) => !gone.has(w));
      if (c.ways.length === n0) continue;
      c.sorted = null;
      if (!c.ways.length) { this._cells.delete(k); this._order = null; }
    }
    this._dud.clear();
  }

  // ------------------------------------------------------------ snapshot ----

  /** What this client believes is riding near (x, z): one row per slot, sorted, for two clients to compare. */
  snapshot(x, z, r = ATTACH_R) {
    const wt = this.now(), out = [];
    for (const s of this._pool.values()) {
      if (wt < s.t0 || wt > s.plan.tEnd) continue;
      _hint.k = 0; _hint.s = 0;
      planAt(s.plan, wt, _hint, _N);
      const p = planPose(s.plan, _N.arc, _hint, _P);
      if (dist(p.x - x, p.z - z) > r) continue;
      out.push({ key: s.key, seed: s.seed, gen: s.gen, type: s.type, paint: s.paint, arch: s.arch,
        arc: _N.arc, v: _N.v, x: p.x, z: p.z, len: s.plan.len, body: !!s.body });
    }
    out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return out;
  }
}

export const _tuning = { TRIP_T, ATTACH_R, DETACH_R, NOTICE_R, MPW, PCELL };
