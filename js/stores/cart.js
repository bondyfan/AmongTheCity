// ---- stores/cart.js: what the player is carrying round a shop, and their bag at home ----
// Pure logic, no three.js and no DOM (tests/stores.test.mjs). Two small things:
//
//   Cart   the goods picked off the shelves and not yet paid for. How many fit
//          depends on what they are carried in: three in the hands, a basket's
//          worth, a trolley's worth. Paying empties it into the bag.
//   Bag    what has been bought and not yet eaten. It is the player's own and
//          is kept in the browser beside the save; eating from it heals and
//          fills through js/vitals.js, exactly as a meal at a counter does.
//
// PURCHASES ARE PER PLAYER: neither object is ever sent to a peer.

import { goodById, total } from './catalog.js';

/** How many items fit in what the player carries them in. */
export const CAPACITY = { hands: 3, basket: 14, trolley: 60 };

export class Cart {
  constructor() { this.lines = new Map(); this.carrier = null; this.store = null; }
  get cap() { return CAPACITY[this.carrier ?? 'hands']; }
  count() { let n = 0; for (const l of this.lines.values()) n += l.n; return n; }
  get empty() { return this.lines.size === 0; }
  /** Put one of `good` in at `price`. False when nothing more fits. */
  add(good, price) {
    if (this.count() >= this.cap) return false;
    const l = this.lines.get(good.id);
    if (l) l.n++; else this.lines.set(good.id, { id: good.id, name: good.name, icon: good.icon, price, n: 1 });
    return true;
  }
  /** Take one of `id` back out (onto the shelf). */
  remove(id) {
    const l = this.lines.get(id);
    if (!l) return false;
    if (--l.n <= 0) this.lines.delete(id);
    return true;
  }
  has(id) { return this.lines.get(id)?.n ?? 0; }
  list() { return [...this.lines.values()]; }
  total() { return total(this.list()); }
  clear() { this.lines.clear(); }
}

const KEY = 'atc-bag';
export class Bag {
  /** `store` is a Storage (localStorage) or anything with getItem/setItem; null keeps it in memory. */
  constructor(store = null) {
    this.store = store; this.items = new Map();
    try {
      const raw = JSON.parse(store?.getItem(KEY) ?? '{}');
      for (const [id, n] of Object.entries(raw)) if (goodById(id) && n > 0) this.items.set(id, Math.min(99, n | 0));
    } catch { /* an unreadable bag is an empty bag */ }
  }
  save() { try { this.store?.setItem(KEY, JSON.stringify(Object.fromEntries(this.items))); } catch { /* full or private */ } }
  /** Everything a paid cart held that is worth keeping (food and drink). */
  takeAll(lines) {
    let kept = 0;
    for (const l of lines) {
      const g = goodById(l.id);
      if (!g || g.keep === false) continue;
      this.items.set(l.id, Math.min(99, (this.items.get(l.id) ?? 0) + l.n));
      kept += l.n;
    }
    this.save();
    return kept;
  }
  count() { let n = 0; for (const v of this.items.values()) n += v; return n; }
  list() { return [...this.items].map(([id, n]) => ({ good: goodById(id), n })).filter((r) => r.good); }
  /** Take one out to eat: the good, or null when there is none. */
  eat(id) {
    const n = this.items.get(id) ?? 0;
    if (n <= 0) return null;
    if (n === 1) this.items.delete(id); else this.items.set(id, n - 1);
    this.save();
    return goodById(id);
  }
  clear() { this.items.clear(); this.save(); }
}

/**
 * An order at a restaurant: dishes chosen at the kiosk, paid at once, cooked
 * for a while, handed over at the counter. `ready(t)` says when.
 */
export class Order {
  constructor() { this.lines = new Map(); this.state = 'none'; this.number = 0; this.readyAt = 0; this.store = null; this.drive = false; }
  add(dish) { const l = this.lines.get(dish.id); if (l) l.n++; else this.lines.set(dish.id, { ...dish, n: 1 }); }
  remove(id) { const l = this.lines.get(id); if (l && --l.n <= 0) this.lines.delete(id); }
  list() { return [...this.lines.values()]; }
  count() { let n = 0; for (const l of this.lines.values()) n += l.n; return n; }
  total() { return total(this.list()); }
  /** Paid: it is in the kitchen for 12 s plus 3 s a dish, never more than 40. */
  place(now, number, store, drive = false) {
    this.state = 'cooking'; this.number = number; this.store = store; this.drive = drive;
    this.readyAt = now + Math.min(40, 12 + 3 * this.count()) * (drive ? 0.5 : 1);
  }
  ready(now) { return this.state === 'cooking' && now >= this.readyAt; }
  /** What eating it all gives: { hp, kcal }. */
  worth() { let hp = 0, kcal = 0; for (const l of this.lines.values()) { hp += l.hp * l.n; kcal += l.kcal * l.n; } return { hp, kcal }; }
  clear() { this.lines.clear(); this.state = 'none'; this.store = null; this.drive = false; }
}
