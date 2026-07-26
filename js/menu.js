// ---- Main menu: the screen before Pardubice ----
// Fully self-contained like js/settings.js: every bit of DOM and CSS is
// injected from here, index.html and style.css stay untouched. main.js calls
// showMenu() BEFORE boot() and awaits the promise — the player picks single
// player ("Hrát") or the shared dedicated server ("Multiplayer (server)"),
// and only then does the city start streaming.
//
// The multiplayer button gates on the server actually being up: the same
// /health polling pattern as the Woods serverstatus module — enabled only
// while GET {SERVER_URL}/health answers { ready: true }, with the player/room
// count as the status line, re-checked every few seconds while the menu is
// open. No WebSocket is touched here; the transport (netcity.js) connects
// only after the click.
//
// Layering: the menu sits at z-index 15 — above the HUD (10) but BELOW the
// settings gear (20) and panel (40), so "Nastavení" stays reachable from the
// menu (main.js brings initSettings up before showMenu for exactly this).
// The #enter-overlay boot cover lives at z-40 and would blanket the menu, so
// it is stashed (visibility) while the menu is up and restored on the pick —
// the familiar "Přijíždíte do Pardubic…" spinner then covers the boot.

import { SERVER_URL } from '../server-config.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const CSS = `
#atc-menu {
  position: fixed; inset: 0; z-index: 15; display: flex;
  align-items: center; justify-content: center; text-align: center;
  color: #e8ecf4; font-family: 'Trebuchet MS','Segoe UI',system-ui,sans-serif;
  background: radial-gradient(ellipse at 50% 30%, #1b2434 0%, #0d1016 70%);
  transition: opacity 0.35s ease;
}
#atc-menu.atc-menu-out { opacity: 0; pointer-events: none; }
.atc-menu-inner { max-width: 520px; padding: 24px; }
.atc-menu-inner h1 {
  font-size: 44px; letter-spacing: 6px; line-height: 1.15; margin: 0 0 6px;
  text-shadow: 0 3px 18px rgba(0,0,0,0.8);
}
.atc-menu-sub {
  font-size: 15px; letter-spacing: 4px; opacity: 0.75; margin-bottom: 40px;
  text-transform: uppercase;
}
.atc-menu-btn {
  display: block; width: 100%; margin: 12px 0; padding: 15px 18px;
  font: inherit; font-size: 18px; font-weight: 700; letter-spacing: 1px;
  color: #e8ecf4; cursor: pointer; border-radius: 12px;
  background: rgba(38, 48, 74, 0.75); border: 1px solid rgba(140,170,220,0.35);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.atc-menu-btn:hover:not(:disabled) {
  background: rgba(58, 76, 116, 0.9); border-color: rgba(160,195,245,0.7);
}
.atc-menu-btn:disabled { opacity: 0.45; cursor: default; }
.atc-menu-btn small {
  display: block; font-size: 12.5px; font-weight: 400; letter-spacing: 0.3px;
  opacity: 0.8; margin-top: 4px;
}
.atc-menu-hint { margin-top: 34px; font-size: 12.5px; opacity: 0.55; line-height: 1.7; }
.atc-menu-hint b {
  background: #26304a; border-radius: 4px; padding: 1px 7px; margin: 0 2px;
  font-size: 11.5px; color: #cfe0ff; font-weight: 600;
}
`;

// ---- /health poller (Woods serverstatus pattern, inlined) --------------------
function healthUrl() {
  if (!SERVER_URL) return null;
  return SERVER_URL.replace(/\/+$/, '') + '/health';
}

async function checkHealth() {
  const url = healthUrl();
  if (!url) return { online: false, detail: 'server není nastaven' };
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(to);
    const j = res.ok ? await res.json().catch(() => null) : null;
    if (res.ok && j && j.ready) {
      return { online: true, detail: `online · ${j.players ?? 0} hráčů` };
    }
    return { online: false, detail: 'server není připraven' };
  } catch {
    return { online: false, detail: 'server nedostupný' };
  }
}

/**
 * showMenu() → Promise<{ mode: 'single' | 'server' }>
 * Builds the menu, polls the server health while it's open, resolves on the
 * player's pick and removes itself (restoring the boot spinner underneath).
 */
export function showMenu() {
  return new Promise((resolve) => {
    document.head.appendChild(el('style', '', '')).textContent = CSS;

    const overlay = el('div'); overlay.id = 'atc-menu';
    const inner = el('div', 'atc-menu-inner');
    inner.appendChild(el('h1', '', 'AMONG THE CITY'));
    inner.appendChild(el('div', 'atc-menu-sub', 'Pardubice'));

    const single = el('button', 'atc-menu-btn',
      '▶ Hrát<small>sám ve městě</small>');
    const multi = el('button', 'atc-menu-btn',
      '🌐 Multiplayer (server)<small class="atc-mp-status">hledám server…</small>');
    multi.disabled = true;
    inner.append(single, multi);

    inner.appendChild(el('p', 'atc-menu-hint',
      '<b>WASD</b> pohyb · <b>E</b> nastoupit/vystoupit · <b>C</b> pohled řidiče · '
      + '<b>M</b> mapa · <b>V</b> raketa (z vrtulníku)'
      + '<br>Nastavení najdete pod ⚙️ vpravo nahoře.'));
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    // the boot cover (z-40) would blanket the menu — stash it, restore on pick
    const cover = document.getElementById('enter-overlay');
    const coverVis = cover ? cover.style.visibility : '';
    if (cover) cover.style.visibility = 'hidden';

    // health poll while the menu is open; also re-enables if the server comes
    // UP after the menu appeared (typical local flow: start game, then server)
    const status = multi.querySelector('.atc-mp-status');
    let timer = null, closed = false;
    const poll = async () => {
      const { online, detail } = await checkHealth();
      if (closed) return;
      multi.disabled = !online;
      status.textContent = detail;
    };
    if (SERVER_URL) { poll(); timer = setInterval(poll, 5000); }
    else status.textContent = 'server není nastaven';

    const pick = (mode) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (cover) cover.style.visibility = coverVis;   // spinner covers the boot
      overlay.classList.add('atc-menu-out');
      setTimeout(() => overlay.remove(), 400);
      resolve({ mode });
    };
    single.addEventListener('click', () => pick('single'));
    multi.addEventListener('click', () => pick('server'));
  });
}
