// ---- carjack.js: the driver you pull out of a car ------------------------------
//
// A car in traffic has somebody in it. Taking it is not opening a door, it is
// taking a person out through one: the door comes open (js/carentry.js), you
// reach in, and the driver lands on the road beside it. This module is that
// driver from the moment they leave the seat:
//
//   thrown   out past the open door and down, the same flight a body thrown
//            through a windscreen has (js/ejection.js), only short and sideways
//   lying    a second and a half on the tarmac
//   rising   the same hands-and-knees get-up the player has (js/bodymoves.js)
//   running  away from whoever did it, and gone once they are far enough off
//
// and the question the law asks about it: did anybody SEE. witnessed() is the
// old rule (Frank, 18 Nov 2026: a person or a lit window within 100 m); since
// 25 Nov 2026 the law is js/crimelaw.js, where the driver himself rings the
// police unless he is dead before the call goes through.
//
// So the driver is a body you can hurt (25 Nov 2026): hp, run down by the
// player's car (update's `car`), and hittable by fists through nearest() and
// hurt(), the shape js/combat.js asks every target source for (x, z, state
// 'walk' while running, dead, mesh). A dead one stays on the road for DEAD_T.
// onRunOver(r, killed) tells main.js a car did it, so the law hears of it.
//
// At most MAX bodies at once; an older one makes way. Local, like the crowd's
// own ragdolls: nothing here is on the wire.

import { makeCitizen } from './citizen.js';
import { stockDriverOf } from './cardoor.js';
import { whoIs } from './characters/seated.js';
import { PLAYER_SCALE, CHUNK, WALK, INTERIOR } from './config.js';
import { launchBody, stepBody, feetFor } from './ejection.js';
import { SIT_DROP, seatX } from './seating.js';
import { getUpPose, snapshot } from './bodymoves.js';
import { chunkKey } from './geo.js';

const DRIVERS = ['m30', 'f30', 'm60', 'f60', 'm30', 'f30'];
const MAX = 3;
const RUN_V = 4.8;              // m/s away from you
const GONE_R = 55, GONE_T = 16; // m, s: out of the story
export const WITNESS_R = 100;   // m
const HP = 100;
const DEAD_T = 40;              // s a body lies on the road before it is cleared
const HIT_V = 2.5;              // m/s of the player's car that knocks somebody down
const KILL_V = 7;               // …and that kills (a pedestrian's casualty line is 6)

const _feet = { x: 0, y: 0, z: 0 };
const _q = { x: 0, z: 0 };
const _o = { interior: true, yLo: 0, yHi: 0, aboveY: 0 };

export class Carjack {
  /** { scene, world, makeBody }: makeBody is for tests; the default is a citizen. */
  constructor(opts = {}) {
    this.scene = opts.scene ?? null;
    this.world = opts.world ?? null;
    // anybody who drives: not the ninety-year-old on a stick
    // whoever the glass showed at the wheel is who comes out of the door (js/carcrew.js)
    this.makeBody = opts.makeBody ?? ((car) => makeCitizen({ archetype: DRIVERS[(Math.random() * DRIVERS.length) | 0],
      avatar: whoIs(stockDriverOf(car))?.body }));
    this.out = [];
    this.onRunOver = null;        // (r, killed): the player's car hit a thrown-out driver
  }

  /**
   * The driver of `car` leaves through the door on `side` (-1 left, +1 right).
   * seat: where they sat, in the car's frame. Returns the record.
   */
  throwOut(car, side, seat) {
    while (this.out.length >= MAX) this._drop(0);
    const body = car._victim ?? this.makeBody(car);
    car._victim = null;
    body.group.scale.setScalar(PLAYER_SCALE);
    body.group.rotation.set(0, 0, 0);
    this.scene?.add(body.group);          // (out of the car's own frame, if it sat there)
    const h = car.heading, ch = Math.cos(h), sh = Math.sin(h);
    // sideways out of the door and a little back along the car, in the world
    const lx = side * 3.4, lz = 1.1;
    const vx = lx * ch + lz * sh, vz = -lx * sh + lz * ch;
    const hip = 0.92 * PLAYER_SCALE;
    const st = launchBody({ x: car.x, z: car.z, y: car.y ?? 0, heading: h, impactVx: vx / 0.8, impactVz: vz / 0.8 },
      { x: side * ((car.wid ?? 1.8) / 2 + 0.15), y: (seat?.y ?? 0.5) + 0.1, z: seat?.z ?? 0 }, hip);
    st.car = null; st.vy = 1.9; st.ap *= 0.5;
    st.gy = car.y ?? 0;
    body.group.rotation.order = 'YXZ';
    body.ragdollPose();
    const r = { body, st, t: 0, phase: 'thrown', x: st.x, z: st.z, y: st.gy, heading: st.yaw, walkT: 0, lay: null,
      hp: HP, dead: false, state: 'rag', mesh: body.group };
    this.out.push(r);
    this._place(r);
    return r;
  }

