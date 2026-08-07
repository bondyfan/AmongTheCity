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
//
// The nickname field is the one thing the server run REQUIRES: a nameplate
// over a stranger's head is what turns "another citizen" into "someone".
// Single player accepts an empty one — you are alone, nobody reads it — but
// it is still remembered and handed back, so a player who types a name once
// never has to think about it again.

import { SERVER_URL } from '../server-config.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// ---- nickname ---------------------------------------------------------------
// Woods' filter plus the blank-nameplate defence. Two classes of character go:
//
//   1. markup/JSON breakers  <>&"'`  — the name ends up in a canvas today and
//      could end up in a DOM chat line tomorrow.
//   2. characters that render as NOTHING. String.trim() only knows Unicode Zs
//      and line terminators, so U+200B (zero-width space), U+3164 (hangul
//      filler) and U+2800 (blank braille) all sail straight through it — the
//      classic "invisible nickname" trick. Without this the menu's "no name,
//      no server" gate is one paste away from being bypassed, and U+202E
//      (right-to-left override) would let a name reverse the text after it.
//
// live-typing filter too: everything sanitizeName does EXCEPT trim/slice, so
// the caret is never fought over a space the player is still typing through
// (the 14-char cap is the input's own maxlength; the trim happens on read).
const STRIP = /[<>&"'`\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFC\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}]/gu;
// …and the backstop for every blank NOBODY has enumerated yet. Naming the
// characters one at a time is whack-a-mole: the first version of this list
// caught U+200B and U+3164 and still waved through U+034F (combining grapheme
// joiner), U+17B5 (Khmer inherent vowel), U+FE0F (variation selector) and the
// whole U+E00xx tag block — every one of them a perfectly empty nameplate,
// verified against the shipped function. So the rule is also stated
// positively: a nickname must contain at least one character that puts INK on
// the canvas — not whitespace, not a combining mark, not a format control, not
// a surrogate, not private-use, not unassigned. U+200D (ZWJ) and the variation
// selectors deliberately survive the strip above, so a family emoji stays one
// glyph and a thumbs-up keeps its colour; both are format/mark characters, so
// a name made of nothing but them is still refused right here.
const INK = /[^\s\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cs}\p{Cn}\p{Co}]/u;

// Exported because the network layer has to run the SAME filter AGAIN on the
// way IN — a peer's name arrives over the wire and nothing that arrives over a
// wire is trusted. Keep this body byte-identical to netcity.sanitizeName and
// nametags.clean, or sender and receiver disagree about what the name is.
export function sanitizeName(s) {
  const n = String(s ?? '').replace(STRIP, '').trim().slice(0, 14).trim();
  return INK.test(n) ? n : '';
}

export const NAME_KEY = 'atc-name';

// localStorage throws in some privacy modes — the menu must still open
function loadName() {
  try { return sanitizeName(localStorage.getItem(NAME_KEY) || ''); } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch {}
}

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
/* nickname: the same dark panel + #cfe0ff accent as the buttons below it, so
   the field reads as the first step of the same control, not as a stray form */
