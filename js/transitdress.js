// ---- transitdress.js: what a bus on a line wears -------------------------------
// The traffic gives a timetabled trip an ordinary car mesh (js/traffic.js
// _attach). This module finds those cars each frame and hangs on them what
// makes them a bus OF A LINE: the destination displays (js/destsign.js) and,
// on a trolleybus, the poles (js/trolleypoles.js), which it then keeps on the
// wire. Nothing here is shared state: it reads the schedule and draws.

import * as VEH from './vehicles.js';
import { nightKOf } from './sky.js';
import { DestSigns } from './destsign.js';
import { TrolleyPoles } from './trolleypoles.js';
import { TRANSIT_BODY } from './transitbody.js';

export class TransitDress {
  constructor({ traffic, vehicles, world, deadAt = null }) {
    this.traffic = traffic;
    this.vehicles = vehicles;
    this.signs = new DestSigns();
    this.poles = new TrolleyPoles(world?.terrain ?? null, deadAt);
    this.world = world;
    this._poled = [];             // { car, rig }: every trolleybus that has a mesh
  }

  update(dt, t01) {
    this.signs.update(nightKOf(t01 ?? 0.5));
    for (const car of this.traffic.cars) {
      const line = car.ai?.fixed?.tag;
      if (!line || !TRANSIT_BODY[car.kind]) continue;
      const ud = car.mesh.userData;
      let d = ud.transit;
      if (!d) {
        const body = ud.body ?? car.mesh, surface = VEH.bodySurface(car.kind);
        d = ud.transit = { sign: this.signs.attach(body, car.kind, surface, line), poles: null };
        if (!this.poles.terrain) this.poles.terrain = this.world?.terrain ?? null;
        d.poles = this.poles.attach(body, car.kind, surface);
        if (d.poles) this._poled.push({ car, rig: d.poles });
      }
      this.signs.use(d.sign);
    }
    // the poles of every trolleybus there is, driven or not: one somebody
    // stole (no schedule any more) has to let go of the wire too
    const P = this._poled;
    for (let i = P.length - 1; i >= 0; i--) {
      const { car, rig } = P[i];
      if (!this.vehicles.cars.has(car)) { P[i] = P[P.length - 1]; P.pop(); continue; }
      this.poles.update(rig, car, car.ai?.route ? car.ai : null, dt);
    }
  }
}
