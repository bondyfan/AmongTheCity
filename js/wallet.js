// ==========================================================================
// Wallet — the player's money, and nothing else
//
// ONE NUMBER AT MODULE LEVEL, NOT A CLASS. There is exactly one player per
// tab and therefore exactly one wallet, and this file is being written at the
// same hour as the five other modules that spend from it. `new Wallet()`
// handed around would have worked right up until two of those files each
// built one: the pump would debit a wallet the status bar never reads, the
// HUD would sit at the boot balance all session, and nothing anywhere would
// throw. A module-level binding makes that particular afternoon impossible to
// write. It costs exactly what a singleton costs — reset() has to exist for
// the tests and for "nová hra" — and that is a cheap price for an economy
// that cannot fork.
//
// KORUNY ARE WHOLE, AND THIS IS THE ONLY PLACE THEY BECOME WHOLE. Fuel is
// priced per litre in decimals: a pump at 38,90 Kč/l and a 42,7 l fill is
// 1 661,03 Kč. Somebody has to turn that into money, and if the answer is
// "whoever gets there first" then fuel.js rounds one way, the shop rounds
// another, and the status bar formats a float that still has a fraction in
// it — so the ticker adds up +800, −1 661, +240 while the balance says
// something two koruna off, and the player is the one who spots it. So the
// rule is stated once, here, and every caller may pass whatever decimal it
// likes:
//
//   ROUND TO THE NEAREST WHOLE KORUNA, TIES AWAY FROM ZERO.
//
// That is also what the world does. The 50 h coin left circulation in 2008
// and the smallest thing you can put on a Czech counter is a jednokoruna, so
// 1 661,03 Kč costs 1 661 Kč at the till too. A charge that rounds to zero is
// genuinely free — a caller that wants to bill for hundredths must accumulate
// them on its own side, because this module will not carry a fraction for
// anybody.
//
// pay() IS ATOMIC, AND THAT IS THE WHOLE JOB. It works out the whole amount,
// tests THAT amount, and only then moves it. There is no path through this
// file that takes part of a price. The bug it exists to prevent is a pump
// that debits as it fills, runs the player dry at 31 litres, and leaves them
// with a part tank they paid for and a caller that was told the sale failed.
// Because the affordability test happens before the subtraction, pay() also
// cannot open a debt: after a successful pay() the balance is >= 0. A
// negative balance is reachable only through setMoney(), which is restore and
// dev, and kc() prints the minus sign for it.
//
// canPay(n) === (pay(n) would return true), for every n including the corrupt
// ones. One predicate, _afford(), answers both, so a caller that asks before
// it buys can never be surprised by the buy.
//
// THE NOTIFICATION FIRES AFTER THE MONEY MOVED, so a listener that calls
// money() from inside its own callback reads the truth and not the previous
// balance. `delta` is signed and is what ACTUALLY moved, never what was asked
// for — if the ceiling clipped an absurd earn, the ticker must show the
// clipped figure or the running total on screen stops matching the balance
// underneath it. `what` is a short label and it reaches the player's eyes, so
// it is Czech: 'benzín', 'oprava', 'pokuta'. Two labels are reserved:
// setMoney() and reset() both report 'set', which means THE BALANCE WAS
// REPLACED — snap the display to it, do not run a ticker. A restored save
// must not fly a "+37 500 Kč" banner past the player, and a HUD should not
// need two branches to know that.
//
// DEFENSIVE, AND STRICTLY SO. Only a finite number is money. Number(n)
// coercion was considered and rejected: it maps null, '' and [] to 0, and a
// silent zero is precisely the failure the house rule about corrupt input is
// aimed at — an earn that quietly pays nothing looks exactly like an earn
// that was never called. Anything that is not a finite number is refused
// outright, the balance is untouched, and pay() says false.
//
// CO-OP: MONEY IS PER PLAYER AND PURELY LOCAL. Nothing in js/netcity.js syncs
// it and nothing should. This is survivable — not merely tolerated — because
// money moves nothing in the shared world: it spawns no car, moves no
// citizen, opens no door, and appears in no snapshot. Two players standing on
// the same corner see the same city, the same crowd and the same traffic
// lights, and different balances, and neither can tell by looking. The moment
// a balance crossed the wire it would need an authority that owns the
// economy, and there is no such server here; the shop that sold you the petrol
// is a price table, not a stockroom.
//
// HEADLESS: no DOM, no three.js, no clock, no storage, no imports at all.
// Nothing in here allocates after load — the listener dispatch is an indexed
// loop over a plain array — and money() is a property read, because
// js/statusbar.js calls it every frame and stepGame can run three times per
// rendered frame.
// ==========================================================================

// What a new game starts with. The exact figure is a balance decision that
// really belongs next to PRICE, and it lives here only because the contract
// keeps this module import-free; main.js may override it at boot with
// setMoney() without editing this file. It is deliberately small: enough to
// fill a tank and still eat, not enough to fill it twice. A player who starts
// rich never finds out that petrol costs money, and the first hour of this
// game has to contain a decision.
export const START = 2500;

// A ceiling, not a wrap. Nine digits is what a status bar can show without
// the layout jumping, and it is orders of magnitude past anything the economy
// can generate — its real job is that a saturating add can never turn the
// balance into Infinity, and Infinity − Infinity is how a wallet becomes NaN
// forever. Debt is bounded by the same figure on the other side.
const MONEY_MAX = 999999999;

let _money = START;

// Subscribers, in the order they subscribed. An array and not a Set because
// dispatch has to be an indexed loop with no iterator allocated, and the
// duplicate check in onChange() is a linear scan of a list that is two or
// three entries long for the life of the process.
const _lis = [];

// ---- turning whatever we were handed into koruna --------------------------

