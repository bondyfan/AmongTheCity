// ---- Pedestrians: the city gets people ----
// A city without people reads as a model railway, so citizens walk the REAL
// footways: every non-drivable way in the data (footway, path, pedestrian,
// steps, cycleway) is a lane they stroll along, keeping to one side the way
// people do. They spawn just out of view around the player, hop between
// connected paths at junctions, and despawn once left behind — the same
// streaming logic the traffic uses, only slower and on the pavement.
//
// Cost discipline: each citizen is a dozen small boxes, so the population is
// capped and the walk graph is built lazily per streamed tile, never scanned
// whole. Frame work is pure scalar math on the live list.

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE } from './config.js';

const SPAWN_R = 110;       // meters — pedestrians appear this far out
const DESPAWN_R = 190;     // …and are recycled past here
const MAX_PEDS = 34;       // population cap (each is ~12 small meshes)
const SIDE = 0.9;          // how far off the path centerline they walk
const JOIN_R = 7;          // path ends within this distance connect
const SPEED = [1.15, 1.55];// m/s — a stroll to a brisk walk

// walkable classes: everything the data marks as not drivable
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'living_street']);

export class Pedestrians {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.peds = [];
    this.paths = [];               // usable polylines, grown as tiles stream
    this._seen = new Set();        // road _id already ingested
    this._t = 0;                   // spawn throttle
    this._near = []; this._nearAt = null; // local path shortlist + where it was built
    this.max = MAX_PEDS;
    this._ingest(city.roads);
    city.onTileLoaded?.((t) => this._ingest(t.roads));
  }

  // keep only paths long enough to walk and cheap enough to sample
  _ingest(roads) {
    for (const r of roads ?? []) {
      if (r.d || !FOOT.has(r.t) || r.p.length < 2) continue;
      if (this._seen.has(r._id)) continue;
      this._seen.add(r._id);
      if ((r._len ?? 0) < 12) continue;   // driveway stubs aren't worth a walker
      this.paths.push(r);
    }
  }

  update(dt, focus) {
    // --- spawn/despawn bookkeeping a few times a second, not every frame ---
    this._t -= dt;
    if (this._t <= 0) {
      this._t = 0.4;
      for (let i = this.peds.length - 1; i >= 0; i--) {
        const p = this.peds[i];
        if (Math.hypot(p.x - focus.x, p.z - focus.z) > DESPAWN_R) this._remove(i);
      }
      let tries = 40;
      while (this.peds.length < this.max && tries-- > 0) this._trySpawn(focus);
    }

    // --- walk ---
    for (const p of this.peds) {
      // a scared walker calms down again over a few seconds
      if (p.calm > 0 && (p.calm -= dt) <= 0) p.speed = SPEED[0] + Math.random() * (SPEED[1] - SPEED[0]);
      const path = p.path.p;
      // The walker always stands ON node i and moves toward i+dir, so that
      // neighbour must exist. A turn-around at an endpoint keeps i and only
      // flips dir; this guard catches anything malformed in the data instead
      // of throwing halfway through the frame.
      const next = path[p.i + p.dir];
      if (!next) { p.dir = -p.dir; continue; }
      const [ax, az] = path[p.i], [bx, bz] = next;
      let dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz) || 1;
      dx /= segLen; dz /= segLen;
      p.t += (p.speed * dt) / segLen;
      // walk on the right-hand side of the path — perpendicular of travel
      const ox = -dz * SIDE * p.side, oz = dx * SIDE * p.side;
      if (p.t >= 1) {                       // reached the segment's far node
        p.t = 0;
        p.i += p.dir;
        const atEnd = p.dir > 0 ? p.i >= path.length - 1 : p.i <= 0;
        if (atEnd) this._hop(p);
      }
      p.x = ax + dx * segLen * p.t + ox;
      p.z = az + dz * segLen * p.t + oz;
      // heading faces the walk direction: dir = (−sin h, −cos h) ⇒ h = atan2(−dx, −dz)
      const want = Math.atan2(-dx, -dz);
      let d = want - p.heading;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      p.heading += d * Math.min(1, dt * 6);
      p.walkT += p.speed * dt * 1.6;
      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.heading;
      p.animate(p.walkT, p.speed / 1.4);
    }
  }

  // A blast on the street: everyone within reach turns round and legs it down
  // their own pavement. They keep using the path graph — a citizen sprinting
  // across the Labe would be a worse bug than one sprinting the wrong way —
  // so "flee" is a direction flip plus a burst of speed that decays back to a
  // stroll over the next few seconds.
  panic(x, z, r) {
    for (const p of this.peds) {
      if (Math.hypot(p.x - x, p.z - z) > r) continue;
      const path = p.path.p;
      const next = path[p.i + p.dir];
      // if the way we're walking leads TOWARD the bang, turn around
      if (next && Math.hypot(next[0] - x, next[1] - z) < Math.hypot(p.x - x, p.z - z))
        p.dir = -p.dir;
      p.speed = Math.min(6.2, p.speed + 3.4);
      p.calm = 6 + Math.random() * 4;
    }
  }

  // At a path end, step onto another path that starts nearby (a real junction
  // of pavements); with nothing to join, turn on the spot and walk back.
  _hop(p) {
    const ex = p.path.p[p.i][0], ez = p.path.p[p.i][1];
    const options = [];
    for (const r of this.paths) {
      if (r === p.path) continue;
      const a = r.p[0], b = r.p[r.p.length - 1];
      if (Math.hypot(a[0] - ex, a[1] - ez) < JOIN_R) options.push([r, 0, 1]);
      else if (Math.hypot(b[0] - ex, b[1] - ez) < JOIN_R) options.push([r, r.p.length - 1, -1]);
      if (options.length >= 6) break;       // enough choice; stop scanning
    }
    if (options.length) {
      const [r, i, dir] = options[(Math.random() * options.length) | 0];
      p.path = r; p.i = i; p.dir = dir; p.t = 0;
    } else {                                 // dead end — about turn
      // stay ON this endpoint and walk back: moving i as well would step it
      // past the array end on a two-node path
      p.dir = -p.dir;
      p.side = -p.side;                      // still keeping to the right
      p.t = 0;
    }
  }

  // Paths within reach of the player, refreshed only when he has actually
  // moved on. The region holds thousands of footways; sampling that list at
  // random put a walker near the camera roughly never (measured: 2 of 34
  // alive), so spawning draws from this local shortlist instead.
  _nearby(focus) {
    if (this._nearAt && Math.hypot(focus.x - this._nearAt.x, focus.z - this._nearAt.z) < 60
      && this._near.length) return this._near;
    const list = [];
    for (const r of this.paths) {
      const [x, z] = r.p[0];
      if (Math.abs(x - focus.x) < SPAWN_R + 60 && Math.abs(z - focus.z) < SPAWN_R + 60) list.push(r);
    }
    this._near = list;
    this._nearAt = { x: focus.x, z: focus.z };
    return list;
  }

  _trySpawn(focus) {
    const near = this._nearby(focus);
    if (!near.length) return;
    const r = near[(Math.random() * near.length) | 0];
    const i = (Math.random() * (r.p.length - 1)) | 0;
    const [x, z] = r.p[i];
    const d = Math.hypot(x - focus.x, z - focus.z);
    if (d < 18 || d > SPAWN_R) return;       // not on top of the player, not miles off
    const c = makeCitizen();
    // people share ONE scale with the player — a half-size hero among
    // full-size passers-by reads as a bug, whatever the constant is set to
    c.group.scale.setScalar(PLAYER_SCALE);
    c.group.position.set(x, 0, z);
    this.scene.add(c.group);
    this.peds.push({
      mesh: c.group, animate: c.walk, path: r, i, dir: 1, t: 0,
      x, z, heading: 0, walkT: Math.random() * 10,
      side: Math.random() < 0.5 ? 1 : -1,
      speed: SPEED[0] + Math.random() * (SPEED[1] - SPEED[0]),
      calm: 0,
    });
  }

  _remove(idx) {
    const p = this.peds[idx];
    this.scene.remove(p.mesh);
    p.mesh.traverse(o => o.geometry?.dispose?.());
    this.peds.splice(idx, 1);
  }
}
