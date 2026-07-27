// ---- NetUI: the co-op HUD — who you are, who is online, and whether the
// socket is still there at all ----
//
// The bug this file exists for: when the WebSocket drops, NOTHING on screen
// changes. The peers' avatars simply stop moving and the player keeps driving
// around a city they believe is shared, concluding an hour later that "the
// server doesn't work". A multiplayer client that cannot say "you are alone
// now" is worse than a single-player one, because it lies by omission.
//
// Three surfaces, one module:
//   • a toast stack   — transient: joins, leaves, connection events
//   • a status row    — permanent: "hraješ jako <name>" with a dot in YOUR
//                       jacket colour, plus an online LED and a head count
//   • a banner        — a loud, persistent strip while the connection is down,
//                       and a short green one when it comes back
//
// The colour dot is deliberately more than decoration: it is the visual unit
// test for identity. The dot, your own avatar's jacket and the jacket your
// friend sees on you all come from ONE uid→colour function (js/identity.js),
// so the moment those three disagree the dot is the place you notice.
//
// All DOM and CSS are injected from here — index.html and css/style.css stay
// untouched, the same rule settings.js and worldmap.js already follow. Nothing
// touches the document until makeNetUI() is actually called, so importing this
// headless (node --check, tests) is free.
//
// Every string that reaches the screen goes in through textContent, and every
// nickname is re-sanitized by nametags' own cleaner first: these names arrive
// off the wire, and this is the one module that puts them into the DOM rather
// than onto a canvas.

import { cleanName } from './nametags.js';

// How long a toast of each kind stays up. Bad news lingers; a friend joining
// does not need six seconds of the player's attention.
const TOAST_MS = { info: 3800, join: 4400, leave: 4400, ok: 3200, warn: 5200, error: 6500 };
const OUT_MS = 340;          // must match the atcNetOut animation below
const MAX_TOASTS = 4;        // older ones are retired early rather than stacking
const RECONNECT_BANNER_MS = 3200;

// Leading glyph per kind. Text, not SVG: this row sits over a 3D scene and a
// glyph inherits the shadow and the colour for free.
const ICON = { info: '•', join: '▸', leave: '◂', ok: '✓', warn: '!', error: '⚠' };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// 0xrrggbb (or a css string, or nothing) → a css colour. Numbers come from the
// jacket palette; a string is trusted only if it looks like a colour, because
// this value ends up in an inline style.
const SAFE_CSS_COLOR = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i;
function cssColor(c) {
  if (typeof c === 'number' && Number.isFinite(c))
    return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && SAFE_CSS_COLOR.test(c.trim())) return c.trim();
  return null;
}

// Czech head count. "2 hráči" / "5 hráčů" is the difference between a HUD that
// was written for the player and one that was translated at it.
function czPlayers(n) {
  if (n <= 0) return 'nikdo další';
  if (n === 1) return '1 hráč';
  if (n < 5) return n + ' hráči';
  return n + ' hráčů';
}