// A finite number → a whole number of koruna. Anything else → NaN, which is
// this file's single word for "that was not money". Every comparison below
// answers false against NaN, so the refusal needs no second branch anywhere.
// The zero case also normalises −0: Math.round(−0.4) is −0, and a −0 balance
// is a "−0 Kč" bug report waiting for a formatter that tests the sign bit.
function _whole(n) {
  if (!Number.isFinite(n)) return NaN;
  const r = Math.round(n);
  return r === 0 ? 0 : r;
}

// An amount somebody wants to move: whole, and not negative. A negative price
// is a corrupt price, never a gift — earn(−500) must not take money and
// pay(−500) must not hand it out.
function _amount(n) {
  const v = _whole(n);
  return v >= 0 ? v : NaN;
}

function _clamp(v) {
  return v > MONEY_MAX ? MONEY_MAX : v < -MONEY_MAX ? -MONEY_MAX : v;
}

// The one affordability question in the file. `amt` is already whole.
//
// The `amt === 0` term is not redundant and it is not free-item pedantry: a
// player in debt has _money < 0, so a plain `_money >= amt` would refuse to
// let them accept something that costs nothing, and canPay(0) would disagree
// with pay(0). NaN falls through both comparisons to false, which is how a
// corrupt amount gets refused.
function _afford(amt) {
  return amt === 0 || _money >= amt;
}

// Move the balance to `next` and tell everybody what actually happened.
// `next` must already be whole and finite; the clamp is the last guard before
// the number is stored, and the delta is measured AFTER it, so what the HUD
// tickers always sums to what the balance shows.
function _apply(next, what) {
  const v = _clamp(next);
  const d = v - _money;
  if (d === 0) return;          // nothing moved, so there is nothing to say
  _money = v;
  _fire(d, what);
}

function _fire(delta, what) {
  // No String() — a coercion here would allocate on a path a listener might
  // re-enter, and a non-string label is a caller bug, not a value to salvage.
  const label = typeof what === 'string' ? what : '';
  // Snapshot the length: a listener that subscribes from inside a callback
  // does not get delivered the event that predates its own subscription, and
  // the loop cannot run off a list that grew under it.
  const n = _lis.length;
  for (let i = 0; i < n; i++) {
    // One broken listener must not un-sell the petrol. The balance has
    // already moved by the time we are here, so an exception thrown by the
    // HUD cannot roll it back — all it can do is rob the OTHER listeners of
    // the event, and it does not get to do that either.
    try {
      _lis[i](_money, delta, label);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('wallet: listener threw', err);
    }
  }
}

// ---- public API -----------------------------------------------------------

/** The balance, in whole koruna. Always an integer, may be negative (debt). */
export function money() {
  return _money;
}

/** Could this be paid right now? True exactly when pay() would return true. */
export function canPay(n) {
  return _afford(_amount(n));
}

/**
 * Take `n` koruna for `what`, all of it or none of it.
 *
 * Returns false and changes NOTHING when the player is short, when the amount
 * is negative, and when it is NaN or Infinity. Returns true and changes
 * nothing when it rounds to zero — a free item is still a completed sale, and
 * a caller that treats `false` as "the pump broke" would otherwise break on
 * the one price it is guaranteed to be able to afford.
 */
export function pay(n, what) {
  const amt = _amount(n);
  if (!_afford(amt)) return false;
  if (amt !== 0) _apply(_money - amt, what);
  return true;
}

/**
 * Give the player `n` koruna for `what`. Silently ignores anything that is
 * not a positive finite amount — a fare that computed to NaN pays nothing,
 * which is wrong in a way somebody will notice, rather than poisoning the
 * balance, which is wrong in a way nobody can undo.
 */
export function earn(n, what) {
  const amt = _amount(n);
  if (!(amt > 0)) return;       // !(>) also swallows NaN, and 0 has nothing to say
  _apply(_money + amt, what);
}

/**
 * Replace the balance outright: loading a save, or the dev console.
 *
 * ALWAYS notifies, with what='set', even when the number did not move and
 * even when it was corrupt. That is the point of this function — after it
 * returns, every listener is holding the true balance, unconditionally.
 * Without that guarantee a restored save leaves the HUD showing the number
 * from before the load, which is the one bug this signature exists to stop.
 */
export function setMoney(n) {
  const v = _whole(n);
  // Corrupt input keeps the balance it had. We still fire, because the caller
  // asked for a resynchronisation and got one; what it did not get is a new
  // number.
  const next = Number.isFinite(v) ? _clamp(v) : _money;
  const d = next - _money;
  _money = next;
  // Not _apply(): that one stays quiet when nothing moved, which is right for
  // a transaction and wrong here. A save restored onto an identical balance
  // still has to leave the HUD in a known state.
  _fire(d, 'set');
}

/**
 * Subscribe to every change: fn(money, delta, what).
 *
 * Called with the balance AFTER the change, the signed amount that actually
 * moved, and the label. There is no unsubscribe in the contract and there is
 * deliberately no list-of-one special case either; what there is instead is a
 * duplicate check, because init() being called twice is a normal thing for a
 * HUD to survive and a double-subscribed ticker counts every purchase twice.
 */
export function onChange(fn) {
  if (typeof fn !== 'function') return;
  if (_lis.indexOf(fn) >= 0) return;
  _lis.push(fn);
}

/**
 * Back to the starting balance. Reports itself as 'set' rather than 'reset'
 * on purpose: to a display, "the balance was replaced" and "the balance was
 * replaced with the starting one" are the same event, and a second label
 * would only invite somebody's HUD to ticker −37 500 Kč across the screen on
 * new game. The listeners stay subscribed — reset() is a new game, not a
 * teardown.
 */
export function reset() {
  setMoney(START);
}
