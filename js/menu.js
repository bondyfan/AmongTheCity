// ---- Main menu: the screen before Pardubice ----
// Fully self-contained like js/settings.js: every bit of DOM and CSS is
// injected from here, index.html and style.css stay untouched. main.js calls
// showMenu() BEFORE boot() and awaits the promise, the player picks single
// player ("Hrát") or the shared dedicated server ("Multiplayer (server)"),
// and only then does the city start streaming.
//
// The multiplayer button gates on the server actually being up: the same
// /health polling pattern as the Woods serverstatus module, enabled only
// while GET {SERVER_URL}/health answers { ready: true }, with the player/room
// count as the status line, re-checked every 10 s while the menu is open and
// visible (js/menuhealth.js, which also stops asking once the page has been
// left alone for 10 minutes). No WebSocket is touched here; the transport
// (netcity.js) connects only after the click.
//
// Layering: the menu sits at z-index 15, above the HUD (10) but BELOW the
// settings gear (20) and panel (40), so "Nastavení" stays reachable from the
// menu (main.js brings initSettings up before showMenu for exactly this).
// The #enter-overlay boot cover lives at z-40 and would blanket the menu, so
// it is stashed (visibility) while the menu is up and restored on the pick:
// the familiar "Přijíždíte do Pardubic…" spinner then covers the boot
// (main.js renames it "…do Prahy…" when the game begins in Prague).
//
// The nickname field is the one thing the server run REQUIRES: a nameplate
// over a stranger's head is what turns "another citizen" into "someone".
// Single player accepts an empty one, you are alone, nobody reads it, but
// it is still remembered and handed back, so a player who types a name once
// never has to think about it again.

import { startHealthPoll } from './menuhealth.js';
import { browserStore, fmtPlayed } from './savegame.js';
import { confirmPanel } from './panel.js';
import { kc } from './prices.js';
import { MENU_CSS } from './menustyle.js';
import { startMenuScene } from './menubg.js';
import { START_PLACES } from './config.js';
import { placeOf, placeById } from './startplace.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// ---- nickname ---------------------------------------------------------------
// Woods' filter plus the blank-nameplate defence. Two classes of character go:
//
//   1. markup/JSON breakers  <>&"'`: the name ends up in a canvas today and
//      could end up in a DOM chat line tomorrow.
//   2. characters that render as NOTHING. String.trim() only knows Unicode Zs
//      and line terminators, so U+200B (zero-width space), U+3164 (hangul
//      filler) and U+2800 (blank braille) all sail straight through it, the
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
// whole U+E00xx tag block, every one of them a perfectly empty nameplate,
// verified against the shipped function. So the rule is also stated
// positively: a nickname must contain at least one character that puts INK on
// the canvas, not whitespace, not a combining mark, not a format control, not
// a surrogate, not private-use, not unassigned. U+200D (ZWJ) and the variation
// selectors deliberately survive the strip above, so a family emoji stays one
// glyph and a thumbs-up keeps its colour; both are format/mark characters, so
// a name made of nothing but them is still refused right here.
const INK = /[^\s\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cs}\p{Cn}\p{Co}]/u;

// Exported because the network layer has to run the SAME filter AGAIN on the
// way IN, a peer's name arrives over the wire and nothing that arrives over a
// wire is trusted. Keep this body byte-identical to netcity.sanitizeName and
// nametags.clean, or sender and receiver disagree about what the name is.
export function sanitizeName(s) {
  const n = String(s ?? '').replace(STRIP, '').trim().slice(0, 14).trim();
  return INK.test(n) ? n : '';
}

export const NAME_KEY = 'atc-name';

// localStorage throws in some privacy modes, the menu must still open
function loadName() {
  try { return sanitizeName(localStorage.getItem(NAME_KEY) || ''); } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch {}
}

// The city the game begins in (the Pardubice / Praha pill), remembered like
// the name. Only a fresh game reads it: a save starts in its own city unless
// the player taps the other one.
export const START_KEY = 'atc-start';
function loadStart() {
  try { return placeById(localStorage.getItem(START_KEY))?.id ?? null; } catch { return null; }
}
function saveStart(id) {
  try { localStorage.setItem(START_KEY, id); } catch {}
}

// The stylesheet lives in js/menustyle.js and the painted town behind the
// menu in js/menubg.js; this file keeps the behaviour.

// The /health poller and its cost guard live in js/menuhealth.js.

const NOTE_IDLE = 'Uvidí ji ostatní hráči · na server bez ní nelze';
const NOTE_MISS = 'Nejdřív si zvolte přezdívku';

