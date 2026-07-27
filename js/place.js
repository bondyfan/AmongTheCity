// ---- Place: "where am I", in words ----------------------------------------
// Two answers, updated a few times a second and handed to the HUD by main.js:
// the STREET under your wheels and the TOWN around you. Both come out of data
// the world already carries — `n` on ~13 % of the ways (1 145 of the 8 560 in
// the tile holding the station, which is every named street in it; the rest are
// service spurs, driveways and footpaths that have no name to carry) and
// public/data/places.json, 2 331 named settlements in the same local metres as
// everything else — so this module downloads exactly one small file and
// otherwise costs a few thousand distance tests a second.
//
// Three things are worth reading the code for.
//
// 1. THE STREET IS FOUND THROUGH THE CHUNK INDEX, never the road array. The
//    world reaches Prague: city.roads holds hundreds of thousands of ways and
//    scanning it four times a second would be the most expensive thing in the
//    frame by an order of magnitude. geo.js already buckets every feature into
//    120 m cells, and a road can only be "the street I am standing on" if it
//    passes within ~57 m (the widest aeroway's half-width plus the pavement
//    allowance), so the 3×3 cell neighbourhood is provably exhaustive: the
//    scanned square reaches at least CHUNK metres past the player in every
//    direction, and a way whose nearest point is that close is registered in a
//    cell we visit. Measured over every named way in the tile around the
//    station: 27 ways tested per scan on average, 77 in the worst case, out of
//    8 560 — and standing on any one of those 1 145 named ways returns its own
//    name, all 1 145 of them.
//
// 2. THE TOWN IS A CONTAINMENT QUESTION FIRST AND A DISTANCE QUESTION SECOND.
//    See the long note above _scanTown — this is where a naive "nearest place,
//    weighted by rank" gives visibly wrong answers, and it is the one piece of
//    judgement in the file.
//
// 3. BOTH ANSWERS ARE STICKY. A junction is a place where two named ways are
//    within metres of each other, so the raw nearest-way answer flickers
//    between them at walking pace; and driving out of a village the town answer
//    strobes on and off at its boundary. A new answer therefore has to hold for
//    HOLD seconds before it is published, which costs a fraction of a second of
//    staleness and buys a HUD that never blinks.
//
// A places.json that fails to load is not fatal: `town` simply stays null and
// the street readout carries on alone.

import { CHUNK } from './config.js';
import { distPointToSegment } from './geo.js';

const PLACES_URL = 'data/places.json';

// ---- timing ---------------------------------------------------------------
const STREET_DT = 0.25;   // s between street scans (4 Hz — a car at 130 km/h
                          // covers 9 m, which is well inside one street)
const TOWN_DT = 0.5;      // s between town scans; a town boundary is a kilometre
                          // -scale thing and does not need 4 Hz
const HOLD = 0.6;         // s a NEW answer must survive before it replaces the
                          // published one (the contract's anti-flicker)

// ---- street ---------------------------------------------------------------
// How far past the kerb still counts as "on this street": pavement, verge,
// parking bay and the slop in an OSM centreline. Added to half the way's own
// width, so a 30 m dual carriageway reaches further than a 4 m lane.
const STREET_PAD = 12;
const CELL_R = 1;         // chunk rings scanned around the player — see note 1

// ---- town -----------------------------------------------------------------
// Every place gets a RADIUS: how far its name plausibly reaches. That radius is
// what turns a list of points into a map of areas without any polygon data.
// Rank floor (0 city … 5 isolated dwelling), then refined upward by population
// where the file has it.
const RANK_R = [3000, 900, 420, 700, 260, 90];
// Tie-break weight for places you are OUTSIDE of: at equal distance the bigger
// settlement is the more useful position report ("2 km from Pardubice" beats
// "2 km from Nový Dvůr"). Deliberately mild — this only ever compares things
// you are demonstrably not in, so it must not overrule plain proximity by much.
const RANK_K = [0.55, 0.72, 0.9, 0.92, 1.0, 1.25];
// People per km² of BUILT-UP area — not administrative area, which for Czech
// obce includes the fields. Calibrated against the three cities in the file:
// it puts Pardubice (88 520) at 3.4 km, Hradec Králové (90 596) at 3.4 km and
// Praha (1 275 406) at 12.7 km, which is what those cities measure.
const POP_DENS = 2500;
const R_MAX = 11000;      // …and a ceiling, so no population figure lets one
                          // place claim a quarter of the world
