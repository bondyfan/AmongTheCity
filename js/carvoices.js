// ---- the main-thread half of the car voices -----------------------------------
// Once a frame this turns the state of the game (the player's car, the traffic
// near the ears) into what public/worklets/carmixer.js needs to make sound: for
// every voice its revs, load, speed, distance, bearing and closing speed.
//
// It owns one drivetrain per voice (js/drivetrain.js: gears, clutch, limiter)
// and the voice budget (js/voicebudget.js). It makes no sound itself and knows
// nothing about WebAudio: `post` is whatever delivers a message to the mixer,
// which is a MessagePort in the game and a plain function call in node. That is
// what lets the tests and the offline renders run the very code the game runs.

import { makeDrivetrain, drivetrainStep, throttleFromMotion } from './drivetrain.js';
import { makeThrustDrive, thrustStep } from './thrustdrive.js';
import { vehicleVoice, voiceKey, voiceClass } from './enginekinds.js';
import { assignVoices } from './voicebudget.js';

// Mirrors of the layout constants in public/worklets/carmixer.js. That file is
// served as it stands and cannot be imported from here; tests/caraudio.test.mjs
// checks the two copies stay equal.
export const MAX_VOICES = 9, HEAD = 2, STRIDE = 10, FRAME_LEN = HEAD + MAX_VOICES * STRIDE;
export const MAX_DIST = 130;
const F_ON = 0, F_RPM = 1, F_LOAD = 2, F_CUT = 3, F_SPEED = 4, F_BRAKE = 5,
  F_COBBLE = 6, F_DIST = 7, F_PAN = 8, F_VR = 9;
const REUSE_AFTER = 0.2;      // s a dropped slot rests while its voice fades out

export class CarVoices {
  constructor(post) {
    this.post = post;
    this.frameBuf = new Float32Array(FRAME_LEN);
    this.sent = new Set();                      // engine specs the mixer has
    this.slots = new Array(MAX_VOICES - 1).fill(null);   // traffic ids, slot = index + 1
    this.state = Array.from({ length: MAX_VOICES }, () => null);
    this.freedAt = new Float64Array(MAX_VOICES).fill(-1);
    this.t = 0;
    this._cands = [];
    this._blocked = (i) => this.t - this.freedAt[i + 1] < REUSE_AFTER;
  }

  _voice(slot, kind, seed) {
    const K = vehicleVoice(kind), key = voiceKey(kind);
    if (key && !this.sent.has(key)) {
      this.sent.add(key);
      // a thruster kind sends `thr` where a piston kind sends `eng`, and says so
      this.post(K.thr ? { t: 'spec', key, eng: K.thr, cls: voiceClass(kind) } : { t: 'spec', key, eng: K.eng });
    }
    this.post({ t: 'voice', slot, key, seed, heavy: K.heavy ?? (K.air ? 1 : 0), rail: K.rail ?? 0, loud: K.loud });
    return this.state[slot] = {
      K, dt: K.box ? makeDrivetrain(K.box) : null, td: K.thr ? makeThrustDrive(K.drive) : null, kind,
      v: -1, acc: 0, d: -1, vr: 0, moved: 0, stopped: 0,
      x: 0, z: 0, cob: 0, cobT: 0,     // cobT is set by whoever can see the map
    };
  }

  /** The player has taken the wheel of a car of this kind. */
  playerStart(kind) { this._voice(0, kind, 1); this.playerOn = 1; }
  playerStop() {
    if (!this.playerOn) return;
    this.playerOn = 0; this.state[0] = null; this.post({ t: 'free', slot: 0 });
  }

  /** The player's revs and gear, for the HUD or a test. Null on foot. For a
   *  thruster kind it is the thrust drive: rpm, load, thrust, tank. */
  get player() { return this.state[0]?.dt ?? this.state[0]?.td ?? null; }

  /**
   * One frame.
   *   player    null on foot, else { speed, throttle, slip, brake, cobble }
   *   cabin     0 outside .. 1 in the driver's seat
   *   traffic   [{ id, kind, x, z, speed }] within earshot, any order
   *   ears      { x, z, dx, dz }: where the listener is and which way it faces
   */
  frame(dt, player, cabin, traffic, ears) {
    const f = this.frameBuf;
    this.t += dt;
    f.fill(0);
    f[0] = cabin;
    const p = this.state[0];
    if (p && player) {
      const b = HEAD;
      f[b + F_ON] = 1;
      f[b + F_SPEED] = Math.abs(player.speed);
      f[b + F_BRAKE] = player.brake ?? 0;
      f[b + F_COBBLE] = player.cobble ?? 0;
      if (p.dt) {
        drivetrainStep(p.dt, Math.abs(player.speed), player.throttle, dt, player.slip ?? 0);
        f[b + F_RPM] = p.dt.rpm; f[b + F_LOAD] = p.dt.load; f[b + F_CUT] = p.dt.cut;
      } else if (p.td) {
        thrustStep(p.td, Math.abs(player.speed), player.throttle, dt, player.slip ?? 0);
        f[b + F_RPM] = p.td.rpm; f[b + F_LOAD] = p.td.load; f[b + F_CUT] = p.td.thrust;
      }
      this._air(0, p, Math.abs(player.speed), player.brake ?? 0);
    }
    this._traffic(dt, traffic, ears, f);
    this.post(f);
  }

