// ---- tickets.js: a ticket for every train, kept in the player's phone ----
// Frank, 22 Nov 2026: "na každej vlak si musím koupit lístek ... vytáhnu mobil
// a tam si to koupím."
//
// THE RULE. A ticket is a SINGLE RIDE on one train, however far: bought on the
// phone (js/phone.js, key L) at any time, kept in the phone until it is used.
// Nobody is stopped at the door. A few seconds after the train has left the
// platform the conductor comes round (and at the latest as it stops at the
// next station): a ticket in the phone is marked and is good on that train
// until he gets off it, and for getting back on the same train. Two kinds:
//   'os'  any ordinary train of the open world,
//   'r'   the express R Pardubice - Praha (js/express.js); it is also taken on
//         an ordinary train when he has nothing cheaper.
// WITHOUT ONE he pays the fare and a surcharge on the spot (PRICE.train.fine),
// which makes that ride paid for. Without the money for it the conductor puts
// him off at the next station (the caller's `putOff`, which is trains.alight).
//
// WHAT IS SAVED. The unused tickets in the phone (`held`), with the money they
// were bought for: js/career.js writes both into the same save at the same
// autosave point and reads both back. The ride being ridden is not saved: a
// load never puts anyone back on a train.
//
// Pure: no DOM, no three.js. The wallet is injected for the tests.

import PRICE, { kc } from './prices.js';
import * as wallet from './wallet.js';

export const KINDS = Object.freeze(['os', 'r']);
export const CHECK_AFTER = 7;     // s of running before the conductor reaches him
export const MAX_HELD = 20;       // tickets of one kind a phone holds

/** Which ticket a train asks for. */
export const kindOf = (train) => (train?.express ? 'r' : 'os');
/** What one costs. */
export const fare = (kind) => (kind === 'r' ? PRICE.train.ticket : PRICE.train.local);
/** What the tickets are called on the phone and in the hints. */
export const KIND_NAME = Object.freeze({ os: 'Osobní vlak', r: 'Rychlík' });

const whole = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_HELD, Math.floor(v))) : 0);

export class Tickets {
  /**
   * @param opts { pay(n, what) -> bool, say(event, data) }
   *   say: 'bought' | 'ok' | 'fined' | 'broke' | 'off' (see sayText)
   */
  constructor(opts = {}) {
    this.pay = opts.pay ?? wallet.pay;
    this.say = opts.say ?? null;
    this.held = { os: 0, r: 0 };
    this.ride = null;        // { id, kind, state: 'open' | 'valid' | 'off', left, moved }
    this.validOn = null;     // id of the train the last marked ticket is good on
    this._lis = [];
  }

  /** Called with nothing whenever the phone's contents or the ride changed. */
  onChange(fn) { if (typeof fn === 'function' && !this._lis.includes(fn)) this._lis.push(fn); }
  _changed() { for (const fn of this._lis) { try { fn(); } catch { /* a listener's own trouble */ } } }
  _say(event, data) { this.say?.(event, data); }

  // ---- the phone -----------------------------------------------------------
  /** How many unused tickets of this kind are in the phone. */
  count(kind) { return this.held[kind] ?? 0; }
  /** Would a check on a train of this kind find a ticket? */
  has(kind) { return this.held[kind] > 0 || (kind === 'os' && this.held.r > 0); }

  /** Buy one. { ok, reason: null | 'money' | 'full' | 'kind' } */
  buy(kind) {
    if (!KINDS.includes(kind)) return { ok: false, reason: 'kind' };
    if (this.held[kind] >= MAX_HELD) return { ok: false, reason: 'full' };
    if (!this.pay(fare(kind), 'jízdenka')) return { ok: false, reason: 'money' };
    this.held[kind]++;
    this._say('bought', { kind, price: fare(kind) });
    this._changed();
    return { ok: true, reason: null };
  }

  // ---- the save ------------------------------------------------------------
  snapshot() { return { os: this.held.os, r: this.held.r }; }
  restore(s) {
    this.held.os = whole(s?.os);
    this.held.r = whole(s?.r);
    this.ride = null;
    this.validOn = null;
    this._changed();
  }

