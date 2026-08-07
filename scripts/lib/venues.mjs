// ---- venues: the named trade on a Czech street, straight out of OSM --------
// A survey of what the pipeline throws away (docs/OSM-COVERAGE.md) found the
// single largest recoverable loss sitting in scripts/split-extracts.mjs: the
// string "shop" does not appear in that file, so every named shop and eatery
// NODE in the country is discarded before build-region.mjs ever sees it.
// Measured over the six extracts inside the world mask, node ids deduplicated:
// shop 19 317 (16 559 named), restaurant 5 603 (5 302), cafe 1 809 (1 704),
// fast_food 1 778 (1 500), pharmacy 1 094 (1 044), post_office 1 075 (1 060),
// bank 608 (594) — 31 284 nodes, 27 763 of them NAMED, and the pipeline kept
// zero. Verified in the product, not just the extract: `grep -c McDonald
// data/raw-region/0_0.json` was 0, so nothing downstream could have used the
// name even in principle.
//
// What the game did instead was INVENT the missing trade — js/interiors.js
// picked buildings by hash and renamed them McDonald's or KFC — while the real
// McDonald's (node/13970695060), the real Lidl (node/3394785494), the real
// Česká pošta (node/12569453187) and the real coraHB (node/13634813428) stood
// within 450 m of the world origin and reached nothing.
//
// This module is the ONE definition of what a venue is, shared by the splitter
// (which must keep the node) and the builder (which must emit it and hang it on
// a building), so the two can never disagree about the tag list again.

// The amenities that are a PLACE OF TRADE OR SERVICE with a name over the door.
// Deliberately not the whole amenity vocabulary: a bench, a bin and a parking
// space are already street furniture, and amenity=* holds 219 values of which
// most are neither named nor visible.
const VENUE_AMENITY = /^(fast_food|restaurant|cafe|bar|pub|bank|post_office|pharmacy|school|kindergarten|library|cinema|theatre|townhall|marketplace)$/;
// Tourism is nearly all `information` boards (26 338 of them) — worthless as a
// building identity. These three are buildings somebody named.
const VENUE_TOURISM = /^(hotel|museum|attraction)$/;
// shop=no / shop=vacant is a surveyor saying "this unit is EMPTY", which is the
// opposite of a venue.
const NOT_A_SHOP = /^(no|vacant|closed)$/;

/**
 * venueKind(tags) → the OSM value that says what this place SELLS, or null.
 * One flat namespace across shop/amenity/tourism because the runtime asks one
 * question of it ("what trade is this"), and `office` collapses to a single
 * kind: its 73 values (company, lawyer, estate_agent…) all look the same from
 * the street, and the tiles are committed to git.
 */
export function venueKind(t) {
  if (!t) return null;
  if (t.shop && !NOT_A_SHOP.test(t.shop)) return t.shop;
  if (VENUE_AMENITY.test(t.amenity ?? '')) return t.amenity;
  if (VENUE_TOURISM.test(t.tourism ?? '')) return t.tourism;
  if (t.office && t.office !== 'no') return 'office';
  return null;
}

/**
 * venueName(tags) → what is written over the door, or null.
 * A brand with no name is still a recognisable shop (a Z-BOX, a Žabka), so it
 * stands in for the name; `operator` is NOT accepted — on Czech data it is
 * mostly "Česká pošta, s.p." bolted onto street furniture, which would put a
 * post office sign on a post box.
 */
