// ---- Shop panels: the food counter (E) and the car deal (B) ----
// Two small lists on js/panel.js. Both are views: the buying itself (wallet,
// vitals, ownership) is the caller's, passed in as callbacks that answer true
// when the sale went through, so a refused payment leaves the panel exactly as
// it was and the buttons re-read the balance.

import { makePanel, el } from './panel.js';
import { PRICE, kc } from './prices.js';

function payRow(icon, title, line, price, label, can, onClick, cost = true) {
  const r = el('div', 'atc-pn-row');
  r.appendChild(el('span', 'pr-icon', icon));
  const main = el('div', 'pr-main');
  main.appendChild(el('div', 'pr-title', title));
  if (line) main.appendChild(el('div', 'pr-line', line));
  const side = el('div', 'pr-side');
  if (price !== null) side.appendChild(el('span', 'pr-pay' + (cost ? ' cost' : ''), kc(price)));
  if (label) {
    const b = el('button', 'atc-btn', label);
    b.type = 'button';
    b.disabled = !can;
    b.addEventListener('click', onClick);
    side.appendChild(b);
  }
  r.append(main, side);
  return r;
}

// ---- food -----------------------------------------------------------------
const FOOD_ICON = { parek: '🌭', pernik: '🍪', langos: '🫓', smazak: '🧀', gulas: '🍲', svickova: '🍽️' };
/** Energy a plate gives: more filling than healing, so a snack keeps you going
 *  and a proper meal resets the day. */
export const energyOf = (plate) => Math.min(100, Math.round(plate.hp * 1.7));

export class FoodPanel {
  constructor({ onBuy, money }) {
    this.onBuy = onBuy; this.money = money;
    this.panel = makePanel({ title: '', narrow: true });
    this._venue = null;
  }
  get isOpen() { return this.panel.isOpen; }

  show(venue) {
    this._venue = venue;
    this.panel.setTitle(venue.name);
    this._draw();
    if (!this.panel.isOpen) this.panel.open();
  }

  _draw() {
    const body = this.panel.body, have = this.money();
    body.textContent = '';
    this.panel.sub.textContent = kc(have);
    for (const plate of PRICE.food) {
      body.appendChild(payRow(FOOD_ICON[plate.id] ?? '🍴', plate.name,
        '+' + plate.hp + ' zdraví · +' + energyOf(plate) + ' sytost',
        plate.price, 'Koupit', have >= plate.price,
        () => { if (this.onBuy(plate, this._venue)) this._draw(); }));
    }
    body.appendChild(el('p', 'atc-pn-note', 'Jídlo léčí hned. S prázdným žaludkem se tělo samo neuzdravuje.'));
  }
}

// ---- cars -----------------------------------------------------------------
export class CarPanel {
  constructor({ onBuy, onRepair, onCanister, money }) {
    this.onBuy = onBuy; this.onRepair = onRepair; this.onCanister = onCanister; this.money = money;
    this.panel = makePanel({ title: '', narrow: true });
    this._view = null;
  }
  get isOpen() { return this.panel.isOpen; }
  close() { this.panel.close(); }

  /**
   * view = { car, name, mine, offer: {price, list, cond, note} | null,
   *          tradeIn, damage (0..1), fuelPct, repair (Kč) }
   */
  show(view) {
    this._view = view;
    this._draw();
    if (!this.panel.isOpen) this.panel.open();
  }

  _draw() {
    const v = this._view, body = this.panel.body, have = this.money();
    body.textContent = '';
    this.panel.setTitle(v.mine ? 'TVOJE AUTO' : 'KOUPIT AUTO');
    this.panel.sub.textContent = kc(have);
    // no-break spaces: "81" and "%" must not end up on two lines
    const state = 'stav ' + Math.round((1 - Math.min(1, v.damage)) * 100) + '\u00a0% · nádrž '
      + Math.round(v.fuelPct * 100) + '\u00a0%';
    if (v.mine) {
      body.appendChild(payRow('🚗', v.name, state, null, null, false, null));
      if (v.repair > 0) {
        body.appendChild(payRow('🔧', 'Oprava', 'Karoserie i motor jako dřív', v.repair, 'Opravit',
          have >= v.repair && v.canRepair,
          () => { if (this.onRepair(v.car)) this.panel.close(); }));
        if (!v.canRepair) body.appendChild(el('p', 'atc-pn-note', 'Opravit jde jen stojící auto.'));
      }
      if (v.canister) {
        body.appendChild(payRow('⛽', 'Kanystr ' + v.canister.units + ' ' + v.canister.unit,
          'Dovoz paliva až k autu. U pumpy je to levnější.', v.canister.price, 'Objednat',
          have >= v.canister.price,
          () => { if (this.onCanister(v.car)) this.panel.close(); }));
      }
      if (v.repair <= 0 && !v.canister) {
        body.appendChild(el('p', 'atc-pn-note', 'Auto je v pořádku. Je uložené, najdeš ho na mapě a počká tam, kde ho necháš.'));
      }
      return;
    }
    if (!v.offer) {
      body.appendChild(payRow('🚫', v.name, 'Tohle není na prodej', null, null, false, null));
      return;
    }
    const total = Math.max(0, v.offer.price - v.tradeIn);
    body.appendChild(payRow('🚗', v.name,
      v.offer.note + ' · ' + state + ' · v ceníku ' + kc(v.offer.list), v.offer.price, null, false, null));
    if (v.tradeIn > 0)
      body.appendChild(payRow('↔️', 'Protiúčet', 'Tvoje dosavadní auto jde na protiúčet', -v.tradeIn, null, false, null, false));
    body.appendChild(payRow('✅', 'K zaplacení', total > have ? 'Chybí ' + kc(total - have) : 'Auto bude tvoje',
      total, 'Koupit', have >= total,
      () => { if (this.onBuy(v.car)) this.panel.close(); }));
    body.appendChild(el('p', 'atc-pn-note',
      'Vlastní auto se ukládá, je vidět na mapě, počká tam, kde ho necháš, a můžeš si ho nechat opravit.'));
  }
}
