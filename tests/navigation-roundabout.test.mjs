// ---- roundabouts you can actually leave, and a line that stays in front ----
// Two defects that only showed up on the real region, reproduced here on
// geometry small enough to read.
//
// The first is a data defect the router has to survive: the exit slip roads of
// oneway roundabouts are laid down a metre or two off the ring they leave,
// while the entry slips land exactly on it. keyOf welds at 10 cm, so the exits
// were never attached — measured over the whole region, 175 of 613 oneway
// roundabouts had entries and no exit at all, and crossing one cost 14 993 m
// and eighteen minutes where the straight line was 87 m.
//
// The second is a tracking defect. A route that drives the same tarmac twice
// leaves the car equidistant from both passes, and nearest-point matching gave
// the answer to whichever pass the loop reached last: at 982 m along a real
// route the tracker reported 1512 m. The ribbon then drew the road ahead of
// somewhere half a kilometre away, which is how the line ended up behind the
// car — 96 m behind at the median, 272 m at worst.

// three.js is not an npm package here, so the resolver hook is registered
// before the modules under test are imported. See tests/three-alias.mjs.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// navline needs a canvas for its flow texture and nothing else from the DOM,
// and it wants it at import time.
globalThis.document ??= {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  }),
};

const { Navigation } = await import('../js/navigation.js');
const { NavLine } = await import('../js/navline.js');

// ---- a oneway roundabout with the real defect in it ----------------------
const N = 16, R = 12;
const RING = [];
for (let i = 0; i <= N; i++) {
  const t = (i % N) / N * Math.PI * 2;
  RING.push([+(R * Math.cos(t)).toFixed(3), +(R * Math.sin(t)).toFixed(3)]);
}
// a point `d` metres further out than ring vertex i, along the same radius
const out = (i, d) => {
  const p = RING[i], L = Math.hypot(p[0], p[1]) || 1;
  return [+(p[0] * (1 + d / L)).toFixed(3), +(p[1] * (1 + d / L)).toFixed(3)];
};

// `slip` is the gap the exit is laid down with — 0 is a healthy junction, and
// anything up to a couple of metres is what the region's data actually has.
function roundabout(slip, { weld = true } = {}) {
  const roads = [
    { d: 1, ow: 1, t: 'secondary', v: 30, n: 'kruhák', p: RING.map(q => [q[0], q[1]]) },
    { d: 1, ow: 1, t: 'secondary', v: 50, n: 'příjezd', p: [out(12, 400), RING[12].slice()] },
    { d: 1, ow: 1, t: 'secondary', v: 50, n: 'odjezd', p: [out(4, slip), out(4, 400)] },
  ];
  const listeners = [];
  const city = { roads: [], onTileLoaded: (cb) => listeners.push(cb) };
  const nav = new Navigation(city);
  if (!weld) nav._weldBatch = () => { nav._touched.clear(); };
  for (const r of roads) city.roads.push(r);
  for (const cb of listeners) cb({ roads });
  return nav;
}

// far enough out that the ring itself is not a rival destination candidate —
// otherwise the router legitimately "arrives" on the ring near the pin and the
// test would pass without the exit ever being connected
const FROM = out(12, 350), TO = out(4, 350);

test('an exit slip laid a metre off the ring still leaves the roundabout', () => {
  const nav = roundabout(1.5);
  nav.setDestination(TO[0], TO[1]);
  assert.ok(nav.reroute(FROM[0], FROM[1]), 'a route exists');
  assert.equal(nav.partial, false, 'and it reaches the pin');
  // in, round, out: longer than the straight line, nothing like a tour
  const straight = Math.hypot(FROM[0] - TO[0], FROM[1] - TO[1]);
  assert.ok(nav.remainingM < straight * 2,
    `route ${Math.round(nav.remainingM)} m for ${Math.round(straight)} m straight`);
});

