// ---- Stats and achievements (P) ----
// Progress you can see: the numbers, the achievements (earned ones lit, the
// rest dimmed with what they ask for) and the parts of town discovered so far.
// Reads a Progress (js/progress.js) and draws it; owns no state of its own.

import { makePanel, el } from './panel.js';
import { ACHIEVEMENTS } from './progress.js';
import { fmtPlayed } from './savegame.js';
import { kc } from './prices.js';

const km = (m) => (m / 1000).toFixed(m < 100000 ? 1 : 0).replace('.', ',') + ' km';

function tile(value, label) {
  const t = el('div', 'atc-stat');
  t.appendChild(el('b', '', value));
  t.appendChild(el('span', '', label));
  return t;
}

export class StatsPanel {
  constructor() {
    this.panel = makePanel({ title: 'PŘEHLED' });
  }
  get isOpen() { return this.panel.isOpen; }
  close() { this.panel.close(); }

  show({ progress, played, money, car }) {
    const s = progress.stats, body = this.panel.body;
    body.textContent = '';
    const got = Object.keys(progress.unlocked).length;
    this.panel.sub.textContent = 'odehráno ' + fmtPlayed(played);

    body.appendChild(el('div', 'atc-pn-h3', 'Statistiky'));
    const grid = el('div', 'atc-stat-grid');
    grid.append(
      tile(kc(money), 'na účtu'),
      tile(kc(s.earned), 'vyděláno prací'),
      tile(kc(s.spent), 'utraceno'),
      tile(String(s.jobsCourier), 'doručených zásilek'),
      tile(String(s.jobsTaxi), 'odvezených zákazníků'),
      tile(kc(s.bestPay), 'nejlepší zakázka'),
      tile(km(s.driveM), 'za volantem'),
      tile(km(s.walkM), 'pěšky'),
      tile(car ?? 'žádné', 'tvoje auto'),
    );
    body.appendChild(grid);

    body.appendChild(el('div', 'atc-pn-h3', 'Úspěchy ' + got + ' / ' + ACHIEVEMENTS.length));
    const list = el('div', 'atc-ach');
    for (const a of ACHIEVEMENTS) {
      const on = !!progress.unlocked[a.id];
      const r = el('div', 'atc-pn-row' + (on ? '' : ' locked'));
      r.appendChild(el('span', 'pr-icon', on ? '🏆' : '🔒'));
      const main = el('div', 'pr-main');
      main.appendChild(el('div', 'pr-title', a.name));
      main.appendChild(el('div', 'pr-line', a.desc));
      const side = el('div', 'pr-side');
      side.appendChild(el('span', 'pr-pay', '+' + kc(a.reward)));
      r.append(main, side);
      list.appendChild(r);
    }
    body.appendChild(list);

    body.appendChild(el('div', 'atc-pn-h3', 'Objevená místa ' + s.districts.length));
    if (s.districts.length) {
      const chips = el('div', 'atc-chips');
      for (const d of s.districts) chips.appendChild(el('span', 'atc-chip', d));
      body.appendChild(chips);
    } else {
      body.appendChild(el('div', 'atc-pn-empty', 'Zatím nic. Každá čtvrť a obec, do které vjedeš, se tu objeví.'));
    }
    if (!this.panel.isOpen) this.panel.open();
  }
}