  /**
   * The driver, sitting at the wheel for real, for the moment the door opens
   * on them: until then they were only drawn in the glass (js/carglass.js).
   * The body rides the car's own body group and is the one throwOut() throws.
   */
  seat(car, seat) {
    if (car._victim || !car.mesh) return;
    const body = this.makeBody(car);
    body.group.scale.setScalar(PLAYER_SCALE);
    (car.mesh.userData?.body ?? car.mesh).add(body.group);
    body.group.position.set(seatX(seat.x), seat.y - SIT_DROP, seat.z);
    body.group.rotation.set(0, 0, 0);
    body.sitPose?.(1);
    car._victim = body;
  }

  /**
   * px, pz: who they are running from. car: the car the player drives, or
   * null; it knocks down (and above KILL_V kills) whoever it drives into.
   */
  update(dt, px, pz, car = null) {
    for (let i = this.out.length - 1; i >= 0; i--) {
      const r = this.out[i];
      r.t += dt;
      if (r.dead) { if (r.t > DEAD_T) this._drop(i); continue; }
      if (car && this._struck(r, car)) continue;
      if (r.phase !== 'run') {
        const going = stepBody(r.st, dt, this.world ?? FLAT, null);
        this._place(r);
        if (r.st.phase === 'rise') {
          r.lay ??= snapshot(r.body.parts);
          r.body.standPose();
          getUpPose(r.body.parts, r.st.rise ?? 0, r.st.faceUp, r.lay);
        }
        if (!going) {
          r.phase = 'run'; r.t = 0; r.state = 'walk';
          r.x = r.st.x; r.z = r.st.z; r.y = r.st.gy; r.heading = r.st.yaw;
          r.body.group.rotation.order = 'XYZ';
          r.body.group.rotation.set(0, r.heading, 0);
          r.body.standPose();
        }
        continue;
      }
      // on their feet: away from you, round whatever is in the way
      let dx = r.x - px, dz = r.z - pz;
      const d = Math.hypot(dx, dz) || 1;
      if (d > GONE_R || r.t > GONE_T) { this._drop(i); continue; }
      dx /= d; dz /= d;
      const want = Math.atan2(-dx, -dz);
      r.heading += Math.atan2(Math.sin(want - r.heading), Math.cos(want - r.heading)) * Math.min(1, 6 * dt);
      const v = Math.min(RUN_V, 1.5 + r.t * 4), mv = v * dt;
      _q.x = r.x - Math.sin(r.heading) * mv; _q.z = r.z - Math.cos(r.heading) * mv;
      const w = this.world;
      if (w?.collide) {
        _o.yLo = r.y + INTERIOR.stepUp - 0.06; _o.yHi = r.y + INTERIOR.headroom; _o.aboveY = r.y + 0.3;
        w.collide(_q, WALK.radius, _o);
      }
      r.x = _q.x; r.z = _q.z;
      if (w?.supportY) { const s = w.supportY(r.x, r.z, r.y + INTERIOR.stepUp); if (Math.abs(s - r.y) < 1.2) r.y = s; }
      r.walkT += mv * 1.6;
      r.body.group.position.set(r.x, r.y, r.z);
      r.body.group.rotation.y = r.heading;
      r.body.walk(r.walkT, Math.min(1.25, v / 5.6), v > 3.5 ? 0.6 : 0, v);
    }
  }

  /** The nearest live driver within rad that want(r) accepts (js/combat.js's target contract). */
  nearest(x, z, rad, want = null) {
    let best = null, bd = rad * rad;
    for (const r of this.out) {
      if (r.dead) continue;
      if (want ? !want(r) : r.state !== 'walk') continue;
      const dx = r.x - x, dz = r.z - z, d2 = dx * dx + dz * dz;
      if (d2 <= bd) { bd = d2; best = r; }
    }
    return best;
  }

