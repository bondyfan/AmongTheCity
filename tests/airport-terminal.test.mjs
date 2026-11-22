// The passenger terminal of Pardubice airport (js/landmarks-letiste.js, js/airport-plan.js)
// checked without a browser: its frame, its doors, the walks a passenger makes, and
// the one thing that matters most in a terminal, that the only way airside is through
// the security lanes. Solids are tested as city.collide reads them: a piece stops a
// walker only when its bottom is at ground level (bot <= 0.5); a door's lintel is a
// piece with bot = H.door and is walked under.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const plan = await import('../js/airport-plan.js');
const { FRAME, H, DOORS, COUNTERS, MAHE_COUNTERS, LANES, GATES, ARRIVALS_EXIT, CAROUSEL, AREA, OSM_NAME,
  toWorld, toLocal, zoneAt, inBuilding } = plan;
const { OUTSIDE, buildLetiste, letisteSolids, gapsOf } = await import('../js/landmarks-letiste.js');
const { Kit, LandmarkSink } = await import('../js/landmarkskit.js');
const { LANDMARKS, matches, solidHas } = await import('../js/landmarks.js');

/** The solids as the walker meets them: those standing on the ground. */
const pieces = letisteSolids();
const ground = pieces.filter((p) => p.bot <= 0.5);
const blocked = (x, z) => ground.some((p) => solidHas(p, x, z));
/** Can a walker go straight from plan point a to plan point b? Sampled every 10 cm. */
function straight(a, b) {
  const A = toWorld(a[0], a[1]), B = toWorld(b[0], b[1]);
  const n = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 0.1));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (blocked(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t)) return false;
  }
  return true;
}
/** Every straight leg of a route is clear of the ground-level solids. */
function walkable(route) {
  for (let i = 0; i + 1 < route.length; i++) {
    if (!straight(route[i], route[i + 1])) return { ok: false, leg: i, from: route[i], to: route[i + 1] };
  }
  return { ok: true };
}

// ---- the frame ----------------------------------------------------------------
test('the terminal frame round-trips and turns 2.74 degrees from the grid', () => {
  for (const [u, v] of [[0, 0], [-90.9, -25.3], [68.55, 23.2], [-35.95, 7], [42, 17.4]]) {
    const w = toWorld(u, v), l = toLocal(w.x, w.z);
    assert.ok(Math.abs(l.u - u) < 1e-6 && Math.abs(l.v - v) < 1e-6, `(${u}, ${v}) comes back as (${l.u}, ${l.v})`);
  }
  // one metre of u moves the world by (cos θ, sin θ): u is the building's east
  const a = toWorld(0, 0), b = toWorld(1, 0);
  assert.ok(Math.abs((b.x - a.x) - Math.cos(FRAME.theta)) < 1e-9);
  assert.ok(Math.abs((b.z - a.z) - Math.sin(FRAME.theta)) < 1e-9);
});

// ---- the footprint ------------------------------------------------------------
test('the landmark matches exactly one footprint in the shipped tile, the terminal', () => {
  const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/-1_0.json', import.meta.url), 'utf8'));
  const entry = LANDMARKS.find((l) => l.id === 'letiste-terminal');
  assert.ok(entry, 'letiste-terminal is registered in LANDMARKS');
  assert.ok(OSM_NAME.includes(entry.name), 'the registered name is part of the OSM name');
  const hits = tile.buildings.filter((f) => matches(entry, f));
  assert.equal(hits.length, 1, `${hits.length} footprints match the terminal`);
  assert.equal(hits[0].n, OSM_NAME);
  // the plan's frame covers that ring. Two corners of the OSM outline stand 0.9 m
  // south of the hall's glazing line (v 24.1 against the plan's 23.2, at u 33.4 to
  // 34.7 and -35.99 to -34.7): small masonry bumps the plan leaves out, so the
  // tolerance is one metre, and nothing else in the ring strays further
  for (const [x, z] of hits[0].o) {
    const { u, v } = toLocal(x, z);
    assert.ok(inBuilding(u, v, 1.0), `corner (${u.toFixed(1)}, ${v.toFixed(1)}) lies outside the plan`);
  }
  assert.ok(AREA === 6022, 'the plan carries the footprint area');
});

