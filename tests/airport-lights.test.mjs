// The lights of the two airports (js/airport-lights-plan.js): where they stand
// and what colour each shows from where. The numbers are the ones a pilot
// reads off a chart: edge lights 60 m apart and yellow for the last 600 m,
// green thresholds that are red from the runway, the approach lights on the
// landing side, four PAPI boxes showing two white over two red on a 3 degree
// path, blue taxiway edges that never stand on a runway.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const P = await import('../js/airport-lights-plan.js');
const PLAN = await import('../js/airport-plan.js');
const { REGIONS } = await import('../js/regions.js');
const { lkpdLights, sezLights, runwayLights, runwayFrame, taxiLights, lightColour, isDynamic, COLOUR } = P;

const lkpd = lkpdLights(PLAN).lights;
const tile = JSON.parse(readFileSync(new URL('../public/data/regions/mahe/tiles/1_-20.json', import.meta.url), 'utf8'));
const sezDesc = REGIONS.mahe.airport;
const sez = sezLights(sezDesc, tile.roads).lights;
const of = (ls, kind) => ls.filter((l) => l.kind === kind);
const R = PLAN.RUNWAY;
const F = runwayFrame([R.a, R.mid, R.b]);
// a light in the runway's frame: s along from 09's threshold, e to the right (south of the line flown east)
const local = (F2, l) => {
  let best = null;
  F2.seg.forEach((g, k) => {
    const t = (l.x - g.x0) * g.ux + (l.z - g.z0) * g.uz, e = -(l.x - g.x0) * g.uz + (l.z - g.z0) * g.ux;
    const tc = Math.max(k === 0 ? -Infinity : 0, Math.min(k === F2.seg.length - 1 ? Infinity : g.l, t));
    const d = Math.hypot(t - tc, e);
    if (!best || d < best.d) best = { s: g.s0 + tc, e, d, inside: g.s0 + tc >= 0 && g.s0 + tc <= F2.L };
  });
  return best;
};
const colour = (l, eye, ly = 0, t = 0) => lightColour(l, eye[0], eye[1], eye[2], ly, t, [0, 0, 0]);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('LKPD: edge lights down both sides every 60 m at most, a light at each threshold', () => {
  const edge = of(lkpd, 'edge');
  assert.equal(edge.length, 2 * (Math.ceil(F.L / 60) + 1));
  for (const side of [-1, 1]) {
    const s = edge.map((l) => local(F, l)).filter((q) => Math.sign(q.e) === side).map((q) => q.s).sort((p, q) => p - q);
    assert.ok(near(s[0], 0, 0.5) && near(s[s.length - 1], F.L, 0.5), 'from threshold to threshold');
    for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] <= 60 && s[i] - s[i - 1] > 55, 'spacing ' + (s[i] - s[i - 1]).toFixed(1));
  }
  for (const l of edge) assert.ok(near(Math.abs(local(F, l).e), R.width / 2 + 1.5, 0.3), 'just outside the 75 m paving');
});

test('LKPD: the last 600 m are yellow toward the end they warn of, white from the other way', () => {
  const edge = of(lkpd, 'edge');
  // on final for 27, east of its threshold: the far (west) end is the one rolled toward
  const eye27 = [R.b[0] + 3000, 400, R.b[1] + 150];
  const atS = (s) => edge.filter((l) => near(local(F, l).s, s, 31));
  for (const l of atS(300)) assert.ok(same(colour(l, eye27), COLOUR.yellow), 'near 09 threshold, seen from 27: yellow');
  for (const l of atS(F.L - 300)) assert.ok(same(colour(l, eye27), COLOUR.white), 'near 27 threshold, seen from 27: white');
  for (const l of atS(F.L / 2)) assert.ok(same(colour(l, eye27), COLOUR.white), 'the middle is white');
  // lined up on 09 the other way round
  const eye09 = [R.a[0] - 50, 230, R.a[1]];
  for (const l of atS(F.L - 300)) assert.ok(same(colour(l, eye09), COLOUR.yellow));
  for (const l of atS(300)) assert.ok(same(colour(l, eye09), COLOUR.white));
  const yellow = edge.filter((l) => same(colour(l, eye27), COLOUR.yellow));
  assert.equal(yellow.length, 2 * 11, 'eleven a side in the 600 m (one every 59.5 m, the end one too)');
});

