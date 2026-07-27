// ---- weapons.js: the helicopter's rocket pod ----
// V fires. Everything else in this file exists to make the two seconds between
// the trigger and the hole in the wall feel like something.
//
// The rocket is unguided and fast (55 m/s off the rail, 210 m/s on the motor)
// with just enough gravity to droop, so aiming is a real skill: point the nose,
// account for your own velocity, fire. To keep that fair rather than obscure,
// `aimPoint()` runs the exact same ballistic integration ahead of time against
// the world and drops a ring on the predicted impact — the reticle is not a
// guess, it is the simulation.
//
// Impact is resolved by SUB-STEPPING the flight path: at 210 m/s a 60 Hz frame
// covers 3.5 m, which is enough to fly clean through a wall panel, so the
// integrator walks the segment in ~1.2 m bites and tests each one against the
// terrain and the building index. The first hit wins.
//
// The blast itself is four things layered, because one of them alone always
// reads as a decal: a flash (real PointLight, so the street lights up), an
// expanding fireball, a ground shockwave ring, and a lot of dust — plus the
// actual destruction, which city.js routes into the building's box model.
//
// Multiplayer sees the SAME explosion in every client, so detonate() is written
// to be replayable: `onDetonate` reports a local blast the instant it happens
// (never a frame later — at 210 m/s a frame is 3.5 m of wall) and
// `detonate(..., {remote:true})` replays somebody else's without shaking the
// local camera or shouting into the local headphones.

import * as THREE from 'three';
import { MISSILE } from './config.js';
import { missileLaunch, explosion, sfx, sfxAt } from './audio.js';

const M = MISSILE;
const STEP = 1.2;                 // m — collision sub-step along the path
const POOL = 12;                  // rockets in the air at once
// A blast somebody ELSE set off still lights up the street, but past this it is
// a few pixels on the horizon and would only steal the sprite pool from a hit
// the player can actually see. The light has a 90 m falloff, so its own cut is
// tighter still: past that it contributes literally nothing but a stolen slot.
const REMOTE_FX_R = 700;
const REMOTE_LIGHT_R = 120;

// ---- shared geometry / materials ---------------------------------------
let _geo = null, _mat = null;
function rocketAssets() {
  if (_geo) return [_geo, _mat];
  const body = new THREE.CylinderGeometry(0.085, 0.085, 1.05, 7);
  body.rotateX(-Math.PI / 2);                     // axis y → −z, the nose
  const nose = new THREE.ConeGeometry(0.085, 0.32, 7);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, -0.66);
  const fins = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.BoxGeometry(0.02, 0.22, 0.26);
    f.translate(0, 0.14, 0.44);
    f.rotateZ((i / 3) * Math.PI * 2);
    fins.push(f);
  }
  _geo = { body, nose, fins };
  _mat = {
    skin: new THREE.MeshLambertMaterial({ color: 0x4a4d52 }),
    tip: new THREE.MeshLambertMaterial({ color: 0x8a2b20 }),
    // the motor: overbright + toneMapped:false so the bloom pass bites, the
    // same trick the street lamps and headlights use
    flame: new THREE.MeshBasicMaterial({ color: 0xffc46a, toneMapped: false }),
  };
  return [_geo, _mat];
}

function makeRocket() {
  const [g, m] = rocketAssets();
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g.body, m.skin), new THREE.Mesh(g.nose, m.tip));
  for (const f of g.fins) grp.add(new THREE.Mesh(f, m.skin));
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.9, 6), m.flame);
  flame.rotation.x = -Math.PI / 2;                // cone points −z; we want +z
  flame.position.z = 0.95;
  grp.add(flame);
  grp.visible = false;
  return { grp, flame };
}