// ---- the doors ----------------------------------------------------------------
test('every door is a hole in an outside wall, and its solid leaves a walkable gap', () => {
  for (const d of DOORS) {
    const owner = OUTSIDE.find((s) => s.doors.includes(d.id));
    assert.ok(owner, `${d.id} is not in any outside wall`);
    // where the door's centre falls along its wall, measured as gapsOf does
    const dx = owner.b[0] - owner.a[0], dz = owner.b[1] - owner.a[1], L = Math.hypot(dx, dz);
    const s = ((d.u - owner.a[0]) * dx + (d.v - owner.a[1]) * dz) / L;
    const gap = gapsOf(owner).find((g) => Math.abs((g.s0 + g.s1) / 2 - s) < 1e-6);
    assert.ok(gap, `${d.id}: no gap in its wall at the plan's position`);
    assert.ok(gap.s0 > 0 && gap.s1 < L, `${d.id} lies on the wall's ends`);
    assert.ok(Math.abs(gap.s1 - gap.s0 - d.w) < 1e-9, `${d.id}: the gap is ${gap.s1 - gap.s0}, the plan says ${d.w}`);
    // the opening is clear at ground level, and the lintel over it is a piece walked under
    const w = toWorld(d.u, d.v);
    assert.ok(!blocked(w.x, w.z), `${d.id}: the opening is blocked at ground level`);
    assert.ok(pieces.some((p) => p.bot >= H.door - 1e-6 && solidHas(p, w.x, w.z)), `${d.id}: no lintel over the opening`);
  }
});

// ---- where the furniture stands -------------------------------------------------
test('counters, lanes, gates and their shops are in the zones the passengers pass through', () => {
  for (const c of COUNTERS) {
    assert.equal(zoneAt(c.u, c.v), 'landside', `counter ${c.no} is not landside`);
    assert.equal(zoneAt(c.u, c.v - 1.6), 'landside', `counter ${c.no}'s passenger place is not landside`);
    assert.equal(zoneAt(c.u, c.v + 1.4), 'landside', `counter ${c.no}'s belt is not landside`);
  }
  for (const L of LANES) {
    assert.equal(zoneAt(L.u, 8.5), 'security', `lane at ${L.u} starts outside security`);
    assert.equal(zoneAt(L.u, 12.5), 'security', `lane at ${L.u} ends outside security`);
    assert.equal(zoneAt(L.belt, 10), 'security', `the X-ray of lane ${L.u} is outside security`);
  }
  for (const g of GATES) {
    assert.equal(zoneAt(g.desk.u, g.desk.v), 'airside', `gate ${g.id}'s desk is not airside`);
    assert.equal(zoneAt(g.seats.u0 + 2, g.seats.v0 + 2), 'airside', `gate ${g.id}'s seats are not airside`);
  }
  assert.equal(zoneAt(CAROUSEL.u, CAROUSEL.v), 'arrivals');
  assert.equal(zoneAt(ARRIVALS_EXIT.u - 1, ARRIVALS_EXIT.v), 'arrivals');
  assert.equal(zoneAt(ARRIVALS_EXIT.u + 1, ARRIVALS_EXIT.v), 'landside');
  assert.deepEqual(MAHE_COUNTERS, [3, 4]);
});

// ---- the walks ------------------------------------------------------------------
const counter3 = COUNTERS.find((c) => c.no === 3);
const gate2 = GATES.find((g) => g.id === '2');
const door = (id) => DOORS.find((d) => d.id === id);
test('a walker goes from the main door to counter 3 on the ground', () => {
  const m = door('main-w');
  const route = [[m.u, m.v + 1.3], [m.u, -8], [counter3.u, counter3.v - 2.1]];
  const r = walkable(route);
  assert.ok(r.ok, `blocked on leg ${r.leg}: ${JSON.stringify(r.from)} to ${JSON.stringify(r.to)}`);
});

test('a walker goes from the counters through lane 1 into the lounge and on to the gate 2 door', () => {
  const lane = LANES[0], g2 = door(gate2.door);
  const route = [[counter3.u, 2.5], [lane.u, 2.5], [lane.u, 14], [34.6, 15], [50, 16], [g2.u, 16], [g2.u, 19.5]];
  const r = walkable(route);
  assert.ok(r.ok, `blocked on leg ${r.leg}: ${JSON.stringify(r.from)} to ${JSON.stringify(r.to)}`);
  const w = toWorld(g2.u, g2.v);
  assert.ok(!blocked(w.x, w.z), 'the gate 2 door is shut at ground level');
});

test('lane 2 is a way airside too, and the arrivals hall is not airside', () => {
  const lane = LANES[1];
  assert.ok(walkable([[counter3.u, 2.5], [lane.u, 2.5], [lane.u, 14], [34.6, 15]]).ok, 'lane 2 is blocked');
  assert.equal(zoneAt(ARRIVALS_EXIT.u - 6, -5), 'arrivals');
});

