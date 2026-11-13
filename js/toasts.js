// ---- Toasts: one line for every reward and event ----
// "Zakázka hotová +480 Kč", "Objeveno: Polabiny", "🏆 Taxikář". A short stack
// on the right rail (#toasts in index.html, styled in css/style.css) that
// fills from the top and empties itself. Nothing here is interactive and the
// whole layer is click-through, so a toast can never eat a click meant for the
// game or steal the pointer lock.
//
// EVERY STRING GOES IN AS textContent. Half of what gets announced is a name
// off the map (a venue, a district) and none of it is markup.
//
// The queue exists because events arrive in bursts: finishing a job can pay,
// unlock an achievement and discover a district in the same frame, and four
// cards landing at once is unreadable. At most MAX are on screen; the rest
// wait their turn, and an identical message already showing is not repeated.

const MAX = 4;
const LIFE = 4200;       // ms on screen
const OUT = 320;         // ms of the exit animation (toastOut in style.css)

let _root = null;
const _queue = [];
const _live = [];        // { el, key, until }
let _timer = 0;

function root() {
  if (_root?.isConnected) return _root;
  if (typeof document === 'undefined') return null;      // node tests
  _root = document.getElementById('toasts');
  if (!_root) {
    _root = document.createElement('div');
    _root.id = 'toasts';
    document.body.appendChild(_root);
  }
  return _root;
}

function show(t) {
  const r = root();
  if (!r) return;
  const el = document.createElement('div');
  el.className = 'atc-toast' + (t.kind ? ' ' + t.kind : '');
  const icon = document.createElement('span');
  icon.className = 'tt-icon';
  icon.textContent = t.icon ?? '';
  const text = document.createElement('span');
  text.className = 'tt-text';
  text.textContent = t.text;
  const sub = document.createElement('span');
  sub.className = 'tt-sub';
  sub.textContent = t.sub ?? '';
  text.appendChild(sub);
  if (t.icon) el.appendChild(icon);
  el.appendChild(text);
  r.appendChild(el);
  _live.push({ el, key: t.key, until: performance.now() + (t.ms ?? LIFE) });
}

// One timer for the whole stack rather than one per toast: a setTimeout each
// would be throttled independently in a hidden tab and the cards would then
// leave in the wrong order.
function pump() {
  _timer = 0;
  const now = performance.now();
  for (let i = _live.length - 1; i >= 0; i--) {
    const l = _live[i];
    if (now < l.until) continue;
    _live.splice(i, 1);
    l.el.classList.add('out');
    setTimeout(() => l.el.remove(), OUT);
  }
  while (_live.length < MAX && _queue.length) show(_queue.shift());
  if (_live.length || _queue.length) _timer = setTimeout(pump, 250);
}

/**
 * toast(text, { icon, sub, kind, ms })
 *   kind: 'good' (money in), 'warn' (failed, fined), 'ach' (achievement), or
 *   nothing for plain information.
 */
export function toast(text, opts = {}) {
  if (!text) return;
  const key = text + '|' + (opts.sub ?? '');
  if (_live.some((l) => l.key === key) || _queue.some((q) => q.key === key)) return;
  _queue.push({ text: String(text), key, ...opts });
  if (_queue.length > 12) _queue.shift();      // a runaway caller must not grow this forever
  if (!_timer) pump();
}

/** For a harness: what is on screen right now. */
export function liveToasts() {
  return _live.map((l) => l.el.textContent);
}