  // ---- the ride ------------------------------------------------------------
  /** He stepped into a coach of `train` (Trains opts.onBoard). */
  board(train) {
    if (!train) return;
    this.ride = {
      id: train.id, kind: kindOf(train),
      state: this.validOn === train.id ? 'valid' : 'open',
      left: CHECK_AFTER, moved: false,
    };
    this._changed();
  }

  /** He stepped out, or was taken off it (Trains opts.onAlight). */
  alight() {
    if (!this.ride) return;
    this.ride = null;
    this._changed();
  }

  /**
   * Every frame. `train` is the train he rides (trains.riding) or null;
   * `putOff()` stands him on the platform and answers whether it could.
   */
  update(dt, train, putOff) {
    const r = this.ride;
    if (!r) return;
    if (!train || train.id !== r.id) { this.alight(); return; }
    if (r.state === 'open') {
      if (!train.halted) {
        r.moved = true;
        r.left -= dt;
        if (r.left <= 0) this._inspect();
      } else if (r.moved) this._inspect();      // it got there before the conductor did
    }
    // put off where there is a platform to stand on: a station, doors open
    if (r.state === 'off' && train.halted && train.station && (train.closed ?? 0) < 0.2) {
      const name = train.stopName ?? null;
      if (putOff?.()) {
        this.ride = null;
        this._say('off', { station: name });
        this._changed();
      }
    }
  }

  _inspect() {
    const r = this.ride;
    const use = this.held[r.kind] > 0 ? r.kind : (r.kind === 'os' && this.held.r > 0 ? 'r' : null);
    if (use) {
      this.held[use]--;
      r.state = 'valid';
      this.validOn = r.id;
      this._say('ok', { kind: use });
    } else {
      const price = fare(r.kind), fine = PRICE.train.fine;
      if (this.pay(price + fine, 'přirážka ve vlaku')) {
        r.state = 'valid';
        this.validOn = r.id;
        this._say('fined', { kind: r.kind, price, fine });
      } else {
        r.state = 'off';
        this._say('broke', { kind: r.kind });
      }
    }
    this._changed();
  }

  // ---- for the HUD ---------------------------------------------------------
  /** Beside a standing train: what the hint says about the ticket (HTML). */
  hintNear(train) {
    const kind = kindOf(train);
    if (this.validOn === train?.id || this.has(kind)) return 'jízdenku máš';
    return 'jízdenka ' + kc(fare(kind)) + ' · <kbd>L</kbd> mobil';
  }

  /** Aboard: the same (HTML), '' once the ticket has been marked. */
  hintAboard() {
    const r = this.ride;
    if (!r || r.state === 'valid') return '';
    if (r.state === 'off') return '<b>v další stanici vystupuješ</b>';
    return this.has(r.kind) ? 'jízdenku máš' : '<b>bez jízdenky</b> · <kbd>L</kbd> mobil';
  }
}

/**
 * What the conductor (or the phone) says, as a toast: { text, sub, icon, kind }.
 * Plain text, for js/toasts.js.
 */
export function sayText(event, d = {}) {
  switch (event) {
    case 'bought':
      return { text: 'Jízdenka koupena', sub: KIND_NAME[d.kind] + ' · ' + kc(d.price), icon: '🎫', kind: 'good' };
    case 'ok':
      return { text: 'Průvodčí: jízdenka v pořádku', sub: 'Platí, dokud nevystoupíš', icon: '🎫', kind: 'good' };
    case 'fined':
      return { text: 'Průvodčí: jedeš bez jízdenky', sub: 'Jízdné ' + kc(d.price) + ' a přirážka ' + kc(d.fine),
        icon: '🎫', kind: 'warn', ms: 7000 };
    case 'broke':
      return { text: 'Průvodčí: bez jízdenky a bez peněz', sub: 'V další stanici vystupuješ', icon: '🎫', kind: 'warn', ms: 7000 };
    case 'off':
      return { text: 'Průvodčí tě vysadil', sub: d.station ?? 'Další vlak si zaplať', icon: '🎫', kind: 'warn', ms: 7000 };
    default:
      return null;
  }
}

/** The player's own: one phone per tab, like the wallet. */
export const tickets = new Tickets();
