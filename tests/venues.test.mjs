// ---- the real trade, from the real data ------------------------------------
// This replaces the franchise-stamp tests. Those pinned the behaviour of a
// GUESS: js/interiors.js used to pick buildings by hash and rename them
// McDonald's or KFC, because scripts/split-extracts.mjs discarded every named
// shop and eatery node in the country before build-region.mjs could see one
// (the string "shop" did not appear in that file). The user could stand at
// Pardubice hlavní nádraží, see a McDonald's, a Lidl, a Česká pošta and a
// coraHB in OSM, and find none of them in the game.
//
// So the test is now the opposite assertion: those four are IN THE DATA, they
// arrive with the names OSM wrote down, and each one lands on the footprint it
// really stands on. If the extraction filter loses them again, this fails.

import test from 'node:test';
import assert from 'node:assert';
import { venueKind, venueName, isVenue, joinVenues } from '../scripts/lib/venues.mjs';
import { loadCity, venueAt } from '../js/geo.js';
import { stationArea, centroid } from './fixture-venues.mjs';

const { buildings, venues, stats, elements } = stationArea();
const byName = (re) => buildings.filter((b) => b.n && re.test(b.n));

test('the named POI nodes survive extraction at all', () => {
  // The four the user reported by name, with the OSM node ids they carry.
  const ids = {
    13970695060: ["McDonald's", 'fast_food'],
    12569453187: null,                 // Česká pošta — it is 380 m east, outside this cut
    13634813428: ['coraHB', 'car_parts'],
    3394785494: ['Lidl', 'supermarket'],
  };
  for (const [id, want] of Object.entries(ids)) {
    const el = elements.find((e) => String(e.id) === id);
    if (!want) { assert.equal(el, undefined); continue; }
    assert.ok(el, `node/${id} is not in the fixture — the extraction box moved`);
    assert.ok(isVenue(el.tags), `node/${id} (${want[0]}) would be dropped by split-extracts`);
    assert.equal(venueName(el.tags), want[0]);
    assert.equal(venueKind(el.tags), want[1]);
  }
});

test("the McDonald's by Pardubice hlavní nádraží is where OSM put it", () => {
  // node/13970695060, amenity=fast_food, 50.033526 15.754266 → x −131, z −202,
  // 241 m from the origin. The game must find it there and nowhere else.
  const mcd = byName(/mcdonald/i);
  assert.equal(mcd.length, 1, `${mcd.length} McDonald's in 600 × 260 m of Pardubice`);
  const [cx, cz] = centroid(mcd[0].o);
  const d = Math.hypot(cx - (-131), cz - (-202));
  assert.ok(d < 40, `the McDonald's building sits ${Math.round(d)} m from the OSM node`);
  assert.equal(mcd[0].u, 'fast_food', 'it arrived without its trade');
});

test('the supermarket and the car-parts shop land on their own buildings', () => {
  // Lidl: node/3394785494, x −434 z −113. coraHB (the user wrote "Kora HB" —
  // OSM spells it coraHB): node/13634813428, x −341 z −119.
  for (const [re, kind, x, z] of [
    [/^Lidl$/, 'supermarket', -434, -113],
    [/^coraHB$/, 'car_parts', -341, -119],
  ]) {
    const b = byName(re);
    assert.equal(b.length, 1, `expected exactly one ${re}`);
    assert.equal(b[0].u, kind);
    const [cx, cz] = centroid(b[0].o);
    const d = Math.hypot(cx - x, cz - z);
    assert.ok(d < 40, `${b[0].n} is ${Math.round(d)} m from its OSM node`);
  }
});

test('a venue names its host and is then not shipped twice', () => {
  // 24 named venues in this cut, 20 of them standing in or at a footprint.
  assert.ok(stats.inside >= 15, `only ${stats.inside} venues landed inside a building`);
  assert.ok(stats.taken >= 5, `only ${stats.taken} buildings took a name`);
  // Whatever gave a building its name is redundant in the point layer — the
  // builder drops exactly those, and nothing else.
  assert.equal(stats.claimed.size, stats.taken);
  for (const v of stats.claimed)
    assert.ok(buildings.some((b) => b.n === v.n), `${v.n} was dropped without being absorbed`);
  // …and the ones that did NOT win still exist: a block's other tenants are
  // other businesses, not duplicates. Sportisimo and CCC sit in named buildings
  // by the station and must keep their own records.
  const left = venues.filter((v) => !stats.claimed.has(v));
  assert.ok(left.some((v) => v.n === 'Sportisimo'), 'the losing tenants were thrown away');
});

