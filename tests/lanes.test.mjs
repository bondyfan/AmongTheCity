// js/lanes.js: the lanes of a motorway, which the paint and the AI cars both
// read. What no screenshot shows:
//   · a lane that jumps sideways where OSM splits the carriageway into a
//     3-lane piece is a lane change every AI car makes at 130 km/h;
//   · a lane or a shoulder painted outside the drawn asphalt is paint on grass;
//   · an acceleration lane that tapers at the wrong end sends merging cars
//     into the verge, and one that depends on which tile arrived first is a
//     co-op split.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const L = await import('../js/lanes.js');
const { laneLayout, auxRight, auxShare, endsIndex, LANE_W, LINE_W, SHOULDER_W, MEDIAN_HALF, TAPER, AUX_MAX } = L;

const tile = (tx, tz) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${tx}_${tz}.json`, import.meta.url), 'utf8')).roads;
const K = (q) => q[0].toFixed(1) + ',' + q[1].toFixed(1);
const way = (roads, a, b) => roads.find((r) => r.t === 'motorway' && K(r.p[0]) === K(a) && K(r.p[r.p.length - 1]) === K(b));

test('every class but motorway and motorway_link has no lane layout', () => {
  for (const t of ['trunk', 'primary', 'secondary', 'residential', 'service', 'trunk_link', 'footway', undefined]) {
    assert.equal(laneLayout({ t, w: 11, ln: 2, ow: 1, p: [[0, 0], [1, 0]] }), null, String(t));
  }
  assert.equal(laneLayout(null), null);
});

test('one shared, frozen record per layout: the per-car and per-chunk callers allocate nothing', () => {
  const a = laneLayout({ t: 'motorway', w: 12.5, ln: 2, ow: 1, _paved: true });
  assert.equal(laneLayout({ t: 'motorway', w: 11, ln: 2, ow: 1 }), a, 'raw and paved are the same carriageway');
  assert.notEqual(laneLayout({ t: 'motorway', w: 11, ln: 3, ow: 1 }), a);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.centers) && Object.isFrozen(a.shoulder));
});

test('a 2-lane carriageway is the D 27.5: two 3.75 m lanes on the line, a 2.5 m shoulder, all inside the ribbon', () => {
  for (const r of [{ t: 'motorway', w: 11, ln: 2, ow: 1 }, { t: 'motorway', w: 12.5, ln: 2, ow: 1, _paved: true }]) {
    const l = laneLayout(r);
    assert.equal(l.n, 2); assert.equal(l.width, LANE_W);
    assert.deepEqual(l.centers, [-1.875, 1.875]);
    assert.deepEqual(l.dividers, [0]);
    assert.equal(l.edgeL, -3.875); assert.equal(l.edgeR, 3.875);
    assert.deepEqual(l.shoulder, { from: 3.75, to: 6.25 });
    assert.equal(l.shoulder.to - l.shoulder.from, SHOULDER_W);
    assert.equal(l.ribbonHalf, 6.25, 'the drawn ribbon is w + geo.js pave 1.5');
  }
  // the median: on the measured p50 spacing the inner edge line stands about
  // 2.25 m from a barrier at the midpoint, and the two ribbons just meet there
  const l = laneLayout({ t: 'motorway', w: 11, ln: 2, ow: 1 });
  const gap = MEDIAN_HALF - (-l.edgeL);
  assert.ok(gap > 2.2 && gap < 2.5, `inner edge line ${gap.toFixed(2)} m from the barrier`);
  assert.ok(Math.abs(l.ribbonHalf - MEDIAN_HALF) < 0.1);
});

test('the through lanes stay put on a 3-lane piece; the third lane takes the shoulder band, inside the ribbon', () => {
  const two = laneLayout({ t: 'motorway', w: 11, ln: 2, ow: 1 });
  for (const ln of [3, 4]) {
    const l = laneLayout({ t: 'motorway', w: 11, ln, ow: 1 });
    assert.equal(l.n, 3);
    assert.deepEqual(l.centers.slice(0, 2), two.centers, 'a lane jumps where the way gains a lane');
    assert.equal(l.edgeL, two.edgeL);
    assert.equal(l.dividers[1], two.edgeR, 'the old edge line becomes the divider');
    assert.equal(l.shoulder, null);
    assert.ok(l.centers[2] + l.widths[2] / 2 <= l.ribbonHalf, 'the third lane runs off the asphalt');
    assert.ok(l.widths[2] > 2.2, `third lane ${l.widths[2]} m`);
  }
});

test('every lane of every layout lies on the drawn asphalt, left to right, without overlap', () => {
  const cases = [];
  for (const t of ['motorway', 'motorway_link']) for (const ln of [undefined, 1, 2, 3, 4]) for (const ow of [1, 0]) cases.push({ t, w: t === 'motorway' ? 11 : 5.5, ln, ow });
  for (const r of cases) {
    const l = laneLayout(r);
    assert.equal(l.centers.length, l.n); assert.equal(l.widths.length, l.n); assert.equal(l.dividers.length, l.n - 1);
    for (let k = 0; k < l.n; k++) {
      const a = l.centers[k] - l.widths[k] / 2, b = l.centers[k] + l.widths[k] / 2;
      assert.ok(a >= -l.ribbonHalf - 1e-9 && b <= l.ribbonHalf + 1e-9, JSON.stringify(r));
      if (k) assert.ok(Math.abs(a - l.dividers[k - 1]) < 0.2, 'a divider is not between its lanes');
    }
    assert.ok(l.edgeL < l.centers[0] && l.edgeR > l.centers[l.n - 1]);
    assert.ok(Math.abs(l.edgeL) <= l.ribbonHalf && Math.abs(l.edgeR) <= l.ribbonHalf);
    if (l.shoulder) assert.ok(l.shoulder.from >= l.centers[l.n - 1] && l.shoulder.to <= l.ribbonHalf + 1e-9);
  }
  // a slip road: one 3.5 m lane on its line, or two that fill it
  assert.deepEqual(laneLayout({ t: 'motorway_link', w: 5.5, ln: 1, ow: 1 }).centers, [0]);
  assert.equal(laneLayout({ t: 'motorway_link', w: 5.5, ln: 2, ow: 1 }).n, 2);
});

test('a narrower carriageway narrows its lanes and edge lines onto its asphalt, and gets no 0.75 m third lane', () => {
  // the D35 by Opatovice (its Labe viaducts are w 8) and three w 6 ways far
  // east: every real motorway record of those tiles, as the tiles hold them
  const real = [...tile(0, -3), ...tile(1, -3), ...tile(24, 16)].filter((r) => r.t === 'motorway' || r.t === 'motorway_link');
  assert.ok(real.some((r) => r.t === 'motorway' && r.w === 8) && real.some((r) => r.t === 'motorway' && r.w === 6));
  for (const r of real) {
    const l = laneLayout(r);
    assert.ok(-l.edgeL + LINE_W / 2 <= l.ribbonHalf + 1e-9 && l.edgeR + LINE_W / 2 <= l.ribbonHalf + 1e-9, `an edge line off the asphalt on w ${r.w}`);
    assert.ok(Math.min(...l.widths) >= 2, `a ${Math.min(...l.widths)} m lane on w ${r.w} ln ${r.ln}`);
    if (l.shoulder) assert.ok(l.shoulder.to - l.shoulder.from >= 1);
  }
  // the w 8 three-lane piece on the viaduct: two lanes, and no auxiliary lane either
  const v = real.find((r) => r.t === 'motorway' && r.w === 8 && r.ln === 3);
  assert.equal(laneLayout(v).n, 2);
  assert.equal(auxRight(v, endsIndex(real)), null);
  // a D 27.5 is unchanged by this
  assert.deepEqual(laneLayout({ t: 'motorway', w: 6, ln: 2, ow: 1 }).centers, [-1.75, 1.75]);
  assert.equal(laneLayout({ t: 'motorway', w: 11, ln: 2, ow: 1 }).width, LANE_W);
});

test('an acceleration lane begins where its slip road ends and tapers out; a deceleration lane the other way round', () => {
  const roads = [...tile(-11, -3), ...tile(-10, -3)];
  const at = endsIndex(roads);
  // exit 35 Poděbrady-západ, eastbound (measured: the link off it starts at the end)
  const dec = auxRight(way(roads, [-49370.3, -9927], [-49136.2, -9926.2]), at);
  assert.equal(dec.kind, 'dec'); assert.equal(dec.at, 0);
  assert.ok(Math.abs(dec.run - 234) < 2, `run ${dec.run}`);
  assert.equal(auxShare(dec, 0), 0); assert.equal(auxShare(dec, TAPER), 1); assert.equal(auxShare(dec, dec.len), 1);
  // the OMV rest area pair: a slip road at both ends, a lane all along
  const wv = auxRight(way(roads, [-48868.2, -9930.2], [-48565.6, -9938.7]), at);
  assert.equal(wv.kind, 'weave'); assert.equal(auxShare(wv, 0), 1); assert.equal(auxShare(wv, wv.len), 1);
  // out of the rest area: its slip road is filed in -11_-3, the lane in -10_-3
  const acc = auxRight(way(roads, [-47945.8, -9943.6], [-47711.2, -9937.2]), at);
  assert.equal(acc.kind, 'acc');
  assert.equal(auxShare(acc, 0), 1); assert.equal(auxShare(acc, acc.len - TAPER / 2), 0.5); assert.equal(auxShare(acc, acc.len), 0);
  // …and with the slip road's tile not loaded it is the fallback, tapering at
  // both ends, never a guess at which end
  const alone = tile(-10, -3);
  const fb = auxRight(way(alone, [-47945.8, -9943.6], [-47711.2, -9937.2]), endsIndex(alone));
  assert.equal(fb.kind, 'aux');
  assert.equal(auxShare(fb, 0), 0); assert.equal(auxShare(fb, fb.len), 0); assert.equal(auxShare(fb, fb.len / 2), 1);
  // a 2-lane way has no auxiliary lane
  assert.equal(auxRight(roads.find((r) => r.t === 'motorway' && r.ln === 2 && r.ow), at), null);
});

test('a run of three 3-lane ways is ONE acceleration lane, whatever order endsAt lists them in', () => {
  const roads = [...tile(-9, -3), ...tile(-9, -2)];
  const ids = [[[-42325.3, -9662.7], [-42299.3, -9664.9]], [[-42299.3, -9664.9], [-42257.8, -9668.4]], [[-42257.8, -9668.4], [-42043.2, -9686.3]]];
  const ws = ids.map(([a, b]) => way(roads, a, b));
  const runOf = (list) => ws.map((w) => auxRight(w, endsIndex(list)));
  const a = runOf(roads), b = runOf([...roads].reverse());
  assert.deepEqual(a, b);
  for (const x of a) { assert.equal(x.kind, 'acc'); assert.ok(Math.abs(x.run - 283) < 2, `run ${x.run}`); }
  assert.deepEqual(a.map((x) => Math.round(x.at)), [0, 26, 68]);
  // full at the merge node of the first piece, nothing at the end of the last
  assert.equal(auxShare(a[0], 0), 1);
  assert.equal(auxShare(a[2], a[2].len), 0);
  assert.ok(auxShare(a[2], a[2].len - TAPER - 1) === 1);
});

test('the real third lane out of Prague is a lane, not an auxiliary one', () => {
  const roads = [...tile(-17, -2), ...tile(-17, -3), ...tile(-16, -3)];
  const at = endsIndex(roads);
  const w = way(roads, [-78253.6, -9338.3], [-77056, -9876.1]);
  assert.equal(w.ln, 3);
  assert.equal(auxRight(w, at), null, 'a 2.7 km third lane read as an acceleration lane');
  assert.ok(AUX_MAX < 1317);
});

test('lanes.js is pure: no imports, nothing that touches three or the DOM', () => {
  const src = readFileSync(new URL('../js/lanes.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'lanes.js imports something');
  assert.ok(!/\b(document|window|THREE|Math\.random|Date\.now|performance)\b/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!src.includes(String.fromCharCode(0x2014)), 'an em dash');
});