const REPORT_MAX = 4000;  // m — outside every place and further than this from
                          // the nearest one, the honest answer is nothing

// "no candidate is serving its hold" — and it has to be a value no candidate
// can ever be, because null IS a legitimate candidate (it means "off the end of
// every named street"). Reusing null for both was a real bug: after a name was
// published, `pend` went back to null, the next null candidate compared equal
// to it, and the stale `at` from the PREVIOUS candidate had long since expired,
// so leaving a street cleared the HUD instantly instead of after the hold.
const NO_PEND = Symbol('no pending');

// The radius of one place. Exported because it is the number the whole town
// answer turns on and the tests pin it against real settlements.
export function placeRadius(rank, pop) {
  const r = rank >= 0 && rank <= 5 ? rank | 0 : 4;
  // area = pop / density (km²) → radius = sqrt(area/π) (km) → metres. Only ever
  // GROWS a place past its rank floor: a village that reports 6 inhabitants is
  // a village that forgot to count, not a village 50 m across.
  const popR = pop > 0 ? Math.sqrt(pop / (Math.PI * POP_DENS)) * 1000 : 0;
  return Math.min(R_MAX, Math.max(RANK_R[r], popR));
}

// places.json is fetched ONCE per page load and shared by every PlaceFinder
// ever built (worldmap.js does the same for its labels; the second request for
// the same URL is a browser cache hit anyway). A failure resolves to an empty
// list rather than rejecting — the caller degrades to street-only.
let _placesP = null;
function loadPlaces() {
  if (!_placesP) {
    _placesP = fetch(PLACES_URL)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(d => prepare(d?.places ?? []))
      .catch(err => {
        console.warn('[place] places.json unavailable, street only:', err.message);
        return [];
      });
  }
  return _placesP;
}

// One pass at load time computes everything the per-scan loop would otherwise
// recompute 2 331 times, twice a second: the radius, the rank weight, and the
// squared cutoff past which a place cannot win EITHER branch of the test (its
// own radius, or the report limit — whichever reaches further).
function prepare(raw) {
  const out = [];
  for (const p of raw) {
    if (!p || typeof p.n !== 'string' || !Array.isArray(p.p)) continue;
    const r = p.r >= 0 && p.r <= 5 ? p.r | 0 : 4;
    const R = placeRadius(r, p.pop);
    const lim = R > REPORT_MAX ? R : REPORT_MAX;
    out.push({ n: p.n, r, x: p.p[0], z: p.p[1], R, k: RANK_K[r], lim2: lim * lim });
  }
  return out;
}

export class PlaceFinder {
  constructor(city) {
    this.city = city;
    this.places = [];              // filled asynchronously; [] = street only
    this.clock = null;             // test seam: () => seconds. null = wall clock
    // One channel per answer: `val` is what the outside world sees, `pend` the
    // candidate currently serving its HOLD, `at` when that candidate first
    // appeared. Allocated here, mutated forever — update() allocates nothing.
    this._s = { val: null, pend: NO_PEND, at: 0 };
    this._t = { val: null, pend: NO_PEND, at: 0 };
    this._streetDue = 0;
    this._townDue = 0;
    // Generation stamp for the street scan's dedupe: geo.js files a feature in
    // EVERY cell its bbox touches, so a long way turns up in several of our
    // nine. Stamping it beats a Set — no allocation, no clearing, O(1).
    this._gen = 0;
    loadPlaces().then(list => { this.places = list; });
  }

  // Contract: the town, or null. Getters, so the sticky state has exactly one
  // home and nothing can publish an answer without going through _settle.
  get town() { return this._t.val; }
  get street() { return this._s.val; }

