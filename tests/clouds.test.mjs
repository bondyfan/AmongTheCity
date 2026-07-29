// ---- clouds are at an altitude, and the altitude is physics ----
// A cloud is where rising air got cold enough to condense. Air lifted off the
// ground cools at ~9.8 °C/km while the dew point it carries falls at only
// ~1.8 °C/km, so they converge; where they meet is the lifting condensation
// level, and the pilot's rule of thumb is 125 m per °C of spread. A Czech
// summer afternoon puts fair-weather cumulus 1.2–1.5 km up.
//
// The part this file exists to protect: temperature and dew point belong to the
// AIR MASS, not to the ground under it, so that level is a constant height
// above SEA LEVEL across a region — a flat lid every cumulus shares, which does
// not rise with the terrain. The old constants were 230–620, chosen when the
// ground was a plane at zero and "above sea level" and "above ground" were the
// same sentence. On real terrain that buried the entire sky: Pardubice stands
// at 221 m and the ridges above Zlín at 350.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { Clouds, CLOUD_RANGES, CLOUD_DIST_DEFAULT } = await import('../js/clouds.js');

const build = (dist) => new Clouds(new THREE.Scene(), dist);

test('every cloud is above the highest ground in the world', () => {
  // The world runs from 175 m in the Polabí to 752 m in the Vysočina hills the
  // I/35 crosses on its way to Zlín; nothing may be built below the top of that.
  // (fetch-terrain prints the range on every rebuild — keep this in step.)
  const WORLD_HI = 752;
  const c = build();
  let lowest = Infinity;
  for (const cl of c.clusters) for (const p of cl.puffs) lowest = Math.min(lowest, cl.y + p.oy);
  assert.ok(lowest > WORLD_HI,
    `a cloud reaches ${lowest.toFixed(0)} m — that is inside the terrain`);
});

test('the base sits where the condensation level puts it', () => {
  // 125 m × (T − Td): a 24 °C / 12 °C afternoon is 1500 m above the ground the
  // air rose from, and the ground here is 200–350 m. So a base somewhere in
  // 1.1–1.7 km above sea level is the honest answer, and 2–3 km for the deck
  // above it. Wide brackets on purpose — this is a weather model, not a METAR.
  const c = build();
  let lo = Infinity, hi = -Infinity;
  for (const cl of c.clusters) { lo = Math.min(lo, cl.y); hi = Math.max(hi, cl.y); }
  assert.ok(lo > 1100 && lo < 1700, `low deck at ${lo.toFixed(0)} m`);
  assert.ok(hi > 2000 && hi < 3200, `upper deck at ${hi.toFixed(0)} m`);
});

test('a cumulus deck has a FLAT base, which is what the eye reads', () => {
  // Cumulus in one air mass share their base — pilots call it the ceiling and
  // mean it literally. Drawing altitudes uniformly across a 400 m band, which
  // is what the old code did, destroys exactly that.
  const c = build();
  const low = c.clusters.map((cl) => cl.y).filter((y) => y < 2000);
  assert.ok(low.length > 10, 'no low deck to speak of');
  const spread = Math.max(...low) - Math.min(...low);
  assert.ok(spread < 200, `the low deck is ${spread.toFixed(0)} m thick — that is a smear, not a lid`);
});

test('a cloud is never at coordinate NaN', () => {
  // The stratification grid was a fixed 4×4 = 16 cells from when the field held
  // 14 bodies. When the count grew to 120, `cells[c]` was undefined for every
  // cluster past the sixteenth, so 104 of 120 clouds were built at NaN —
  // present in the scene, counted in the budget, and never drawn.
  for (const dist of Object.keys(CLOUD_RANGES)) {
    const c = build(dist);
    assert.equal(c.clusters.length, CLOUD_RANGES[dist].n, `${dist}: wrong cluster count`);
    for (const cl of c.clusters) {
      assert.ok(Number.isFinite(cl.x) && Number.isFinite(cl.y) && Number.isFinite(cl.z),
        `${dist}: cluster at ${cl.x},${cl.y},${cl.z}`);
      for (const p of cl.puffs) {
        assert.ok(Number.isFinite(p.ox) && Number.isFinite(p.oy) && Number.isFinite(p.oz),
          `${dist}: puff offset is not a number`);
      }
    }
  }
});

