// THE STONE STEPS DOWN TO THE NÁPLAVKY (js/quaystairs.js, js/quayflights.js).
// A flight was a terrain stamp and nothing else: a smooth slab of aerial photo
// with a dark fan of smeared ground off its open side. Now the stamp is the
// ground UNDER a flight of treads and risers, and these pin what that takes:
// the ground stays under the stone, the feet stay on it, a car stays off it,
// the OSM line's footway slab is not drawn through it, and every piece is
// built once whatever order the chunks come in.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { Terrain } = await import('../js/terrain.js');
const { STAIRS } = await import('../js/naplavky.js');
const { FLIGHTS, groundUnder, treadTop, walkLine, quayStairY, isQuayStairWay, quayStairsCollide, RISE } =
  await import('../js/quayflights.js');
const { quayStairsInto } = await import('../js/quaystairs.js');
const { CityWorld } = await import('../js/city.js');
const { CHUNK } = await import('../js/config.js');

function flatPrague(y = 193) {
  const t = new Terrain(4800, 20);
  for (const k of ['-21,-1', '-20,-1', '-21,-2', '-20,-2']) t.grids.set(k, new Int16Array(t.n * t.n).fill(y * 10));
  t._loads = 1;
  return t;
}
const at = (F, s, d) => [F.a[0] + F.ux * s + F.nx * d, F.a[1] + F.uz * s + F.nz * d];

test('every flight has steps a person climbs, and they are all the same', () => {
  assert.equal(FLIGHTS.length, STAIRS.length);
  for (const F of FLIGHTS) {
    assert.ok(Math.abs(F.h - RISE) < 0.03, `${F.name}: ${(F.h * 100).toFixed(1)} cm risers`);
    assert.ok(F.g > 0.24 && F.g < 0.8, `${F.name}: ${(F.g * 100).toFixed(0)} cm treads`);
    assert.ok(Math.abs(treadTop(F, F.L - 1e-6) - F.y1) < 1e-6, `${F.name}: the top step is not the landing`);
  }
  // Na Františku has 44 steps in reality
  const nf = FLIGHTS.find((F) => F.name === 'Na Františku stairs');
  assert.ok(Math.abs(nf.n - 44) <= 2, `Na Františku: ${nf.n} steps`);
});

test('the ground of the stamp stays under the treads, as the 2 m ground mesh draws it', () => {
  const t = flatPrague();
  for (const F of FLIGHTS) {
    let worst = -Infinity, where = 0;
    for (let s = 0.02; s < F.L; s += 0.05) {
      for (const d of [-F.l + 0.2, 0, F.r - 0.2]) {
        const [x, z] = at(F, s, d);
        const top = treadTop(F, s);
        // the stamp itself, at the point
        const g = t.heightAt(x, z);
        // and a ground triangle edge 2 m long across it (js/quayground.js
        // refines to that near a hard edge): the chord over a concave kink
        // stands above the stamp
        // (not across a wall: js/quayedge.js puts a vertex on its line there)
        const [xa, za] = at(F, s - 1, d), [xb, zb] = at(F, s + 1, d);
        const ha = t.heightAt(xa, za), hb = t.heightAt(xb, zb);
        const chord = Math.abs(ha - hb) > 1.5 ? -Infinity : (ha + hb) / 2;
        const over = Math.max(g, chord) - top;
        if (over > worst) { worst = over; where = s; }
      }
      assert.ok(Math.abs(groundUnder(F, s) - t.heightAt(...at(F, s, 0))) < 0.02,
        `${F.name}: groundUnder disagrees with the stamp at s ${s.toFixed(2)}`);
    }
    // (2 cm: where two flights climb away from one foot, the chord over the
    // V between them reads 1.4 cm over the first tread at the worst vertex
    // placement; anywhere else it is under 5 mm)
    assert.ok(worst < 0.02, `${F.name}: ground ${(worst * 100).toFixed(1)} cm through the step at s ${where.toFixed(2)}`);
  }
});

test('feet on a flight are never more than half a step off the stone', () => {
  for (const F of FLIGHTS) {
    for (let s = 0.01; s < F.L; s += 0.03) {
      const [x, z] = at(F, s, 0.3);
      const y = quayStairY(x, z);
      assert.ok(y !== null, `${F.name}: no walking level at s ${s.toFixed(2)}`);
      assert.ok(Math.abs(y - treadTop(F, s)) <= F.h / 2 + 1e-6,
        `${F.name}: feet ${((y - treadTop(F, s)) * 100).toFixed(1)} cm off the tread at s ${s.toFixed(2)}`);
    }
    // and nothing past the band
    const [x, z] = at(F, F.L / 2, F.r + 0.5);
    assert.ok(quayStairY(x, z) === null || FLIGHTS.some((G) => G !== F), `${F.name}: a level beside the flight`);
  }
  assert.strictEqual(quayStairY(-95600, -6600), null);
  assert.strictEqual(quayStairY(1500, -800), null);
});