  // performance.now() and NOT Date.now(): the hold timer must be monotonic, or
  // an NTP correction mid-drive publishes a street name early or holds one for
  // a minute. Seconds, to match every other clock in the project.
  _now() {
    if (this.clock) return this.clock();
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  // Called every frame; does real work at most 4×/s and returns on a single
  // compare in between. The only allocation on the whole path is the nine chunk
  // keys the street scan hands to Map.get — 36 short strings a second, and the
  // alternative would be a second spelling of geo.chunkKey, which is worse.
  update(x, z) {
    const now = this._now();
    if (now >= this._streetDue) {
      this._streetDue = now + STREET_DT;
      this._settle(this._s, this._scanStreet(x, z), now);
    }
    if (now >= this._townDue) {
      this._townDue = now + TOWN_DT;
      this._settle(this._t, this.places.length ? this._scanTown(x, z) : null, now);
    }
  }

  // The stickiness, both channels share it. Note the one asymmetry: adopting a
  // name over NOTHING is instant. There is nothing to flicker away from at
  // that point, and making the boot (and every re-entry after a gap) sit
  // through 0.6 s of blank HUD would be staleness bought with no anti-flicker
  // in return. Replacing a name with another name — or with nothing — always
  // costs the full hold, which is the case the contract cares about.
  _settle(ch, cand, now) {
    if (cand === ch.val) { ch.pend = NO_PEND; return; }        // already published
    if (ch.val === null) { ch.val = cand; ch.pend = NO_PEND; return; }
    if (cand !== ch.pend) { ch.pend = cand; ch.at = now; return; }
    if (now - ch.at >= HOLD) { ch.val = cand; ch.pend = NO_PEND; }
  }

  // ---- street ------------------------------------------------------------
  // Nearest NAMED way whose distance is under (w/2 + STREET_PAD), searched
  // through the 3×3 chunk neighbourhood. Named footways and cycleways exist
  // (41 of the station tile's 1 145 named ways) and are deliberately NOT
  // excluded: if you are walking one, its name IS where you are, and on foot
  // that is more useful than the carriageway twenty metres away.
  _scanStreet(x, z) {
    const idx = this.city?.chunkIndex;
    if (!idx) return null;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const gen = ++this._gen;
    let best = null, bestD = Infinity;
    for (let i = -CELL_R; i <= CELL_R; i++) {
      for (let j = -CELL_R; j <= CELL_R; j++) {
        // the key format is geo.chunkKey's, verbatim — one index, one spelling
        const cell = idx.get((cx + i) + ',' + (cz + j));
        if (!cell) continue;
        const roads = cell.roads;
        for (let a = 0; a < roads.length; a++) {
          const r = roads[a];
          if (!r.n || r._pfg === gen) continue;
          r._pfg = gen;
          // A road only wins if it is inside BOTH its own kerb allowance and
          // whatever the best answer so far is, so one cap drives the segment
          // rejection as well as the final test.
          const lim = (r.w ?? 6) * 0.5 + STREET_PAD;
          const cap = lim < bestD ? lim : bestD;
          const p = r.p;
          let d = Infinity;
          for (let s = 0; s < p.length - 1; s++) {
            const ax = p[s][0], az = p[s][1], bx = p[s + 1][0], bz = p[s + 1][1];
            // segment bbox reject: a way clipped at a 4.8 km tile border can
            // carry hundreds of segments and all but two are nowhere near us
            if (x < (ax < bx ? ax : bx) - cap || x > (ax > bx ? ax : bx) + cap) continue;
            if (z < (az < bz ? az : bz) - cap || z > (az > bz ? az : bz) + cap) continue;
            const dd = distPointToSegment(x, z, ax, az, bx, bz, null);
            if (dd < d) d = dd;
          }
          if (d < cap) { bestD = d; best = r.n; }
        }
      }
    }
    return best;
  }

  // ---- town --------------------------------------------------------------
  // THE WEIGHTING, and why it is not one number.
  //
  // The obvious implementation is a single score — d × k(rank), or d − R — and
  // both of them get a case badly wrong.
  //
  //   Standing in Slezské Předměstí (suburb, r=3, no population in the file, so
  //   R = 700 m) you are also 2 143 m from the centre of Hradec Králové (city,
  //   90 596 people, R = 3 400 m). Any score that simply rewards size hands you
  //   "Hradec Králové" — technically true and useless, because the suburb is
  //   the more specific true answer and the one a local would give.
  //
  //   Standing in a field 2 km short of Sezemice (town, 2 317 people, R = 900 m)
  //   you are 4.1 km from the centre of Pardubice (R = 3 357 m). "d − R" —
  //   distance to the nearest place's EDGE — answers Pardubice (743 vs 1 457),
  //   which is wrong in the other direction: you are in neither, and the
  //   nearest thing is Sezemice.
  //
  // What separates the two cases is not size, it is CONTAINMENT. So the test is
  // two-tier, and each tier gets the rule that is right for it:
  //
  //   · Among the places you are INSIDE (d < R), the MOST SPECIFIC one wins —
  //     highest rank number, ties broken by distance. Slezské Předměstí (r=3)
  //     over Hradec Králové (r=0). This is the tier that makes a city 3 km away
  //     beat a neighbourhood 400 m away exactly when it should: the city
  //     contains you and the 260 m-radius neighbourhood does not, so the
  //     neighbourhood was never the containing place to begin with. Move 200 m
  //     closer to it and it takes the answer straight back.
  //   · Among the places you are OUTSIDE of, the nearest wins, weighted mildly
  //     by rank (RANK_K). Sezemice at 2 000 × 0.72 = 1 440 over Pardubice at
  //     4 100 × 0.55 = 2 255.
  //   · Containment always outranks proximity: being in a place beats being
  //     near one, however small the place and however big the neighbour.
  //
  // The report cutoff applies only to the second tier. Praha's radius is 11 km
  // and its centroid is 8 km from Zličín; you are still in Praha, and "nothing"
  // would be a worse answer than a slightly distant centroid.
  //
  // WHAT THIS MEANS ON THE REAL GAZETTEER, because it surprised me and it is
  // the right behaviour rather than a bug to file later: inside a city you get
  // the DISTRICT, not the city. The station forecourt reads "Zelené Předměstí"
  // (r=3, 489 m away) rather than "Pardubice" (1 748 m); the Old Town reads
  // "Josefov"; Hradec's ring reads "Slezské Předměstí". That is GTA's own HUD
  // convention and it is what a local would say — and the street line under it
  // supplies the detail, so nothing is lost. Only where a district's own name
  // does not reach do you fall back to the city.
  //
  // The one rough edge, accepted: Czech OSM also carries the ZSJ statistical
  // sub-units as r=4, and a few of them sit almost exactly on their parent's
  // node — "Slezské Předměstí-střed" is 48 m from Slezské Předměstí, "Hradec
  // Králové-historické jádro" 5 m from Hradec Králové. Within their 260 m the
  // more specific rule hands you the hyphenated name. It is not wrong, just
  // wordy, and the alternative (refusing r=4 a containment win) would also
  // refuse it in the one case the contract explicitly asks for — a
  // neighbourhood you are genuinely standing in beating the city around it.
  //
  // Cost: one squared-distance compare per place (2 331 of them) twice a
  // second. A spatial grid was considered and rejected — the query radius has
  // to be R_MAX + REPORT_MAX = 15 km to be correct for Praha, which is most of
  // the grid anyway.
  _scanTown(x, z) {
    const list = this.places;
    let inBest = null, inRank = -1, inD = Infinity;
    let outBest = null, outScore = Infinity, outD = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > p.lim2) continue;          // cannot win either tier — 99 % exit here
      const d = Math.sqrt(d2);
      if (d < p.R) {
        if (p.r > inRank || (p.r === inRank && d < inD)) { inRank = p.r; inD = d; inBest = p; }
      } else {
        const s = d * p.k;
        if (s < outScore) { outScore = s; outD = d; outBest = p; }
      }
    }
    if (inBest) return inBest.n;
    return outBest && outD <= REPORT_MAX ? outBest.n : null;
  }
}
