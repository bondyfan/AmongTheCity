// ---- appearance.js: a player's look as one short code ---------------------------
//
// What the character creator produces, what the save and localStorage keep,
// and what rides in the co-op state packet: '1-<head>-<body>', the catalogue
// ids of the head (face and hair) and of the body (build and clothes) the
// player picked, behind a version digit. Twelve characters or so.
//
// Pure: no three, no DOM beyond a guarded localStorage. A code is only ever
// trusted as far as the catalogue confirms it: an id this build does not have
// falls back to something it does, on every screen the same way.

import { catalog, entry, pool, strHash } from './cast.js';

export const LOOK_VERSION = '1';
export const LOOK_KEY = 'atc-look';
const SHAPE = /^1-([a-z0-9_]{1,12})-([a-z0-9_]{1,12})$/;

/** { head, body } to a code. */
export function encodeLook(look) {
  const body = String(look?.body ?? ''), head = String(look?.head ?? body);
  const code = `${LOOK_VERSION}-${head}-${body}`;
  return SHAPE.test(code) ? code : '';
}

/** A code to { head, body }, or null when it is not one. Nothing is checked against the catalogue. */
export function decodeLook(code) {
  const m = typeof code === 'string' ? SHAPE.exec(code) : null;
  return m ? { head: m[1], body: m[2] } : null;
}

/** The string as a well-formed code, or ''. Use on anything off the wire or out of storage. */
export const sanitizeLook = (code) => (decodeLook(code) ? code : '');

// who may wear what: a head goes on a body of the same sex and skin tone
const fits = (h, b) => !!h && !!b && h.sex === b.sex && (h.tone ?? 0) === (b.tone ?? 0);
const wearable = (a) => !!a && (a.kind === 'adult' || a.creator === true) && a.creator !== false;

/**
 * A code this catalogue can actually show, or null. A head that does not fit
 * its body (another sex, another tone, gone from the build) becomes the body's own.
 */
export function validLook(code) {
  const d = decodeLook(code);
  if (!d) return null;
  const b = entry(d.body);
  if (!wearable(b)) return null;
  const h = entry(d.head);
  return encodeLook({ body: b.id, head: wearable(h) && fits(h, b) ? h.id : b.id });
}

/** The look a uid gets before its player has chosen one. */
export function defaultLook(uid) {
  const all = catalog().filter(wearable);
  if (!all.length) return '';
  const b = all[strHash(uid) % all.length];
  return encodeLook({ body: b.id, head: b.id });
}

const STYLE_NAMES = { casual: 'Ležérní', smart: 'Elegantní', sport: 'Sportovní', work: 'Pracovní', party: 'Večerní' };
const STYLE_ORDER = ['casual', 'sport', 'smart', 'party', 'work'];
export const styleName = (s) => STYLE_NAMES[s] ?? s;

/**
 * Everything the creator offers, as the catalogue stands:
 *   { sexes: ['m', 'f'], tones(sex), heads(sex, tone), styles(sex, tone), bodies(sex, tone, style) }
 * Lists hold catalogue entries, in catalogue order.
 */
export function creatorOptions() {
  const all = catalog().filter(wearable);
  const sexes = ['m', 'f'].filter((s) => all.some((a) => a.sex === s));
  const of = (sex, tone) => all.filter((a) => a.sex === sex && (a.tone ?? 0) === tone);
  return {
    sexes,
    tones: (sex) => [...new Set(all.filter((a) => a.sex === sex).map((a) => a.tone ?? 0))].sort((a, b) => a - b),
    heads: (sex, tone) => of(sex, tone).filter((a) => a.head !== false),
    styles: (sex, tone) => STYLE_ORDER.filter((s) => of(sex, tone).some((a) => (a.style ?? 'casual') === s)),
    bodies: (sex, tone, style) => of(sex, tone).filter((a) => (a.style ?? 'casual') === style),
    all,
  };
}

/** Where a code sits in the creator: { sex, tone, style, head, body } (entries), or null. */
export function describeLook(code) {
  const v = validLook(code), d = v && decodeLook(v);
  if (!d) return null;
  const body = entry(d.body), head = entry(d.head);
  return { sex: body.sex, tone: body.tone ?? 0, style: body.style ?? 'casual', head, body };
}

// ---- who has chosen what -------------------------------------------------------
// base uid -> code. The local player's entry is written by the creator; a
// peer's arrives in their state packet (js/netcity.js). Readers get '' for a
// stranger and fall back to defaultLook().
const LOOKS = new Map();
const subs = new Set();
export function setLookFor(uid, code) {
  const c = sanitizeLook(code), id = String(uid ?? '');
  if (!id || (LOOKS.get(id) ?? '') === c) return false;
  if (c) LOOKS.set(id, c); else LOOKS.delete(id);
  if (LOOKS.size > 512) LOOKS.delete(LOOKS.keys().next().value);
  for (const f of subs) { try { f(id, c); } catch { /* a listener must not break the caller */ } }
  return true;
}
export const lookCodeFor = (uid) => LOOKS.get(String(uid ?? '')) ?? '';
/** fn(uid, code) whenever somebody's look changes. Returns the unsubscribe. */
export function onLookChange(fn) { subs.add(fn); return () => subs.delete(fn); }
/** The decoded, catalogue-checked look of a uid: their choice, or the default for strangers. */
export function lookOf(uid) {
  return decodeLook(validLook(lookCodeFor(uid)) ?? defaultLook(uid));
}

export function loadMyLook() {
  try { return sanitizeLook(globalThis.localStorage?.getItem(LOOK_KEY) ?? ''); } catch { return ''; }
}
export function saveMyLook(code) {
  const c = sanitizeLook(code);
  try { if (c) globalThis.localStorage?.setItem(LOOK_KEY, c); else globalThis.localStorage?.removeItem(LOOK_KEY); } catch { /* private mode */ }
  return c;
}

export { pool };