test('LKPD: the thresholds are rows of green across the full width, red from the runway', () => {
  const rows = of(lkpd, 'threshold');
  assert.equal(rows.length, 2 * 26);
  const eye27 = [R.b[0] + 3000, 400, R.b[1] + 150];
  const at27 = rows.filter((l) => local(F, l).s > F.L), at09 = rows.filter((l) => local(F, l).s < 0);
  assert.equal(at27.length, 26);
  for (const l of at27) assert.ok(same(colour(l, eye27), COLOUR.green), 'the landing threshold is green');
  for (const l of at09) assert.ok(same(colour(l, eye27), COLOUR.red), 'the far end is red');
  const e = at27.map((l) => local(F, l).e).sort((p, q) => p - q);
  assert.ok(near(e[0], -37.5, 0.3) && near(e[e.length - 1], 37.5, 0.3));
  for (let i = 1; i < e.length; i++) assert.ok(e[i] - e[i - 1] <= 3.01);
  assert.equal(of(lkpd, 'centre').length, 0, 'LKPD has no centreline lights (eAIP: RCLL NIL)');
});

test('LKPD: the approach lights are on the landing side, 794.5 m of them with crossbars and a rabbit on 27', () => {
  const app = [...of(lkpd, 'approach'), ...of(lkpd, 'flash')].map((l) => ({ l, q: local(F, l) }));
  const off27 = app.filter(({ q }) => q.s > F.L), off09 = app.filter(({ q }) => q.s < 0);
  assert.equal(off27.length + off09.length, app.length, 'none on the runway');
  const out27 = off27.map(({ q }) => q.s - F.L);
  assert.ok(Math.max(...out27) <= 794.5 && Math.max(...out27) > 760, '27: PALS CAT I to ' + Math.max(...out27).toFixed(0) + ' m');
  assert.ok(Math.max(...off09.map(({ q }) => -q.s)) <= 420.01, '09: SALS 420 m');
  // the centreline barrettes stay within 2 m of the extended centreline; the crossbars reach out
  for (const d of [150, 300, 450, 600, 750]) {
    const bar = off27.filter(({ q }) => near(q.s - F.L, d, 0.5));
    const half = Math.max(...bar.map(({ q }) => Math.abs(q.e)));
    assert.ok(near(half, 15 * (d + 300) / 600, 0.01), 'crossbar at ' + d + ' m reaches ' + half.toFixed(1));
  }
  const wide = off27.filter(({ q }) => ![150, 300, 450, 600, 750].some((d) => near(q.s - F.L, d, 0.5)));
  for (const { q } of wide) assert.ok(Math.abs(q.e) <= 2.01);
  // they face the approach only: from the runway they are dark
  const onRunway = [R.a[0] + 300, 228, R.a[1] + 14];
  for (const { l } of off27) assert.ok(same(colour(l, onRunway), COLOUR.off));
  // the flashers run from the outermost toward the threshold
  const fl = of(lkpd, 'flash').sort((p, q) => p.flash - q.flash);
  assert.equal(fl.length, 17, 'one at every barrette from 300 m out');
  for (let i = 1; i < fl.length; i++) assert.ok(local(F, fl[i]).s < local(F, fl[i - 1]).s, 'each one nearer the threshold');
  assert.equal(of(lkpd, 'flash').filter((l) => local(F, l).s < 0).length, 0, 'none on 09');
});

test('the rabbit: one flash at a time, sweeping in, twice a second', () => {
  const fl = of(lkpd, 'flash').sort((p, q) => p.flash - q.flash);
  const eye = [R.b[0] + 3000, 400, R.b[1] + 150];
  const brightest = (t) => fl.reduce((b, l, i) => (colour(l, eye, 0, t)[0] > colour(fl[b], eye, 0, t)[0] ? i : b), 0);
  const order = [0.02, 0.1, 0.2, 0.3].map((t) => brightest(t));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'the sweep moves in: ' + order.join(','));
  assert.equal(brightest(0.52), brightest(0.02), 'and starts again half a second later');
  const lit = fl.filter((l) => colour(l, eye, 0, 0.2)[0] > 0.5).length;
  assert.ok(lit >= 1 && lit <= 3, lit + ' lit at once');
});

