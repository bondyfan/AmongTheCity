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
//
// Frank, 25 Nov 2026: "kampan se musi dat ukoncit.. asi v nastaveni - kampan a
// tam ukoncit". The part that runs can be quit here (a second click confirms
// it, so a slip of the mouse throws nothing away), and the part that waits
// says where it begins, with the navigation to its start one click away.

import { kc } from './prices.js';
import { startNote } from './campaignparts.js';

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

/** What the quit button says, and what the note over it says. Pure: tested in tests/campaignflow.test.mjs. */
export function quitWords(info) {
  return info.replaying
    ? { label: 'Ukončit opakování', note: 'Opakování se neukládá. Když ho ukončíš, zůstaneš, kde stojíš, a uložená hra zůstane, jak byla.' }
    : { label: 'Ukončit kampaň', note: 'Rozehraná část se neukládá. Když ji ukončíš, zůstaneš ve volné hře, kde stojíš, a začít ji můžeš znovu na jejím startu.' };
}
export const CONFIRM = 'Opravdu ukončit? Klikni znovu';

/**
 * Fill the tab. `info` is career.campaigns() plus `next` (career.nextPart()),
 * `inGame` (the world is up) and `net` (co-op); `play(id)` starts a part,
 * `quit()` ends the running one, `route(part)` navigates to a start.
 */
export function fillCampaigns(box, info, { play, quit, route }) {
  box.textContent = '';
  const note = (t) => box.appendChild(el('p', 'atc-set-note', t));
  if (!info.inGame) { note('Kampaně najdeš tady, jakmile spustíš hru.'); return; }
  if (info.net || !info.able) { note('Kampaně jdou hrát a opakovat jen ve hře pro jednoho hráče.'); return; }
  const grid = box.appendChild(el('div', 'atc-set-grid atc-camp'));
  for (const c of info.list) {
    const card = grid.appendChild(el('div', 'atc-opt atc-camp-card'));
    const text = card.appendChild(el('div'));
    text.append(el('span', 'atc-opt-label', c.title), el('small', '', c.sub), el('small', 'atc-camp-state', rewardLine(c)));
    if (info.running === c.id) {
      card.appendChild(el('small', 'atc-camp-run', info.replaying ? 'Právě ji opakuješ' : 'Právě ji hraješ'));
    } else if (c.done && !info.busy) {
      const b = card.appendChild(el('button', 'atc-set-act', 'Hrát znovu'));
      b.type = 'button';
      b.addEventListener('click', () => play(c.id));
    } else if (info.next?.id === c.id && !info.busy) {
      text.append(el('small', 'atc-camp-run', startNote(info.next)));
      const b = card.appendChild(el('button', 'atc-set-act', 'Navigovat na start'));
      b.type = 'button';
      b.addEventListener('click', () => route?.(info.next));
    }
  }
  if (info.busy) {
    const words = quitWords(info);
    note(words.note);
    const b = box.appendChild(el('button', 'atc-set-act', words.label));
    b.type = 'button';
    let armed = 0;
    b.addEventListener('click', () => {
      if (armed) { clearTimeout(armed); armed = 0; quit(); return; }
      b.textContent = CONFIRM;
      armed = setTimeout(() => { armed = 0; b.textContent = words.label; }, 4000);
    });
  } else {
    note('Každá část má svůj konec. Další začne, až přijdeš na její start (značka na mapě). Opakovaná část odměnu vyplácí jen poprvé.');
  }
}
