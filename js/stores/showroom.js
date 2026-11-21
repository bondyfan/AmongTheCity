// ---- stores/showroom.js: a car showroom the player can walk into ----
// Main thread. The inside of a maker's own store (js/stores/chains.js kind
// 'showroom'): cars standing on the floor, a card by each, the advisers' desk.
//
// THE DISPLAY CARS are ordinary vehicles in main.js's `parked` list, left open:
// E gets into one, B buys one that has a price (js/garage.js), and the gate
// opens for it. Which car stands on which stand is a function of the store's
// key and the stand's slot (js/stores/showlayout.js), so two co-op players see
// the same red Roadster behind the same gate without a word on the wire. Like
// a car at the kerb (js/kerbparking.js), one that somebody drove away does not
// come back this session, and each client keeps that to itself.
//
// DRIVING ONE AWAY is theft the moment it leaves the premises: two stars at
// once (showlayout.js watchDisplay, called by js/stores/world.js every frame).

import { registerInterior } from './world.js';
import { showLayout, SHOW_CARS } from './showlayout.js';
import { isOpen } from './chains.js';
import { hashK } from './site.js';
import { FINISH, packLook } from '../carlook.js';
import { archetypeAt } from '../people.js';
import { PLAYER_SCALE } from '../config.js';

const R_CAR = 3.4, R_SPEC = 1.3;
/** Stands whose car has been taken this session: store key and slot. */
const TAKEN = new Set();
/** For the tests: a new session. */
export function resetShowrooms() { TAKEN.clear(); }

const heading = (dx, dz) => Math.atan2(-dx, -dz);

export class ShowShop {
  constructor(rec, layout, d) {
    this.rec = rec; this.layout = layout; this.d = d;
    this.driveHint = true;                       // it has a word for somebody at the wheel too
    this.cars = [];                              // { st, car }
    this.adviser = null;
    this.greeted = false;
    for (const st of layout.stands) this._park(st);
  }

  /** Stand a display car on its stand, unless it was taken earlier this session. */
  _park(st) {
    const C = this.d.cars;
    if (!C || TAKEN.has(st.id)) return;
    // showroom paint: full gloss, not a speck on it
    const car = C.add(st.kind, st.x, st.z, st.heading, st.color, packLook(FINISH.GLOSS, 0, st.slot & 7, false));
    car.unlocked = true;                         // (js/carlocks.js) a display car is open
    car._grounded = true;
    car._show = { o: this.rec.f.o, id: st.id, name: st.name, gone: false };
    C.parked.push(car);
    this.cars.push({ st, car });
  }

  /** Is this display car still standing on its stand, with nobody in it? */
  _onStand(e) {
    const C = this.d.cars, c = e.car;
    return C.parked.includes(c) && !c.owned && C.driving() !== c && C.riding() !== c
      && Math.hypot(c.x - e.st.x, c.z - e.st.z) < 0.8;
  }

  _nearCar(x, z) {
    let best = R_CAR, hit = null;
    for (const e of this.cars) {
      if (!this.d.cars.parked.includes(e.car)) continue;
      const dd = Math.hypot(e.car.x - x, e.car.z - z);
      if (dd < best) { best = dd; hit = e; }
    }
    return hit;
  }
  _nearSpec(x, z) {
    for (const p of this.layout.points) if (p.kind === 'spec' && Math.hypot(p.x - x, p.z - z) < R_SPEC) return p;
    return null;
  }

  hint(x, z, env) {
    const drv = env?.car;
    if (drv?._show && !drv._show.gone && !drv.owned)
      return 'Vystavený vůz · když s ním odjedeš, jde po tobě policie';
    if (!env?.onFoot) return '';
    const sp = this._nearSpec(x, z);
    if (sp) return 'E · technické údaje';
    const e = this._nearCar(x, z);
    if (e) return 'E nasednout · ' + e.st.name + (e.car.owned ? '' : ' (vystavený vůz)');
    return '';
  }

  /** E: only the card on a stand is the showroom's; a car's door is main.js's. */
  use(x, z, env) {
    if (!env?.onFoot) return false;
    const sp = this._nearSpec(x, z);
    if (!sp) return false;
    const st = this.layout.stands[sp.slot];
    this.d.toast(st.name, { icon: '⚡', sub: st.spec });
    return true;
  }

  update(dt, x, z, inside, env) {
    const open = isOpen(this.rec.chain, this.d.hour());
    if (inside && !this.greeted && open) {
      this.greeted = true;
      this.d.toast('Tesla Centrum Praha', { icon: '⚡', sub: 'Do vystavených vozů si můžeš sednout.' });
    }
    // ---- the adviser behind the desk ----
    const st = this.layout.staff[0];
    if (!st || !this.d.makeCitizen) return;
    if (!open) { this.adviser?.dispose(); this.adviser = null; return; }
    if (!this.adviser) {
      const seed = (this.rec.key ^ 0x51ed) >>> 0;
      const c = this.d.makeCitizen({ archetype: archetypeAt(hashK(seed, 11)).key, seed, prop: null });
      c.group.scale.setScalar(PLAYER_SCALE);
      this.d.scene.add(c.group);
      this.adviser = c;
    }
    const c = this.adviser, r = this.layout.room;
    c.group.position.set(st.x, this.rec.base + this.rec.site.floor + 0.03, st.z);
    // they look at whoever is in the room, else out over the floor
    c.group.rotation.y = inside ? heading(x - st.x, z - st.z) : heading(r.ax * -1, r.az * -1);
    c.standPose();
  }

  dispose() {
    const C = this.d.cars;
    for (const e of this.cars) {
      if (this._onStand(e)) {
        C.parked.splice(C.parked.indexOf(e.car), 1);
        C.remove(e.car);
      } else TAKEN.add(e.st.id);                 // driven, bought or shunted: it is gone from the stand
    }
    this.cars.length = 0;
    this.adviser?.dispose();
    this.adviser = null;
  }
}

registerInterior('showroom', { layout: showLayout, Shop: ShowShop });
export { SHOW_CARS };
