// ---- cast.js: who is played by which modelled person ----------------------------
//
// Pure data and hashing: no three, no DOM, no clock. The catalogue is the
// manifest's list of avatars; this file answers "which of them is this citizen"
// so that every screen in a co-op room answers the same:
//
//   * a pedestrian is a pure function of its seed (the id two clients share)
//     and its archetype, which already decided its voice (js/people.js);
//   * an officer or a medic is drawn from the uniforms, by seed;
//   * the campaign's named people are a fixed table;
//   * a player is whatever their appearance code says
//     (js/characters/appearance.js), or a hash of their uid until it arrives.
//
// A catalogue entry: { id, sex: 'm' | 'f', kind, age, tone, style, top, bottom }
//   kind   'adult' | 'child' | 'police' | 'medic' | ... (the avatar's job)
//   age    'young' | 'adult' | 'old'
//   tone   0..3, light to dark skin (the creator groups heads and bodies by it)
//   style  'casual' | 'smart' | 'sport' | 'work' (the creator's clothing styles)

let CATALOG = [];
let NAMED = {};          // uid -> avatar id (the campaign's cast)
const POOLS = new Map();

export function setCatalog(list, named = {}) {
  CATALOG = Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string') : [];
  NAMED = named ?? {};
  POOLS.clear();
}
export const catalog = () => CATALOG;
export const entry = (id) => CATALOG.find((a) => a.id === id) ?? null;

// murmur-style finaliser over two ints: the low bits are what `% n` reads
export function mix32(a, b = 0) {
  let h = (a ^ Math.imul((b + 0x9e3779b9) | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
export function strHash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return mix32(h, str.length);
}

// which archetype walks as which age (js/people.js keys, and the campaign's 'man' / 'woman')
const ARCH = {
  m30: ['m', 'adult'], f30: ['f', 'adult'], m60: ['m', 'old'], f60: ['f', 'old'], m90: ['m', 'old'],
  man: ['m', 'adult'], woman: ['f', 'adult'],
};
export const sexOf = (archKey) => (ARCH[archKey] ?? ARCH.m30)[0];

/** The avatars a (sex, kind, age) may be drawn from. Falls back by age, then by kind, never empty unless the catalogue is. */
export function pool(sex, kind = 'adult', age = null) {
  const key = sex + '|' + kind + '|' + (age ?? '');
  let p = POOLS.get(key);
  if (p) return p;
  const of = (f) => CATALOG.filter(f).map((a) => a.id);
  p = of((a) => a.sex === sex && a.kind === kind && (age == null || a.age === age || (age === 'adult' && a.age === 'young')));
  if (!p.length && age != null) p = of((a) => a.sex === sex && a.kind === kind);
  // a uniform matters more than the sex of who wears it
  if (!p.length) p = of((a) => a.kind === kind);
  if (!p.length) p = of((a) => a.sex === sex && a.kind === 'adult');
  if (!p.length) p = of((a) => a.kind === 'adult');
  if (!p.length) p = of(() => true);
  POOLS.set(key, p);
  return p;
}

const SALT_BODY = 0x5b0d1e;

/** A pedestrian: the same seed and archetype give the same person on every screen. */
export function avatarForSeed(seed, archKey = 'm30') {
  const [sex, age] = ARCH[archKey] ?? ARCH.m30;
  const p = pool(sex, 'adult', age);
  return p.length ? p[mix32(seed >>> 0, SALT_BODY) % p.length] : null;
}

/** A uniform: 'police' or 'medic'. */
export function avatarForRole(role, seed, sex = 'm') {
  const p = pool(sex, role);
  return p.length ? p[mix32(seed >>> 0, SALT_BODY + 1) % p.length] : null;
}

/** A named person of the story, or null. */
export const avatarForName = (uid) => (uid != null && NAMED[uid] && entry(NAMED[uid]) ? NAMED[uid] : null);

/** A player nobody has an appearance code for yet: an adult, by their uid. */
export function avatarForUid(uid, sex = null) {
  const h = strHash(uid);
  const p = pool(sex ?? (h & 1 ? 'f' : 'm'), 'adult', 'adult');
  return p.length ? p[(h >>> 1) % p.length] : null;
}

/**
 * What makeCitizen's `look` is played by: { body, head } avatar ids (head is
 * null when the body's own head is worn), or null when the catalogue has
 * nobody. `code` is the decoded appearance of a player, when known.
 *   seed   an integer the caller hashed from the citizen's identity
 */
export function castFor(look = {}, seed = 0, code = null) {
  if (!CATALOG.length) return null;
  if (look.avatar && entry(look.avatar)) return { body: look.avatar, head: null };
  const sex = sexOf(look.archetype);
  if (look.role === 'police' || look.role === 'medic') {
    const id = avatarForRole(look.role, seed, sex);
    return id ? { body: id, head: null } : null;
  }
  if (look.uid != null) {
    const named = avatarForName(look.uid);
    if (named) return { body: named, head: null };
    if (code && entry(code.body)) return { body: code.body, head: code.head && code.head !== code.body && entry(code.head) ? code.head : null };
    // an extra of the story is cast as the sex its scene asked for
    const id = avatarForUid(look.uid, look.archetype ? sex : null);
    return id ? { body: id, head: null } : null;
  }
  const id = avatarForSeed(seed, look.archetype);
  return id ? { body: id, head: null } : null;
}
