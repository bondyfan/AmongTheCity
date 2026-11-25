// The people of the Pardubice terminal (js/airport-people-plan.js) checked without a
// browser: the plan is deterministic and has the roles it should, nobody stands in a
// wall, a counter or a bench, nobody is within 1.2 m of the player's walk from the
// doors to the counters, through the arch, to gate 2 and out of its door, every
// seated one is on a real seat, and everybody is inside the building.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const plan = await import('../js/airport-plan.js');
const { DOORS, COUNTERS, LANES, GATES, MAHE_GATE, toLocal, inBuilding } = plan;
const people = await import('../js/airport-people-plan.js');
const { airportPeoplePlan, SEAT, SEAT_RECTS } = people;
const { letisteSolids } = await import('../js/landmarks-letiste.js');
const { solidHas } = await import('../js/landmarks.js');

const entries = airportPeoplePlan();
const local = (e) => toLocal(e.x, e.z);
const counter = (no) => COUNTERS.find((c) => c.no === no);

// The solids a walker meets at ground level, and the bench blocks among them (the
// bench rows are solid blocks 0.45 high, which only their own sitters may touch).
const pieces = letisteSolids().filter((p) => p.bot <= 0.5);
const isBench = (p) => p.top === 0.45;
const RING = Array.from({ length: 12 }, (_, i) => [Math.cos(i * Math.PI / 6) * 0.3, Math.sin(i * Math.PI / 6) * 0.3]);
/** Does a body of radius 0.3 at world (x, z) touch a solid? Benches are skipped for sitters. */
function touches(x, z, sitter) {
  const pts = [[0, 0], ...RING];
  return pts.some(([dx, dz]) => pieces.some((p) => (!sitter || !isBench(p)) && solidHas(p, x + dx, z + dz)));
}

// The player's walk, built here from airport-plan's own points: the north doors to
// counters 3 and 4 (and the point between them, where he buys the ticket), then lane 1's
// arch, the lounge, gate 2's desk and its door.
function walkersLine() {
  const north = DOORS.filter((d) => d.side === 'n');
  const c3 = counter(3), c4 = counter(4);
  const stops = [[c3.u, c3.v - 2.1], [c4.u, c4.v - 2.1], [(c3.u + c4.u) / 2, c3.v - 1.2]];
  const lane = LANES[0];
  const g2 = GATES.find((g) => g.id === MAHE_GATE);
  const door2 = DOORS.find((d) => d.id === g2.door);
  const lines = [];
  for (const d of north) for (const s of stops) lines.push([[d.u, d.v + 1.3], [d.u, -8], s]);
  for (const s of [stops[0], stops[2]]) {
    lines.push([s, [lane.u, s[1]], [lane.u, 14], [34.6, 15], [50, 16], [g2.desk.u, 16], [door2.u, 16], [door2.u, door2.v - 0.4]]);
  }
  return lines;
}
const LINES = walkersLine();

function segDist(u, v, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((u - a[0]) * ex + (v - a[1]) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(u - a[0] - ex * t, v - a[1] - ey * t);
}

// ---- the plan itself ----------------------------------------------------------------
test('the plan is deterministic, uses no random numbers, and every entry has the fields the bodies need', async () => {
  const src = readFileSync(new URL('../js/airport-people-plan.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('Math.random'), 'the plan calls Math.random');
  // a fresh evaluation of the module (its own cache entry) gives the same people
  const fresh = await import(new URL('../js/airport-people-plan.js?fresh=1', import.meta.url).href);
  assert.equal(JSON.stringify(fresh.airportPeoplePlan()), JSON.stringify(entries));
  const keys = ['heading', 'pose', 'role', 'seed', 'x', 'y', 'z'];
  const seeds = new Set();
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).sort(), keys);
    for (const k of ['x', 'y', 'z', 'heading']) assert.ok(Number.isFinite(e[k]), `${k} is not a number`);
    assert.ok(Number.isInteger(e.seed) && e.seed >= 0, 'seed is not an unsigned integer');
    seeds.add(e.seed);
    assert.ok(['stand', 'sit', 'idle'].includes(e.pose), `pose ${e.pose}`);
    assert.ok(['agent', 'security', 'gate', 'passenger'].includes(e.role), `role ${e.role}`);
  }
  assert.equal(seeds.size, entries.length, 'two people share a seed');
});

