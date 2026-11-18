// ---- birdsites.js: which birds sit where, as pure data ------------------------
// No three.js, no clock, no randomness of its own: like js/people.js and
// js/wardrobe.js this is the part two co-op clients and a headless test have
// to agree on, so everything here is a function of a place and a few shared
// numbers.
//
// A CANDIDATE is somewhere a bird could sit: a patch of pavement, the arm of a
// street lamp, the top edge of a road sign, a stretch of trolley wire, the eave
// of a roof. js/birds.js finds candidates in the map around the player; this
// module answers, for one candidate on its own, "does a flock live here, of
// what, and where exactly does each bird sit". The answer depends on the
// candidate's POSITION and nothing else, so it cannot depend on which tile
// arrived first, and the same lamp carries the same two pigeons on every screen.
//
// WHAT IS SHARED AND WHAT IS LOCAL (the co-op contract of the whole feature):
//   shared   where flocks live, their species, size, colours and seats; the
//            birds passing overhead (skyFlights): all pure in place and time
//   local    a flock taking off because THIS player, a car or a bang came near,
//            where it lands afterwards, and how long it stays away. A flock is
//            back on its shared seat the next time it comes into range.

export const KIND = Object.freeze({ GROUND: 1, LAMP: 2, SIGN: 3, WIRE: 4, ROOF: 5, POST: 6 });

/**
 * The four birds. size: scale against the pigeon the mesh is modelled as;
 * wing: extra span; hz/amp: wingbeat; cruise: m/s; nerve: how far off a threat
 * is noticed (x the base radius); bound: sparrows fly in bursts with the wings
 * shut in between; glide: share of a descent spent on set wings.
 */
export const SPECIES = Object.freeze({
  pigeon: { key: 'pigeon', size: 1.0, wing: 1.0, hz: 7.2, amp: 1.05, cruise: 9.5, accel: 16, nerve: 1.0, bound: 0, glide: 0.35,
    tints: [0x6c7480, 0x7b838d, 0x5a626c, 0x8a8f95, 0x4d4a52, 0xb9b6ae, 0x6a5a52] },
  sparrow: { key: 'sparrow', size: 0.46, wing: 0.86, hz: 15, amp: 1.2, cruise: 8.0, accel: 22, nerve: 1.5, bound: 1, glide: 0,
    tints: [0x7a5c40, 0x6b5138, 0x86694a, 0x5e4a36] },
  crow: { key: 'crow', size: 1.42, wing: 1.12, hz: 3.9, amp: 0.95, cruise: 9.0, accel: 11, nerve: 1.9, bound: 0, glide: 0.5,
    tints: [0x16171a, 0x1c1c20, 0x121316, 0x23242a] },
  gull: { key: 'gull', size: 1.36, wing: 1.38, hz: 3.3, amp: 0.8, cruise: 10.5, accel: 10, nerve: 1.3, bound: 0, glide: 0.75,
    tints: [0xe9e8e3, 0xdcdcd8, 0xf2f1ec] },
});

export const BIRD_SEED = 0x51b1d5;

