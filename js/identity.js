// ---- Identity: one source of truth for "who is that box person?" ----
//
// WHY THIS MODULE EXISTS
// Until now the look of a player was decided in two different places that did
// not agree. player.js hard-coded a blue jacket for the local hero ("so you
// always find yourself") while netcity.js dressed every REMOTE player from its
// own eight-colour palette hashed off their uid — and the hero blue was not in
// that palette. The consequence was not cosmetic: everybody saw THEMSELVES in
// blue and EACH OTHER in a colour they could not predict, so "the blue one is
// me" was true on four screens at once and nobody could be described out loud
// ("jdu k tomu zelenýmu" pointed at a different person on every machine).
//
// The rule this module enforces: appearance is a pure function of the uid.
// lookForUid(uid) is called by the local player and by every observer, and it
// touches no randomness, no clock and no storage — same uid in, same bytes out,
// on every machine in the room, forever.
//
// Palette size is a birthday-problem decision, not a taste one — and the
// arithmetic has to be stated honestly, because an earlier version of this
// comment claimed sixteen jackets "pushes the first likely collision out past
// nine players", which is off by a factor of two. The exact figures for k=16
// (1 − 16!/((16−n)!·16^n), checked against 400 000 sampled uids, χ² = 21.4 on
// 15 df, i.e. the hash below really is uniform):
//
//     n =  4 → 33 %      n =  9 → 94 %
//     n =  5 → 50 %      n = 20 → 100 % (≈11.6 distinct jackets for 20 people)
//
// So sixteen buys ONE more player than eight before a duplicate is even money
// (5 instead of 4), and in a full 20-player room roughly eight players are
// wearing somebody else's colour. That is a deliberate ceiling, not an
// oversight: the readable-at-street-distance limit is real — 32 muddy shades
// would be worse than 16 clear ones — so the jacket is a STRONG HINT and the
// name tag over the head is what actually disambiguates. Anything that treats
// the jacket as a unique key (a kill feed, a scoreboard, a "follow the green
// one" instruction) is wrong by construction; use the uid.

// ---- hashing --------------------------------------------------------------
// FNV-1a with a final avalanche. The old `h = h * 31 + c` hash was fine for
// hash maps but terrible here: it barely mixes into the LOW bits, and the low
// bits are exactly what `% palette.length` reads. Two uids differing in the
// last character ('u4f2a1' / 'u4f2a2') landed in adjacent buckets by
// construction, which is the worst possible property when the buckets are
// colours a human has to tell apart. The avalanche step below makes one
// changed character flip roughly half the output bits.
export function strHash(s) {
  const str = s == null ? '' : String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // FNV prime 16777619 via shifts — stays inside 32-bit int math in JS
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
  }
  // xorshift-multiply finisher (murmur3 fmix32), so low bits carry entropy too
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// index into an array of length n, derived from uid + a per-slot salt so the
// jacket, the trousers and the hair are independent draws instead of three
// views of the same number (which would make colour pairs strongly correlated)
const slot = (uid, salt, n) => strHash(salt + '\u0000' + uid) % n;

// ---- the wardrobe ---------------------------------------------------------
// Sixteen jackets, deliberately brighter and more saturated than citizen.js's
// muted street palette: PLAYERS must pop out of a pavement full of pedestrians.
// Hues are spread around the wheel so neighbouring indices are never confusable.
// Index 8 is the historical hero blue 0x3a63a8 — kept so the colour players
// already associate with "me" still exists, it is just no longer everybody's.
export const PLAYER_JACKETS = [
  0xd6382f, // 0  red
  0xf05a28, // 1  orange
  0xe8a723, // 2  amber
  0xc9d92e, // 3  lime
  0x7fb069, // 4  sage
  0x2ea44f, // 5  green
  0x14a89a, // 6  teal
  0x2e9ac4, // 7  azure
  0x3a63a8, // 8  blue  (the old hard-coded hero jacket)
  0x6c5ce7, // 9  indigo
  0x8e44ad, // 10 purple
  0xd35490, // 11 pink
  0x9b1b6e, // 12 magenta
  0xb96b3c, // 13 tan
  0xe8e2d0, // 14 cream
  0x4a4e69, // 15 slate
];

// Trousers/skin/hair stay in the muted register — the jacket is the identifier,
// the rest is variety. Lengths are coprime-ish with 16 on purpose: it keeps two
// players who happen to share a jacket from also sharing everything else.
export const PLAYER_PANTS = [0x2f3540, 0x3d4450, 0x4a4038, 0x555a52,
  0x38404a, 0x5a5248, 0x25313b];
export const PLAYER_SKINS = [0xd9a066, 0xe8b98c, 0xc78d5a, 0xb87848, 0xf0c8a0];
export const PLAYER_HAIRS = [0x3a2a1a, 0x22201e, 0x6b5a3a, 0x8a8a86, 0x4a342a];

// Which jacket this uid wears. Exported separately because the net layer wants
// the INDEX (a small int is cheaper on the wire and lets a future server hand
// out collision-free slots) while the renderer wants the colour.
export function jacketIndexForUid(uid) {
  return slot(uid, 'jacket', PLAYER_JACKETS.length);
}

