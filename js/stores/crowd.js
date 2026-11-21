// ---- stores/crowd.js: the people in a shop ----
// Main thread. The bodies of js/stores/schedule.js's plans: shoppers pushing a
// trolley or carrying a basket from shelf to shelf and through a till,
// cashiers sitting at the open tills and scanning what comes down the belt,
// the crew behind a restaurant's counter, guests at its kiosks and tables.
//
// They are the game's own people (js/citizen.js, the modelled humans when the
// bank is loaded) played with their recorded walking, standing and sitting; a
// reaching hand, a scanning arm and a bite are added on top, joint by joint,
// the way the campaign's scenes do it. Bodies exist only while the store's
// interior does, and are made one a frame so a full shop is not one hitch.

import { registerCrowd } from './world.js';
import { marketPlan, fastPlan, at, visit, slotCount, slotsOut, tillsOpen } from './schedule.js';
import { carrierMesh } from './props.js';
import { archetypeAt } from '../people.js';
import { hashK } from './site.js';
import { PLAYER_SCALE } from '../config.js';

const DROP = 0.425;                    // hips down onto a chair (js/prologue-seat.js)
const heading = (dx, dz) => Math.atan2(-dx, -dz);
const _s = {};

class Crowd {
  constructor(rec, layout, d) {
    this.rec = rec; this.layout = layout; this.d = d;
    this.fast = layout.kind === 'fast';
    this.slots = new Array(slotCount(layout)).fill(null);    // { c, walkT, plan, cycle, carry }
    this.staff = [];                                         // { c, st }
    this.doorT = 0;
    this._plans = new Map();
    this._staffDone = false;
  }
  _plan(slot, cycle) {
    const k = slot + ':' + cycle;
    let p = this._plans.get(k);
    if (!p) {
      if (this._plans.size > 64) this._plans.clear();
      p = (this.fast ? fastPlan : marketPlan)(this.layout, slot, cycle);
      this._plans.set(k, p);
    }
    return p;
  }
  _body(seed, prop) {
    const c = this.d.makeCitizen({ archetype: archetypeAt(hashK(seed, 11)).key, seed: seed >>> 0, prop });
    c.group.scale.setScalar(PLAYER_SCALE);
    this.d.scene.add(c.group);
    return c;
  }
  _place(c, a, b, y, h) {
    const [x, z] = this.layout.room.at(a, b);
    c.group.position.set(x, y, z);
    c.group.rotation.y = h;
    return [x, z];
  }
  /** World heading for a direction given in the room's axes. */
  _h(da, db) {
    const r = this.layout.room;
    return heading(r.ax * da + r.bx * db, r.az * da + r.bz * db);
  }

  _makeStaff() {
    const L = this.layout, key = this.rec.key;
    if (this.fast) L.staff.forEach((st, i) => this.staff.push({ c: null, st, i, seed: key ^ (i * 7919 + 13) }));
    else L.tills.forEach((t, i) => this.staff.push({ c: null, till: t, i, seed: key ^ (i * 7919 + 13) }));
    this._staffDone = true;
  }

