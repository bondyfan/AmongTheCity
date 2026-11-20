// ---- stores/shopping.js: doing the shopping ----
// The local player's side of a supermarket: take a basket inside the door or a
// trolley from the bay outside, take things off the shelves, have them scanned
// at a till with a cashier or scan them at a self-checkout, pay with the
// game's money, carry the shopping out. Walking out with unpaid goods sets off
// the alarm at the door and is a crime with witnesses.
//
// One instance per store whose interior is built; the cart, the bag and the
// panel are the player's own and are shared by every store (js/stores/world.js).
// Nothing here is sent to anybody: purchases are per player.

import { DEPT_NAME, goodsOf, priceAt } from './catalog.js';
import { isOpen, hoursText } from './chains.js';
import { carrierMesh } from './props.js';
import { beep, paid, refused, alarm } from './sounds.js';
import { tillsOpen } from './schedule.js';
import { kc } from '../prices.js';

const R_SHELF = 1.9, R_TILL = 1.5, R_BASKET = 1.4, R_BAY = 2.6;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class MarketShop {
  /**
   * @param rec    the store record of js/stores/world.js { site, chain, key }
   * @param layout js/stores/layout.js marketLayout
   * @param d      { cart, bag, panel, wallet, wanted, toast, hour() }
   */
  constructor(rec, layout, d) {
    this.rec = rec; this.layout = layout; this.d = d;
    this.scan = null;                       // { t, per, n, till, self }
    this.wasInside = false;
    const sp = rec.site.spots;
    this.bay = sp.bay ? rec.site.dw((sp.bay.u0 + sp.bay.u1) / 2, sp.bay.v1 + 0.9) : null;
  }
  get open() { return isOpen(this.rec.chain, this.d.hour()); }

  _nearest(x, z, kind, r) {
    let best = r, hit = null;
    for (const p of this.layout.points) {
      if (p.kind !== kind) continue;
      const dd = Math.hypot(p.x - x, p.z - z);
      if (dd < best) { best = dd; hit = p; }
    }
    return hit;
  }
  /** What E would do where the player stands: { html, act } or null. */
  _what(x, z) {
    const cart = this.d.cart, here = cart.store === null || cart.store === this.rec.key;
    if (this.bay && Math.hypot(this.bay[0] - x, this.bay[1] - z) < R_BAY) {
      if (!cart.carrier) return { html: '<kbd>E</kbd> vzít vozík', act: () => this._take('trolley') };
      if (cart.carrier === 'trolley' && cart.empty) return { html: '<kbd>E</kbd> vrátit vozík', act: () => this._drop() };
    }
    if (!here) return null;
    const bk = this._nearest(x, z, 'baskets', R_BASKET);
    if (bk) {
      if (!cart.carrier) return { html: '<kbd>E</kbd> vzít košík', act: () => this._take('basket') };
      if (cart.carrier === 'basket' && cart.empty) return { html: '<kbd>E</kbd> vrátit košík', act: () => this._drop() };
    }
    const till = this._nearest(x, z, 'till', R_TILL) ?? this._nearest(x, z, 'self', R_TILL);
    if (till && !cart.empty) {
      const self = till.kind === 'self';
      if (!self && till.i >= tillsOpen(this.layout.tills.length, this.d.hour()))
        return { html: 'Pokladna ' + (till.i + 1) + ' je zavřená', act: null };
      return { html: self ? '<kbd>E</kbd> samoobslužná pokladna' : '<kbd>E</kbd> zaplatit · pokladna ' + (till.i + 1), act: () => this._checkout(till, self) };
    }
    const sh = this._nearest(x, z, 'shelf', R_SHELF);
    if (sh) return { html: '<kbd>E</kbd> zboží · ' + esc(DEPT_NAME[sh.cat] ?? 'regál'), act: () => this._shelf(sh) };
    return null;
  }
  hint(x, z) {
    if (this.d.panel.isOpen) return '';
    return this._what(x, z)?.html ?? '';
  }
  use(x, z) {
    const w = this._what(x, z);
    if (!w?.act) return false;
    w.act();
    return true;
  }

  _take(kind) {
    const c = this.d.cart;
    c.carrier = kind; c.store = this.rec.key;
    this.d.onCarrier?.(kind, this.rec);
    this.d.toast(kind === 'trolley' ? 'Vozík' : 'Košík', { icon: '🛒', sub: 'Zboží ber u regálů klávesou E, zaplať u pokladny.' });
  }
  _drop() {
    const c = this.d.cart;
    c.carrier = null; if (c.empty) c.store = null;
    this.d.onCarrier?.(null, this.rec);
  }
  _shelf(pt) {
    const cart = this.d.cart, chain = this.rec.chain;
    cart.store = this.rec.key;
    this.d.panel.shelf({
      title: (DEPT_NAME[pt.cat] ?? 'Regál').toUpperCase(),
      goods: goodsOf(pt.cat).map((good) => ({ good, price: priceAt(chain.id, good) })),
      cart,
      hint: cart.carrier ? 'Zaplatíš u pokladny, nebo u samoobslužné pokladny.'
        : 'V rukou uneseš tři věci. Košík je hned za dveřmi, vozíky před obchodem.',
      onTake: (good, price) => {
        const ok = cart.add(good, price);
        if (!ok) { refused(); this.d.toast('Víc se nevejde', { icon: '🛒', kind: 'warn', sub: cart.carrier ? 'Zaplať, nebo něco vrať.' : 'Vezmi si košík nebo vozík.' }); }
        else this.d.onPick?.();
        return ok;
      },
      onPut: (id) => { cart.remove(id); this.d.onPick?.(); },
    });
  }
  _checkout(till, self) {
    const cart = this.d.cart;
    this.scan = { t: 0, per: self ? 0.42 : 0.62, n: cart.count(), till, self, beeps: 0 };
    this.d.onScan?.(this.scan);
    this.d.panel.till({
      title: self ? 'SAMOOBSLUŽNÁ POKLADNA' : 'POKLADNA ' + (till.i + 1),
      cart, have: () => this.d.wallet.money(),
      scanned: () => (this.scan ? Math.floor(this.scan.t / this.scan.per) : 0),
      note: self ? 'Markuješ si sám. Placení kartou.' : 'Dobrý den. Tašku budete chtít?',
      onPay: () => this._pay(),
      onClose: () => { this.scan = null; this.d.onScan?.(null); },
    });
  }
  _pay() {
    const cart = this.d.cart, sum = cart.total();
    if (!this.d.wallet.pay(sum, 'nákup')) { refused(); return false; }
    const n = cart.count(), kept = this.d.bag.takeAll(cart.list());
    cart.clear();
    paid();
    this.d.onPick?.();
    this.d.onPaid?.(sum, n);
    this.d.toast('Zaplaceno ' + kc(sum), { icon: '🧾', kind: 'good',
      sub: kept ? 'Nákup máš v tašce. Klávesou I ji otevřeš a můžeš jíst.' : 'Děkujeme za nákup.' });
    return true;
  }

  /** Once a frame while the player is at this store. `inside`: within the footprint. */
  update(dt, x, z, inside) {
    const cart = this.d.cart;
    if (this.scan) {
      const before = Math.floor(this.scan.t / this.scan.per);
      this.scan.t += dt;
      const now = Math.min(this.scan.n, Math.floor(this.scan.t / this.scan.per));
      if (now > before && before < this.scan.n) { beep(); this.d.panel.redraw(); }
      // walked away from the till: the sale is off
      if (Math.hypot(this.scan.till.x - x, this.scan.till.z - z) > 2.6) this.d.panel.close();
    }
    // ---- the door: out with goods that were never paid for ----
    if (this.wasInside && !inside && cart.store === this.rec.key) {
      if (!cart.empty) {
        alarm();
        const n = cart.count();
        this.d.bag.takeAll(cart.list());
        cart.clear();
        this.d.onPick?.();
        this.d.wanted.add(18, 'krádež v obchodě');
        this.d.toast('Alarm u východu', { icon: '🚨', kind: 'warn', sub: n + ' ks nezaplaceného zboží. To je krádež.' });
      }
      if (cart.carrier === 'basket') this._drop();        // the basket stays at the door
      if (!cart.carrier) cart.store = null;
    }
    this.wasInside = inside;
  }
  closedHint() { return 'Zavřeno · otevřeno ' + hoursText(this.rec.chain); }
  dispose() { if (this.scan) this.d.panel.close(); }
}

export { carrierMesh };
