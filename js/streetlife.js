// ---- streetlife.js: the small life of a street, in one place ------------------
// Birds (js/birds.js), the dogs people walk (js/dogs.js) and the prams they
// push (js/pedpropdraw.js). main.js builds this once, next to the crowd, and
// calls update() once a frame after the crowd has moved; that is the whole
// wiring. The bag in a hand and the phone at an ear need none: they are part
// of the walker's own mesh (js/bodyextras.js).
//
// WHAT IT COSTS: four draw calls in all (birds, dogs, leads, prams), whatever
// the number of animals, and a few hundredths of a millisecond of script.
//
// SHARED / LOCAL, for co-op:
//   shared  where flocks live and which birds they are; the flocks passing
//           overhead; who has a dog, a pram, a bag or a phone, and which
//   local   a flock scared into the air and where it went; where a dog has its
//           nose this second; the switch below
//
// `__atc.life.birds.enabled = false` (and .dogs, .prams) switches a part off
// in a running game, for an A/B of the frame time.

import { Birds } from './birds.js';
import { Dogs } from './dogs.js';
import { Prams } from './pedpropdraw.js';
import { signPerches } from './meshes.js';
import { tod, worldT } from './worldclock.js';

export class StreetLife {
  /** @param o { city, world, peds } */
  constructor(scene, { city, world, peds }) {
    this.peds = peds;
    const signs = new Map();           // chunk key -> its sign tops, worked out once
    this.birds = new Birds(scene, {
      city, world, sites: peds?.sites ?? null,
      signs: (key) => {
        let s = signs.get(key);
        if (!s) {
          if (signs.size > 400) signs.clear();
          signs.set(key, s = signPerches(city, key, world.terrain));
        }
        return s;
      },
      hourOf: () => tod() * 24,
      clock: () => worldT(),
    });
    // a dog stands on what its owner walks on
    this.dogs = new Dogs(scene, { groundY: (x, z) => (peds?.terrain ? peds.terrain.heightAt(x, z) : 0) });
    this.prams = new Prams(scene);
    this._threat = { x: 0, z: 0, speed: 0, inCar: false, cars: null, car: null, peds: null };
    this._lx = NaN; this._lz = 0;
    // a new tile can move a sign's kerb: let its chunks be worked out again
    city.onTileLoaded?.(() => signs.clear());
  }

  /** A bang at (x, z): every bird that heard it goes up. */
  scare(x, z, r) { this.birds.scare(x, z, r); }

  /**
   * Once a frame, after peds.update().
   * @param focus     the player's position { x, z }
   * @param view      viewerState() or null
   * @param playerCar the car being driven, or null
   * @param cars      the AI cars (anything iterable of { x, z, speed })
   */
  update(dt, focus, view, playerCar = null, cars = null) {
    const th = this._threat, list = this.peds?.peds ?? [];
    // how fast the player is going, from where they were last frame
    const moved = Number.isFinite(this._lx) ? Math.hypot(focus.x - this._lx, focus.z - this._lz) : 0;
    this._lx = focus.x; this._lz = focus.z;
    const v = dt > 0 && moved < 30 ? moved / dt : 0;
    th.speed += (v - th.speed) * Math.min(1, dt * 6);
    th.x = focus.x; th.z = focus.z; th.inCar = !!playerCar;
    th.cars = cars; th.car = playerCar;
    th.peds = list;
    this.birds.update(dt, focus, view, th);
    this.dogs.update(dt, list, focus);
    this.prams.update(list);
  }

  dispose() { this.birds.dispose(); this.dogs.dispose(); this.prams.dispose(); }
}
