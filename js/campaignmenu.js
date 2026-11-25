// ---- campaignmenu.js: the Kampaně tab of the settings panel ----
// Frank, 22 Nov 2026: "v nastaveni nekde musi byt zalozka kampane aby clovek si
// mohl kliknout na jakoukoliv kampan kterou delal aby ji mohl delat znovu. (ale
// kdyz z toho neco vyhraje treba penize tak uz ty penize nedostane znovu / na
// konci te mise se mu ukaze ze penize nedostal ... protoze uz tu misi opakuje)"
//
// The panel (js/settings.js) knows nothing of campaigns: every time its tab is
// opened it raises `atc:campaigns` with the empty page, and main.js hands that
// page here with what js/career.js says there is. A finished campaign gets a
// "Hrát znovu" button; what it paid is shown, and that it will not pay twice.

import { kc } from './prices.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** What one campaign's card says under its name. Pure: tested in tests/campaigns.test.mjs. */
export function rewardLine(c) {
  if (!c.reward) return c.done ? 'Dohráno' : 'Ještě nedohráno';
  if (!c.done) return 'Ještě nedohráno · odměna ' + kc(c.reward);
  return c.paid
    ? 'Dohráno · odměna ' + kc(c.reward) + ' vyplacena, při opakování se nevyplácí'
    : 'Dohráno · odměna ' + kc(c.reward) + ' ještě nebyla vyplacena, dostaneš ji';
}

/**
 * Fill the tab. `info` is career.campaigns() plus `inGame` (the world is up)
 * and `net` (co-op); `play(id)` starts a replay, `quit()` ends a running one.
 */
export function fillCampaigns(box, info, { play, quit }) {
  box.textContent = '';
  const note = (t) => box.appendChild(el('p', 'atc-set-note', t));
  if (!info.inGame) { note('Kampaně najdeš tady, jakmile spustíš hru.'); return; }
  if (info.net || !info.able) { note('Kampaně jdou hrát a opakovat jen ve hře pro jednoho hráče.'); return; }
  const grid = box.appendChild(el('div', 'atc-set-grid atc-camp'));
  for (const c of info.list) {
    const card = grid.appendChild(el('div', 'atc-opt atc-camp-card'));
    const text = card.appendChild(el('div'));
    text.append(el('span', 'atc-opt-label', c.title), el('small', '', c.sub), el('small', 'atc-camp-state', rewardLine(c)));
    if (c.done && !info.busy) {
      const b = card.appendChild(el('button', 'atc-set-act', 'Hrát znovu'));
      b.type = 'button';
      b.addEventListener('click', () => play(c.id));
    } else if (info.replaying === c.id) {
      card.appendChild(el('small', 'atc-camp-run', 'Právě ji opakuješ'));
    }
  }
  if (info.replaying) {
    note('Opakování se ukládá až na svém konci. Když ho ukončíš, vrátíš se k uložené hře.');
    const b = box.appendChild(el('button', 'atc-set-act', 'Ukončit opakování'));
    b.type = 'button';
    b.addEventListener('click', quit);
  } else if (info.busy) {
    note('Kampaň právě běží. Opakovat jde až dohranou kampaň, po jejím konci.');
  } else {
    note('Opakovaná kampaň začíná od začátku a hraje se na jeden zátah. Odměnu vyplácí jen poprvé.');
  }
}
