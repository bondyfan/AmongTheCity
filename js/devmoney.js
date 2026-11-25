// ---- Dev money: the pure half of "give me money" behind ?devmode ----
//
// Frank, 25 Nov 2026: "když je člověk v dev módu, tak si může přidat peníze
// ... třeba na otestování toho letadla". The flight to Mahé costs about
// 20 000 Kč, and earning that by hand every time the ticket counter changes
// is how a test session turns into a play session.
//
// This file only answers "what did the player type, and is it money?". The
// buttons live in js/devmode.js, and the money itself goes through
// wallet.earn() in main.js, so a dev top-up is an earning like any other: the
// HUD tickers it, the next autosave point writes it down, and in co-op it is
// your own wallet only, because no wallet ever crosses the wire.
//
// Pure: no DOM, no game, no wallet. It imports only the formatter.

import { kc } from './prices.js';

// One top-up at most. Ten million is five hundred flights to the Seychelles,
// which is more than any test needs, and it stays far below the wallet's own
// ceiling (999 999 999), so a few presses can never run the balance into it
// by accident without the player having typed something absurd first.
export const DEV_ADD_MAX = 10_000_000;

// The quick buttons. 20 000 is the one Frank asked for: about one flight.
export const DEV_QUICK = Object.freeze([1_000, 20_000, 100_000]);

// What each refusal says under the field. Czech, because it reaches the eyes.
export const DEV_MONEY_WHY = Object.freeze({
  empty: 'Zadej částku.',
  nan: 'Jen celé číslo, třeba 20 000.',
  negative: 'Jen kladná částka. Odebírat se tu nedá.',
  zero: 'Nula nic nepřidá.',
  max: 'Najednou nejvýš ' + kc(DEV_ADD_MAX) + '.',
});

// Whitespace a Czech number may carry between its thousands: a plain space,
// a no-break space and the narrow no-break space that kc() itself prints.
const GAPS = /[\s  ]+/g;

/**
 * Read an amount typed into the dev field.
 *
 * Accepts whole koruna, with or without thousands gaps and a trailing "Kč"
 * ("20000", "20 000", "20 000 Kč", "+500"). Refuses everything else rather
 * than guessing: "1,5" and "1.500" mean different things to different
 * readers, "1e5" is a programmer's number and not a price, and a minus is a
 * debit, which this tool deliberately does not do.
 *
 * → { ok: true, amount } or { ok: false, why } where `why` is a key of
 *   DEV_MONEY_WHY.
 */
export function parseDevAmount(text) {
  if (typeof text !== 'string') return { ok: false, why: text == null ? 'empty' : 'nan' };
  let t = text.trim().replace(/k[cč]\.?$/i, '').replace(GAPS, '');
  if (t === '') return { ok: false, why: 'empty' };
  if (/^-\d+$/.test(t)) return { ok: false, why: 'negative' };
  if (t[0] === '+') t = t.slice(1);
  if (!/^\d+$/.test(t)) return { ok: false, why: 'nan' };
  const amount = Number(t);
  if (amount === 0) return { ok: false, why: 'zero' };
  // a long string of digits parses to a huge float or to Infinity, and both
  // are past the ceiling, so one comparison covers them
  if (!(amount <= DEV_ADD_MAX)) return { ok: false, why: 'max' };
  return { ok: true, amount };
}

/** "+20 000 Kč" for a quick button. */
export const quickLabel = (n) => '+' + kc(n);