/** The same integer hash the crowd uses (js/crowdsites.js), kept here so this file imports nothing. */
export function hash32(a, b = 0, c = 0, d = 0, e = 0) {
  let h = 0x811c9dc5;
  for (const v of [a, b, c, d, e]) {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}
export const rnd01 = (h) => (h >>> 8) / 16777216;

/** A candidate's identity: its place to a quarter of a metre, and its kind. */
export const siteId = (kind, x, z) => hash32(BIRD_SEED, Math.round(x * 4), Math.round(z * 4), kind);

/**
 * How much of the bird life is out at this hour (0..24): everything by day,
 * thinning through dusk, and at night only a few asleep on lamps and eaves.
 */
export function dayK(hour, kind = KIND.GROUND) {
  const h = ((hour % 24) + 24) % 24;
  const night = kind === KIND.GROUND || kind === KIND.SIGN ? 0 : 0.3;
  const up = (a, b) => Math.max(0, Math.min(1, (h - a) / (b - a)));
  if (h < 12) return night + (1 - night) * up(4.8, 6.3);
  return night + (1 - night) * (1 - up(19.2, 21.2));
}

// share of candidates of a kind that hold a flock, by day
const OCC = { [KIND.GROUND]: 0.2, [KIND.LAMP]: 0.15, [KIND.SIGN]: 0.1, [KIND.WIRE]: 0.2, [KIND.ROOF]: 0.16, [KIND.POST]: 0.12 };

// [species, weight] by where and by how built-up it is (urban 0..1)
function table(kind, urban, water) {
  const u = urban, r = 1 - urban;
  let t;
  // (crows by the cube of how open it is: a suburb has a few, a field has little else)
  const c = r * r * r;
  if (kind === KIND.GROUND) t = [['pigeon', 8 + 54 * u], ['sparrow', 26 + 6 * u], ['crow', 3 + 62 * c]];
  else if (kind === KIND.WIRE) t = [['sparrow', 55], ['pigeon', 10 + 25 * u], ['crow', 4 + 34 * c]];
  else if (kind === KIND.SIGN || kind === KIND.POST) t = [['sparrow', 34], ['pigeon', 10 + 30 * u], ['crow', 8 + 46 * c]];
  else if (kind === KIND.ROOF) t = [['pigeon', 20 + 50 * u], ['crow', 10 + 32 * c], ['sparrow', 14]];
  else t = [['pigeon', 12 + 40 * u], ['crow', 10 + 48 * c], ['sparrow', 8]];          // a lamp
  if (water) t.push(['gull', kind === KIND.GROUND || kind === KIND.LAMP || kind === KIND.POST ? 46 : 22]);
  return t;
}

// [min, max] birds in one flock
const COUNT = {
  pigeon: { [KIND.GROUND]: [3, 11], [KIND.LAMP]: [1, 3], [KIND.SIGN]: [1, 2], [KIND.WIRE]: [2, 6], [KIND.ROOF]: [2, 8], [KIND.POST]: [1, 1] },
  sparrow: { [KIND.GROUND]: [4, 10], [KIND.LAMP]: [1, 3], [KIND.SIGN]: [1, 3], [KIND.WIRE]: [3, 9], [KIND.ROOF]: [2, 6], [KIND.POST]: [1, 1] },
  crow: { [KIND.GROUND]: [1, 4], [KIND.LAMP]: [1, 2], [KIND.SIGN]: [1, 1], [KIND.WIRE]: [1, 3], [KIND.ROOF]: [1, 3], [KIND.POST]: [1, 1] },
  gull: { [KIND.GROUND]: [2, 5], [KIND.LAMP]: [1, 2], [KIND.SIGN]: [1, 1], [KIND.WIRE]: [1, 2], [KIND.ROOF]: [1, 4], [KIND.POST]: [1, 1] },
};

/** How far apart two birds of a species sit in a row, metres. */
export const rowGap = (sp) => 0.11 + 0.2 * sp.size;

/**
 * Does a flock live at this candidate, and which?
 *   cand  { kind, x, z, len? }  (len: metres of rail, wire or eave to sit along)
 *   ctx   { urban: 0..1, water: bool, hour: 0..24, density: 0..2 (the crowd slider, 1 = as designed) }
 * Returns null, or { id, species, n, seed }.
 */
export function flockAt(cand, ctx = {}) {
  const id = siteId(cand.kind, cand.x, cand.z);
  const k = dayK(ctx.hour ?? 12, cand.kind) * (ctx.density ?? 1);
  if (!(rnd01(hash32(id, 1)) < (OCC[cand.kind] ?? 0) * k)) return null;
  const t = table(cand.kind, Math.max(0, Math.min(1, ctx.urban ?? 0.6)), !!ctx.water);
  let total = 0;
  for (const e of t) total += e[1];
  let r = rnd01(hash32(id, 2)) * total, key = t[t.length - 1][0];
  for (const e of t) { r -= e[1]; if (r < 0) { key = e[0]; break; } }
  const sp = SPECIES[key];
  const [lo, hi] = COUNT[key][cand.kind] ?? [1, 1];
  // squared: a big flock is the occasional one
  const q = rnd01(hash32(id, 3));
  let n = lo + Math.floor(q * q * (hi - lo + 1));
  if (cand.len != null) n = Math.min(n, Math.max(1, Math.floor(cand.len / rowGap(sp)) + 1));
  return { id, species: key, n: Math.max(1, Math.min(hi, n)), seed: hash32(id, 4) };
}

/**
 * Where each bird of a flock sits.
 *   cand     { kind, x, z, y?, dx?, dz?, len? }: a row kind sits along (dx, dz)
 *            through (x, y, z); the ground kind scatters round (x, z)
 *   groundY  (x, z) => height of the pavement there (ground kind only)
 * Returns [{ x, y, z, yaw }], yaw in the game's convention (facing -sin, -cos).
 */
export function seatsFor(cand, species, n, seed, groundY = null) {
  const sp = SPECIES[species] ?? SPECIES.pigeon, out = [];
  if (cand.kind === KIND.GROUND) {
    // a sunflower scatter: even, never two on one spot, and it grows with n
    const step = 0.2 + 0.26 * sp.size, a0 = rnd01(hash32(seed, 9)) * 6.283;
    for (let i = 0; i < n; i++) {
      const r = step * Math.sqrt(i + 0.6) * (0.85 + 0.3 * rnd01(hash32(seed, i, 1)));
      const a = a0 + i * 2.39996 + (rnd01(hash32(seed, i, 2)) - 0.5) * 0.5;
      const x = cand.x + Math.cos(a) * r, z = cand.z + Math.sin(a) * r;
      out.push({ x, y: groundY ? groundY(x, z) : (cand.y ?? 0), z, yaw: rnd01(hash32(seed, i, 3)) * 6.283 });
    }
    return out;
  }
  const dx = cand.dx ?? 1, dz = cand.dz ?? 0, gap = rowGap(sp);
  // which way the row looks: across the rail, most of them the same way
  const across = Math.atan2(dz, -dx) + (rnd01(hash32(seed, 8)) < 0.5 ? 0 : Math.PI);
  const half = (cand.len ?? 0) / 2;
  for (let i = 0; i < n; i++) {
    let s = (i - (n - 1) / 2) * gap * (1 + 0.5 * rnd01(hash32(seed, i, 1)));
    if (half > 0) s = Math.max(-half, Math.min(half, s));
    const flip = rnd01(hash32(seed, i, 2)) < 0.14 ? Math.PI : 0;
    out.push({ x: cand.x + dx * s, y: cand.y ?? 0, z: cand.z + dz * s,
      yaw: across + flip + (rnd01(hash32(seed, i, 3)) - 0.5) * 0.5 });
  }
  return out;
}

// ---- birds passing overhead --------------------------------------------------
// A sky with nothing crossing it is what makes a town feel like a model. Each
// SKY_CELL square of the world sends a small flock across itself every SKY_T
// seconds, on a straight line, high over the roofs. Position is a closed form
// of the shared clock, so two players watch the same crows go over.
export const SKY_CELL = 420, SKY_T = 46;

/**
 * The flight of cell (ci, cj) in time slot `slot` (floor(t / SKY_T)), or null
 * when that slot is empty. { species, n, x0, z0, dx, dz, y, speed, t0, dur, seed }.
 */
export function skyFlight(ci, cj, slot, ctx = {}) {
  const h = hash32(BIRD_SEED, ci, cj, slot, 0x5c1);
  if (rnd01(h) > 0.62 * dayK(ctx.hour ?? 12, KIND.ROOF)) return null;
  const urban = Math.max(0, Math.min(1, ctx.urban ?? 0.6));
  const t = [['pigeon', 20 + 40 * urban], ['crow', 20 + 40 * (1 - urban)], ['sparrow', 12]];
  if (ctx.water) t.push(['gull', 50]);
  let total = 0;
  for (const e of t) total += e[1];
  let r = rnd01(hash32(h, 1)) * total, key = 'pigeon';
  for (const e of t) { r -= e[1]; if (r < 0) { key = e[0]; break; } }
  const sp = SPECIES[key];
  const a = rnd01(hash32(h, 2)) * 6.283, dx = Math.cos(a), dz = Math.sin(a);
  // through a point somewhere in the cell, entering one cell-width before it
  const px = (ci + rnd01(hash32(h, 3))) * SKY_CELL, pz = (cj + rnd01(hash32(h, 4))) * SKY_CELL;
  const run = SKY_CELL * 1.6, speed = sp.cruise * (0.95 + 0.25 * rnd01(hash32(h, 5)));
  const lo = key === 'sparrow' ? 14 : 26, hi = key === 'gull' || key === 'crow' ? 70 : 48;
  return {
    species: key, seed: h,
    n: key === 'sparrow' ? 5 + (hash32(h, 6) % 8) : key === 'pigeon' ? 4 + (hash32(h, 6) % 9) : 1 + (hash32(h, 6) % 5),
    x0: px - dx * run / 2, z0: pz - dz * run / 2, dx, dz,
    y: lo + rnd01(hash32(h, 7)) * (hi - lo),
    speed, t0: slot * SKY_T + rnd01(hash32(h, 8)) * SKY_T * 0.5, dur: run / speed,
  };
}

/** Bird i of a sky flight at shared time t: { x, y, z } over the GROUND height the caller adds, or null when it is not in the air. */
export function skyBirdAt(f, i, t, out) {
  const u = t - f.t0;
  if (u < 0 || u > f.dur) return null;
  // a loose skein: each bird a little behind and beside the first, drifting
  const back = (rnd01(hash32(f.seed, i, 1)) * 0.9 + 0.12 * i) * 3.2, side = (rnd01(hash32(f.seed, i, 2)) - 0.5) * (4 + f.n * 0.9);
  const wob = Math.sin(u * 0.7 + i * 1.9) * 0.8;
  const s = u * f.speed - back;
  out.x = f.x0 + f.dx * s - f.dz * (side + wob);
  out.z = f.z0 + f.dz * s + f.dx * (side + wob);
  out.y = f.y + (rnd01(hash32(f.seed, i, 3)) - 0.5) * 5 + Math.sin(u * 0.45 + i) * 0.9;
  return out;
}