test('a surveyed building name always outranks a POI node standing in it', () => {
  const named = { o: [[0, 0], [40, 0], [40, 30], [0, 30]], n: 'Palác Pardubice', h: 12 };
  const anon = { o: [[100, 0], [120, 0], [120, 16], [100, 16]], h: 5 };
  const s = joinVenues([named, anon], [
    { p: [20, 15], t: 'clothes', n: 'CCC' },
    { p: [110, 8], t: 'bakery', n: 'Pekárna' },
  ]);
  assert.equal(named.n, 'Palác Pardubice', 'a tenant renamed the gallery it sits in');
  assert.equal(named.u, 'clothes', '…but the trade still reaches it');
  assert.equal(anon.n, 'Pekárna');
  assert.equal(s.taken, 1);
});

test('a doorway node may not rename a tower block', () => {
  // A restaurant node on the pavement is 2–3 m outside the wall, which is how
  // OSM maps an entrance — but a bistro under eight storeys of flats is a
  // bistro, not a nine-storey Restaurace, so `beside` refuses anything tall.
  const tower = { o: [[0, 0], [30, 0], [30, 20], [0, 20]], h: 26 };
  const kiosk = { o: [[100, 0], [112, 0], [112, 9], [100, 9]], h: 3.5 };
  const s = joinVenues([tower, kiosk], [
    { p: [15, -3], t: 'restaurant', n: 'U Raka' },
    { p: [106, -3], t: 'cafe', n: 'Momento' },
  ]);
  assert.equal(tower.n, undefined, 'a doorway node renamed a 26 m block of flats');
  assert.equal(kiosk.n, 'Momento');
  assert.equal(s.beside, 1);
});

test('shop=vacant is a surveyor saying the unit is empty', () => {
  assert.equal(venueKind({ shop: 'vacant', name: 'Bývalá prodejna' }), null);
  assert.equal(venueKind({ shop: 'no' }), null);
  assert.equal(venueKind({ shop: 'hairdresser' }), 'hairdresser');
  // office=* collapses: 73 values that all look the same from the street, on
  // tiles that are committed to git
  assert.equal(venueKind({ office: 'estate_agent' }), 'office');
  // a brand stands in for a missing name (a Z-BOX, a Žabka); `operator` does
  // not, or every post box in the country becomes a post office
  assert.equal(venueName({ brand: 'Žabka' }), 'Žabka');
  assert.equal(venueName({ operator: 'Česká pošta, s.p.' }), null);
  assert.equal(isVenue({ amenity: 'bench' }), false);
});

test('the client indexes the leftovers and can be asked what stands here', async () => {
  // The other half of the contract: a venue no footprint absorbed still has to
  // reach the player. It is bucketized by chunk, so the HUD asks one 3×3 of
  // cells rather than a list that grows for the whole session.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      buildings: [], roads: [], rails: [], water: [], waterways: [],
      green: [], paved: [], trees: [], pois: [], signals: [],
      venues: [
        { p: [-239.4, -206.6], t: 'clothes', n: 'Sportisimo' },
        { p: [-217.9, -290.8], t: 'clothes', n: 'CCC' },
      ],
    }),
  });
  try {
    const city = await loadCity('legacy');       // no `tiles` key = index it all
    assert.equal(venueAt(city, -238, -208, 7)?.n, 'Sportisimo');
    // …and it does not answer for a shop you are not standing at: 5.6 m away
    // with a 3 m reach is the far side of the pavement
    assert.equal(venueAt(city, -234, -208, 3), null);
    assert.equal(venueAt(city, -218, -292, 7)?.n, 'CCC');
    assert.equal(venueAt(city, 0, 0, 20), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