const CSS_TEXT = `
/* The stack lives above the minimap on the left rail: the right rail already
   carries the speedo, the rocket pod and the vehicle name card, and the top
   centre is the location banner. 246px clears the 220px minimap plus its
   16px inset; the phone breakpoint tracks the 150px minimap in style.css. */
#atc-net {
  position: fixed; left: 16px; bottom: 246px; z-index: 14; pointer-events: none;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  max-width: min(52vw, 360px);
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
}
@media (max-width: 760px) { #atc-net { bottom: 176px; max-width: 74vw; } }
.atc-net-hide { display: none !important; }
.atc-net-toasts { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.atc-net-toast {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 10px; border-radius: 9px;
  font-size: 13px; font-weight: 600; color: #e9eef7; line-height: 1.25;
  background: rgba(12,16,24,0.82); border: 1px solid rgba(140,170,220,0.26);
  border-left: 3px solid #7fa8e8;
  box-shadow: 0 3px 14px rgba(0,0,0,0.45);
  animation: atcNetIn 0.22s ease both;
}
.atc-net-toast .atc-net-ico { font-size: 12px; opacity: 0.95; }
.atc-net-toast.k-join  { border-left-color: #6ad07a; }
.atc-net-toast.k-leave { border-left-color: #9aa6bd; }
.atc-net-toast.k-ok    { border-left-color: #6ad07a; }
.atc-net-toast.k-warn  { border-left-color: #ffc14d; }
.atc-net-toast.k-error { border-left-color: #ff7a6a; }
.atc-net-toast.atc-out { animation: atcNetOut ${OUT_MS}ms ease both; }
/* the peer's own jacket colour, so a toast and the dot on the map agree */
.atc-net-swatch {
  width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
  border: 1px solid rgba(0,0,0,0.55); box-shadow: 0 0 0 1px rgba(255,255,255,0.16);
}
/* identity row: permanent, quiet, and the only place the player's own name is
   written — a name tag over your OWN head would sit in the middle of the
   third-person view and hide exactly what you are steering at */
.atc-net-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px 5px 9px;
  border-radius: 999px; font-size: 12.5px; color: #cbd6e8;
  background: rgba(10,14,22,0.62); border: 1px solid rgba(140,170,220,0.2);
  text-shadow: 0 1px 3px rgba(0,0,0,0.8); white-space: nowrap;
}
.atc-net-dot {
  width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; background: #8a93a6;
  border: 1px solid rgba(0,0,0,0.55); box-shadow: 0 0 0 1px rgba(255,255,255,0.18);
}
.atc-net-me b { color: #f2f6ff; font-weight: 800; }
.atc-net-net { display: flex; align-items: center; gap: 6px; opacity: 0.92; }
.atc-net-net::before {
  content: ''; width: 1px; height: 12px; background: rgba(255,255,255,0.18);
}
.atc-net-led {
  width: 7px; height: 7px; border-radius: 50%; margin-left: 2px; flex: 0 0 auto;
  background: #6ad07a; box-shadow: 0 0 6px rgba(106,208,122,0.85);
}
.atc-net-net.off .atc-net-led {
  background: #ff7a6a; box-shadow: 0 0 6px rgba(255,122,106,0.8);
  animation: atcNetBlink 1.1s steps(1, end) infinite;
}
.atc-net-net.off { color: #ffb3a8; }
/* the loud one: only while the socket is actually down */
#atc-net-banner {
  position: fixed; top: 44px; left: 50%; transform: translateX(-50%);
  /* above the world map overlay (36), below the settings panel (40): losing the
     connection is news you still need while you are staring at the map */
  z-index: 38; pointer-events: none;
  display: flex; align-items: center; gap: 9px; padding: 8px 16px; border-radius: 10px;
  font: 700 14px/1.2 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.4px;
  color: #fff1ec; background: rgba(122,26,20,0.9);
  border: 1px solid rgba(255,140,120,0.5); box-shadow: 0 6px 24px rgba(0,0,0,0.5);
  animation: atcNetIn 0.25s ease both;
  max-width: 92vw; text-align: center;
}
#atc-net-banner .atc-net-led { animation: atcNetBlink 1.1s steps(1, end) infinite; }
#atc-net-banner.ok {
  color: #eafff0; background: rgba(20,86,44,0.9); border-color: rgba(120,230,160,0.45);
}
#atc-net-banner.ok .atc-net-led {
  background: #6ad07a; box-shadow: 0 0 6px rgba(106,208,122,0.85); animation: none;
}
@keyframes atcNetIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* the banner is x-centred by a transform, so its own keyframes must carry
   that translate through or it would snap to the left edge while animating */
#atc-net-banner { animation-name: atcNetBannerIn; }
@keyframes atcNetBannerIn {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@keyframes atcNetOut {
  from { opacity: 1; transform: translateY(0); max-height: 44px; }
  to   { opacity: 0; transform: translateY(-4px); max-height: 0; }
}
@keyframes atcNetBlink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) {
  .atc-net-toast, #atc-net-banner { animation: none !important; }
  .atc-net-led { animation: none !important; }
}
`;

let _cssDone = false;
function ensureCss() {
  if (_cssDone || typeof document === 'undefined') return;
  _cssDone = true;
  document.head.appendChild(document.createElement('style')).textContent = CSS_TEXT;
}

// The jacket palette lives in js/identity.js, which is the ONE place a uid
// becomes a colour. Importing it statically would make this UI module refuse
// to load in a build that ships without it, so it is pulled in on demand and a
// failure just leaves the dot grey — a missing colour must never cost the
// player the disconnect banner.
let _identP = null;
function identity() {
  if (!_identP) _identP = import('./identity.js').catch(() => null);
  return _identP;
}