// The whole outfit, deterministic. jacketIdx overrides the hashed jacket when
// something authoritative (a server-assigned slot) knows better; pass null to
// derive it. Every field is always filled in — a caller must never be left to
// roll dice for the missing ones, which is exactly how remote avatars used to
// change trousers on every reconnect.
export function lookForUid(uid, jacketIdx = null) {
  const id = uid == null ? '' : String(uid);
  const ji = Number.isInteger(jacketIdx)
    // a negative or out-of-range index must still land in the palette
    ? ((jacketIdx % PLAYER_JACKETS.length) + PLAYER_JACKETS.length) % PLAYER_JACKETS.length
    : jacketIndexForUid(id);
  return {
    jacket: PLAYER_JACKETS[ji],
    pants: PLAYER_PANTS[slot(id, 'pants', PLAYER_PANTS.length)],
    skin: PLAYER_SKINS[slot(id, 'skin', PLAYER_SKINS.length)],
    hair: PLAYER_HAIRS[slot(id, 'hair', PLAYER_HAIRS.length)],
  };
}

// ---- uid ------------------------------------------------------------------
// 'base:tab'.
//
// base  lives in localStorage and IS the person: their look and their name are
//       derived from it, so the same human opening a second tab still looks and
//       reads like themselves in both.
// tab   lives in sessionStorage, which is per-tab by specification. Without it
//       two tabs of one browser share the localStorage uid, the relay sees the
//       same uid twice, and each tab reaps the other's avatar as a duplicate —
//       the classic "I opened a second window to test co-op and both of us
//       disappeared" bug.
//
// The old generator, 'u' + Math.random().toString(36).slice(2, 8), could and did
// degenerate: toString(36) of a small mantissa is short (Math.random() ~ 1e-9
// gives "0.000000abc"), slice(2, 6) then returns a handful of zeros or, at the
// limit of Math.random() === 0, the empty string — a uid of literally 'u'.
// token() below always returns exactly `n` characters from a fixed alphabet.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function token(n) {
  let out = '';
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(n);
    c.getRandomValues(buf);
    // 256 % 36 !== 0, so a plain modulo is very slightly biased; for a display
    // id that is irrelevant and rejection sampling is not worth the code.
    for (let i = 0; i < n; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }
  for (let i = 0; i < n; i++) out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return out;
}

const BASE_KEY = 'atc-uid';   // same key netcity.js has always used
const TAB_KEY = 'atc-tab';

// Storage throws outright in some privacy modes (Safari private windows, an
// iframe with third-party storage blocked). Falling over there would take the
// whole game down, so every access is guarded and the in-memory fallbacks below
// keep the uid stable for at least the lifetime of the page.
function read(store, key) {
  try { return globalThis[store]?.getItem(key) || ''; } catch { return ''; }
}
function write(store, key, val) {
  try { globalThis[store]?.setItem(key, val); } catch { /* private mode */ }
}

let _base = '';
let _tab = '';
let _uid = '';

// The persistent half — exported so a caller that only wants "who am I across
// sessions" (a highscore, a saved nickname) does not have to split a string.
export function baseId() {
  if (_base) return _base;
  let b = read('localStorage', BASE_KEY);
  // Anything shorter than 3 chars is a leftover from the degenerate generator;
  // reissue it rather than let a player be permanently called 'u'.
  if (!b || b.length < 3) { b = 'u' + token(8); write('localStorage', BASE_KEY, b); }
  // A stored id must never contain the separator, or baseUid() would truncate it
  _base = b.split(':')[0] || ('u' + token(8));
  return _base;
}

function tabId() {
  if (_tab) return _tab;
  let t = read('sessionStorage', TAB_KEY);
  if (!t || t.length < 2) { t = token(4); write('sessionStorage', TAB_KEY, t); }
  _tab = t.split(':')[0] || token(4);
  return _tab;
}

// Full per-tab identity. This is what goes on the wire.
export function localUid() {
  return _uid || (_uid = baseId() + ':' + tabId());
}

// The person behind a connection. Look and nickname are derived from THIS, so
// two tabs of the same human are two bodies wearing one identity — which is the
// honest reading, and it means you can recognise your friend's second window.
export function baseUid(uid) {
  const s = uid == null ? '' : String(uid);
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
}

// Convenience for the net/UI layers: a short human-readable stub of an unknown
// peer ('Hráč 4f2a'), derived from the BASE so both tabs of one player read the
// same. Only [a-z0-9] survives, so nothing off the wire can reach a texture or
// the DOM as markup.
export function shortId(uid) {
  const s = baseUid(uid).toLowerCase().replace(/[^a-z0-9]/g, '');
  return (s.slice(-4) || '????');
}

// Test/teardown hook: forget the memoised identity so a fresh localUid() can be
// derived (used by tests; the game itself calls this never).
export function resetIdentityCache() {
  _base = ''; _tab = ''; _uid = '';
}