  _traffic(dt, traffic, ears, f) {
    // ---- who is worth hearing
    const cands = this._cands; cands.length = 0;
    if (traffic && ears) {
      for (const c of traffic) {
        const d = Math.hypot(c.x - ears.x, c.z - ears.z);
        if (d < MAX_DIST) cands.push({ id: c.id, d, loud: vehicleVoice(c.kind).loud, c });
      }
    }
    const { taken, dropped } = assignVoices(cands, this.slots, MAX_DIST, this._blocked);
    for (const s of dropped) {
      this.state[s + 1] = null; this.freedAt[s + 1] = this.t; this.post({ t: 'free', slot: s + 1 });
    }
    for (const [s, cand] of taken) this._voice(s + 1, cand.c.kind, 2 + ((this.t * 977) | 0) + s);
    // ---- and what each of them is doing
    for (const cand of cands) {
      const s = this.slots.indexOf(cand.id);
      if (s < 0) continue;
      const st = this.state[s + 1], c = cand.c, b = HEAD + (s + 1) * STRIDE;
      const v = Math.abs(c.speed);
      // traffic has no pedal: guess it from how the speed is changing
      const a = st.v < 0 || dt <= 0 ? 0 : (v - st.v) / dt;
      st.acc += (Math.max(-12, Math.min(12, a)) - st.acc) * Math.min(1, dt * 5);
      st.v = v;
      // closing speed, for the Doppler delay to coast on between frames
      const vr = st.d < 0 || dt <= 0 ? 0 : (cand.d - st.d) / dt;
      st.vr += (Math.max(-90, Math.min(90, vr)) - st.vr) * Math.min(1, dt * 8);
      st.d = cand.d;
      const brake = st.acc < -1.2 ? Math.min(1, -st.acc / 7) : 0;
      f[b + F_ON] = 1; f[b + F_SPEED] = v; f[b + F_BRAKE] = brake;
      st.x = c.x; st.z = c.z;
      st.cob += (st.cobT - st.cob) * Math.min(1, dt * 6);
      f[b + F_COBBLE] = c.cobble ?? st.cob;
      f[b + F_DIST] = cand.d; f[b + F_VR] = st.vr;
      // bearing against the listener's own right-hand side, -1..1
      const L = cand.d || 1, rx = -ears.dz, rz = ears.dx;
      f[b + F_PAN] = ((c.x - ears.x) * rx + (c.z - ears.z) * rz) / L * Math.min(1, cand.d / 3);
      if (st.dt) {
        const th = throttleFromMotion(v, st.acc, st.K.vmax, st.K.accel * 0.6);
        drivetrainStep(st.dt, v, th, dt, 0);
        f[b + F_RPM] = st.dt.rpm; f[b + F_LOAD] = st.dt.load; f[b + F_CUT] = st.dt.cut;
      } else if (st.td) {
        thrustStep(st.td, v, throttleFromMotion(v, st.acc, st.K.vmax, st.K.accel * 0.6), dt, 0);
        f[b + F_RPM] = st.td.rpm; f[b + F_LOAD] = st.td.load; f[b + F_CUT] = st.td.thrust;
      }
      this._air(s + 1, st, v, brake);
    }
  }

  // A bus or a lorry stopping lets its brake air go, and again as it moves off.
  _air(slot, st, v, brake) {
    if (!st.K.air) return;
    if (v > 3) st.moved = 1;
    if (v < 0.35) {
      if (st.moved) { st.moved = 0; this.post({ t: 'hiss', slot, level: 1 }); }
      st.stopped = 1;
    } else if (st.stopped && v > 0.8 && brake < 0.1) {
      st.stopped = 0; this.post({ t: 'hiss', slot, level: 0.45 });
    }
  }

  /** A collision. k 0..1; give x,z and ears for one that is not the player's own. */
  hit(k, x, z, ears) {
    let pan = 0, gain = 1;
    if (ears && x !== undefined) {
      const dx = x - ears.x, dz = z - ears.z, d = Math.hypot(dx, dz);
      if (d > MAX_DIST) return;
      pan = d > 2 ? (dx * -ears.dz + dz * ears.dx) / d : 0;
      gain = 7 / Math.max(7, d) * (1 - (d / MAX_DIST) ** 2);
    }
    this.post({ t: 'hit', k, pan, gain });
  }

  /** Silence everything: the menu, a wreck, leaving the game. */
  stop() {
    this.playerStop();
    for (let s = 0; s < this.slots.length; s++) {
      if (this.slots[s] !== null) { this.slots[s] = null; this.state[s + 1] = null; this.freedAt[s + 1] = this.t; }
    }
    this.post({ t: 'stop' });
  }
}