test('PAPI: four boxes left of the touchdown zone, two white over two red on the glide path', () => {
  const papi = of(lkpd, 'papi');
  assert.equal(papi.length, 8, 'four for each end');
  const p27 = papi.filter((l) => local(F, l).s > F.L / 2).sort((p, q) => Math.abs(local(F, p).e) - Math.abs(local(F, q).e));
  for (const l of p27) {
    const q = local(F, l);
    assert.ok(near(q.s, F.L - 300, 0.5), 'abeam the aiming point, 300 m in');
    assert.ok(q.e > 0, 'south of the line, which is left landing west');
  }
  assert.ok(near(local(F, p27[0]).e, 37.5 + 15, 0.01) && near(local(F, p27[3]).e - local(F, p27[0]).e, 27, 0.01));
  const box = p27[0], ly = 223;
  const eyeAt = (deg, d = 5000) => {
    const g = F.at(F.L - 300 + d);
    return [g.x, ly + Math.tan(deg * Math.PI / 180) * d, g.z];
  };
  const show = (deg) => p27.map((l) => (colour(l, eyeAt(deg), ly)[1] > 0.7 ? 'W' : 'R')).join('');
  assert.equal(show(3), 'RRWW', 'on the path: the two nearest the runway red');
  assert.equal(show(4.2), 'WWWW', 'high');
  assert.equal(show(3.3), 'RWWW', 'slightly high');
  assert.equal(show(2.7), 'RRRW', 'slightly low');
  assert.equal(show(1.5), 'RRRR', 'low');
  assert.ok(same(colour(box, [R.a[0], 300, R.a[1]], ly), COLOUR.off), 'from behind: nothing');
  const p09 = papi.filter((l) => local(F, l).s < F.L / 2);
  for (const l of p09) assert.ok(near(local(F, l).s, 300, 0.5) && local(F, l).e < 0, '09: north of the line, left landing east');
});

test('taxiway edges: blue, 60 m apart on the straight and close in the turns, never on the runway or another taxiway', () => {
  for (const [name, lights, ways, hw] of [
    ['LKPD', lkpd, [{ p: PLAN.TAXI_OUT.slice(9), w: 23 }, { p: PLAN.TAXI_IN.slice(0, 16), w: 23 }], 37.5],
    ['SEZ', sez, tile.roads.filter((r) => r.t === 'taxiway' && r.w >= 15), 23],
  ]) {
    const taxi = of(lights, 'taxi');
    assert.ok(taxi.length > 150, name + ': ' + taxi.length + ' taxiway lights');
    const line = name === 'LKPD' ? [R.a, R.mid, R.b] : [[sezDesc.runway.ends['13'].x, sezDesc.runway.ends['13'].z], [sezDesc.runway.ends['31'].x, sezDesc.runway.ends['31'].z]];
    const F2 = runwayFrame(line);
    for (const l of taxi) {
      assert.ok(same(l.c, COLOUR.blue) && !isDynamic(l));
      const q = local(F2, l);
      if (q.inside) assert.ok(Math.abs(q.e) >= hw + 4 - 1e-6, name + ': a taxiway light on the runway at ' + l.x.toFixed(0) + ',' + l.z.toFixed(0));
      for (const w of ways) {
        for (let i = 1; i < w.p.length; i++) {
          const [ax, az] = w.p[i - 1], [bx, bz] = w.p[i], L2 = (bx - ax) ** 2 + (bz - az) ** 2;
          const t = Math.max(0, Math.min(1, ((l.x - ax) * (bx - ax) + (l.z - az) * (bz - az)) / L2));
          assert.ok(Math.hypot(l.x - ax - (bx - ax) * t, l.z - az - (bz - az) * t) >= w.w / 2 - 1 - 1e-6, name + ': on a taxiway');
        }
      }
      const nn = taxi.reduce((b, o) => (o === l ? b : Math.min(b, Math.hypot(o.x - l.x, o.z - l.z))), Infinity);
      assert.ok(nn >= 4 - 1e-6, name + ': two lights in one place');
      assert.ok(nn <= 60.5, name + ': a gap of ' + nn.toFixed(0) + ' m');
    }
  }
  // the fillet from the parallel taxiway into the link to 09 is a curve: lights a few metres apart along it
  const bend = of(lkpd, 'taxi').filter((l) => Math.hypot(l.x + 2470, l.z - 1732) < 30);
  assert.ok(bend.length >= 4, bend.length + ' in the bend');
  for (const l of bend) {
    const nn = bend.reduce((b, o) => (o === l ? b : Math.min(b, Math.hypot(o.x - l.x, o.z - l.z))), Infinity);
    assert.ok(nn <= 8, 'in a turn ' + nn.toFixed(1) + ' m apart');
  }
});