  /** A blow { dmg, vx, vz, ... }: hp comes off, and at zero they are dead. */
  hurt(r, blow) {
    if (!r || r.dead || !blow) return false;
    const dmg = blow.dmg > 0 ? blow.dmg : 0;
    r.hp -= dmg;
    if (!(r.hp > 0)) this._kill(r);
    return true;
  }

  // The player's car against one driver: inside its footprint and moving,
  // they go down; fast enough, for good. Returns true if they were hit.
  _struck(r, car) {
    const v = Math.abs(car.speed ?? 0);
    if (v < HIT_V) return false;
    const h = car.heading ?? 0, fx = -Math.sin(h), fz = -Math.cos(h);
    const x = r.phase === 'run' ? r.x : r.st.x, z = r.phase === 'run' ? r.z : r.st.z;
    const dx = x - car.x, dz = z - car.z;
    const a = dx * fx + dz * fz, b = dx * -fz + dz * fx;
    if (Math.abs(a) > (car.len ?? 4.4) / 2 + 0.35 || Math.abs(b) > (car.wid ?? 1.8) / 2 + 0.3) return false;
    const killed = v >= KILL_V;
    if (killed) this._kill(r);
    else {
      r.hp -= v * 12;
      if (!(r.hp > 0)) this._kill(r);
      else {
        // knocked over: thrown again, the way they came out of the door
        const st = launchBody({ x, z, y: r.y ?? 0, heading: h, impactVx: fx * v, impactVz: fz * v },
          { x: 0, y: 0.6, z: 0 }, 0.92 * PLAYER_SCALE);
        st.car = null; st.gy = r.y ?? 0;
        r.st = st; r.phase = 'thrown'; r.state = 'rag'; r.lay = null; r.t = 0;
        r.body.group.rotation.order = 'YXZ';
        r.body.ragdollPose();
      }
    }
    try { this.onRunOver?.(r, r.dead); } catch (e) { console.warn('[carjack] onRunOver:', e); }
    return true;
  }

  // Dead: flat on the road where they fell, and not getting up.
  _kill(r) {
    if (r.phase !== 'run' && r.st) { r.x = r.st.x; r.z = r.st.z; r.y = r.st.gy ?? r.y; }
    r.dead = true; r.hp = 0; r.state = 'dead'; r.phase = 'dead'; r.t = 0;
    r.body.ragdollPose?.();
    r.body.group.rotation.set(-Math.PI / 2 * 0.96, r.heading ?? 0, 0, 'YXZ');
    r.body.group.position.set(r.x, (r.y ?? 0) + 0.18, r.z);
  }

  _place(r) {
    const st = r.st, f = feetFor(st, _feet);
    r.body.group.position.set(f.x, f.y, f.z);
    r.body.group.rotation.set(st.pitch, st.yaw, st.roll);
  }

  _drop(i) {
    const r = this.out[i];
    this.out.splice(i, 1);
    r?.body.dispose?.();
  }

  dispose() { while (this.out.length) this._drop(0); }
}

const FLAT = { supportY: () => 0, heightAt: () => 0 };

/**
 * Did anybody see it happen at (x, z)? ctx = { peds, cars, city, night }:
 *   peds   js/pedestrians.js (anybody alive within WITNESS_R)
 *   cars   an iterable of cars with somebody driving (`ai` set), the victim's
 *          own excluded by the caller
 *   city   the streamed city (a building within WITNESS_R, when `night` says
 *          windows are lit: 0..1, lit from 0.3)
 * Returns 'person', 'window' or null.
 */
export function witnessed(x, z, ctx) {
  const R = WITNESS_R, R2 = R * R;
  try { if (ctx.peds?.nearest?.(x, z, R, (p) => !p.dead)) return 'person'; } catch { /* no crowd */ }
  if (ctx.cars) for (const c of ctx.cars) {
    if (!c.ai) continue;
    const dx = c.x - x, dz = c.z - z;
    if (dx * dx + dz * dz < R2) return 'person';
  }
  const idx = ctx.city?.chunkIndex;
  if (idx && (ctx.night ?? 0) >= 0.3) {
    for (let ox = -R; ox <= R; ox += R) for (let oz = -R; oz <= R; oz += R) {   // R < CHUNK: every cell in reach
      const cell = idx.get(chunkKey(x + ox, z + oz));
      if (!cell?.buildings) continue;
      for (const b of cell.buildings) {
        const p = b.o?.[0];
        if (!p) continue;
        const dx = p[0] - x, dz = p[1] - z;
        if (dx * dx + dz * dz < R2) return 'window';
      }
    }
  }
  return null;
}
