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
//
// Hit physics (GTA-lite): main.js hands us `peds.cars` (Set of AI cars) and
// `peds.playerCar` every frame. A moving car whose oriented rectangle overlaps
// a walker launches them into a ragdoll — fly, tumble, bounce once, slide out.
// Fast hits kill; corpses lie on a separate small budget, bleed a pooled decal,
// and can be run over again. Slow hits stun: the ped lies a few seconds, gets
// up and flees. Owners may subscribe:
//   peds.onPedHit    = (ped, impactSpeed) => {}   // every qualifying hit
//   peds.onPedKilled = (ped) => {}                // once, when a hit is lethal

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE, LAYER_Y } from './config.js';

const SPAWN_R = 110;       // meters — pedestrians appear this far out
const DESPAWN_R = 190;     // …and are recycled past here
const MAX_PEDS = 34;       // population cap (each is ~12 small meshes)
const SIDE = 0.9;          // how far off the path centerline they walk
const JOIN_R = 7;          // path ends within this distance connect
const SPEED = [1.15, 1.55];// m/s — a stroll to a brisk walk

// ---- hit / ragdoll tuning ----
const HIT_MIN_SPEED = 1.5; // m/s — a car crawling slower than this can't hit
const KILL_SPEED = 7;      // m/s (~25 km/h) — impact above this is lethal
const PED_R = 0.35;        // standing collision circle
const LIE_R = 0.4;         // lying capsule: circles of this radius…
const LIE_HALF = 0.55;     // …sampled at ± this along the lying body axis
const GRAV = 18;           // slightly heavy gravity reads punchier than 9.8
const RESTITUTION = 0.3;   // one bounce, then slide
const SLIDE_FRICTION = 8;  // m/s² ground decel while sliding to rest
const NUDGE_K = 0.55;      // re-running-over a corpse relaunches at this energy
const HIT_COOLDOWN = 0.5;  // s — one car can't machine-gun hits on one ped
const PANIC_R = 25;        // bystanders inside this radius flee a hit
const DOWN_TIME = [2, 4];  // stunned survivors lie this long before getting up
const CORPSE_TIME = 60;    // s a corpse stays…
const CORPSE_FADE = 1.5;   // …then sinks away over this long (materials are
                           // SHARED across citizens, so opacity-fade would
                           // ghost every walker on screen — sinking won't)
const CORPSE_MAX = 10;     // visible-corpse budget, separate from the walk cap
const LIE_Y = 0.3;         // lying pivot height: body straddles the road deck
                           // (LAYER_Y.road 0.20) instead of sinking through it
const HALF_PI = Math.PI / 2;

// ---- blood decals ----
const BLOOD_MAX = 40;      // pooled groups of 3 discs, oldest reused
const BLOOD_GROW = 2;      // s to spread to full size
const BLOOD_LIFE = 70;     // s on the ground, then shrink out over 2 s
const BLOOD_Y = LAYER_Y.road + 0.04; // above the road deck, below markings (0.26)

// point-in-expanded-rect: (u,v) is the circle center in the car's frame
function rectCircle(u, v, hl, hw, r) {
  const du = u < -hl ? u + hl : u > hl ? u - hl : 0;
  const dv = v < -hw ? v + hw : v > hw ? v - hw : 0;
  return du * du + dv * dv < r * r;
}

