// ---- stores/eating.js: ordering, sitting down and eating at a fast-food restaurant ----
// The local player's side of a McDonald's, a KFC or a Burger King, done the way
// it is done in Czechia: order and pay at a kiosk (or at the counter), watch
// for the number, collect the tray at the counter, sit at a free table and eat.
// The drive-through is the same order placed from the driver's seat at the
// order post and handed out at the window, eaten in the car.
//
// What a meal does goes through js/vitals.js like every other meal in the game:
// it heals and it fills, a little with every bite while seated.

import * as THREE from 'three';
import { registerInterior } from './world.js';
import { eatLayout } from './eatlayout.js';
import { menuOf } from './catalog.js';
import { isOpen } from './chains.js';
import { driveOf } from './drive.js';
import { around } from './site.js';
import { FITTINGS } from './fixgeo.js';
import { fixtureMaterial } from './fixtures.js';
import { paid, refused, chime } from './sounds.js';
import { kc } from '../prices.js';

const R_USE = 1.5, R_SEAT = 1.2, R_DRIVE = 4.2;
const SIT = 0.9;            // seconds to sit down
const DROP = 0.425;         // how far the hips come down onto a chair (js/prologue-seat.js)
let _tray = null;

export class EatShop {
  constructor(rec, layout, d) {
    this.rec = rec; this.layout = layout; this.d = d;
    this.driveHint = true;                       // has something to say to a driver too
    // the lane the map has, decided once per building (the chunk mesh stood its post by the same answer)
    this.drive = rec.chain.eat?.drive ? driveOf(rec.f, around(rec.f, null)?.roads) : null;
    this.seat = null;                            // the chair the player is on
    this.sitT = 0; this.rising = false; this.eaten = 0; this.meal = null;
    this.tray = null; this.told = false; this.wasInside = false;
    this.seq = 40 + Math.floor(layout.seed(77) * 50);
  }
  get order() { return this.d.order; }
  get mine() { return this.order.store === this.rec.key; }

  _near(x, z, kind, r) {
    let best = r, hit = null;
    for (const p of this.layout.points) {
      if (p.kind !== kind) continue;
      const dd = Math.hypot(p.x - x, p.z - z);
      if (dd < best) { best = dd; hit = p; }
    }
    return hit;
  }
  _freeSeat(x, z) {
    let best = R_SEAT, hit = null;
    for (const s of this.layout.seats) {
      if (this.d.seatBusy?.(this.rec, s.i)) continue;
      const dd = Math.hypot(s.x - x, s.z - z);
      if (dd < best) { best = dd; hit = s; }
    }
    return hit;
  }

  _what(x, z, env) {
    const o = this.order, now = this.d.time(), open = isOpen(this.rec.chain, this.d.hour());
    if (env?.car) return this._whatDrive(env.car, now, open);
    if (this.seat) return { html: this.meal ? '<kbd>E</kbd> vstát od stolu' : '<kbd>E</kbd> vstát', act: () => { this.rising = true; } };
    if (!open) return null;
    if (o.state === 'tray' && this.mine) {
      const s = this._freeSeat(x, z);
      if (s) return { html: '<kbd>E</kbd> sednout si a najíst se', act: () => this._sit(s) };
      return { html: 'Najdi si volnou židli', act: null };
    }
    const at = this._near(x, z, 'counter', R_USE), kiosk = this._near(x, z, 'kiosk', R_USE);
    if (o.state === 'cooking' && this.mine) {
      if (o.ready(now)) return at ? { html: '<kbd>E</kbd> vyzvednout objednávku ' + o.number, act: () => this._collect() }
        : { html: 'Objednávka ' + o.number + ' je hotová · vyzvedni ji u pultu', act: null };
      return { html: 'Objednávka ' + o.number + ' se připravuje…', act: null };
    }
    if (o.state === 'none' && (at || kiosk))
      return { html: kiosk ? '<kbd>E</kbd> objednat na kiosku' : '<kbd>E</kbd> objednat u pultu', act: () => this._menu(false) };
    return null;
  }
  _whatDrive(car, now, open) {
    const dr = this.drive, o = this.order;
    if (!dr || !open) return null;
    const slow = Math.abs(car.speed ?? 0) < 2;
    const atPost = Math.hypot(car.x - dr.ox, car.z - dr.oz) < R_DRIVE, atHatch = Math.hypot(car.x - dr.px, car.z - dr.pz) < R_DRIVE;
    if (o.state === 'none' && atPost) return slow ? { html: '<kbd>E</kbd> objednat z auta', act: () => this._menu(true) } : { html: 'Zastav u objednávkového stojanu', act: null };
    if (o.state === 'cooking' && this.mine && o.drive) {
      if (!atHatch) return atPost ? { html: 'Popojeď k výdejnímu okénku', act: null } : null;
      if (!o.ready(now)) return { html: 'Objednávka ' + o.number + ' se připravuje…', act: null };
      return slow ? { html: '<kbd>E</kbd> převzít objednávku ' + o.number, act: () => this._handOut() } : { html: 'Zastav u okénka', act: null };
    }
    return null;
  }
  hint(x, z, env) {
    if (this.d.panel.isOpen) return '';
    return this._what(x, z, env)?.html ?? '';
  }
  use(x, z, env) {
    const w = this._what(x, z, env);
    if (!w) return false;
    w.act?.();
    return !!w.act;
  }

