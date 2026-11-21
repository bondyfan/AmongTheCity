// ---- The bottom-right block's two new lines: the limit and the model ------
// Frank, 21 Nov 2026: "musi to ukazovat max povolenou rychlost vpravo dole. A
// taky pravo dole uplne i pod benzinem musi byt zobrazeny nazev auta/model".
//
//   #limit-sign   the Czech B 20a disc left of the speed number, the limit of
//                 the road under the wheels (js/roadlaw.js). Hidden on foot,
//                 off the road for more than a few seconds, in the air.
//   #speedo       .over while the shown speed is above the limit, .way while
//                 it is more than 50 % above it (what the police charge).
//   #car-model    the model name at the foot of the block, under the fuel.
//
// It writes the DOM only when something it shows has changed: the speed class
// can flip a few times a second, the rest a few times a drive.
import { speeding } from './roadlaw.js';

export function createLawHud(doc = globalThis.document) {
  const sign = doc?.getElementById('limit-sign');
  const num = sign?.firstElementChild ?? null;
  const speedo = doc?.getElementById('speedo');
  const model = doc?.getElementById('car-model');
  let lim = -1, tier = -1, name = null;

  /** car: the car you drive or null; limit: km/h or 0; label: its model name. */
  return function update(car, limit, label) {
    const l = car && limit > 0 ? limit : 0;
    if (l !== lim) {
      lim = l;
      if (sign) {
        sign.classList.toggle('hidden', l <= 0);
        sign.classList.toggle('w3', l >= 100);
        if (num) num.textContent = l > 0 ? String(l) : '';
      }
    }
    const kmh = car ? (car.vGround ?? Math.abs(car.speed ?? 0)) * 3.6 : 0;
    const t = l <= 0 ? 0 : speeding(kmh, l) ? 2 : Math.round(kmh) > l ? 1 : 0;
    if (t !== tier) {
      tier = t;
      speedo?.classList.toggle('over', t === 1);
      speedo?.classList.toggle('way', t === 2);
    }
    const n = car ? (label || '') : '';
    if (n !== name) {
      name = n;
      if (model) {
        model.textContent = n;
        model.classList.toggle('hidden', !n);
      }
    }
  };
}