// fireball / shockwave sprites — a tiny dedicated pool, because these want
// additive-ish blending and a different fade curve from the grey dust
function fireTexture() {
  const S = 64, R = S / 2, d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
    const a = u >= 1 ? 0 : Math.pow(1 - u, 1.3);
    const i = (y * S + x) * 4;
    d[i] = 255; d[i + 1] = 236; d[i + 2] = 210;
    d[i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(d, S, S);
  t.needsUpdate = true;
  return t;
}

export class Weapons {
  /**
   * @param scene  THREE.Scene
   * @param world  CityWorld — needs heightAt, buildingHitAt and applyHit
   *               (damageBuilding is the pre-multiplayer fallback)
   * @param fx     { dust } — the shared dust pool from interiorsim
   */
  constructor(scene, world, fx) {
    this.scene = scene;
    this.world = world;
    this.fx = fx ?? {};
    this.ammo = M.mag;
    this.cool = 0;
    this.reload = 0;
    this.shake = 0;                 // main.js reads this into the camera
    this.live = [];
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const r = makeRocket();
      scene.add(r.grp);
      this.pool.push(r);
    }
    // blast sprites. NOT `this.fire` — an own property of that name would
    // shadow the fire() method on the prototype, and the trigger would
    // silently stop being callable.
    const tex = fireTexture();
    this.balls = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true,
        depthWrite: false, opacity: 0, toneMapped: false });
      const s = new THREE.Sprite(m);
      s.visible = false;
      scene.add(s);
      this.balls.push({ s, m, t: 0, life: 0, r0: 1, r1: 4, x: 0, y: 0, z: 0 });
    }
    // shockwave rings, laid flat on whatever they went off above
    const ringGeo = new THREE.RingGeometry(0.55, 1, 32).rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true,
        opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(ringGeo, m);
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, m, t: 0, life: 0, r: 1 });
    }
    this.light = new THREE.PointLight(0xffb060, 0, 90, 1.7);
    this.light.visible = false;
    scene.add(this.light);
    this._lightT = 0;
    // Detonation subscribers. Multiplayer used to POLL `live` and infer a blast
    // from a missile that had left the array — which is a whole frame late, and
    // at 210 m/s a frame is up to 3.5 m of flight (10 m on a 30 Hz tab). The
    // peer then wrecked the wrong wall. This fires from inside detonate(), at
    // the exact metre the blast happened.
    this._det = [];
  }

  /**
   * onDetonate(fn) — fn({x, y, z, r, id}) on EVERY LOCAL detonation,
   * synchronously, from inside the blast. Remote blasts replayed with
   * {remote:true} do NOT re-fire it, so a relayed explosion cannot bounce back
   * onto the wire. `id` is the city's identity for that blast: put it on the
   * wire and pass it back in on the receiving side (detonate opts.id) and the
   * same hit can be delivered twice — live and again inside a snapshot —
   * without going off twice. Returns an unsubscribe.
   */
  onDetonate(fn) {
    if (typeof fn !== 'function') return () => {};
    this._det.push(fn);
    return () => {
      const i = this._det.indexOf(fn);
      if (i >= 0) this._det.splice(i, 1);
    };
  }

  get ready() { return this.cool <= 0 && this.reload <= 0 && this.ammo > 0; }

  /**
   * fire(src) — src = { x, y, z, heading, pitch, vx, vz }.
   * Rockets leave alternate sides of the pod and inherit the machine's own
   * velocity, which is why a fast pass drops them ahead of you and a hover
   * does not.
   */
  fire(src) {
    if (!this.ready) return false;
    const slot = this.pool.find((r) => !r.grp.visible);
    if (!slot) return false;
    this.ammo--;
    this.cool = M.cool;
    if (this.ammo <= 0) this.reload = M.reload;
    const h = src.heading, p = (src.pitch ?? 0) - 0.055;   // pod sits nose-down
    const cp = Math.cos(p);
    const dx = -Math.sin(h) * cp, dz = -Math.cos(h) * cp, dy = Math.sin(p);
    // alternate rails: right of dir(h) is (cos h, −sin h)
    const side = (this._side = !this._side) ? 1 : -1;
    const ox = Math.cos(h) * 1.05 * side, oz = -Math.sin(h) * 1.05 * side;
    const m = {
      slot,
      x: src.x + ox + dx * 1.6, y: src.y - 0.35 + dy * 1.6, z: src.z + oz + dz * 1.6,
      vx: (src.vx ?? 0) + dx * M.v0, vy: (src.vy ?? 0) + dy * M.v0, vz: (src.vz ?? 0) + dz * M.v0,
      t: 0, trail: 0,
    };
    slot.grp.visible = true;
    this.live.push(m);
    missileLaunch?.();
    sfx?.('rocket_launch', 0.85);   // sample layered over the synth whoosh; no-ops if absent
    this.shake = Math.max(this.shake, 0.18);
    return true;
  }

  update(dt, ctx) {
    if (this.cool > 0) this.cool -= dt;
    if (this.reload > 0 && (this.reload -= dt) <= 0) this.ammo = M.mag;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.4);
    this._fxStep(dt);

    for (let i = this.live.length - 1; i >= 0; i--) {
      const m = this.live[i];
      m.t += dt;
      // the motor burns all the way: accelerate along the CURRENT heading, so
      // gravity bends the trajectory and the thrust follows the bend
      const sp = Math.hypot(m.vx, m.vy, m.vz) || 1;
      if (sp < M.vmax) {
        const a = M.accel * dt;
        m.vx += (m.vx / sp) * a; m.vy += (m.vy / sp) * a; m.vz += (m.vz / sp) * a;
      }
      m.vy -= M.gravity * dt;
      const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt, nz = m.z + m.vz * dt;
      const hit = this._trace(m.x, m.y, m.z, nx, ny, nz, ctx);
      // smoke trail: one puff every few metres of travel, drifting and greying
      m.trail += Math.hypot(nx - m.x, ny - m.y, nz - m.z);
      if (m.trail > 6 && this.fx.dust) {
        m.trail = 0;
        this.fx.dust.puff(m.x, m.y, m.z, 0.8, 5.5, 1.5, 0.32, 0xb9b3ab,
          (Math.random() - 0.5) * 1.2, 0.4, (Math.random() - 0.5) * 1.2);
      }
      if (hit) {
        this.detonate(hit.x, hit.y, hit.z, hit.b, ctx);
        m.slot.grp.visible = false;
        this.live.splice(i, 1);
        continue;
      }
      m.x = nx; m.y = ny; m.z = nz;
      if (m.t > M.life) {                       // fuel out — go off in the air
        this.detonate(m.x, m.y, m.z, null, ctx);
        m.slot.grp.visible = false;
        this.live.splice(i, 1);
        continue;
      }
      const g = m.slot.grp;
      g.position.set(m.x, m.y, m.z);
      // point the airframe down its own velocity
      const flat = Math.hypot(m.vx, m.vz) || 1e-6;
      g.rotation.set(0, 0, 0);
      g.rotation.y = Math.atan2(-m.vx, -m.vz);
      g.rotateX(Math.atan2(m.vy, flat));
      m.slot.flame.scale.setScalar(0.75 + Math.random() * 0.55);
    }
  }

  // Walk one frame's path in STEP-sized bites; return the first thing hit.
  _trace(x0, y0, z0, x1, y1, z1, ctx) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const L = Math.hypot(dx, dy, dz);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + dx * t, y = y0 + dy * t, z = z0 + dz * t;
      const b = this.world.buildingHitAt?.(x, y, z);
      if (b) return { x, y, z, b };
      // A building already made of boxes is no longer in the footprint index —
      // its own panels answer for it. That is what makes the SECOND rocket
      // behave: it hits whatever is still standing and flies clean through the
      // hole the first one made, instead of either passing through the whole
      // wreck or detonating on a footprint that is no longer there.
      if (this.world.solidAt?.(x, y, z)) return { x, y, z, b: null };
      if (y <= this.world.heightAt(x, z)) return { x, y: this.world.heightAt(x, z), z, b: null };
      if (ctx?.cars) {
        for (const c of ctx.cars) {
          if (Math.abs(c.x - x) > 2.6 || Math.abs(c.z - z) > 2.6) continue;
          const cy = c.mesh?.position.y ?? 0;
          if (y > cy + 2.2 || y < cy - 0.4) continue;
          return { x, y, z, b: null };
        }
      }
    }
    return null;
  }

  /**
   * The blast: FX, sound, the shove on nearby traffic, and the demolition.
   *
   * `opts.remote` marks a blast that happened in SOMEBODY ELSE'S helicopter and
   * arrived over the wire. It is the same explosion in the same world — same
   * fireball, same hole in the wall — but it must not touch the two things that
   * belong to the local player's body: the camera does not shake (a peer three
   * kilometres away was rattling the pilot's teeth) and the report is played
   * POSITIONED via sfxAt instead of the flat mono `sfx`, which used to go off at
   * full volume inside the headphones whatever the distance.
   * `opts.id` is the sender's id for the blast — pass the one that came off the
   * wire so the city can recognise it if it ever arrives a second time.
   */
  detonate(x, y, z, b, ctx, opts) {
    const r = M.blast;
    const remote = opts?.remote === true;
    const gy = this.world.heightAt(x, z);
    // How far the local ear/eye is from this blast. interiorsim owns the focus
    // (it is the module that feeds audio's listener), so it is the one honest
    // source available here; without it, treat a remote blast as mid-distance.
    const foc = remote ? this.world.interiors?.focus : null;
    const dist = foc ? Math.hypot(foc.x - x, foc.z - z) : (remote ? 260 : 0);
    // fireball + rings + light
    if (!remote || dist < REMOTE_FX_R) {
      for (let i = 0; i < 4; i++) this._fireball(x + (Math.random() - 0.5) * r * 0.5,
        y + (Math.random() - 0.4) * r * 0.5, z + (Math.random() - 0.5) * r * 0.5,
        r * (0.35 + Math.random() * 0.3), r * (1.3 + Math.random() * 0.9),
        0.42 + Math.random() * 0.35);
      this._ring(x, Math.max(gy + 0.1, y - r * 0.6), z, r * 3.4);
      if (this.fx.dust) for (let i = 0; i < 7; i++)
        this.fx.dust.puff(x + (Math.random() - 0.5) * r, y + Math.random() * r * 0.7,
          z + (Math.random() - 0.5) * r, r * 0.4, r * 2.4, 2.6 + Math.random() * 2,
          0.42, 0x6e6660);
    }
    if (!remote || dist < REMOTE_LIGHT_R) {
      this.light.position.set(x, y + 1.5, z);
      this.light.intensity = 260;
      this.light.visible = true;
      this._lightT = 0.28;
    }
    if (remote) {
      // `explosion()` is the synth blast and has no panner and no fallback in
      // audio.js, so distance has to be baked into its amplitude by hand; the
      // sample rides on top through sfxAt, which does its own attenuation and
      // simply drops out when it is inaudible.
      const k = Math.max(0.05, Math.min(1, 1 - dist / 900));
      explosion?.(k);
      sfxAt?.('explosion_big', 0.95, x, z, 900);
      // NO this.shake — the camera belongs to the local player.
    } else {
      explosion?.(1);
      sfx?.('explosion_big', 0.95); // sample layered over the synth blast; no-ops if absent
      this.shake = Math.min(1.6, this.shake + M.shake);
    }

    // The demolition itself. applyHit() is the multiplayer-safe door: it logs
    // the hit for late joiners and QUEUES it when the region tile it landed on
    // has not streamed in yet (a peer can perfectly well blow up a village
    // 8 km away). damageBuilding stays the fallback for a world that predates
    // it — it never read `b` anyway, the sphere finds its own targets.
    // `hit` comes back carrying its id (minted by the city when we did not pass
    // one), which is what the subscribers below hand to the network.
    const hit = { x, y, z, r, ...(opts?.id ? { id: opts.id } : {}) };
    if (this.world.applyHit) this.world.applyHit(hit);
    else this.world.damageBuilding?.(b, x, y, z, r);

    // traffic gets thrown about. Cars carry a scalar speed along their heading,
    // so the shove becomes "spun and flung down your own axis", which at these
    // magnitudes reads exactly like being swatted.
    if (ctx?.cars) for (const c of ctx.cars) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d > r * 2.2) continue;
      const k = 1 - d / (r * 2.2);
      const away = Math.atan2(-(c.x - x), -(c.z - z));
      let rel = away - c.heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      c.speed = (c.speed ?? 0) - Math.cos(rel) * 26 * k;
      c.heading += (Math.random() - 0.5) * 1.4 * k;
      c._rammedT = Math.max(c._rammedT ?? 0, 2.6);
    }
    ctx?.peds?.panic?.(x, z, r * 5);

    // …and only now, with the world already changed, tell the network. A
    // subscriber that throws is a bug in the subscriber, not a reason for the
    // rocket to half-explode.
    if (!remote && this._det.length)
      for (const fn of this._det) { try { fn(hit); } catch (e) { console.error(e); } }
  }

  /**
   * aimPoint(src) → {x,y,z} | null — where a rocket fired right now would land.
   * Same integrator as update(), coarser steps, no side effects. Cheap enough
   * to run a few times a second for the reticle.
   */
  aimPoint(src) {
    const h = src.heading, p = (src.pitch ?? 0) - 0.055, cp = Math.cos(p);
    let x = src.x, y = src.y - 0.35, z = src.z;
    let vx = (src.vx ?? 0) - Math.sin(h) * cp * M.v0;
    let vy = (src.vy ?? 0) + Math.sin(p) * M.v0;
    let vz = (src.vz ?? 0) - Math.cos(h) * cp * M.v0;
    const dt = 1 / 30;
    for (let i = 0; i < 120; i++) {
      const sp = Math.hypot(vx, vy, vz) || 1;
      if (sp < M.vmax) { const a = M.accel * dt; vx += vx / sp * a; vy += vy / sp * a; vz += vz / sp * a; }
      vy -= M.gravity * dt;
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
      const hit = this._trace(x, y, z, nx, ny, nz, null);
      if (hit) return hit;
      x = nx; y = ny; z = nz;
      if (y < -20) return null;
    }
    return null;
  }

  // ---- FX plumbing -------------------------------------------------------
  _fireball(x, y, z, r0, r1, life) {
    const f = this.balls.find((s) => !s.s.visible);
    if (!f) return;
    f.x = x; f.y = y; f.z = z; f.r0 = r0; f.r1 = r1; f.life = life; f.t = 0;
    f.s.visible = true;
  }
  _ring(x, y, z, r) {
    const g = this.rings.find((s) => !s.mesh.visible);
    if (!g) return;
    g.mesh.position.set(x, y, z);
    g.r = r; g.life = 0.55; g.t = 0;
    g.mesh.visible = true;
  }
  _fxStep(dt) {
    for (const f of this.balls) {
      if (!f.s.visible) continue;
      f.t += dt;
      const u = f.t / f.life;
      if (u >= 1) { f.s.visible = false; continue; }
      const r = f.r0 + (f.r1 - f.r0) * Math.sqrt(u);
      f.s.position.set(f.x, f.y + u * 2.2, f.z);
      f.s.scale.set(r, r, 1);
      // white-hot → orange → soot, the way a real fireball actually cools
      f.m.color.setRGB(1, 0.86 - u * 0.66, 0.66 - u * 0.62);
      f.m.opacity = (1 - u) * (u < 0.12 ? u / 0.12 : 1);
    }
    for (const g of this.rings) {
      if (!g.mesh.visible) continue;
      g.t += dt;
      const u = g.t / g.life;
      if (u >= 1) { g.mesh.visible = false; continue; }
      const s = 0.6 + g.r * u;
      g.mesh.scale.set(s, 1, s);
      g.m.opacity = (1 - u) * 0.75;
    }
    if (this._lightT > 0) {
      this._lightT -= dt;
      this.light.intensity = Math.max(0, 260 * (this._lightT / 0.28));
      if (this._lightT <= 0) this.light.visible = false;
    }
  }
}