test('…and unwelded it does not: the defect is real, not theoretical', () => {
  const nav = roundabout(1.5, { weld: false });
  nav.setDestination(TO[0], TO[1]);
  nav.reroute(FROM[0], FROM[1]);
  assert.equal(nav.partial, true, 'with no weld the exit cannot be reached at all');
});

test('a gap far wider than a lane is left alone', () => {
  // 6 m is not a survey error, it is a different road. Welding there would
  // drive the player across whatever lies between.
  const nav = roundabout(6);
  nav.setDestination(TO[0], TO[1]);
  nav.reroute(FROM[0], FROM[1]);
  assert.equal(nav.partial, true, 'the weld does not reach across a real gap');
});

test('an ordinary two-way dead end is never welded to a passing road', () => {
  // a cul-de-sac whose tip stops one metre short of a through road. Both its
  // directions exist, so it is not directionally dead and must not be a
  // candidate — otherwise every close-parked lane becomes a rat run.
  const listeners = [];
  const city = { roads: [], onTileLoaded: (cb) => listeners.push(cb) };
  const nav = new Navigation(city);
  const roads = [
    { d: 1, t: 'residential', v: 50, n: 'průtah', p: [[0, 0], [200, 0]] },
    { d: 1, t: 'service', v: 30, n: 'slepá', p: [[100, -60], [100, -1]] },
  ];
  for (const r of roads) city.roads.push(r);
  for (const cb of listeners) cb({ roads });
  // two roads in, two roads out — nothing was cut, nothing was joined
  assert.equal(nav._segs.filter(s => !s.dead).length, 2, 'the graph is untouched');
});

// ---- the line only ever lies in front of the car -------------------------

test('a route that doubles back never draws itself behind the car', () => {
  // out along a street and straight back down it, 6 m apart — close enough
  // that nearest-point matching cannot tell the passes apart on position
  const route = [];
  for (let x = 0; x <= 600; x += 10) route.push([x, 0]);
  for (let x = 600; x >= 0; x -= 10) route.push([x, 6]);
  const nl = new NavLine(null);
  nl.set(route);
  nl.setVisible(true);

  let worstBehind = 0, worstJump = 0;
  // creep along the OUTBOUND leg; the returning leg is the trap
  for (let x = 5; x <= 590; x += 5) {
    nl.update(0.016, x, 0, null);
    worstJump = Math.max(worstJump, Math.abs(nl._s - x));
    for (let k = 0; k < nl._m; k++) {
      if (nl._col[k * 8 + 3] <= 0.02) continue;      // not lit
      // travel is +x here, so anything with a smaller x is behind the car
      const behind = x - nl._spx[k];
      if (behind > worstBehind) worstBehind = behind;
    }
  }
  assert.ok(worstJump < 25, `tracker drifted ${worstJump.toFixed(0)} m from the car`);
  // NEAR_KEEP metres of route are deliberately never cut, whatever their
  // bearing, so that the ring of a roundabout stays legible while you are going
  // round it. Right at the U-turn that exemption is what shows: about half of
  // it can lie behind you. Everything past it — the 96 m median and the 272 m
  // worst measured on real routes before the fix — is gone.
  assert.ok(worstBehind < 25, `${worstBehind.toFixed(0)} m of line was drawn behind the car`);
});

test('the ribbon starts at the car, not at the window it was cut from', () => {
  // the window is only re-cut every REBUILD metres; between cuts the alphas
  // have to walk forward on their own, or the car drives past its own line
  const route = [];
  for (let x = 0; x <= 1000; x += 10) route.push([x, 0]);
  const nl = new NavLine(null);
  nl.set(route);
  nl.setVisible(true);
  let worstBehind = 0;
  for (let x = 5; x <= 500; x += 1) {
    nl.update(0.016, x, 0, null);
    for (let k = 0; k < nl._m; k++) {
      if (nl._col[k * 8 + 3] <= 0.02) continue;
      if (x - nl._spx[k] > worstBehind) worstBehind = x - nl._spx[k];
    }
  }
  assert.ok(worstBehind <= 0.01, `${worstBehind.toFixed(1)} m of line behind the car`);
});
