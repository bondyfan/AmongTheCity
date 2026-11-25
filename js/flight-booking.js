// ---- flight-booking.js: "Kam letíme?" at the check-in desk ----
// The list js/flight-destinations.js gives for this airport, on js/panel.js
// (Escape and a click outside close it, by the panel's own rules). A view
// only: the buying is the caller's `onBuy(dest)`, which answers true when the
// ticket was sold, and the panel then closes.

import { makePanel, el } from './panel.js';
import { kc } from './prices.js';
import { destinationsFrom } from './flight-destinations.js';

const ICON = { sez: '🏝️', ped: '🏠', prg: '🏰' };

export function bookingPanel({ money, onBuy }) {
  const panel = makePanel({ title: 'Kam letíme?', narrow: true });
  let home = null;

  function row(d, have) {
    const r = el('div', 'atc-pn-row');
    r.appendChild(el('span', 'pr-icon', ICON[d.id] ?? '✈️'));
    const main = el('div', 'pr-main');
    main.appendChild(el('div', 'pr-title', d.name + ' · ' + d.country));
    main.appendChild(el('div', 'pr-line', d.open
      ? d.no + ' přes ' + d.via + ' · asi ' + Math.round(d.hours) + ' h · odlet do 5 minut'
      : 'Připravujeme'));
    const side = el('div', 'pr-side');
    if (d.open) {
      side.appendChild(el('span', 'pr-pay cost', kc(d.fare)));
      const b = el('button', 'atc-btn', 'Koupit');
      b.type = 'button';
      b.disabled = have < d.fare;
      b.title = have < d.fare ? 'Na letenku nemáš dost peněz' : 'Koupit letenku';
      b.addEventListener('click', () => { if (onBuy(d)) panel.close(); else draw(); });
      side.appendChild(b);
    } else {
      r.style.opacity = '0.55';
    }
    r.append(main, side);
    return r;
  }
  function draw() {
    const have = money();
    panel.body.textContent = '';
    panel.sub.textContent = kc(have);
    for (const d of destinationsFrom(home)) panel.body.appendChild(row(d, have));
    panel.body.appendChild(el('p', 'atc-pn-note',
      'Letadlo už stojí na ploše. Nástup začne hned po odbavení a letí se nejpozději za pět minut.'));
  }

  return {
    /** Open the list for airport `at` ('LKPD', 'LKPR', 'SEZ'). */
    open(at, title = 'Kam letíme?') {
      home = at;
      panel.setTitle(title);
      draw();
      if (!panel.isOpen) panel.open();
    },
    close() { panel.close(); },
    get isOpen() { return panel.isOpen; },
  };
}
