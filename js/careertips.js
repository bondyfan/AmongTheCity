// ---- Career, the slow half: discovery, one-off tips, achievement pay ----
// Three small jobs that run a couple of times a second from js/career.js and
// share nothing but the toast channel. Kept apart from the integrator so that
// file stays a list of hooks: each function here takes what it needs and owns
// no state of its own (the `tips` record and the Progress are the caller's,
// because both are part of the save).

import * as wallet from './wallet.js';
import * as vitals from './vitals.js';
import * as fuel from './fuel.js';
import { kc } from './prices.js';
import { toast } from './toasts.js';
import { foodPlaceAt } from './jobplaces.js';

let lastTown = null;

/** The quarter or village place.js says we are in: a toast the first time. */
export function discover(progress, town) {
  if (!town || town === lastTown) return;
  lastTown = town;
  if (progress.enterDistrict(town))
    toast('Objeveno: ' + town, { icon: '🧭', sub: progress.stats.districts.length + '. místo na tvé mapě' });
}

/** Explanations, once each, at the moment the thing they explain first
 *  matters. `tips` is the saved record of the ones already given. */
export function contextTips(tips, car) {
  if (car && !tips.fuel && fuel.frac(car) < 0.15) {
    tips.fuel = 1;
    toast('Dochází palivo', { icon: '⛽', kind: 'warn', sub: 'Pumpy jsou na mapě (M). U stojanu zastav a drž F.', ms: 8000 });
  }
  if (!tips.hungry && vitals.energy() < 20) {
    tips.hungry = 1;
    toast('Máš hlad', { icon: '🍴', kind: 'warn', sub: 'U restaurace nebo obchodu stiskni E. Hladové tělo se nehojí.', ms: 8000 });
  }
  if (!tips.wreck && car && (car.damage ?? 0) >= 1) {
    tips.wreck = 1;
    toast('Auto je na odpis', { icon: '🔧', kind: 'warn', sub: 'Vlastní auto jde opravit (B). Cizí nech stát.', ms: 8000 });
  }
}

// ---- the food counter's hint ----
// The on-foot hint is written every frame (main.js updateHud), and a 3x3 chunk
// scan plus a fresh string there would be per-frame work for something that
// changes when you walk through a door. So the place is looked up here, from
// the slow tick, and the frame only reads `food.html`. The name comes off the
// map: it is escaped, because the hint element takes markup.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const food = { name: null, html: '' };
export function foodScan(city, x, z, onFoot) {
  const v = onFoot ? foodPlaceAt(city, x, z) : null;
  const name = v?.name ?? null;
  if (name === food.name) return;
  food.name = name;
  food.html = name ? '<kbd>E</kbd> jídlo a pití · ' + esc(name) : '';
}

/** Pay out whatever achievements have just come true. True if any did. */
export function payAwards(progress) {
  let any = false;
  for (const a of progress.check()) {
    any = true;
    wallet.earn(a.reward, 'úspěch');
    progress.addEarned(a.reward);
    toast(a.name + '  +' + kc(a.reward), { icon: '🏆', kind: 'ach', sub: a.desc, ms: 6000 });
  }
  return any;
}