/**
 * showMenu() → Promise<{ mode: 'single' | 'server', name: string, start: string }>
 * `name` is already sanitized and is '' only when the player went single
 * player without typing one. `start` is the START_PLACES id the pill shows
 * (js/startplace.js startPoint turns it and the save into a spawn point). Builds the menu, polls the server health while
 * it's open, resolves on the player's pick and removes itself (restoring the
 * boot spinner underneath).
 */
export function showMenu() {
  return new Promise((resolve) => {
    // idempotent: a second showMenu() must not stack a second <style> (and a
    // second copy of the shake keyframes) into <head>
    if (!document.getElementById('atc-menu-css')) {
      const st = el('style'); st.id = 'atc-menu-css'; st.textContent = MENU_CSS;
      document.head.appendChild(st);
    }

    const overlay = el('div'); overlay.id = 'atc-menu';
    const scene = el('canvas', 'atc-menu-scene');
    overlay.append(scene, el('div', 'atc-menu-shade'));
    // where and when: the real hour in Pardubice, so the menu feels like a
    // window onto the town rather than a title card
    const chip = el('div', 'atc-menu-chip');
    chip.append(el('i'), el('span'));
    const tick = () => {
      let hm = '';
      try { hm = new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }); } catch {}
      chip.lastChild.textContent = 'Pardubice' + (hm ? ' · ' + hm : '');
    };
    tick();
    overlay.appendChild(chip);

    const inner = el('div', 'atc-menu-inner');
    inner.appendChild(el('div', 'atc-menu-kicker', 'Otevřené město · skutečné Pardubice'));
    // one span per letter: each rises on its own beat and the sheen runs
    // through the word letter by letter (js/menustyle.js)
    const title = el('h1', 'atc-menu-title');
    title.setAttribute('aria-label', 'Among The City');
    let li = 0;
    for (const word of ['AMONG', 'THE', 'CITY']) {
      const w = el('span', 'w');
      w.setAttribute('aria-hidden', 'true');
      for (const ch of word) {
        const l = el('span', 'l', ch);
        l.style.setProperty('--i', String(li++));
        w.appendChild(l);
      }
      title.appendChild(w);
    }
    inner.appendChild(title);
    inner.appendChild(el('div', 'atc-menu-sub', 'Pardubice'));
    const card = el('div', 'atc-menu-card');

    const nameRow = el('div', 'atc-name-row');
    const nameLbl = el('label', 'atc-name-label', 'Přezdívka');
    nameLbl.htmlFor = 'atc-menu-name';
    nameRow.appendChild(nameLbl);
    const nameIn = el('input', 'atc-menu-name');
    nameIn.id = 'atc-menu-name';
    nameIn.type = 'text';
    nameIn.maxLength = 14;
    nameIn.placeholder = 'Vaše přezdívka';
    nameIn.autocomplete = 'off';
    nameIn.spellcheck = false;
    // value goes in as a PROPERTY, never through el()'s innerHTML. What sits
    // in localStorage is still player input and must never become markup.
    nameIn.value = loadName();
    const note = el('div', 'atc-name-note', NOTE_IDLE);
    nameRow.append(nameIn, note);
    card.appendChild(nameRow);

    // A returning player CONTINUES by default: the save (js/savegame.js) is
    // read here only to decide what the first button says, and career.js loads
    // it for real after the pick. "Nová hra" sits under it as a quiet link and
    // asks first, because it throws that save away. The save is the local
    // player's in either mode, so the multiplayer button continues it too.
    const store = browserStore();
    // the save's own city is the default: "Pokračovat" continues where you
    // were. Without a save, the city picked last time.
    const sum0 = store.summary();
    const savedAt = sum0?.pos ? placeOf(sum0.pos.x, sum0.pos.z).id : null;
    let start = savedAt ?? loadStart() ?? START_PLACES[0].id;
    const single = el('button', 'atc-menu-btn primary');
    const fresh = el('button', 'atc-menu-new', 'Nová hra');
    fresh.type = 'button';
    const paintSingle = () => {
      const sum = store.summary();
      single.textContent = '';
      // built from text nodes: the summary is numbers, but it came out of
      // localStorage and nothing from there goes through innerHTML
      single.append(sum ? '▶ Pokračovat' : '▶ Hrát');
      // a save in the OTHER city than the pill shows keeps its career but
      // starts on this city's square, and the line says so
      const here = sum?.pos ? placeOf(sum.pos.x, sum.pos.z).id : null;
      const journey = start === 'pardubice' && sum?.prologue && sum.prologue !== 'done';
      const move = sum && here && here !== start ? ' · nový start ' + placeById(start).at : '';
      single.appendChild(el('small', '', undefined)).textContent = sum
        ? journey ? 'Poslední vlak • příběh začíná znovu' : kc(sum.money) + ' · odehráno ' + fmtPlayed(sum.played)
          + (sum.jobs ? ' · zakázek ' + sum.jobs : '') + move
        : start === 'pardubice' ? 'Příběh • poslední vlak z Kolína' : 'sám ve městě';
      fresh.style.display = sum ? '' : 'none';
    };
    // Pardubice | Praha: a two-option radio group as one pill
    const place = el('div', 'atc-place');
    place.appendChild(el('span', 'atc-place-label', 'Začít'));
    const pill = el('div', 'atc-place-pill');
    pill.setAttribute('role', 'radiogroup');
    pill.setAttribute('aria-label', 'Kde začít');
    const opts = START_PLACES.map((p) => {
      const b = el('button', 'atc-place-opt');
      b.type = 'button';
      b.textContent = p.name;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (closed) return;
        start = p.id;
        saveStart(start);
        paintPlace();
        paintSingle();
      });
      pill.appendChild(b);
      return b;
    });
    const paintPlace = () => opts.forEach((b, i) => b.setAttribute('aria-checked', String(START_PLACES[i].id === start)));
    place.appendChild(pill);
    paintPlace();
    paintSingle();
    fresh.addEventListener('click', async () => {
      const yes = await confirmPanel({ title: 'NOVÁ HRA',
        text: 'Začít znovu? Uložená hra (peníze, auto, statistiky i úspěchy) se smaže a nejde to vrátit.',
        yes: 'Smazat a začít znovu', no: 'Zpět', danger: true });
      if (!yes || closed) return;
      store.clear();
      paintSingle();
    });
    const multi = el('button', 'atc-menu-btn',
      '🌐 Multiplayer (server)<small class="atc-mp-status">hledám server…</small>');
    multi.disabled = true;
    card.append(single, place, fresh, multi);
    inner.appendChild(card);
    overlay.appendChild(inner);

    const keys = [['WASD', 'pohyb'], ['E', 'nastoupit'], ['J', 'zakázky'], ['M', 'mapa'], ['C', 'pohled řidiče'], ['H', 'klakson']];
    overlay.appendChild(el('div', 'atc-menu-foot',
      '<div class="atc-menu-keys">' + keys.map(([k, t]) => `<kbd>${k}</kbd>${t}`).join('<span class="sep">·</span>')
      + '<span class="sep">·</span>nastavení pod ⚙️ vpravo nahoře</div>'
      + '<div class="atc-menu-credit">Mapová data © přispěvatelé OpenStreetMap · Ortofoto © ČÚZK · Podlažnost © IPR Praha</div>'));
    document.body.appendChild(overlay);
    const stopScene = startMenuScene(scene);
    const clock = setInterval(tick, 15000);

    // the boot cover (z-40) would blanket the menu, stash it, restore on pick
    const cover = document.getElementById('enter-overlay');
    const coverVis = cover ? cover.style.visibility : '';
    if (cover) cover.style.visibility = 'hidden';

    // health poll while the menu is open; also re-enables if the server comes
    // UP after the menu appeared (typical local flow: start game, then server)
    let closed = false;
    const stopPoll = startHealthPoll(multi, multi.querySelector('.atc-mp-status'));

    // typing clears a pending rejection and saves as you go, so the name is
    // already in localStorage even if the tab is closed before picking a mode
    nameIn.addEventListener('input', () => {
      const raw = nameIn.value, clean = raw.replace(STRIP, '');
      if (clean !== raw) {
        // hold the caret where the player is typing instead of throwing it to
        // the end, measure how much of the text BEFORE it survived the strip
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
    // (1) `multi.disabled` already means one specific thing, "the server is
    // not answering", and the poller rewrites it every 10 s; folding a second
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
      stopPoll();
      clearInterval(clock);
      if (cover) cover.style.visibility = coverVis;   // spinner covers the boot
      overlay.classList.add('atc-menu-out');        // the town rushes towards you
      setTimeout(() => { stopScene(); overlay.remove(); }, 900);
      resolve({ mode, name: sanitizeName(nameIn.value), start });
    };
    // single player never blocks on a name, you are alone, but if one is
    // typed it still rides along, so there is only ever one identity
    single.addEventListener('click', () => pick('single'));
    // Enter in the name field plays, the way a player expects a form to submit
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); single.click(); } });
    multi.addEventListener('click', () => { if (requireName()) pick('server'); });
  });
}