// ONE geometry + material for every blood disc ever, made on first need so
// merely importing this module (tests) allocates nothing
let _bloodGeo = null, _bloodMat = null;
function bloodAssets() {
  if (!_bloodGeo) {
    _bloodGeo = new THREE.CircleGeometry(1, 14);
    _bloodMat = new THREE.MeshBasicMaterial({
      color: 0x6a0f0f, transparent: true, opacity: 0.75, depthWrite: false,
    });
  }
}

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
    this.cars = null;        // main.js refreshes both every frame before update()
    this.playerCar = null;
    this.onPedHit = null;    // (ped, impactSpeed) — audio/main subscribe here
    this.onPedKilled = null; // (ped)
    this._blood = [];        // pooled decals, grown lazily to BLOOD_MAX
    this._bloodN = 0;        // round-robin reuse cursor = oldest decal
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
      let walkers = 0;                     // corpses live on their own budget
      for (let i = this.peds.length - 1; i >= 0; i--) {
        const p = this.peds[i];
        if (p.state === 'dead' && p.deadT <= 0) { this._remove(i); continue; }
        if (Math.hypot(p.x - focus.x, p.z - focus.z) > DESPAWN_R) { this._remove(i); continue; }
        if (p.state !== 'dead') walkers++;
      }
      let tries = 40;
      while (walkers < this.max && tries-- > 0) if (this._trySpawn(focus)) walkers++;
    }

    // --- cars vs. people ---
    this._hitPass();

    // --- walk / ragdoll ---
    for (const p of this.peds) {
      if (p.hitCd > 0) p.hitCd -= dt;
      if (p.state !== 'walk') { this._ragStep(p, dt); continue; }
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
      // fresh off the ground after a hit: the slide left them OFF the path, so
      // ease from where they lay back onto the walk position instead of snapping
      if (p.blend > 0) {
        p.blend = Math.max(0, p.blend - dt * 0.8);
        p.x += (p.bx - p.x) * p.blend;
        p.z += (p.bz - p.z) * p.blend;
      }
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

    this._bloodStep(dt);
  }

  // ---------------------------------------------------------------- hits ----

  // Player car first (it's the one doing 60 through Třída Míru), then the AI
  // fleet. Everything is bbox-gated before any trig; peds already flying are
  // immune until they land, then a corpse/stunned body can be run over again.
  _hitPass() {
    const pc = this.playerCar, cars = this.cars;
    for (const p of this.peds) {
      if (p.hitCd > 0 || p.state === 'rag') continue;
      if (pc && this._carHit(pc, p)) continue;
      if (cars) for (const c of cars) {
        if (c === pc) continue;
        if (this._carHit(c, p)) break;
      }
    }
  }

  // oriented rectangle (len×wid around heading) vs. the ped's circle —
  // standing peds are one 0.35 m circle at the feet, lying bodies a capsule
  // sampled as three circles along the body axis
  _carHit(car, p) {
    const s = Math.abs(car.speed);
    if (s <= HIT_MIN_SPEED) return false;
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > car.len || Math.abs(dz) > car.len) return false;
    // a car on a bridge deck (LAYER_Y.road + BRIDGE_Y ≈ 1.05) must not squash
    // the walker on the riverside path BELOW it; street cars sit at y ≈ 0.2
    if (Math.abs((car.y || 0) - p.y) > 0.9) return false;
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    const rx = -fz, rz = fx;                     // right of travel
    const hl = car.len / 2, hw = car.wid / 2;
    const lying = p.state !== 'walk';
    let hit = rectCircle(dx * fx + dz * fz, dx * rx + dz * rz,
      hl, hw, lying ? LIE_R : PED_R);
    if (!hit && lying) {                         // head/feet ends of the capsule
      const bx = Math.sin(p.heading) * LIE_HALF, bz = Math.cos(p.heading) * LIE_HALF;
      hit = rectCircle((dx + bx) * fx + (dz + bz) * fz, (dx + bx) * rx + (dz + bz) * rz, hl, hw, LIE_R)
        || rectCircle((dx - bx) * fx + (dz - bz) * fz, (dx - bx) * rx + (dz - bz) * rz, hl, hw, LIE_R);
    }
    if (!hit) return false;
    this._launch(p, car, s);
    return true;
  }

  // the moment of impact: velocity along the car's travel, a kick upward, a
  // shove off the bonnet's centerline, tumble spin, splayed limbs
  _launch(p, car, s) {
    const dirS = car.speed >= 0 ? 1 : -1;        // reversing hits launch backward
    const fx = -Math.sin(car.heading) * dirS, fz = -Math.cos(car.heading) * dirS;
    const k = p.state === 'dead' ? NUDGE_K : 1;  // rolling a corpse, gently
    const kick = (s * 0.9 + 2) * k;
    const side = (p.x - car.x) * -fz + (p.z - car.z) * fx < 0 ? -1 : 1;
    p.vx = fx * kick - fz * side * 1.2 * k;      // lateral = right-of-travel × side
    p.vz = fz * kick + fx * side * 1.2 * k;
    p.vy = Math.min(6, 1.5 + s * 0.25) * k;
    const spin = Math.min(9, 2 + s * 0.6);
    p.avx = spin * (Math.random() * 1.4 - 0.7);
    p.avz = spin * (Math.random() * 1.4 - 0.7);
    p.state = 'rag';
    p.bounced = false;
    p.hitCd = HIT_COOLDOWN;
    p.hurtS = s;
    p.ragdollPose();
    const wasDead = p.dead;
    if (!wasDead && s > KILL_SPEED) p.dead = true;
    // SOUND: body thud (+ scream if fatal) belongs here — subscribe to onPedHit
    this.onPedHit?.(p, s);
    if (p.dead && !wasDead) this.onPedKilled?.(p);
    // SOUND: bystander screams — the crowd scatters
    this.panic(p.x, p.z, PANIC_R);
  }

  // one ragdoll/corpse per frame: fly under gravity while tumbling, bounce
  // once, slide out flat; then lie stunned (get up, flee) or stay a corpse
  _ragStep(p, dt) {
    const m = p.mesh;
    if (p.state === 'down') {                    // stunned, face in the gutter
      if ((p.downT -= dt) <= 0) this._getUp(p);
      return;
    }
    if (p.state === 'dead') {
      p.deadT -= dt;                             // removal in the bookkeeping pass
      if (p.deadT < CORPSE_FADE)                 // sink away — see CORPSE_FADE note
        m.position.y = p.lieY - (1 - Math.max(0, p.deadT) / CORPSE_FADE) * 1.2;
      return;
    }
    // state 'rag' — airborne or sliding
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.vy -= GRAV * dt;
    p.y += p.vy * dt;
    m.rotation.x += p.avx * dt;
    m.rotation.z += p.avz * dt;
    if (p.y <= 0) {
      p.y = 0;
      if (!p.bounced && p.vy < -2.5) {           // one honest bounce
        p.bounced = true;
        p.vy = -p.vy * RESTITUTION;
        p.vx *= 0.65; p.vz *= 0.65;
        p.avx *= 0.5; p.avz *= 0.5;
        // SOUND: tumble-thud on the tarmac
      } else {
        p.vy = 0;                                // sliding out
        const sp = Math.hypot(p.vx, p.vz);
        const ns = Math.max(0, sp - SLIDE_FRICTION * dt);
        const fk = sp > 1e-4 ? ns / sp : 0;
        p.vx *= fk; p.vz *= fk;
        const damp = Math.min(1, dt * 6);        // spin dies on contact…
        p.avx -= p.avx * damp;
        p.avz -= p.avz * damp;
        const ease = Math.min(1, dt * 5);        // …and the body settles flat
        const tx = Math.round((m.rotation.x - HALF_PI) / Math.PI) * Math.PI + HALF_PI;
        const tz = Math.round(m.rotation.z / Math.PI) * Math.PI;
        m.rotation.x += (tx - m.rotation.x) * ease;
        m.rotation.z += (tz - m.rotation.z) * ease;
        p.lieY += (LIE_Y - p.lieY) * ease;
        if (ns < 0.3 && Math.abs(p.avx) < 0.5 && Math.abs(p.avz) < 0.5)
          this._settle(p, tx, tz);
      }
    }
    m.position.set(p.x, p.y + p.lieY, p.z);
  }

  // the slide has stopped: become a corpse (blood, budget) or lie stunned
  _settle(p, tx, tz) {
    p.mesh.rotation.x = tx;
    p.mesh.rotation.z = tz;
    p.lieY = LIE_Y;
    p.vx = p.vz = p.avx = p.avz = 0;
    p.mesh.position.set(p.x, p.lieY, p.z);
    if (p.dead) {
      p.state = 'dead';
      p.deadT = CORPSE_TIME;
      this._spawnBlood(p.x, p.z, 1.0 + Math.random() * 0.4);
      // corpse budget: past CORPSE_MAX the oldest one starts sinking now
      let n = 0, oldest = null;
      for (const q of this.peds) if (q.state === 'dead') {
        n++;
        if (!oldest || q.deadT < oldest.deadT) oldest = q;
      }
      if (n > CORPSE_MAX && oldest && oldest.deadT > CORPSE_FADE) oldest.deadT = CORPSE_FADE;
    } else {
      p.state = 'down';
      p.downT = DOWN_TIME[0] + Math.random() * (DOWN_TIME[1] - DOWN_TIME[0]);
      if (p.hurtS > 5) this._spawnBlood(p.x, p.z, 0.8);  // hurt but alive
    }
  }

  // a survivor picks themself up and legs it — same burst the panic() gives
  _getUp(p) {
    p.state = 'walk';
    p.standPose();
    p.mesh.rotation.set(0, p.heading, 0);
    p.y = 0; p.lieY = 0;
    // re-anchor to the nearest node of their path; blend covers the leftover gap
    const pts = p.path.p;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - p.x) ** 2 + (pts[i][1] - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    p.i = best; p.t = 0;
    if (p.i >= pts.length - 1) { p.i = pts.length - 1; p.dir = -1; }
    else if (p.i <= 0) p.dir = 1;
    p.bx = p.x; p.bz = p.z; p.blend = 1;
    p.speed = 4.2 + Math.random();               // flee!
    p.calm = 6 + Math.random() * 4;
  }

  // --------------------------------------------------------------- blood ----

  // 2–3 overlapping discs per stain — shape decided once at spawn, then the
  // stain spreads over ~2 s. Pool of BLOOD_MAX groups, oldest reused.
  _spawnBlood(x, z, size) {
    bloodAssets();
    let d;
    if (this._blood.length < BLOOD_MAX) {
      const g = new THREE.Group();
      const discs = [];
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(_bloodGeo, _bloodMat);
        m.rotation.x = -HALF_PI;
        m.renderOrder = 2;                       // after the road decks
        g.add(m); discs.push(m);
      }
      d = { g, discs, ts: [0, 0, 0], t: 0, on: false };
      this.scene.add(g);
      this._blood.push(d);
    } else {
      d = this._blood[this._bloodN];
    }
    this._bloodN = (this._bloodN + 1) % BLOOD_MAX;
    d.t = 0; d.on = true;
    d.g.visible = true;
    d.g.position.set(x, BLOOD_Y, z);
    for (let i = 0; i < 3; i++) {
      const m = d.discs[i];
      m.visible = i < 2 || Math.random() < 0.6;        // 2–3 discs
      m.position.set((Math.random() - 0.5) * size * 0.6, i * 0.002,
        (Math.random() - 0.5) * size * 0.6);
      d.ts[i] = size * (i === 0 ? 0.9 + Math.random() * 0.3 : 0.35 + Math.random() * 0.3);
      m.scale.setScalar(0.01);
    }
  }

  _bloodStep(dt) {
    for (const d of this._blood) {
      if (!d.on) continue;
      d.t += dt;
      let k = Math.min(1, d.t / BLOOD_GROW);
      k = 1 - (1 - k) * (1 - k);                 // ease-out spread
      if (d.t > BLOOD_LIFE) {                    // dry up and vanish
        const f = (d.t - BLOOD_LIFE) / 2;
        if (f >= 1) { d.on = false; d.g.visible = false; continue; }
        k *= 1 - f;
      }
      for (let i = 0; i < 3; i++) d.discs[i].scale.setScalar(Math.max(0.01, d.ts[i] * k));
    }
  }

  // A blast on the street: everyone within reach turns round and legs it down
  // their own pavement. They keep using the path graph — a citizen sprinting
  // across the Labe would be a worse bug than one sprinting the wrong way —
  // so "flee" is a direction flip plus a burst of speed that decays back to a
  // stroll over the next few seconds.
  panic(x, z, r) {
    for (const p of this.peds) {
      if (p.state !== 'walk') continue;   // the flying and the dead don't flee
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
    if (!near.length) return false;
    const r = near[(Math.random() * near.length) | 0];
    const i = (Math.random() * (r.p.length - 1)) | 0;
    const [x, z] = r.p[i];
    const d = Math.hypot(x - focus.x, z - focus.z);
    if (d < 18 || d > SPAWN_R) return false; // not on top of the player, not miles off
    const c = makeCitizen();
    // people share ONE scale with the player — a half-size hero among
    // full-size passers-by reads as a bug, whatever the constant is set to
    c.group.scale.setScalar(PLAYER_SCALE);
    c.group.position.set(x, 0, z);
    this.scene.add(c.group);
    this.peds.push({
      mesh: c.group, animate: c.walk,
      ragdollPose: c.ragdollPose, standPose: c.standPose,
      path: r, i, dir: 1, t: 0,
      x, z, heading: 0, walkT: Math.random() * 10,
      side: Math.random() < 0.5 ? 1 : -1,
      speed: SPEED[0] + Math.random() * (SPEED[1] - SPEED[0]),
      calm: 0,
      // hit-physics state: walk | rag (flying/sliding) | down (stunned) | dead
      state: 'walk', dead: false, y: 0, lieY: 0,
      vx: 0, vy: 0, vz: 0, avx: 0, avz: 0, bounced: false,
      hitCd: 0, hurtS: 0, downT: 0, deadT: 0,
      blend: 0, bx: 0, bz: 0,
    });
    return true;
  }

  _remove(idx) {
    const p = this.peds[idx];
    this.scene.remove(p.mesh);
    p.mesh.traverse(o => o.geometry?.dispose?.());
    this.peds.splice(idx, 1);
  }
}
