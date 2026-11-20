// ---- stores/panels.js: the shop's four small screens ----
// The shelf (take and put back), the till (the receipt and the pay button),
// the bag (eat what you bought) and the restaurant's order screen. All four are
// lists on js/panel.js, so Escape and a click outside close them and only one
// is ever up. They are views: taking, paying and eating are the caller's
// callbacks, which answer true when the thing went through.

import { makePanel, el } from '../panel.js';
import { kc } from '../prices.js';

const money = (p) => (Math.abs(p - Math.round(p)) < 0.005 ? kc(Math.round(p)) : p.toFixed(2).replace('.', ',') + ' Kč');

function row(icon, title, line, right, buttons) {
  const r = el('div', 'atc-pn-row');
  r.appendChild(el('span', 'pr-icon', icon));
  const main = el('div', 'pr-main');
  main.appendChild(el('div', 'pr-title', title));
  if (line) main.appendChild(el('div', 'pr-line', line));
  const side = el('div', 'pr-side');
  if (right) side.appendChild(el('span', 'pr-pay cost', right));
  const bs = el('div');
  bs.style.cssText = 'display:flex;gap:6px';
  for (const [label, can, fn] of buttons ?? []) {
    const b = el('button', 'atc-btn', label);
    b.type = 'button'; b.disabled = !can;
    b.addEventListener('click', fn);
    bs.appendChild(b);
  }
  if (buttons?.length) side.appendChild(bs);
  r.append(main, side);
  return r;
}

/** One panel object for all four screens: only one is ever open. */
export class StorePanel {
  constructor() {
    this.panel = makePanel({ title: '', narrow: true, onClose: () => this._onClose?.() });
    this._draw = null; this._onClose = null;
  }
  get isOpen() { return this.panel.isOpen; }
  close() { this.panel.close(); }
  redraw() { if (this.panel.isOpen) this._draw?.(); }
  _show(title, draw, onClose = null) {
    this._draw = draw; this._onClose = onClose;
    this.panel.setTitle(title);
    draw();
    if (!this.panel.isOpen) this.panel.open();
  }

  /** The shelf: v = { title, goods: [{ good, price }], cart, hint, onTake(good, price), onPut(id) }. */
  shelf(v) {
    this._show(v.title, () => {
      const body = this.panel.body;
      body.textContent = '';
      this.panel.sub.textContent = v.cart.count() + ' / ' + v.cart.cap + ' ks';
      for (const { good, price: p } of v.goods) {
        const n = v.cart.has(good.id);
        const fx = good.hp || good.kcal ? '+' + good.hp + ' zdraví · +' + good.kcal + ' sytost' : 'do domácnosti';
        body.appendChild(row(good.icon, good.name, fx + (n ? ' · máš ' + n + '×' : ''), money(p), [
          ['−', n > 0, () => { v.onPut(good.id); this._draw(); }],
          ['Vzít', v.cart.count() < v.cart.cap, () => { v.onTake(good, p); this._draw(); }],
        ]));
      }
      body.appendChild(el('p', 'atc-pn-note', v.hint));
    });
  }

  /** The till: v = { title, cart, have(), scanned(), note, onPay() }. Redrawn by the caller while it scans. */
  till(v) {
    this._show(v.title, () => {
      const body = this.panel.body, lines = v.cart.list(), done = v.scanned();
      body.textContent = '';
      this.panel.sub.textContent = kc(v.have());
      let seen = 0;
      for (const l of lines) {
        const got = Math.max(0, Math.min(l.n, done - seen));
        seen += l.n;
        const r = row(l.icon, l.name + (l.n > 1 ? ' ' + l.n + '×' : ''), got >= l.n ? 'namarkováno' : got ? got + ' z ' + l.n : 'čeká na pásu', money(l.price * l.n));
        if (got < l.n) r.style.opacity = '0.55';
        body.appendChild(r);
      }
      const total = v.cart.total(), ready = done >= v.cart.count();
      body.appendChild(row('🧾', 'Celkem', ready ? (v.have() >= total ? 'Kartou, nebo hotově' : 'Chybí ' + kc(total - v.have())) : 'Markuje se…',
        kc(total), [['Zaplatit', ready && v.have() >= total, () => { if (v.onPay()) this.close(); }]]));
      body.appendChild(el('p', 'atc-pn-note', v.note));
    }, v.onClose);
  }

  /** The bag: v = { bag, onEat(id) }. */
  bag(v) {
    this._show('TAŠKA S NÁKUPEM', () => {
      const body = this.panel.body, list = v.bag.list();
      body.textContent = '';
      this.panel.sub.textContent = v.bag.count() + ' ks';
      if (!list.length) body.appendChild(el('p', 'atc-pn-note', 'Taška je prázdná. Co koupíš v obchodě, najdeš tady a můžeš to sníst kdykoli.'));
      for (const { good, n } of list)
        body.appendChild(row(good.icon, good.name + (n > 1 ? ' ' + n + '×' : ''), '+' + good.hp + ' zdraví · +' + good.kcal + ' sytost', null,
          [[/drinks|beer/.test(good.dept) || good.id === 'mleko' ? 'Vypít' : 'Sníst', true, () => { v.onEat(good.id); this._draw(); }]]));
      if (list.length) body.appendChild(el('p', 'atc-pn-note', 'Jídlo z tašky léčí a sytí stejně jako u pultu.'));
    });
  }

  /** The order screen: v = { title, menu, order, have(), note, onPay() }. */
  menu(v) {
    this._show(v.title, () => {
      const body = this.panel.body;
      body.textContent = '';
      this.panel.sub.textContent = kc(v.have());
      let sec = null;
      for (const d of v.menu) {
        if (d.sec !== sec) { sec = d.sec; const h = el('p', 'atc-pn-note', sec.toUpperCase()); h.style.margin = '12px 2px 4px'; body.appendChild(h); }
        const n = v.order.lines.get(d.id)?.n ?? 0;
        body.appendChild(row(d.icon, d.name + (n ? ' ' + n + '×' : ''), '+' + d.hp + ' zdraví · +' + d.kcal + ' sytost', kc(d.price), [
          ['−', n > 0, () => { v.order.remove(d.id); this._draw(); }],
          ['Přidat', true, () => { v.order.add(d); this._draw(); }],
        ]));
      }
      const total = v.order.total();
      body.appendChild(row('🧾', 'Objednávka', v.order.count() ? v.order.count() + ' položek' : 'Zatím nic', kc(total),
        [[v.payLabel ?? 'Objednat a zaplatit', v.order.count() > 0 && v.have() >= total, () => { if (v.onPay()) this.close(); }]]));
      body.appendChild(el('p', 'atc-pn-note', v.note));
    }, v.onClose);
  }
}

export { money };
