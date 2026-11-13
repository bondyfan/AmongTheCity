// ---- Objective tracker: the card in the top-left corner ----
// What you are doing, where it is, how far, how long you have, what it pays.
// One element (#objective in index.html), written by exactly one caller
// (js/career.js) from exactly one description object, so the introduction and
// a running job can never both be on screen arguing.
//
// Every field is diffed against what is already in the DOM: the distance and
// the clock change every second, the rest changes once a job, and a HUD that
// rewrites six text nodes sixty times a second is a HUD that costs a layout a
// frame for nothing.

let _el = null, _parts = null;
const _last = { on: null, cls: '', icon: '', title: '', pay: '', where: '', dist: '', time: '', keys: '' };

function scan() {
  if (_el?.isConnected) return true;
  if (typeof document === 'undefined') return false;
  _el = document.getElementById('objective');
  if (!_el) return false;
  const q = (c) => _el.querySelector(c);
  _parts = { icon: q('.ob-icon'), title: q('.ob-title'), pay: q('.ob-pay'),
    where: q('.ob-where'), dist: q('.ob-dist'), time: q('.ob-time'), keys: q('.ob-keys') };
  for (const k of Object.keys(_last)) _last[k] = k === 'on' ? null : '';
  return true;
}

function put(key, text) {
  const t = text ?? '';
  if (_last[key] === t) return;
  _last[key] = t;
  _parts[key].textContent = t;
}

/**
 * setObjective(view) with view = {
 *   cls    'intro' | 'courier' | 'taxi'   (the stripe's colour)
 *   urgent boolean                        (the clock is nearly out)
 *   icon, title, pay, where, dist, time   plain text
 *   keys   TRUSTED markup (kbd hints written in js/onboarding.js and
 *          js/career.js, never anything read off the map)
 * } or null to take the card down.
 */
export function setObjective(view) {
  if (!scan()) return;
  const on = !!view;
  if (on !== _last.on) { _last.on = on; _el.classList.toggle('hidden', !on); }
  if (!on) return;
  const cls = (view.cls ?? '') + (view.urgent ? ' urgent' : '');
  if (cls !== _last.cls) { _last.cls = cls; _el.className = cls; }
  put('icon', view.icon); put('title', view.title); put('pay', view.pay);
  put('where', view.where); put('dist', view.dist); put('time', view.time);
  const keys = view.keys ?? '';
  if (keys !== _last.keys) { _last.keys = keys; _parts.keys.innerHTML = keys; }
}
