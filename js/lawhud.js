// ---- The bottom-right block's two new lines: the limit and the model ------
// Frank, 21 Nov 2026: "musi to ukazovat max povolenou rychlost vpravo dole. A
// taky pravo dole uplne i pod benzinem musi byt zobrazeny nazev auta/model".
//
//   #limit-sign   the Czech B 20a disc left of the speed number, the limit of
//                 the road under the wheels (js/roadlaw.js). Hidden on foot,
//                 off the road for more than a few seconds, in the air.
//   #speedo       .over (amber) while the shown speed is above the limit,
//                 .way (red) only above the police threshold for this road,
//                 the speed a patrol takes a star for (Frank, 25 Nov 2026:
//                 "ať se to ukazuje červeně ... jenom když to opravdu platí na
//                 ty policajty"; js/roadlaw.js policeLimit).
//   #car-model    the model name at the foot of the block, under the fuel.
//
// It writes the DOM only when something it shows has changed: the speed class
// can flip a few times a second, the rest a few times a drive.
import { policeLimit } from './roadlaw.js';

export function createLawHud(doc = globalThis.document) {
  const sign = doc?.getElementById('limit-sign');
  const num = sign?.firstElementChild ?? null;
  const speedo = doc?.getElementById('speedo');
  const model = doc?.getElementById('car-model');
  let lim = -1, tier = -1, name = null;

  /**
   * car: the car you drive or null; limit: km/h or 0; label: its model name;
   * threshold: km/h the police take a star above (roadLaw.threshold), the
   * general table for this limit when not given.
   */
  return function update(car, limit, label, threshold) {
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
    const red = Number.isFinite(threshold) ? threshold : policeLimit(l);
    const t = l <= 0 ? 0 : kmh > red ? 2 : Math.round(kmh) > l ? 1 : 0;
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