.atc-name-row { margin: 0 0 18px; }
.atc-menu-name {
  display: block; width: 100%; padding: 13px 16px; text-align: center;
  font: inherit; font-size: 17px; font-weight: 700; letter-spacing: 2px;
  color: #cfe0ff; background: rgba(20, 26, 40, 0.85);
  border: 1px solid rgba(140,170,220,0.35); border-radius: 12px; outline: none;
  /* body sets user-select:none and touch-action:none for the canvas; a text
     field needs both back or a phone cannot place a caret in it */
  user-select: text; -webkit-user-select: text; touch-action: manipulation;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.atc-menu-name::placeholder {
  color: #93a6c6; font-weight: 400; letter-spacing: 1px;
}
.atc-menu-name:focus {
  background: rgba(30, 40, 62, 0.95); border-color: rgba(160,195,245,0.7);
}
.atc-menu-name.name-missing {
  border-color: #d8574a; animation: atc-name-shake 0.3s;
}
@keyframes atc-name-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
  75% { transform: translateX(6px); }
}
.atc-name-note {
  margin-top: 7px; font-size: 11.5px; letter-spacing: 0.3px; opacity: 0.55;
  transition: color 0.15s ease, opacity 0.15s ease;
}
.atc-name-row.miss .atc-name-note { color: #ff9a8d; opacity: 1; }
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

const NOTE_IDLE = 'Uvidí ji ostatní hráči · na server bez ní nelze';
const NOTE_MISS = 'Nejdřív si zvolte přezdívku';

/**
 * showMenu() → Promise<{ mode: 'single' | 'server', name: string }>
 * `name` is already sanitized and is '' only when the player went single
 * player without typing one. Builds the menu, polls the server health while
 * it's open, resolves on the player's pick and removes itself (restoring the
 * boot spinner underneath).
 */
export function showMenu() {
  return new Promise((resolve) => {
    // idempotent: a second showMenu() must not stack a second <style> (and a
    // second copy of the shake keyframes) into <head>
    if (!document.getElementById('atc-menu-css')) {
      const st = el('style'); st.id = 'atc-menu-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }

    const overlay = el('div'); overlay.id = 'atc-menu';
    const inner = el('div', 'atc-menu-inner');
    inner.appendChild(el('h1', '', 'AMONG THE CITY'));
    inner.appendChild(el('div', 'atc-menu-sub', 'Pardubice'));

    const nameRow = el('div', 'atc-name-row');
    const nameIn = el('input', 'atc-menu-name');
    nameIn.type = 'text';
    nameIn.maxLength = 14;
    nameIn.placeholder = 'Vaše přezdívka';
    nameIn.autocomplete = 'off';
    nameIn.spellcheck = false;
    // value goes in as a PROPERTY — never through el()'s innerHTML. What sits
    // in localStorage is still player input and must never become markup.
    nameIn.value = loadName();
    const note = el('div', 'atc-name-note', NOTE_IDLE);
    nameRow.append(nameIn, note);
    inner.appendChild(nameRow);

    const single = el('button', 'atc-menu-btn',
      '▶ Hrát<small>sám ve městě</small>');
    const multi = el('button', 'atc-menu-btn',
      '🌐 Multiplayer (server)<small class="atc-mp-status">hledám server…</small>');
    multi.disabled = true;
    inner.append(single, multi);

    inner.appendChild(el('p', 'atc-menu-hint',
      '<b>WASD</b> pohyb · <b>E</b> nastoupit/vystoupit · <b>C</b> pohled řidiče · '
      + '<b>H</b> klakson · <b>M</b> mapa · <b>V</b> raketa (z vrtulníku)'
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

    // typing clears a pending rejection and saves as you go, so the name is
    // already in localStorage even if the tab is closed before picking a mode
    nameIn.addEventListener('input', () => {
      const raw = nameIn.value, clean = raw.replace(STRIP, '');
      if (clean !== raw) {
        // hold the caret where the player is typing instead of throwing it to
        // the end — measure how much of the text BEFORE it survived the strip
        const at = raw.slice(0, nameIn.selectionStart ?? raw.length)
          .replace(STRIP, '').length;
        nameIn.value = clean;
        nameIn.setSelectionRange(at, at);
      }
      saveName(sanitizeName(nameIn.value));
      nameIn.classList.remove('name-missing');
      nameRow.classList.remove('miss');
      note.textContent = NOTE_IDLE;
    });

    // The gate is a click-time REFUSAL, not a disabled button, for two reasons.
    // (1) `multi.disabled` already means one specific thing — "the server is
    // not answering" — and the poller rewrites it every 5 s; folding a second
    // condition into it would have the poller undo the name check (and the
    // status line can only tell one story at a time). (2) A disabled button
    // swallows the click, so it can never explain itself; an enabled one that
    // shakes the empty field and names the reason teaches in one press. The
    // two conditions therefore stack instead of overwriting: server down =
    // dead button, server up but no name = live button that refuses and says
    // why.
    const requireName = () => {
      if (sanitizeName(nameIn.value)) return true;
      note.textContent = NOTE_MISS;
      nameRow.classList.add('miss');
      nameIn.classList.remove('name-missing');
      void nameIn.offsetWidth;      // reflow, or a second refusal never shakes
      nameIn.classList.add('name-missing');
      nameIn.focus();
      return false;
    };

    const pick = (mode) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (cover) cover.style.visibility = coverVis;   // spinner covers the boot
      overlay.classList.add('atc-menu-out');
      setTimeout(() => overlay.remove(), 400);
      resolve({ mode, name: sanitizeName(nameIn.value) });
    };
    // single player never blocks on a name — you are alone — but if one is
    // typed it still rides along, so there is only ever one identity
    single.addEventListener('click', () => pick('single'));
    multi.addEventListener('click', () => { if (requireName()) pick('server'); });
  });
}
