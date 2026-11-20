// ---- Garage: the one car that is YOURS ----
// Every other car in the city is somebody else's: you can take it, and it is
// gone when you reload. The one you BUY is saved (model, paint, place, tank,
// dents), drawn on both maps, repairable, and waits where you left it.
//
// What "buying" is: you stand next to a parked car (or sit in it) and press B.
// The price is that particular car's (prices.js carOffer: the list price, its
// own condition, minus its damage). One owned car at a time; buying another
// takes the old one in part exchange.
//
// LOCAL, LIKE THE WALLET. Ownership is never put on the wire. In co-op the
// peers go on seeing an ordinary parked car, and when you drive it they see
// what they always see when you drive anything (your ghost car).
//
// The host object is main.js's (see careerHost there): this file reads the
// live `parked` list and the Vehicles fleet through it and never imports
// main.js.

import * as wallet from './wallet.js';
import * as fuel from './fuel.js';
import { makeCarMesh } from './vehicles.js';
import { carOffer, repairCost, canisterCost, PRICE } from './prices.js';
import { hash32 } from './jobgen.js';
import { standsIn } from './parkinglots.js';

const REACH = 5.5;                // m: "next to" a car, for B
const TRADE_IN = 0.5;             // share of its own price the old car fetches

export class Garage {
  constructor(host) {
    this.h = host;
    this.car = null;              // the owned car object, or null
  }

  // A car's identity for pricing. The spawn fleet has a stable index; anything
  // else is named by where it was first looked at, which for a parked car is
  // where the map put it. Stamped once, so driving it does not reprice it.
  seedOf(car) {
    if (car._buySeed === undefined) {
      car._buySeed = Number.isInteger(car.parkIdx)
        ? hash32('fleet|' + car.parkIdx + '|' + car.kind)
        : hash32(car.kind + '|' + Math.round(car.x) + '|' + Math.round(car.z));
    }
    return car._buySeed;
  }

