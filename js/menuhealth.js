// ---- The main menu's server-status poller ----
// The Woods serverstatus pattern: the "Multiplayer (server)" button is enabled
// only while GET {SERVER_URL}/health answers { ready: true }, with the player
// count as the status line. No WebSocket is touched here; the transport
// (netcity.js) connects only after the click.
//
// The poll has its own cost guard, because every /health is a request to the
// paid co-op server (server-city/README.md, "Cost guard"): it asks every 10 s,
// never while the tab is hidden, and stops asking once nobody has touched the
// page for 10 minutes (a menu left open overnight). Any key, click or mouse
// move picks it up again at once.

import { SERVER_URL } from '../server-config.js';

const POLL_MS = 10000;
const POLL_IDLE_MS = 10 * 60 * 1000;
const TOUCH_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

function healthUrl() {
  if (!SERVER_URL) return null;
  return SERVER_URL.replace(/\/+$/, '') + '/health';
}

// The status line for a server that closed co-op for the rest of the billing
// cycle because its monthly budget is used up.
export function limitDetail(resetsAt) {
  const d = new Date(resetsAt);
  const when = Number.isFinite(d.getTime()) ? ` (znovu od ${d.getUTCDate()}. ${d.getUTCMonth() + 1}.)` : '';
  return `Server má tento měsíc vyčerpaný limit${when}`;
}

// { online, detail } from one /health answer (j is its parsed JSON or null).
// Czech plural: 1 hráč, 2 až 4 hráči, 0 and 5+ hráčů.
function players(n) {
  n = Number(n) || 0;
  return n === 1 ? '1 hráč' : n >= 2 && n <= 4 ? `${n} hráči` : `${n} hráčů`;
}

export function healthDetail(ok, j) {
  if (ok && j && j.ready) return { online: true, detail: `online · ${players(j.players)}` };
  if (j && j.reason === 'limit') return { online: false, detail: limitDetail(j.resetsAt) };
  if (j && j.reason === 'unmeasured') return { online: false, detail: 'server teď nemůže ověřit svůj limit' };
  return { online: false, detail: 'server není připraven' };
}

export async function checkHealth() {
  const url = healthUrl();
  if (!url) return { online: false, detail: 'server není nastaven' };
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(to);
    const j = await res.json().catch(() => null);
    return healthDetail(res.ok, j);
  } catch {
    return { online: false, detail: 'server nedostupný' };
  }
}

// Poll into the menu's button and status line; returns stop().
export function startHealthPoll(button, status) {
  if (!SERVER_URL) { status.textContent = 'server není nastaven'; return () => {}; }
  let stopped = false, busy = false, paused = false;
  let lastPoll = 0, lastTouch = Date.now();
  const poll = async () => {
    if (stopped || busy) return;
    busy = true; lastPoll = Date.now();
    try {
      const { online, detail } = await checkHealth();
      if (stopped) return;
      button.disabled = !online;
      button.classList.toggle('online', online);
      status.textContent = detail;
    } finally { busy = false; }
  };
  const tick = () => {
    if (stopped || document.hidden) return;
    if (Date.now() - lastTouch > POLL_IDLE_MS) {
      if (!paused) { paused = true; status.textContent = 'stav serveru se obnoví, až se vrátíte'; }
      return;
    }
    if (Date.now() - lastPoll >= POLL_MS - 250) poll();
  };
  const touched = () => {
    lastTouch = Date.now();
    if (paused) { paused = false; poll(); }
  };
  const onVisible = () => { if (!document.hidden) { lastTouch = Date.now(); paused = false; tick(); } };
  poll();
  const timer = setInterval(tick, 1000);
  for (const ev of TOUCH_EVENTS) window.addEventListener(ev, touched, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const ev of TOUCH_EVENTS) window.removeEventListener(ev, touched);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