// ---- the flood fill: airside is reached only through the lanes ----------------------
const STEP = 0.25;
const key = (u, v) => Math.round(u / STEP) + ',' + Math.round(v / STEP);
/** The walkable cells of the plan at STEP spacing, keyed "i,j" (i along u, j along v). */
function grid() {
  const cells = new Map();
  for (let i = Math.round(-92 / STEP); i <= Math.round(70 / STEP); i++) {
    for (let j = Math.round(-27 / STEP); j <= Math.round(25 / STEP); j++) {
      const u = i * STEP, v = j * STEP;
      if (!inBuilding(u, v)) continue;
      const w = toWorld(u, v);
      if (blocked(w.x, w.z)) continue;
      cells.set(i + ',' + j, { i, j, u, v });
    }
  }
  return cells;
}
/** Every cell a walker starting at (u, v) reaches, not stepping on a cell `wall` marks. */
function reach(cells, u, v, wall = () => false) {
  const start = key(u, v);
  if (!cells.has(start)) return new Set();
  const seen = new Set([start]), queue = [cells.get(start)];
  while (queue.length) {
    const c = queue.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (c.i + di) + ',' + (c.j + dj);
      if (seen.has(k) || !cells.has(k) || wall(cells.get(k))) continue;
      seen.add(k);
      queue.push(cells.get(k));
    }
  }
  return seen;
}
/** The security zone, a little inside its walls: both lanes, their arches and belts. */
const inSecurity = (c) => c.u > 18.2 && c.u < 31.8 && c.v > 7.2 && c.v < 12.8;
test('airside is reached from the landside only through the security lanes', () => {
  const cells = grid();
  assert.ok(cells.size > 50000, `only ${cells.size} walkable cells`);
  const open = reach(cells, -20, 0);
  assert.ok(open.has(key(57.6, 17.2)), 'gate 2 cannot be reached at all');
  assert.ok(open.has(key(20.6, 10)), 'lane 1 cannot be reached');
  // with the security zone shut, nothing airside is reachable from the landside
  const shut = reach(cells, -20, 0, inSecurity);
  assert.ok(!shut.has(key(57.6, 17.2)), 'gate 2 is reachable round the lanes');
  for (const k of shut) {
    const [i, j] = k.split(',').map(Number);
    assert.notEqual(zoneAt(i * STEP, j * STEP), 'airside', `cell ${i * STEP}, ${j * STEP} is airside but was reached without a lane`);
  }
  // the arrivals hall lets out into the check-in hall, and no further than that
  const arr = reach(cells, -60, 5, inSecurity);
  assert.ok(arr.has(key(-20, 0)), 'the arrivals hall does not reach the check-in hall');
  assert.ok(!arr.has(key(57.6, 17.2)), 'the arrivals hall reaches airside');
});

// ---- the shell ------------------------------------------------------------------
test('the shell is a sound model within budget, with the solids under its height', () => {
  const sink = new LandmarkSink();
  buildLetiste(new Kit(sink, 0));
  assert.ok(sink.tris > 500 && sink.tris < 12000, `${sink.tris} triangles`);
  let maxY = -Infinity;
  for (let i = 1; i < sink.pos.length; i += 3) maxY = Math.max(maxY, sink.pos[i]);
  for (const p of pieces) assert.ok(p.top <= maxY + 1e-6, `a solid stands ${p.top} m, the model ${maxY} m`);
  // the same triangles every time: both threads build the same thing
  const again = new LandmarkSink();
  buildLetiste(new Kit(again, 0));
  assert.deepEqual(again.pos, sink.pos);
  assert.deepEqual(again.uv1, sink.uv1);
});

// ---- the interior: what it is made of, and how many batches it takes ----------
test('the interior and the fittings are sound boxes of known finishes, in a bounded number of batches', async () => {
  const { FINISH } = await import('../js/stationkit.js');
  const { ctxOf } = await import('../js/airport-ctx.js');
  const { buildInterior } = await import('../js/airport-interior.js');
  const { buildFittings } = await import('../js/airport-fit.js');
  // a recording kit: the same calls stationKit takes, with no canvas behind them
  const boxes = [];
  let signs = 0, lights = 0;
  const kit = {
    box(x, y, z, w, h, d, finish, rot) { boxes.push({ x, y, z, w, h, d, finish, rot }); },
    round() {}, sign() { signs++; }, both() { signs++; }, light() { lights++; },
  };
  const ctx = ctxOf(kit, 221);
  buildInterior(ctx);
  buildFittings(ctx);
  assert.ok(boxes.length > 300 && boxes.length < 4000, `${boxes.length} boxes`);
  const finishes = new Set(boxes.map((b) => b.finish));
  for (const f of finishes) assert.ok(f in FINISH, `the finish '${f}' is not in stationKit`);
  // one InstancedMesh per finish is one draw call: the set stays a few dozen, plus the atlas and the pools
  assert.ok(finishes.size <= 25, `${finishes.size} finishes`);
  for (const b of boxes) {
    assert.ok(b.w > 0 && b.h > 0 && b.d > 0, `a degenerate box ${JSON.stringify(b)}`);
    assert.ok(b.y + b.h / 2 <= 11.5 + 221, `a box stands above the roof: ${JSON.stringify(b)}`);
  }
  // the eight counter numbers, two gate desks, two gate signs, the porch, the fascia, two
  // direction signs, HOCKEYTOWN, three flags, two shops and the totem's two faces
  assert.equal(signs, 24, `${signs} plates`);
  assert.ok(lights > 0, 'no light pools for the night');
});