test('SEZ: the runway from the region, approach lights off 13 over the sea, none off 31', () => {
  const e = sezDesc.runway.ends, F2 = runwayFrame([[e['13'].x, e['13'].z], [e['31'].x, e['31'].z]]);
  assert.ok(near(F2.L, 2986, 3));
  const edge = of(sez, 'edge');
  assert.equal(edge.length, 2 * (Math.ceil(F2.L / 60) + 1));
  for (const l of edge) assert.ok(near(Math.abs(local(F2, l).e), 23 + 1.5, 0.01));
  const app = of(sez, 'approach').map((l) => local(F2, l).s);
  assert.ok(app.every((s) => s < 0 && s >= -600.01), 'all off 13, 600 m at most');
  assert.equal(of(sez, 'flash').length, 0);
  // on final for 13 from over Victoria: the 13 threshold green, PAPI left (north-east of the line)
  const sp = REGIONS.mahe.spawns['sez-arrival'], eye = [sp.x, sp.y, sp.z];
  for (const l of of(sez, 'threshold').filter((l) => local(F2, l).s < 0)) assert.ok(same(colour(l, eye), COLOUR.green));
  for (const l of of(sez, 'threshold').filter((l) => local(F2, l).s > F2.L)) assert.ok(same(colour(l, eye), COLOUR.red));
  const p13 = of(sez, 'papi').filter((l) => local(F2, l).s < F2.L / 2);
  assert.equal(p13.length, 4);
  for (const l of p13) assert.ok(local(F2, l).e < 0 && near(local(F2, l).s, 300, 0.5));
  const show = p13.sort((p, q) => Math.abs(local(F2, p).e) - Math.abs(local(F2, q).e))
    .map((l) => (colour(l, eye, 4.4)[1] > 0.7 ? 'W' : 'R')).join('');
  assert.equal(show, 'RRWW', 'the spawn on final is on the 3 degree path');
});

test('centreline lights, where a runway has them: white, then red and white from 900 m, red for the last 300', () => {
  const ls = runwayLights({ line: [[0, 0], [3000, 0]], width: 45, centre: true }).filter((l) => l.kind === 'centre');
  assert.equal(ls.length, 200, 'every 15 m');
  const fromA = [-5000, 300, 0], fromB = [8000, 300, 0];
  const at = (x) => ls.find((l) => near(l.x, x, 7.5));
  assert.ok(same(colour(at(2800), fromA), COLOUR.red) && same(colour(at(2800), fromB), COLOUR.white));
  assert.ok(same(colour(at(200), fromB), COLOUR.red) && same(colour(at(200), fromA), COLOUR.white));
  assert.ok(same(colour(at(1500), fromA), COLOUR.white) && same(colour(at(1500), fromB), COLOUR.white));
  const mixed = ls.filter((l) => l.x > 2100 && l.x < 2700).map((l) => (same(colour(l, fromA), COLOUR.red) ? 'R' : 'W')).join('');
  assert.ok(/^(RW)+R?$|^(WR)+W?$/.test(mixed), 'alternating: ' + mixed);
});

test('the same data gives the same lights (co-op: nothing on the wire)', () => {
  assert.deepEqual(lkpdLights(PLAN).lights, lkpd);
  assert.deepEqual(sezLights(sezDesc, tile.roads).lights, sez);
  assert.ok(lkpd.length < 4096 && sez.length < 4096, 'within the mesh');
  // without the tile's taxiways (before they have streamed in) SEZ still has its runway
  const bare = sezLights(sezDesc, []).lights;
  assert.equal(of(bare, 'taxi').length, 0);
  assert.equal(of(bare, 'edge').length, of(sez, 'edge').length);
  assert.equal(taxiLights([], []).length, 0);
});
