// Prague's lights (js/airport-lights-plan.js lkprLights), as the Czech eAIP
// LKPR AD 2.14 and AD 2.9 publish them (read 25 Nov 2026): 06/24 with edge
// and centreline lights, 24 a CAT II/III approach with TDZ and wing bars,
// 06 a 480 m CAT I, 12/30 without a centreline, SALS off 12 and a 900 m CAT I
// off 30, PAPI left everywhere, green centrelines down the taxiways.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const P = await import('../js/airport-lights-plan.js');
const { LKPR_PLAN, prague } = await import('../js/flight-lkpr.js');
const { onFinal } = await import('../js/flight-profile.js');
const { lkprLights, lkprRunways, runwayLights, runwayFrame, lightColour, COLOUR, isDynamic } = P;

const tileOf = (n) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${n}.json`, import.meta.url), 'utf8'));
const tile = tileOf('-23_-2');
const all = lkprLights(LKPR_PLAN, tile.roads).lights;
const [MAIN, CROSS] = lkprRunways(LKPR_PLAN);
const main = runwayLights(MAIN), cross = runwayLights(CROSS);
const F = runwayFrame(MAIN.line);   // s from 06's threshold toward 24's, e to the right of that
const X = runwayFrame(CROSS.line);  // s from 12's threshold toward 30's
const loc = (F2, l) => {
  const g = F2.seg[0], dx = l.x - g.x0, dz = l.z - g.z0;
  return { s: dx * g.ux + dz * g.uz, e: -dx * g.uz + dz * g.ux };
};
const segDist = (x, z, [a, b]) => {
  const ex = b[0] - a[0], ez = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
};
const of = (ls, kind) => ls.filter((l) => l.kind === kind);
const colour = (l, eye, ly = 0) => lightColour(l, eye[0], eye[1], eye[2], ly, 0, [0, 0, 0]);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// eyes: on final for 24 (3 km out, 200 m up), on final for 06, on the runway's middle
const p24 = F.at(F.L + 3000), from24 = [p24.x, 200, p24.z];
const p06 = F.at(-3000), from06 = [p06.x, 200, p06.z];
const pMid = F.at(F.L / 2), onRunway = [pMid.x, 3, pMid.z];

test('LKPR 06/24: the tile\'s runway, edge lights every 60 m, yellow the last 600 m, centreline every 15 m', () => {
  assert.ok(near(F.L, 3715, 10), 'length ' + F.L.toFixed(0));
  const edge = of(main, 'edge');
  // every 60 m down both sides, but for the one or two where 12/30 crosses
  assert.ok(edge.length <= 2 * (Math.ceil(F.L / 60) + 1) && edge.length >= 2 * (Math.ceil(F.L / 60) + 1) - 4);
  for (const l of edge) assert.ok(near(Math.abs(loc(F, l).e), 22.5 + 1.5, 0.01));
  // from 24's approach: the yellow ones are the last 600 m of the roll, at 06's end
  const yellow = edge.filter((l) => same(colour(l, from24), COLOUR.yellow));
  assert.equal(yellow.length, 2 * 11);
  assert.ok(yellow.every((l) => loc(F, l).s < 600));
  const centre = of(main, 'centre');
  assert.equal(centre.length, Math.floor((F.L - 7.5) / 15) + 1);
  const red = centre.filter((l) => same(colour(l, from24), COLOUR.red)).map((l) => loc(F, l).s);
  assert.ok(red.every((s) => s < 900), 'red only in the last 900 m of the roll from 24');
  assert.ok(centre.filter((l) => loc(F, l).s < 300).every((l) => same(colour(l, from24), COLOUR.red)));
  assert.equal(of(cross, 'centre').length, 0, '12/30 has no centreline');
});

test('LKPR 24: CAT II/III 900 m with red side rows, flashers from 300 m out, TDZ 900 m and green wing bars', () => {
  const app = of(main, 'approach').map((l) => ({ l, ...loc(F, l) }));
  const off24 = app.filter((a) => a.s > F.L), off06 = app.filter((a) => a.s < 0);
  assert.equal(off24.length + off06.length, app.length);
  assert.ok(off24.every((a) => a.s - F.L <= 900.01) && off24.some((a) => a.s - F.L > 870));
  assert.ok(off06.every((a) => -a.s <= 480.01) && off06.some((a) => -a.s > 450));
  // the side rows: red barrettes 30 to 270 m out, either side in line with the TDZ
  const red = off24.filter((a) => same(a.l.c, COLOUR.alsRed));
  assert.equal(red.length, 9 * 2 * 3);
  for (const a of red) assert.ok(a.s - F.L >= 29.9 && a.s - F.L <= 270.1 && Math.abs(a.e) >= 8.99 && Math.abs(a.e) <= 12.01);
  assert.equal(off06.filter((a) => same(a.l.c, COLOUR.alsRed)).length, 0, '06 is CAT I');
  // inside 270 m the white crossbars stop short of the red rows
  for (const a of off24.filter((a) => a.s - F.L < 270 && same(a.l.c, COLOUR.approach))) assert.ok(Math.abs(a.e) <= 7.51);
  const fl = of(main, 'flash').map((l) => loc(F, l).s);
  assert.equal(fl.filter((s) => s > F.L).length, 21, '300 to 900 m every 30 m');
  assert.equal(fl.filter((s) => s < 0).length, 7, '06: 300 to 480 m');
  // TDZ: pairs of white barrettes 60 to 900 m in from 24's threshold, dark from the other way
  const tdz = of(main, 'tdz');
  assert.equal(tdz.length, 29 * 2 * 3);
  for (const l of tdz) {
    const q = loc(F, l);
    assert.ok(F.L - q.s >= 59.9 && F.L - q.s <= 900.1 && Math.abs(q.e) >= 8.99 && Math.abs(q.e) <= 12.01);
    assert.ok(same(colour(l, from24), COLOUR.white) && same(colour(l, from06), COLOUR.off));
  }
  // wing bars: green out past the edge lights at 24 only, unseen from the runway
  const wb = of(main, 'wingbar');
  assert.equal(wb.length, 2 * 5);
  for (const l of wb) {
    const q = loc(F, l);
    assert.ok(q.s > F.L && Math.abs(q.e) > 24 && Math.abs(q.e) <= 36.51);
    assert.ok(same(colour(l, from24), COLOUR.green) && same(colour(l, onRunway), COLOUR.off));
  }
});

test('LKPR 12/30: it crosses 06/24 past 12\'s threshold, no edge light on the other\'s paving, a 900 m CAT I and wing bars on 30', () => {
  assert.ok(near(X.L, 3250, 10), 'length ' + X.L.toFixed(0));
  // as at the real field: 12's threshold just north of 06/24, the runway crossing it to the south-east
  const t12 = loc(F, { x: CROSS.line[0][0], z: CROSS.line[0][1] }), t30 = loc(F, { x: CROSS.line[1][0], z: CROSS.line[1][1] });
  assert.ok(t12.e < -22.5 && t30.e > 22.5, 'the two runways cross');
  for (const l of of(main, 'edge')) assert.ok(segDist(l.x, l.z, CROSS.line) >= 22.5 + 1);
  for (const l of of(cross, 'edge')) assert.ok(segDist(l.x, l.z, MAIN.line) >= 22.5 + 1);
  assert.ok(of(main, 'edge').length < 2 * (Math.ceil(F.L / 60) + 1) || of(cross, 'edge').length < 2 * (Math.ceil(X.L / 60) + 1), 'some left out where they cross');
  assert.equal(of(cross, 'tdz').length, 0);
  const app = of(cross, 'approach').map((l) => ({ l, ...loc(X, l) }));
  const off12 = app.filter((a) => a.s < 0), off30 = app.filter((a) => a.s > X.L);
  assert.ok(off12.length > 10 && off12.every((a) => -a.s <= 420.01));
  for (const a of off12) assert.ok(segDist(a.l.x, a.l.z, MAIN.line) >= 22.5 + 3, 'none on 06/24');
  assert.ok(off30.every((a) => a.s - X.L <= 900.01) && off30.some((a) => a.s - X.L > 870));
  assert.equal(of(cross, 'flash').length, 21);
  const wb = of(cross, 'wingbar');
  assert.equal(wb.length, 10);
  assert.ok(wb.every((l) => loc(X, l).s > X.L), 'at 30, none at 12');
});

test('LKPR PAPI: left of every landing direction, two white over two red on the airliner\'s 3 degree path to 24', () => {
  assert.equal(of(all, 'papi').length, 16);
  const p24s = of(main, 'papi').filter((l) => loc(F, l).s > F.L / 2);
  assert.equal(p24s.length, 4);
  for (const l of p24s) {
    const q = loc(F, l);
    assert.ok(near(F.L - q.s, 300, 0.5));
    // flown west-south-west, left is south: the boxes stand south of the centreline
    assert.ok(l.z > F.at(q.s).z + 30);
  }
  const rw = { ...prague().land, y: 0 };
  const show = (dist) => {
    const m = onFinal(rw, dist);
    return [...p24s].sort((a, b) => Math.abs(loc(F, a).e) - Math.abs(loc(F, b).e))
      .map((l) => (colour(l, [m.x, m.y, m.z], 0.6)[1] > 0.7 ? 'W' : 'R')).join('');
  };
  assert.equal(show(3000), 'RRWW');
  assert.equal(show(8000), 'RRWW');
});

test('LKPR taxiways: green centrelines from the tile, never on a runway, one light where ways meet', () => {
  const tl = of(all, 'taxiline');
  assert.ok(tl.length > 1500, 'count ' + tl.length);
  for (const l of tl) {
    assert.ok(same(l.c, COLOUR.taxiGreen) && !isDynamic(l));
    assert.ok(segDist(l.x, l.z, MAIN.line) > 22.5 + 3.99 && segDist(l.x, l.z, CROSS.line) > 22.5 + 3.99);
  }
  for (let i = 0; i < tl.length; i++) for (let j = i + 1; j < tl.length; j++) {
    assert.ok(Math.hypot(tl[i].x - tl[j].x, tl[i].z - tl[j].z) >= 4, 'two lights within 4 m');
  }
  // the longest straight piece of taxiway: lit at most 30 m apart down its middle
  let best = null;
  for (const r of tile.roads.filter((r) => r.t === 'taxiway')) {
    for (let i = 1; i < r.p.length; i++) {
      const l = Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
      if (!best || l > best.l) best = { a: r.p[i - 1], b: r.p[i], l };
    }
  }
  assert.ok(best.l > 300);
  const ux = (best.b[0] - best.a[0]) / best.l, uz = (best.b[1] - best.a[1]) / best.l;
  const along = tl.filter((l) => segDist(l.x, l.z, [best.a, best.b]) < 0.5)
    .map((l) => (l.x - best.a[0]) * ux + (l.z - best.a[1]) * uz).sort((p, q) => p - q);
  assert.ok(along.length > best.l / 31);
  for (let i = 1; i < along.length; i++) assert.ok(along[i] - along[i - 1] <= 30.5 || along[i] - along[i - 1] > 60, 'gap ' + (along[i] - along[i - 1]).toFixed(1));
});

test('LKPR in the mesh: the same data the same lights, within 6144 with the next tile, the runways before the tile streams in', () => {
  assert.deepEqual(lkprLights(LKPR_PLAN, tile.roads).lights, all);
  const c = LKPR_PLAN.runway, mid = { x: (c.threshold.x + c.far.x) / 2, z: (c.threshold.z + c.far.z) / 2 };
  const roads = [...tile.roads, ...tileOf('-22_-2').roads, ...tileOf('-22_-3').roads]
    .filter((r) => r.p?.[0] && Math.hypot(r.p[0][0] - mid.x, r.p[0][1] - mid.z) < 4000);
  const more = lkprLights(LKPR_PLAN, roads).lights;
  assert.ok(more.length > all.length && more.length < 6144, 'count ' + more.length);
  const bare = lkprLights(LKPR_PLAN, []).lights;
  assert.equal(of(bare, 'taxiline').length, 0);
  assert.equal(bare.length, main.length + cross.length);
});