test('the roles: four check-in agents behind the open and staffed counters, two gate agents, two officers, 10 to 16 passengers', () => {
  const role = (r) => entries.filter((e) => e.role === r);
  assert.equal(role('agent').length, 4);
  assert.equal(role('gate').length, 2);
  assert.equal(role('security').length, 2);
  const pax = role('passenger');
  assert.ok(pax.length >= 10 && pax.length <= 16, `${pax.length} passengers`);
  // an agent behind counters 3 and 4 (the two that sell the flight), and behind two others
  const agents = role('agent').map(local);
  for (const no of [3, 4]) {
    const c = counter(no);
    assert.ok(agents.some((l) => Math.hypot(l.u - c.u, l.v - (c.v + 0.9)) < 0.5), `no agent at counter ${no}`);
  }
  for (const l of agents) assert.ok(COUNTERS.some((c) => Math.hypot(l.u - c.u, l.v - (c.v + 0.9)) < 0.5), 'an agent is not behind a counter');
  // gate agents behind the two gate desks
  for (const g of GATES) {
    assert.ok(role('gate').map(local).some((l) => Math.hypot(l.u - g.desk.u, l.v - (g.desk.v + 0.95)) < 0.5), `no agent at gate ${g.id}`);
  }
  // a queue of passengers stands in the reach of the open counters
  const near = pax.filter((e) => e.pose === 'idle').map(local)
    .filter((l) => [3, 4].some((no) => Math.hypot(l.u - counter(no).u, l.v - counter(no).v) < 7.5));
  assert.ok(near.length >= 2, `${near.length} passengers queue for counters 3 and 4`);
  // the check-in agents sit at their counters, the gate agents and officers stand
  for (const e of entries.filter((x) => x.role !== 'passenger')) {
    assert.equal(e.pose, e.role === 'agent' ? 'sit' : 'stand', `${e.role} is ${e.pose}`);
  }
});

test('every person is inside the building, clear of its outside walls', () => {
  for (const e of entries) {
    const { u, v } = local(e);
    assert.ok(inBuilding(u, v, -0.6), `(${u.toFixed(2)}, ${v.toFixed(2)}) is outside the building`);
  }
});

test('nobody is within 1.2 m of the player\'s walk', () => {
  for (const e of entries) {
    const { u, v } = local(e);
    for (const line of LINES) {
      for (let i = 0; i + 1 < line.length; i++) {
        const d = segDist(u, v, line[i], line[i + 1]);
        assert.ok(d >= 1.2, `${e.role} at (${u.toFixed(2)}, ${v.toFixed(2)}) is ${d.toFixed(2)} m from the walk`);
      }
    }
  }
});

test('nobody stands in the lane mouths, and the officers stand clear of the collider', () => {
  for (const e of entries) {
    const { u, v } = local(e);
    assert.ok(!(u > 17.5 && u < 33.5 && v > 6.6 && v < 13.5), `${e.role} stands in the lane mouths`);
  }
  for (const e of entries.filter((x) => x.role === 'security')) {
    const { u, v } = local(e);
    assert.ok(u > 17 && u < 33, 'an officer stands outside the lanes');
    // js/flight-terminal.js holds a walker without a ticket at v 7.4 minus his radius
    assert.ok(v < 7.1, `an officer at v ${v.toFixed(2)} is inside the collider`);
    for (const L of LANES) assert.ok(Math.abs(u - L.u) > 1.2, `an officer blocks the walker's line at ${L.u}`);
  }
});

test('nobody stands inside a wall, a counter, a bench or a lane (sitters may touch their own bench)', () => {
  for (const e of entries) {
    const sitter = e.pose === 'sit';
    assert.ok(!touches(e.x, e.z, sitter), `${e.role} (${e.pose}) at (${local(e).u.toFixed(2)}, ${local(e).v.toFixed(2)}) is inside a solid`);
  }
});

test('the seated are on real seats, at the height of the seat', () => {
  const seated = entries.filter((e) => e.pose === 'sit');
  assert.ok(seated.length >= 6, `${seated.length} seated`);
  for (const e of seated) {
    const { u, v } = local(e);
    const seat = SEAT_RECTS.find((r) => u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1);
    assert.ok(seat, `(${u.toFixed(2)}, ${v.toFixed(2)}) is on no seat`);
    assert.equal(e.y, seat.y, `a ${seat.kind} seat at height ${seat.y}, the body says ${e.y}`);
    if (seat.kind === 'bench') {
      assert.ok(pieces.some((p) => isBench(p) && solidHas(p, e.x, e.z)), 'a bench sitter is not on a bench');
    } else {
      assert.ok(COUNTERS.some((c) => Math.abs(u - c.u) < 0.4 && Math.abs(v - (c.v + 0.9)) < 0.5), 'a chair is not behind a counter');
    }
  }
  for (const e of entries.filter((x) => x.pose !== 'sit')) assert.equal(e.y, 0, 'a standing body is above the tiles');
  assert.equal(SEAT.bench, 0.32);
  assert.equal(SEAT.chair, 0.38);
});

test('nobody is closer than 0.6 m to anybody else', () => {
  const pts = entries.map(local);
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i].u - pts[j].u, pts[i].v - pts[j].v);
    assert.ok(d >= 0.6, `two people are ${d.toFixed(2)} m apart`);
  }
});