test('the clusters are spread over the whole torus, not piled in a corner', () => {
  const c = build();
  const F = c.field;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const cl of c.clusters) {
    minX = Math.min(minX, cl.x); maxX = Math.max(maxX, cl.x);
    minZ = Math.min(minZ, cl.z); maxZ = Math.max(maxZ, cl.z);
  }
  assert.ok(maxX - minX > F * 1.7 && maxZ - minZ > F * 1.7,
    `field covers ${(maxX - minX).toFixed(0)}×${(maxZ - minZ).toFixed(0)} of a ${(F * 2)} m torus`);
});

// ---------------------------------------------------------------------------
// draw distance
// ---------------------------------------------------------------------------

test('every range shows cloud low enough to reach the horizon', () => {
  // A base 1350 m up seen over a 2.6 km field is cloud only above 27° — a patch
  // overhead and a bare horizon. Each range must put its lowest cloud under 20°.
  const BASE = 1350;
  for (const [name, r] of Object.entries(CLOUD_RANGES)) {
    const elev = Math.atan(BASE / r.range) * 180 / Math.PI;
    assert.ok(elev < 20, `${name}: lowest cloud sits ${elev.toFixed(0)}° up — the horizon is empty`);
  }
});

test('each range is wider than the last and holds its cloud density', () => {
  const order = ['medium', 'far', 'furthest'];
  let prev = 0, prevDens = Infinity;
  for (const k of order) {
    const r = CLOUD_RANGES[k];
    assert.ok(r.range > prev, `${k} is not further than the range before it`);
    prev = r.range;
    // bodies per km² of torus — the sky must not thin out as it grows
    const dens = r.n / ((r.field * 2 / 1000) ** 2);
    // it is allowed to THIN with range — that is where the cost lives — but a
    // sky you can see through is not a sky
    assert.ok(dens > 1.4, `${k} sky is ${dens.toFixed(1)} clouds/km² — too empty`);
    assert.ok(dens <= prevDens + 0.01, `${k} got DENSER, which is a cost surprise`);
    prevDens = dens;
  }
});

test('the wrap can never be seen, at any range', () => {
  // The invariant the module is built on: a cluster teleporting to the far side
  // of the torus must already be fully faded. Its centre is `field` away at the
  // boundary and its widest puff reaches ~370 m past that centre, so the fade
  // has to be complete by `field − reach`. clouds.js asserts this on import;
  // this asserts that the assertion is actually load-bearing.
  for (const [name, r] of Object.entries(CLOUD_RANGES)) {
    assert.ok(r.range <= r.field - 370,
      `${name}: range ${r.range} vs field ${r.field} — a cloud would blink across the sky`);
  }
});

test('switching range rebuilds the sky and lets go of the old one', () => {
  const c = build('medium');
  const before = c.clusters.length;
  assert.equal(before, CLOUD_RANGES.medium.n);
  c.setDist('furthest');
  assert.equal(c.dist, 'furthest');
  assert.equal(c.clusters.length, CLOUD_RANGES.furthest.n);
  assert.equal(c.range, CLOUD_RANGES.furthest.range);
  // the group must not still be carrying the medium field's sprites
  assert.equal(c.group.children.length, c.clusters.reduce((n, cl) => n + cl.puffs.length, 0));
});

test('setting the range it already has does nothing, and junk is ignored', () => {
  const c = build('far');
  const same = c.clusters[0];
  c.setDist('far');
  assert.equal(c.clusters[0], same, 'rebuilt the whole sky for no reason');
  c.setDist('preposterous');
  assert.equal(c.dist, 'far', 'an unknown range was accepted');
});

test('an unknown range at construction falls back rather than exploding', () => {
  const c = build('nonsense');
  assert.equal(c.dist, CLOUD_DIST_DEFAULT);
  assert.equal(c.clusters.length, CLOUD_RANGES[CLOUD_DIST_DEFAULT].n);
});