test('the walker stands on the steps and the OSM line beneath them is not a second floor', () => {
  const t = flatPrague();
  const F = FLIGHTS.find((G) => G.name === 'Dvořákovo stairs');
  // the flight's own OSM steps way (tile -20_-2), and a footway on the quay
  const steps = { t: 'steps', w: 1.8, v: 0, d: 0, s: 'paving', p: [[-95661.5, -6816.5], [-95651.3, -6818]] };
  const foot = { t: 'footway', w: 1.8, v: 0, d: 0, s: 'cobble', p: [[-95666.4, -6826.3], [-95664, -6816]] };
  assert.ok(isQuayStairWay(steps));
  assert.ok(!isQuayStairWay(foot));
  assert.ok(!isQuayStairWay({ t: 'steps', w: 1.8, p: [[1500, -800], [1510, -800]] }));
  const key = (x, z) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
  const cells = new Map();
  for (const r of [steps, foot]) for (const p of r.p) {
    const k = key(p[0], p[1]);
    if (!cells.has(k)) cells.set(k, { roads: [], rails: [], buildings: [], water: [] });
    if (!cells.get(k).roads.includes(r)) cells.get(k).roads.push(r);
  }
  const w = Object.assign(Object.create(CityWorld.prototype), { city: { chunkIndex: cells }, terrain: t });
  for (let s = 0.2; s < F.L; s += 0.4) {
    const [x, z] = at(F, s, 0);
    if (!cells.has(key(x, z))) continue;
    const y = w.heightAt(x, z, t.heightAt(x, z) + 2.6);
    assert.ok(Math.abs(y - walkLine(F, s)) < 1e-6, `feet at ${(y - treadTop(F, s)).toFixed(3)} over the tread at s ${s.toFixed(2)}`);
  }
});

test('a car is held off a flight, a walker is not', () => {
  for (const F of FLIGHTS) {
    const [x, z] = at(F, F.L / 2, 0);
    const pos = { x, z };
    assert.ok(quayStairsCollide(pos, 0.5, { y: (F.y0 + F.y1) / 2 }), `${F.name}: a car drove onto it`);
    const { ux, uz, nx, nz, a } = F;
    const s = (pos.x - a[0]) * ux + (pos.z - a[1]) * uz, d = (pos.x - a[0]) * nx + (pos.z - a[1]) * nz;
    assert.ok(s <= -0.5 + 1e-6 || s >= F.L + 0.5 - 1e-6 || d <= -F.l - 0.5 + 1e-6 || d >= F.r + 0.5 - 1e-6,
      `${F.name}: still on it at s ${s.toFixed(2)} d ${d.toFixed(2)}`);
    // a car coming down the street into the top of a flight is put back on the street
    const [tx, tz] = at(F, F.L - 0.3, 0);
    const top = { x: tx, z: tz };
    quayStairsCollide(top, 0.5, { y: F.y1 + 0.3 });
    assert.ok((top.x - a[0]) * ux + (top.z - a[1]) * uz >= F.L + 0.5 - 1e-6, `${F.name}: not pushed back up`);
    // a walker and a level-less nudge pass
    const p2 = { x, z };
    assert.ok(!quayStairsCollide(p2, 0.38, { interior: true, yLo: F.y0 }));
    assert.ok(!quayStairsCollide(p2, 2.4));
  }
});

test('every flight and face is built by exactly one chunk, and the same each time', () => {
  const t = flatPrague();
  const run = (order) => {
    const out = new Map();
    for (const [cx, cz] of order) {
      const tris = [];
      const sink = { triFacing: (...a) => tris.push(a.slice(0, 9).map((v) => Math.round(v * 1000)).join(',')) };
      quayStairsInto(sink, cx * CHUNK, cz * CHUNK, cx * CHUNK + CHUNK, cz * CHUNK + CHUNK, t);
      if (tris.length) out.set(cx + ',' + cz, tris);
    }
    return out;
  };
  const cells = [];
  for (let cx = -806; cx <= -790; cx++) for (let cz = -58; cz <= -30; cz++) cells.push([cx, cz]);
  const a = run(cells), b = run(cells.slice().reverse());
  assert.ok(a.size > 10, `only ${a.size} chunks drew anything`);
  for (const [k, v] of a) assert.deepStrictEqual(b.get(k), v, `chunk ${k} differs with the order`);
  // no triangle twice across chunks
  const seen = new Set();
  let dup = 0;
  for (const v of a.values()) for (const tri of v) { if (seen.has(tri)) dup++; seen.add(tri); }
  assert.equal(dup, 0, `${dup} triangles drawn twice`);
  // nowhere near Prague: nothing, at the first compare
  const none = [];
  quayStairsInto({ triFacing: () => none.push(1) }, 1440, -840, 1560, -720, t);
  assert.equal(none.length, 0);
});