// makeNetUI() — the whole surface, per the co-op contract:
//   toast(msg, kind)              kind: 'info'|'join'|'leave'|'ok'|'warn'|'error'
//   setStatus({online, count, names})
//   setSelf({name, uid, color})   (extra) the permanent "hraješ jako X" row
//   dispose()
// opts.autoPeerToasts (default true): derive join/leave toasts from successive
// setStatus() name lists, so a caller that only reports the roster still gets
// arrivals and departures announced. Turn it off if you toast them yourself.
export function makeNetUI(opts = {}) {
  const o = { autoPeerToasts: true, ...opts };
  if (typeof document === 'undefined') {          // headless: a working no-op
    return { toast() {}, setStatus() {}, setSelf() {}, dispose() {} };
  }
  ensureCss();

  const root = el('div');
  root.id = 'atc-net';
  const toastBox = el('div', 'atc-net-toasts');

  const row = el('div', 'atc-net-row atc-net-hide');
  const dot = el('i', 'atc-net-dot');
  const me = el('span', 'atc-net-me');
  const netBox = el('span', 'atc-net-net atc-net-hide');
  const led = el('i', 'atc-net-led');
  const cnt = el('span', 'atc-net-cnt', '');
  netBox.append(led, cnt);
  row.append(dot, me, netBox);
  root.append(toastBox, row);
  document.body.appendChild(root);

  let banner = null;
  const timers = new Set();                        // every pending timeout, for dispose
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };

  let dead = false;
  let online = undefined;                          // undefined = never reported yet
  let known = new Map();                           // peer key -> display label
  let selfName = '';

  // ---- toasts ----------------------------------------------------------
  function retire(node) {
    if (!node || node.dataset.out) return;
    node.dataset.out = '1';
    node.classList.add('atc-out');
    later(() => node.remove(), OUT_MS);
  }

  // swatch: an optional colour chip, so "Bondy se připojil" carries the same
  // colour the player will look for on the map and over the avatar's head
  function toast(msg, kind = 'info', color = null) {
    if (dead) return;
    const text = String(msg ?? '').slice(0, 140);
    if (!text) return;
    const k = ICON[kind] ? kind : 'info';
    const node = el('div', 'atc-net-toast k-' + k);
    node.append(el('span', 'atc-net-ico', ICON[k]));
    const sw = cssColor(color);
    if (sw) {
      const chip = el('i', 'atc-net-swatch');
      chip.style.background = sw;
      node.append(chip);
    }
    node.append(el('span', '', text));             // textContent — never innerHTML
    toastBox.append(node);
    // Cap the stack from the TOP: the oldest toast is retired the moment a
    // fifth arrives, so a burst of joins never grows a column into the sky.
    // Count only the ones NOT already retiring — retire() starts a 340 ms fade
    // and the node stays in the DOM until it ends, so a loop that re-counted
    // children would spin forever on the fifth toast. (It did.)
    const live = [...toastBox.children].filter(n => !n.dataset.out);
    for (let i = 0; i < live.length - MAX_TOASTS; i++) retire(live[i]);
    // Hard ceiling on the retiring ones too. A fading toast lingers for OUT_MS,
    // so a burst (a full room reconnecting) can pile up nodes faster than the
    // fade timers clear them — past this many, the oldest goes without ceremony.
    while (toastBox.children.length > MAX_TOASTS * 3) toastBox.firstElementChild.remove();
    later(() => retire(node), TOAST_MS[k] ?? TOAST_MS.info);
  }

  // ---- the permanent identity row --------------------------------------
  // color may be a number (0xrrggbb from PLAYER_JACKETS) or a css string. Omit
  // it and the uid is resolved through identity.js instead, which is what
  // makes the dot, the avatar and the peers' view of you the same colour by
  // construction rather than by two call sites agreeing.
  function setSelf(self = {}) {
    if (dead) return;
    selfName = cleanName(self.name) || 'Hráč';
    me.innerHTML = '';
    me.append(document.createTextNode('hraješ jako '), el('b', '', selfName));
    row.classList.remove('atc-net-hide');
    const direct = cssColor(self.color);
    if (direct) { dot.style.background = direct; return; }
    if (!self.uid) return;
    identity().then(mod => {
      if (dead || !mod) return;
      try {
        // THE PERSON, NOT THE TAB. The uid on the wire is 'base:tab' and the
        // wardrobe is a pure function of the BASE half only — player.js dresses
        // the hero with lookForUid(baseUid(uid)) and netcity dresses every peer
        // with the same call. Hashing the FULL uid here made the dot disagree
        // with both: measured over sample uids it landed on a different jacket
        // 15 times out of 16 (u4f2a1b2c:ab3d → dot #2ea44f green, avatar
        // #8e44ad purple). That is not cosmetic — this dot is the one place a
        // player learns which colour to call themselves, and this module's own
        // header calls it the visual unit test for identity. It was failing.
        //
        // lookForUid, not jacketIndexForUid + PLAYER_JACKETS: one call to the
        // very function that paints the avatar, so there is no second place
        // that can drift. The index path stays as the fallback for a build
        // that ships an older identity.js.
        const base = mod.baseUid ? mod.baseUid(self.uid) : self.uid;
        let c = mod.lookForUid ? mod.lookForUid(base)?.jacket : null;
        if (!Number.isFinite(c)) {
          const idx = mod.jacketIndexForUid?.(base);
          const pal = mod.PLAYER_JACKETS;
          c = Array.isArray(pal) && Number.isFinite(idx) ? pal[idx % pal.length] : null;
        }
        const css = cssColor(c);
        if (css) dot.style.background = css;
      } catch { /* a palette we cannot read leaves the dot grey — never fatal */ }
    });
  }

  // ---- connection + roster ---------------------------------------------
  function showBanner(text, ok) {
    hideBanner();
    banner = el('div');
    banner.id = 'atc-net-banner';
    if (ok) banner.className = 'ok';
    banner.append(el('i', 'atc-net-led'), el('span', '', text));
    document.body.appendChild(banner);
    return banner;
  }
  function hideBanner() {
    banner?.remove();
    banner = null;
  }

  // Keys the roster by uid when the caller supplies records, and by name when
  // it supplies bare strings. uid is worth asking for: a peer's real nickname
  // arrives one packet AFTER their uid does, so a name-keyed roster would
  // announce that "Hráč a1b2" left and "Bondy" joined half a second later.
  function rosterOf(names) {
    const m = new Map();
    if (!Array.isArray(names)) return m;
    for (const n of names) {
      if (n && typeof n === 'object') {
        const label = cleanName(n.name) || 'Hráč';
        m.set(String(n.uid ?? label), { label, color: n.color ?? n.jacket ?? null });
      } else {
        const label = cleanName(n);
        if (label) m.set(label, { label, color: null });
      }
    }
    return m;
  }

  function diffRoster(next) {
    const joined = [], left = [];
    for (const [k, v] of next) if (!known.has(k)) joined.push(v);
    for (const [k, v] of known) if (!next.has(k)) left.push(v);
    known = next;
    if (!o.autoPeerToasts) return;
    // One in, one out, same head count: with a name-keyed roster that is a
    // rename (the uid-keyed one never produces it), and announcing a departure
    // for it would be a lie about a player who is standing right there.
    if (joined.length === 1 && left.length === 1) {
      toast(left[0].label + ' je teď ' + joined[0].label, 'info', joined[0].color);
      return;
    }
    for (const p of joined) toast(p.label + ' se připojil', 'join', p.color);
    for (const p of left) toast(p.label + ' odešel', 'leave', p.color);
  }

  // Any key may be omitted and keeps its previous value. online === null means
  // "no session at all" (single player): the network half of the row hides and
  // the roster is forgotten, rather than claiming zero players are online.
  function setStatus(s = {}) {
    if (dead) return;
    // A call that ALSO reports the socket going down must not announce
    // departures. The drop path hands us an empty roster — netcity's onclose
    // nulls every peerState (each _drop re-emits status) and main.js then
    // calls setStatus({online:false, count:0, names:[]}) — and diffing that
    // against the roster we had produced "Bondy odešel", "Karel odešel" and
    // only THEN "Spojení ztraceno". The first two are lies: nobody left, we
    // did, and they are still in the room playing without us. So on the frame
    // the connection dies the roster is adopted silently; the banner and the
    // error toast below carry the actual news.
    const dropping = 'online' in s && s.online === false && online !== false;
    if ('names' in s || 'count' in s) {
      const next = rosterOf(s.names);
      // Only diff when the caller actually gave us names; a count-only update
      // must not reap the roster it says nothing about.
      if (!dropping && 'names' in s && Array.isArray(s.names)) diffRoster(next);
      else if (dropping) known = next;
      const n = Number.isFinite(s.count) ? s.count : next.size;
      cnt.textContent = czPlayers(n);
    }
    if (!('online' in s)) return;
    const was = online;
    online = s.online;
    if (online === null || online === undefined) {
      netBox.classList.add('atc-net-hide');
      hideBanner();
      known = new Map();
      return;
    }
    netBox.classList.remove('atc-net-hide');
    netBox.classList.toggle('off', !online);
    if (!cnt.textContent) cnt.textContent = czPlayers(0);
    if (online === was) return;
    if (!online) {
      // The whole reason this module exists. Persistent — it stays up until
      // the connection is back, because the player needs to know that
      // everything they do from here on is happening in their world only.
      showBanner('Spojení se serverem ztraceno — hraješ sám', false);
      toast('Spojení ztraceno, zkouším se připojit…', 'error');
      known = new Map();                 // everyone is gone as far as we can tell
      cnt.textContent = czPlayers(0);
    } else if (was === false) {
      showBanner('Spojení obnoveno', true);
      later(hideBanner, RECONNECT_BANNER_MS);
      toast('Spojení obnoveno', 'ok');
    } else {
      toast('Připojeno k serveru', 'ok');
    }
  }

  function dispose() {
    dead = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    hideBanner();
    root.remove();
  }

  return { toast, setStatus, setSelf, dispose, get name() { return selfName; } };
}

export default makeNetUI;
