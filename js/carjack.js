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
// rule in Frank's words: a person within a hundred metres, or a building with
// a light on within a hundred metres.
//
// At most MAX bodies at once; an older one makes way. Local, like the crowd's
// own ragdolls: nothing here is on the wire.

import { makeCitizen } from './citizen.js';
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

const _feet = { x: 0, y: 0, z: 0 };
const _q = { x: 0, z: 0 };
const _o = { interior: true, yLo: 0, yHi: 0, aboveY: 0 };

export class Carjack {
  /** { scene, world, makeBody }: makeBody is for tests; the default is a citizen. */
  constructor(opts = {}) {
    this.scene = opts.scene ?? null;
    this.world = opts.world ?? null;
    // anybody who drives: not the ninety-year-old on a stick
    this.makeBody = opts.makeBody ?? (() => makeCitizen({ archetype: DRIVERS[(Math.random() * DRIVERS.length) | 0] }));
    this.out = [];
  }

  /**
   * The driver of `car` leaves through the door on `side` (-1 left, +1 right).
   * seat: where they sat, in the car's frame. Returns the record.
   */
  throwOut(car, side, seat) {
    while (this.out.length >= MAX) this._drop(0);
    const body = car._victim ?? this.makeBody();
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
    const r = { body, st, t: 0, phase: 'thrown', x: st.x, z: st.z, y: st.gy, heading: st.yaw, walkT: 0, lay: null };
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
    const body = this.makeBody();
    body.group.scale.setScalar(PLAYER_SCALE);
    (car.mesh.userData?.body ?? car.mesh).add(body.group);
    body.group.position.set(seatX(seat.x), seat.y - SIT_DROP, seat.z);
    body.group.rotation.set(0, 0, 0);
    body.sitPose?.(1);
    car._victim = body;
  }

  /** px, pz: who they are running from. */
  update(dt, px, pz) {
    for (let i = this.out.length - 1; i >= 0; i--) {
      const r = this.out[i];
      r.t += dt;
      if (r.phase !== 'run') {
        const going = stepBody(r.st, dt, this.world ?? FLAT, null);
        this._place(r);
        if (r.st.phase === 'rise') {
          r.lay ??= snapshot(r.body.parts);
          r.body.standPose();
          getUpPose(r.body.parts, r.st.rise ?? 0, r.st.faceUp, r.lay);
        }
        if (!going) {
          r.phase = 'run'; r.t = 0;
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