  _menu(drive) {
    const o = this.order, chain = this.rec.chain;
    this.d.panel.menu({
      title: chain.label.toUpperCase() + (drive ? ' · Z AUTA' : ''),
      menu: menuOf(chain.id), order: o, have: () => this.d.wallet.money(),
      note: drive ? 'Zaplatíš hned. Jídlo dostaneš u výdejního okénka.' : 'Zaplatíš hned. Až bude číslo na obrazovce, vyzvedni si tác u pultu.',
      onPay: () => {
        const sum = o.total();
        if (!this.d.wallet.pay(sum, 'jídlo')) { refused(); return false; }
        this.seq = (this.seq % 99) + 1;
        o.place(this.d.time(), this.seq, this.rec.key, drive);
        this.told = false;
        paid();
        this.d.toast('Objednávka ' + o.number + ' · ' + kc(sum), { icon: '🧾', kind: 'good',
          sub: drive ? 'Popojeď k výdejnímu okénku.' : 'Sleduj číslo, tác si vyzvedneš u pultu.' });
        return true;
      },
      onClose: () => { if (o.state === 'none') o.clear(); },
    });
  }
  _collect() {
    this.order.state = 'tray';
    _tray ??= FITTINGS.tray().build();
    this.tray = new THREE.Mesh(_tray, fixtureMaterial());
    this.d.scene.add(this.tray);
  }
  /** Eat what is left of the order at once (in the car, or walking out with it). */
  _finish(sub) {
    const o = this.order, w = o.worth(), left = 1 - this.eaten;
    const hp = Math.round(w.hp * left), kcal = Math.round(w.kcal * left);
    if (hp > 0) this.d.vitals.heal(hp);
    if (kcal > 0) this.d.vitals.eat(kcal);
    this.d.onAte?.(Math.round(w.hp), Math.round(w.kcal), sub);
    o.clear();
    this.eaten = 0; this.meal = null;
    this.tray?.removeFromParent(); this.tray = null;
  }
  _handOut() { chime(); this._finish('Snědeno v autě'); }
  _sit(seat) {
    const p = this.d.player();
    this.seat = seat; this.sitT = 0; this.rising = false;
    this.from = { x: p.pos.x, z: p.pos.z, h: p.heading };
    this.meal = this.order.worth();
    this.eaten = 0;
    this.dur = Math.max(7, Math.min(18, 5 + 2.2 * this.order.count()));
  }

