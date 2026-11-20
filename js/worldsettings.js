// ---- How full the world is: traffic, the crowd and the police ----
// Three numbers that are not the player's (Frank, 20 Nov 2026): outside
// ?devmode the game runs on normal traffic, a busy crowd and the normal
// number of patrols, and the three choices "nesmí to tam být vůbec jako
// v možnostech nastavení". They are shared state as well: in co-op every
// client derives the same fleet, the same walkers and the same patrols from
// these numbers (js/traffic.js), so one player on other values would be
// standing in a different city from the rest of the room.
//
// Behind ?devmode they are tools on the dev tab of the settings panel, and a
// co-op session locks them to the fixed values again (js/settings.js
// shareWorld). What a developer once chose is kept in storage for the next
// ?devmode session, and the classic game neither reads it nor writes over it.
//
// Pure: js/settings.js builds the rows and does the storage.

export const WORLD = Object.freeze({ traffic: 120, peds: 60, police: 0.70 });
export const WORLD_KEYS = Object.freeze(Object.keys(WORLD));

// [key, label, [value, text] rungs]: the labels and rungs the panel always had
export const WORLD_ROWS = Object.freeze([
  ['traffic', 'Hustota provozu', [[0, 'Žádná'], [60, 'Řídká'], [120, 'Běžná'], [240, 'Hustá']]],
  ['peds', 'Chodci', [[0, 'Žádní'], [12, 'Málo'], [34, 'Běžně'], [60, 'Rušno']]],
  // how many police cars are on the streets (js/traffic.js patrolP)
  ['police', 'Policejní hlídky', [[0, 'Žádné'], [0.30, 'Málo'], [0.70, 'Běžně'], [1.30, 'Hodně']]],
]);

const rungs = (k) => WORLD_ROWS.find((r) => r[0] === k)[2].map(([v]) => v);
const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** The world values a stored blob holds, snapped to the offered rungs; only
 *  the keys it really has. A hand-edited 100000 cars is the nearest rung. */
export function storedWorld(saved) {
  const out = {};
  for (const k of WORLD_KEYS) {
    const v = saved?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = nearest(rungs(k), v);
  }
  return out;
}

/** What the game runs on: a developer's stored choice when `free` (?devmode,
 *  not in co-op), the fixed values otherwise, whatever was stored. */
export function worldValues(saved, free) {
  return { ...WORLD, ...(free ? storedWorld(saved) : {}) };
}

/** The blob to store. A free session stores what it runs on; a locked one
 *  (the classic game, co-op) stores the developer's earlier choice untouched
 *  and never writes its fixed values in its place. */
export function forStorage(S, kept, free) {
  if (free) return S;
  const out = { ...S };
  for (const k of WORLD_KEYS) {
    if (Object.hasOwn(kept ?? {}, k)) out[k] = kept[k];
    else delete out[k];
  }
  return out;
}
