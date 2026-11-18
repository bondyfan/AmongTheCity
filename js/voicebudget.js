// ---- who gets a voice ---------------------------------------------------------
// There are sixty cars near the player and eight traffic voices. This picks the
// eight, and keeps picking the same eight while nothing much changes, because a
// voice that swaps owner every other frame is a voice that clicks.
//
// Ranked by how loud the car would be at the ears: a lorry at forty metres
// outranks a hatchback at thirty. A car that already has a voice is ranked a
// little above its station (STICKY), so two cars at the same distance do not
// trade a slot back and forth. Slots are stable: a car keeps the slot it was
// given until it loses it, which is what lets the mixer keep its Doppler delay
// line and its filters running without a seam.
//
// Pure, allocation-light and testable in node.

const REF = 7;          // m: inside this, nearer is not louder (matches carmixer.js)
const STICKY = 1.35;    // a held voice counts as this much louder than it is

/**
 * cands  [{ id, d, loud }]  cars within earshot (d in metres, loud ~1)
 * slots  array of ids (or null), length = number of voices; edited in place
 * maxDist  beyond this a car is never a candidate
 * blocked  optional (slotIndex) => true while that slot may not be reused yet
 * Returns { taken: [[slot, cand]], dropped: [slot] } for this call's changes.
 */
export function assignVoices(cands, slots, maxDist, blocked = null) {
  const held = new Map();
  for (let s = 0; s < slots.length; s++) if (slots[s] !== null) held.set(slots[s], s);
  const ranked = [];
  for (const c of cands) {
    if (!(c.d < maxDist)) continue;
    const score = (c.loud ?? 1) / Math.max(REF, c.d) * (1 - (c.d / maxDist) ** 2);
    ranked.push({ c, score: held.has(c.id) ? score * STICKY : score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const want = ranked.slice(0, slots.length);
  const keep = new Set(want.map((w) => w.c.id));
  const dropped = [], taken = [];
  for (let s = 0; s < slots.length; s++) {
    if (slots[s] !== null && !keep.has(slots[s])) { slots[s] = null; dropped.push(s); }
  }
  for (const { c } of want) {
    if (held.has(c.id) && slots[held.get(c.id)] === c.id) continue;
    let free = -1;
    for (let s = 0; s < slots.length; s++) {
      if (slots[s] === null && !dropped.includes(s) && !(blocked && blocked(s))) { free = s; break; }
    }
    if (free < 0) continue;              // nothing free yet: it gets one next frame
    slots[free] = c.id;
    taken.push([free, c]);
  }
  return { taken, dropped };
}