export function venueName(t) {
  const n = t?.name ?? t?.brand;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** A node/way worth keeping: it has a trade AND somebody wrote its name down. */
export const isVenue = (t) => !!venueKind(t) && !!venueName(t);

// ---- which venue wins a building ------------------------------------------
// A block can hold five of these — a supermarket, two offices and a hairdresser
// — and only one name goes on the fascia. Rank by how much the trade DEFINES
// the building: nobody calls a building by the accountant on its third floor,
// everybody calls it the Lidl.
const RANK = new Map(Object.entries({
  mall: 0, department_store: 0, supermarket: 1, hypermarket: 1, wholesale: 1,
  doityourself: 1, hardware: 1, furniture: 1, car: 1,
  hotel: 2, museum: 2, school: 2, kindergarten: 2, hospital: 2, townhall: 2,
  theatre: 2, cinema: 2, library: 2,
  fast_food: 3, restaurant: 3, cafe: 3, bar: 3, pub: 3,
  bank: 4, post_office: 4, pharmacy: 4,
  office: 9,
}));
const rankOf = (kind) => RANK.get(kind) ?? 5;   // an unlisted shop=* is a shop

// ---- the join --------------------------------------------------------------
// OSM maps a shop three ways: as a tag on the building way, as a node INSIDE
// the footprint, or as a node on the pavement at the door. The first already
// reaches the tiles; the other two are what this handles.
const CELL = 40;                    // m — a grid cell about one building wide
// BESIDE: a node at the entrance sits a couple of metres OUTSIDE the wall,
// because the surveyor stood in the doorway. 10 m covers that and the width of
// a pavement without reaching across a street.
const BESIDE_R = 10;
// …and the guard that keeps a doorway node from renaming a tower block. A
// ground-floor bistro under eight storeys of flats is a bistro, not a
// "Restaurace" nine storeys high — so a venue may only claim a building it
// could plausibly BE. A node INSIDE a footprint has no such doubt and skips it.
const BESIDE_MAX_AREA = 2000, BESIDE_MAX_H = 12;

const ringArea = (o) => {
  let a = 0;
  for (let i = 0, n = o.length; i < n; i++) {
    const [x1, z1] = o[i], [x2, z2] = o[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a / 2);
};
const inRing = (x, z, o) => {
  let hit = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [xi, zi] = o[i], [xj, zj] = o[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
// distance from a point to the nearest edge of a ring (0 if the ring is behind
// us — callers only ask this for points already known to be outside)
function distToRing(x, z, o) {
  let best = Infinity;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [x1, z1] = o[i], [x2, z2] = o[j];
    const dx = x2 - x1, dz = z2 - z1, L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / L2)) : 0;
    const d = Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * joinVenues(buildings, venues) — give every building the name and the trade of
 * the venue standing in it. MUTATES the building records: `n` (only when OSM
 * left the footprint itself unnamed — a surveyed building name always wins) and
 * `u`, the shop/amenity value js/interiors.js classify() has read all along and
 * which no build script has ever written.
 *
 * Returns { inside, beside, taken, claimed } — `claimed` is the venues whose
 * name is now ON a building, so the caller can drop them from the point layer
 * rather than ship the same string twice into a committed tile. Everything
 * else survives: a block's other four ground-floor tenants are four more
 * businesses, not a duplicate.
 */
export function joinVenues(buildings, venues) {
  const grid = new Map();
  const box = [];
  for (let i = 0; i < buildings.length; i++) {
    const o = buildings[i].o;
    if (!o || o.length < 3) { box.push(null); continue; }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of o) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    box.push({ x0, z0, x1, z1, area: ringArea(o) });
    // registered over its whole bbox, grown by BESIDE_R so a doorway node one
    // cell over still finds it
    for (let cx = Math.floor((x0 - BESIDE_R) / CELL); cx <= Math.floor((x1 + BESIDE_R) / CELL); cx++)
      for (let cz = Math.floor((z0 - BESIDE_R) / CELL); cz <= Math.floor((z1 + BESIDE_R) / CELL); cz++) {
        const k = cx + ',' + cz;
        let a = grid.get(k);
        if (!a) grid.set(k, a = []);
        a.push(i);
      }
  }

  // best claim per building, so five venues in one block resolve to one fascia
  const claim = new Map();          // building index → { v, rank, inside }
  const stats = { inside: 0, beside: 0, taken: 0, claimed: new Set() };
  for (const v of venues) {
    const [x, z] = v.p;
    const cand = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!cand) continue;
    // SMALLEST containing footprint wins: a bakery inside a shopping centre
    // names the unit it is drawn in, never the whole gallery.
    let hit = -1, hitArea = Infinity, near = -1, nearD = BESIDE_R;
    for (const i of cand) {
      const b = box[i]; if (!b) continue;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && inRing(x, z, buildings[i].o)) {
        if (b.area < hitArea) { hitArea = b.area; hit = i; }
        continue;
      }
      if (hit >= 0 || buildings[i].n) continue;      // beside is the fallback only
      if (b.area > BESIDE_MAX_AREA || (buildings[i].h ?? 0) > BESIDE_MAX_H) continue;
      const d = distToRing(x, z, buildings[i].o);
      if (d < nearD) { nearD = d; near = i; }
    }
    const i = hit >= 0 ? hit : near;
    if (i < 0) continue;
    if (hit >= 0) stats.inside++; else stats.beside++;
    const r = rankOf(v.t), inside = hit >= 0;
    const prev = claim.get(i);
    // an inside node outranks a doorway node whatever it sells; then the trade
    // rank; then name order, so the answer does not depend on which extract was
    // read first or on the order the PBF happened to store two nodes in
    const better = !prev ? true
      : inside !== prev.inside ? inside
      : r !== prev.rank ? r < prev.rank
      : v.n < prev.v.n;
    if (better) claim.set(i, { v, rank: r, inside });
  }
  for (const [i, c] of claim) {
    const b = buildings[i];
    b.u ??= c.v.t;
    if (!b.n) { b.n = c.v.n; stats.taken++; stats.claimed.add(c.v); }
  }
  return stats;
}