  /** The car B is about: the one being driven, else the nearest parked one. */
  carAt(x, z) {
    const h = this.h;
    if (h.game.car) return h.game.car;
    let best = null, bd = REACH;
    for (const c of h.parked) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** Everything the car panel prints about `car`. */
  view(car) {
    const mine = car === this.car;
    const damage = Math.min(1, car.damage ?? 0);
    const offer = mine ? null : carOffer(car.kind, this.seedOf(car), damage);
    const stopped = Math.abs(car.speed ?? 0) < 0.5;
    return {
      car, mine, damage, offer,
      name: (offer?.name ?? PRICE.cars.find((c) => c.kind === car.kind)?.name ?? 'Vozidlo'),
      tradeIn: !mine && this.car ? this.tradeInValue() : 0,
      fuelPct: fuel.frac(car),
      repair: mine ? repairCost(car.damage ?? 0) : 0,
      canRepair: mine && stopped,
      // nearly dry and yours: a canister can be brought out to it
      canister: mine && stopped && fuel.frac(car) < 0.12
        ? { units: PRICE.rescue.units, unit: PRICE.fuel.unit[fuel.fuelTypeOf(car.kind)],
          price: canisterCost(fuel.fuelTypeOf(car.kind)) } : null,
    };
  }

  tradeInValue() {
    const c = this.car;
    if (!c) return 0;
    const o = carOffer(c.kind, this.seedOf(c), Math.min(1, c.damage ?? 0));
    return o ? Math.round(o.price * TRADE_IN / 100) * 100 : 0;
  }

  /** Pay and take ownership. False (and nothing changed) when it cannot be done. */
  buy(car) {
    const v = this.view(car);
    if (v.mine || !v.offer) return false;
    if (Math.abs(car.speed ?? 0) > 1) return false;          // not out of a moving car
    const total = Math.max(0, v.offer.price - v.tradeIn);
    if (!wallet.pay(total, 'auto')) return false;
    this._adopt(car);
    return true;
  }

  // Make `car` the owned one. A car bought where it stands in a car park or
  // at the kerb is still on its stall's books, and both streamers remove
  // their own cars (the lot thins out for the day, the player walks away).
  // They keep their stalls private (a WeakMap each, see parkinglots.js), so
  // this does not reach in: `owned` is the flag both of them test, and a stall
  // holding an owned car lets go of it and stays empty.
  _adopt(car) {
    car._lot = false;
    if (this.car) this.car.owned = false;
    this.car = car;
    car.owned = true;
  }

  /** Ten units of fuel, delivered to the owned car. For the day it ran dry
   *  three streets from a pump. */
  canister(car) {
    if (car !== this.car) return false;
    const c = this.view(car).canister;
    if (!c || !wallet.pay(c.price, 'kanystr')) return false;
    fuel.fill(car, c.units);
    return true;
  }

  /** Put the owned car right: damage to zero and the dented shell replaced. */
  repair(car) {
    if (car !== this.car) return false;
    const v = this.view(car);
    if (!v.canRepair || v.repair <= 0) return false;
    if (!wallet.pay(v.repair, 'oprava')) return false;
    car.damage = 0;
    // dentCar() bends a private CLONE of each hull's geometry and nothing bends
    // it back. A fresh mesh of the same kind carries the undented shapes (they
    // are shared per kind), so each hull is handed its original geometry again
    // and the bent clone is freed. The group itself is untouched: whoever is
    // sitting in it, and every list that holds the car, never notices.
    const hulls = car.mesh?.userData?.hulls ?? [];
    const fresh = makeCarMesh(car.color, car.kind, car.look).group.userData?.hulls ?? [];
    for (let i = 0; i < hulls.length && i < fresh.length; i++) {
      const hull = hulls[i];
      if (!hull.userData.owned) continue;
      hull.geometry.dispose();
      hull.geometry = fresh[i].geometry;
      hull.userData.owned = false;
    }
    return true;
  }

  // ---- persistence ---------------------------------------------------------
  snapshot() {
    const c = this.car;
    if (!c) return null;
    return { kind: c.kind, color: c.color, look: c.look ?? 0, x: c.x, z: c.z, h: c.heading, y: c.y,
      fuel: fuel.levelOf(c), damage: c.damage ?? 0, seed: this.seedOf(c),
      parkIdx: Number.isInteger(c.parkIdx) ? c.parkIdx : null };
  }

  /**
   * Bring the saved car back. In single player a car from the spawn fleet is
   * the SAME object the map just placed (moved to where you left it), so there
   * is no twin standing at its old spot. In co-op the fleet is everybody's, so
   * yours comes back as a car of its own and the fleet is left alone.
   */
  restore(s, solo) {
    if (!s || this.car) return;
    const h = this.h;
    // The parking streamers fill their stalls on the first step, BEFORE the
    // save is applied (main.js steps them ahead of career.update), and a stall
    // cannot know that the saved car is about to stand in it. Left where it was
    // bought, that is the car's identical twin on the same spot. Whatever stall
    // car is in the way goes; its stall finds it gone and stays empty.
    for (let i = h.parked.length - 1; i >= 0; i--) {
      const c = h.parked[i];
      if (!c._lot && !c._kerb) continue;
      if (!standsIn(s.x, s.z, c.x, c.z, c.heading, s.h)) continue;
      h.parked.splice(i, 1);
      h.vehicles.remove(c);
    }
    let car = null;
    const fleet = solo && s.parkIdx !== null ? h.parkedFleet[s.parkIdx] : null;
    if (fleet && fleet.kind === s.kind && !fleet._lot) {
      car = fleet;
      car.x = s.x; car.z = s.z; car.heading = s.h; car.speed = 0;
      // vehicles.js settles an un-grounded parked car onto the road the first
      // frame the terrain under it is known; clearing the flag asks for that
      car._grounded = false;
    } else {
      car = h.vehicles.add(s.kind, s.x, s.z, s.h, s.color, Number.isInteger(s.look) ? s.look & 255 : undefined);
      h.parked.push(car);
    }
    // The saved LEVEL: vehicles.js settles an un-grounded car onto the surface
    // nearest its y, and vehicles.add put it on the HIGHEST one (the overpass
    // over the D11 lane it was left in, the deck over a car park under it).
    if (Number.isFinite(s.y)) { car.y = s.y; car._grounded = false; }
    car._buySeed = s.seed;
    car.damage = s.damage;
    if (s.fuel !== null) {
      const now = fuel.levelOf(car);                 // seeds the tank
      if (s.fuel > now) fuel.fill(car, s.fuel - now);
      else car._fuel = s.fuel;
    }
    this.car = car;
    car.owned = true;
  }
}
