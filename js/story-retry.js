// A FAILED MISSION STARTS CLEAN (Frank, 20 Nov 2026: "kdyz se mise nepodari
// (umre se a nebo busted..) tak mise jde od znova ale cutsceny uz jdou vsechny
// preskocit... a ten vasek musi znovu cekat na nadrazi").
//
// Two things live here, both small and both without the game around them:
//   retry     the mark a failure leaves. While it is set, T skips every film
//             and every talk of the campaign (he has sat through them once).
//             It is lifted when that part is finished, and outlives a reload.
//   parkHome  the car a mission lends him goes back where the mission found
//             it, whole, so whoever waits beside it waits there again.
const KEY = 'atc-story-retry';
let on = false;
try {
  on = localStorage.getItem(KEY) === '1';
} catch {}
export const retry = {
  get on() {
    return on;
  },
  mark() {
    on = true;
    try {
      localStorage.setItem(KEY, '1');
    } catch {}
  },
  clear() {
    on = false;
    try {
      localStorage.removeItem(KEY);
    } catch {}
  },
};

// Stamp where a story car stands when the story first meets it.
export function setHome(car) {
  car.home = { x: car.x, z: car.z, h: car.heading };
  return car;
}
// Back to that spot: stopped, straight, undamaged, and settled onto the ground
// again the first frame the ground there is known (js/vehicles.js, _grounded),
// because he may have failed forty kilometres away. False without a home.
export function parkHome(car) {
  const home = car?.home;
  if (!home) return false;
  car.x = home.x;
  car.z = home.z;
  car.heading = home.h;
  car.speed = car.steer = 0;
  car._lat = car._pv = car._acc = car._roll = car._pitch = 0;
  car.offroad = 0;
  car.damage = 0;
  car.ctl = null;
  car._grounded = false;
  return true;
}
// Where Vašek stands by his estate: a step from the driver's door.
export function besideCar(car, out = 1.55) {
  return { x: car.x + Math.cos(car.heading) * out, z: car.z - Math.sin(car.heading) * out, facing: car.heading + Math.PI / 2 };
}