  /** While seated the store poses the player (js/main.js asks before player.update). */
  posePlayer(dt, p) {
    const s = this.seat;
    if (!s) return false;
    const room = this.layout.room, site = this.rec.site;
    const dirX = room.ax * s.face, dirZ = room.az * s.face;
    const facing = Math.atan2(-dirX, -dirZ);
    this.sitT = this.rising ? Math.max(0, this.sitT - dt / (SIT * 0.8)) : Math.min(1, this.sitT + dt / SIT);
    const k = this.sitT, e = k * k * (3 - 2 * k), floor = this.rec.base + site.floor + 0.03;
    if (this.rising && k === 0) {
      p.pos.x = this.from.x; p.pos.z = this.from.z; p.y = floor; p.heading = facing + Math.PI;
      this.seat = null;
      p._stand();
      if (this.meal) this._finish('Dojedeno');
      return false;
    }
    const x = this.from.x + (s.x - this.from.x) * e, z = this.from.z + (s.z - this.from.z) * e;
    let d = facing - this.from.h; d = Math.atan2(Math.sin(d), Math.cos(d));
    p.pos.x = x; p.pos.z = z; p.y = floor; p.vy = 0; p.speed = 0; p.grounded = true;
    p.heading = this.from.h + d * Math.min(1, e * 1.6);
    p.mesh.position.set(x, floor - DROP * e, z);
    p.mesh.rotation.y = p.heading;
    p._sit(e, 0);
    // ---- eating: the hand goes to the mouth, a bite every second and a half ----
    if (k === 1 && this.meal && !this.rising) {
      const before = this.eaten;
      this.eaten = Math.min(1, this.eaten + dt / this.dur);
      const hp = Math.floor(this.meal.hp * this.eaten) - Math.floor(this.meal.hp * before);
      const kc2 = Math.floor(this.meal.kcal * this.eaten) - Math.floor(this.meal.kcal * before);
      if (hp > 0) this.d.vitals.heal(hp);
      if (kc2 > 0) this.d.vitals.eat(kc2);
      const J = p._cit?.parts, bite = Math.max(0, Math.sin(this.eaten * this.dur * 4.2));
      if (J?.armR) {
        J.armR.rotation.set(-0.35 - 0.75 * bite, 0, 0.12);
        J.elbowR.rotation.x = 1.25 + 0.95 * bite;
        J.armL.rotation.set(-0.3, 0, -0.1); J.elbowL.rotation.x = 1.2;
        J.head.rotation.x = 0.18 + 0.12 * bite;
      }
      if (this.eaten >= 1) {
        const w = this.meal;
        this.d.onAte?.(Math.round(w.hp), Math.round(w.kcal), 'Dojedeno');
        this.order.clear(); this.meal = null; this.eaten = 0;
        this.tray?.removeFromParent(); this.tray = null;
      }
    }
    // the tray: on the table in front of the sitter
    if (this.tray) {
      this.tray.position.set(s.x + dirX * 0.5, floor + 0.76, s.z + dirZ * 0.5);
      this.tray.rotation.y = facing;
    }
    return true;
  }

  update(dt, x, z, inside, env) {
    const o = this.order;
    if (!this.mine) return;
    if (o.state === 'cooking' && !this.told && o.ready(this.d.time())) {
      this.told = true;
      chime();
      this.d.toast('Objednávka ' + o.number + ' je hotová', { icon: '🍔', kind: 'good', sub: o.drive ? 'Převezmi ji u výdejního okénka.' : 'Vyzvedni si tác u pultu.' });
    }
    // carrying the tray: it rides in front of the hands
    if (this.tray && !this.seat) {
      const p = this.d.player(), h = p.heading, fx = -Math.sin(h), fz = -Math.cos(h);
      this.tray.position.set(p.pos.x + fx * 0.42, p.y + 1.02, p.pos.z + fz * 0.42);
      this.tray.rotation.y = h;
      const J = p._cit?.parts;
      if (J?.armL) {
        J.armL.rotation.set(-0.28, 0, -0.1); J.armR.rotation.set(-0.28, 0, 0.1);
        J.elbowL.rotation.x = 1.25; J.elbowR.rotation.x = 1.25;
      }
      // out of the door with the tray: it is eaten on the way
      if (this.wasInside && !inside) this._finish('Snědeno cestou');
    }
    this.wasInside = inside;
  }
  dispose() {
    this.tray?.removeFromParent(); this.tray = null;
    if (this.order.state === 'tray' && this.mine) this.order.clear();
    this.seat = null;
  }
}

registerInterior('fast', { layout: eatLayout, Shop: EatShop });