  update(dt, ctx) {
    const L = this.layout, floor = this.rec.base + this.rec.site.floor + 0.03, now = this.d.time();
    if (!this._staffDone) this._makeStaff();
    let made = false;
    this.doorT = Math.max(0, this.doorT - dt);
    // ---- the crew ----
    const openTills = this.fast ? 0 : tillsOpen(L.tills.length, ctx.hour);
    for (const s of this.staff) {
      const on = ctx.open && (this.fast || s.i < openTills);
      if (!on) { if (s.c) { s.c.dispose(); s.c = null; } continue; }
      if (!s.c) { if (made) continue; s.c = this._body(s.seed, null); made = true; }
      const c = s.c, J = c.parts;
      if (this.fast) {
        const st = s.st;
        // the kitchen hands walk between the grill and the pass; the counter staff stand
        const sway = st.role === 'kitchen' ? Math.sin(now * 0.35 + s.i * 2) * 1.2 : 0;
        this._place(c, st.a, st.b + sway, floor, this._h(-1, 0));
        if (st.role === 'kitchen' && Math.abs(Math.cos(now * 0.35 + s.i * 2)) > 0.25) {
          s.walkT = (s.walkT ?? 0) + Math.abs(Math.cos(now * 0.35 + s.i * 2)) * 0.42 * dt * 1.6;
          c.group.rotation.y = this._h(0, Math.cos(now * 0.35 + s.i * 2));
          c.walk(s.walkT, 0.3, 0, 0.42);
        } else {
          c.standPose();
          if (J?.armR) { J.armR.rotation.x = -0.75 - 0.2 * Math.sin(now * 2.2 + s.i); J.elbowR.rotation.x = 0.9; J.armL.rotation.x = -0.7; J.elbowL.rotation.x = 0.95; }
        }
      } else {
        const t = s.till;
        this._place(c, t.seat.a, t.seat.b, floor - DROP, this._h(0, 1));
        c.sitPose(1, 0);
        // scanning: somebody is paying here (a shopper in the plans, or the player)
        const scan = this.d.scanning?.();
        const busy = this._paying === s.i || (scan && !scan.self && scan.till.i === s.i);
        if (J?.armR) {
          const sw = busy ? Math.sin(now * 5.2 + s.i) : 0;
          J.armR.rotation.set(-0.95 - 0.12 * sw, 0, 0.1 + 0.5 * (busy ? sw : 0));
          J.elbowR.rotation.x = 1.05 + 0.25 * (busy ? Math.cos(now * 5.2) : 0);
          J.armL.rotation.set(-0.85, 0, -0.1); J.elbowL.rotation.x = 1.1;
        }
      }
    }
    // ---- the customers ----
    const out = slotsOut(L, ctx.hour);
    this._paying = -1;
    for (let i = 0; i < this.slots.length; i++) {
      let b = this.slots[i];
      const v = visit(L, i, now);
      const plan = i < out && ctx.open ? this._plan(i, v.cycle) : null;
      const st = plan ? at(plan, v.u, _s) : null;
      if (!st?.present) { if (b) { b.c.dispose(); b.carry?.dispose(); this.slots[i] = null; } continue; }
      if (!b || b.cycle !== v.cycle) {
        if (b) { b.c.dispose(); b.carry?.dispose(); this.slots[i] = null; }
        if (made) continue;
        made = true;
        const seed = (this.rec.key ^ (i * 104729 + v.cycle * 31)) >>> 0;
        b = this.slots[i] = { c: this._body(seed, this.fast ? null : plan.trolley ? 'pram' : 'bag'), walkT: 0, cycle: v.cycle, carry: null, h: 0 };
        if (!this.fast) {
          b.carry = carrierMesh(plan.trolley ? 'trolley' : 'basket', this.rec.chain.trolley ?? this.rec.chain.sign.bg);
          this.d.scene.add(b.carry);
        }
      }
      const c = b.c, J = c.parts;
      // near the door: it opens for them too
      if (st.a < 2.4 && st.a > -2.6 && Math.abs(st.b - L.lane.c) < 2.4) this.doorT = 0.6;
      let y = st.a < 0 ? this.d.world.heightAt(...L.room.at(st.a, st.b)) : floor, h = b.h;
      if (st.moving) {
        h = this._h(st.da, st.db);
        b.walkT += plan.speed * dt * 1.6;
        c.walk(b.walkT, plan.speed / 1.4, 0, plan.speed);
      } else if (st.act === 'sit') {
        h = this._h(st.face, 0); y -= DROP;
        c.sitPose(1, 0);
        if (J?.armR) {
          const bite = Math.max(0, Math.sin(now * 1.9 + i * 1.7));
          J.armR.rotation.set(-0.35 - 0.75 * bite, 0, 0.12); J.elbowR.rotation.x = 1.25 + 0.95 * bite;
          J.armL.rotation.set(-0.3, 0, -0.1); J.elbowL.rotation.x = 1.2;
        }
      } else {
        h = st.act === 'look' || st.act === 'pay' && !this.fast ? this._h(0, st.face) : st.face ? this._h(st.face, 0) : b.h;
        c.standPose();
        if (st.act === 'pay' && !this.fast) this._paying = plan.till;
        if (J?.armR && (st.act === 'look' || st.act === 'kiosk')) {
          // a hand to the shelf, or tapping at the screen
          const reach = st.act === 'look' ? Math.max(0, Math.sin(st.k * Math.PI * 3)) : 0.6 + 0.25 * Math.sin(now * 6);
          J.armR.rotation.set(-1.25 * reach, 0, 0.08); J.elbowR.rotation.x = 0.5 * reach;
        }
      }
      // turn toward the new heading, do not snap
      let dh = h - b.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      b.h += dh * Math.min(1, dt * 9);
      const [x, z] = this._place(c, st.a, st.b, y, b.h);
      if (b.carry) {
        const fx = -Math.sin(b.h), fz = -Math.cos(b.h);
        if (plan.trolley) { b.carry.position.set(x + fx * 0.9, y, z + fz * 0.9); b.carry.rotation.y = b.h; }
        else { b.carry.position.set(x - fz * 0.34 + fx * 0.08, y + 0.62, z + fx * 0.34 + fz * 0.08); b.carry.rotation.y = b.h + Math.PI / 2; }
        b.carry.setCount(Math.round(v.u / plan.dur * (plan.trolley ? 30 : 9)));
      }
    }
  }
  /** Is one of them at the door (it slides open for them)? */
  atDoor() { return this.doorT > 0; }
  /** A chair one of the regulars sits on is never offered to the player. */
  seatBusy(i) {
    if (!this.fast) return false;
    for (let s = 0; s < this.slots.length; s++) {
      const n = this.layout.seats.length;
      if (n && (Math.floor(hashK(this.layout.key, 900) * n) + s * 3) % n === i) return true;
    }
    return false;
  }
  dispose() {
    for (const b of this.slots) if (b) { b.c.dispose(); b.carry?.dispose(); }
    for (const s of this.staff) s.c?.dispose();
    this.slots.fill(null); this.staff.length = 0;
  }
}

// (a showroom has its own adviser and no shoppers' plans: js/stores/showroom.js)
registerCrowd((rec, layout, d) => (d.makeCitizen && layout.kind !== 'showroom' ? new Crowd(rec, layout, d) : null));
