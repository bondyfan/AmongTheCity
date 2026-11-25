// Václav Havel Airport Prague (js/flight-lkpr.js) against the real tile: the stand
// is on the apron and clear of everything it must clear, the desk stands on the
// ground in front of Terminál 1, the taxi routes follow the mapped taxiways, and the
// spawns lie on the extended centreline of 24. Reads public/data/tiles/-23_-2.json
// (read only) and the LKPR entry of js/airfield.js (read only).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const { prague, PRG_SPAWNS, LKPR_PLAN } = await import('../js/flight-lkpr.js');

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/-23_-2.json', import.meta.url), 'utf8'));
const ways = tile.roads.filter((r) => r.t === 'taxiway' || r.t === 'taxilane' || r.t === 'runway');
const runways = ways.filter((r) => r.t === 'runway');
const rings = tile.buildings.filter((b) => b.o && b.o.length > 2).map((b) => b.o);
const aprons = tile.paved.filter((p) => p.t === 'apron').map((p) => p.o);
const fences = tile.barriers.map((b) => b.p);
const bridges = tile.roads.filter((r) => r.br).map((r) => r.p);
const walkways = tile.roads.filter((r) => ['footway', 'path', 'steps', 'pedestrian'].includes(r.t)).map((r) => r.p);
const terminal = tile.buildings.find((b) => b.n === 'Terminál 1').o;

// the airfield's own machines at LKPR, read from js/airfield.js
const airfieldSrc = readFileSync(new URL('../js/airfield.js', import.meta.url), 'utf8');
const lkprBlock = airfieldSrc.slice(airfieldSrc.indexOf("icao: 'LKPR'"));
const machines = [...lkprBlock.slice(0, 600).matchAll(/x: (-?\d+), z: (-?\d+)/g)].map((m) => [+m[1], +m[2]]);

// ---- geometry helpers ----
function segDist(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / L2));
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}
function lineDist(px, pz, pts, closed = false) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, pz, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  if (closed) d = Math.min(d, segDist(px, pz, ...pts[pts.length - 1], ...pts[0]));
  return d;
}
function inRing(px, pz, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const anyRing = (x, z) => rings.some((r) => inRing(x, z, r));
const minRing = (x, z) => Math.min(...rings.map((r) => lineDist(x, z, r, true)));
const minFence = (x, z) => Math.min(...fences.map((f) => lineDist(x, z, f)));
const minLines = (x, z, lines) => Math.min(...lines.map((p) => lineDist(x, z, p)));
// metres of the segment a-b (sampled) that are neither on an apron nor within 2.5 m of a taxiway or runway
function unpavedLength(a, b) {
  const L = along(a, b), N = 60, lines = ways.map((w) => w.p);
  let n = 0;
  for (let i = 0; i <= N; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / N, z = a[1] + ((b[1] - a[1]) * i) / N;
    if (!aprons.some((r) => inRing(x, z, r)) && minLines(x, z, lines) > 2.5) n++;
  }
  return (L * n) / (N + 1);
}
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const fwd = (h) => [-Math.sin(h), -Math.cos(h)];
const TRAVEL = fwd(LKPR_PLAN.runway.heading);
const along = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const pathLength = (pts) => pts.slice(1).reduce((s, q, i) => s + along(q, pts[i]), 0);
// the footprint of the aircraft on a stand: 17.9 m either side, 20.6 m nose, 17.0 m tail
function footprint(x, z, h) {
  const [fx, fz] = fwd(h), rx = Math.cos(h), rz = -Math.sin(h);
  return [[-17.9, 20.6], [17.9, 20.6], [17.9, -17.0], [-17.9, -17.0]].map(([lx, lf]) => [x + rx * lx + fx * lf, z + rz * lx + fz * lf]);
}
// sample points along the footprint's edges, so an edge that cuts through a fence is caught
function edgeSamples(poly, n = 20) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

const prg = prague(() => ways);
const stand = prg.stand;
const threshold = [prg.land.x, prg.land.z];

test('the descriptor has the shape the flight reads, with 24 as the runway in use', () => {
  assert.equal(prg.id, 'LKPR');
  assert.equal(prg.iata, 'PRG');
  assert.equal(prg.region, 'cz');
  assert.equal(prg.name, 'Praha');
  assert.ok(Math.abs(prg.land.heading - prg.depart.heading) < 1e-12, 'depart and land share 24');
  assert.ok(angDiff(prg.land.heading, 115 * Math.PI / 180) < 0.001, '24 is flown about 115 degrees (WSW)');
  assert.ok(angDiff(prg.outbound, -127 * Math.PI / 180) < 1e-9, 'the way home leaves toward Dubai, 127 degrees');
  assert.ok(prg.elev === null && prg.exit && prg.terminal.name === 'Terminál 1');
  // the threshold is the east end of the tile's 06/24 line
  assert.ok(along(threshold, [-106233, -9371]) < 1e-9);
  assert.ok(minLines(threshold[0], threshold[1], runways.map((r) => r.p)) < 1, 'the threshold is on the runway');
});

test('the line-up is 30 m past the threshold, on the centreline, facing the roll', () => {
  const line = [prg.depart.x, prg.depart.z];
  assert.ok(Math.abs(along(line, threshold) - 30) < 0.5, 'thirty metres past the threshold');
  const [ux, uz] = fwd(prg.depart.heading);
  const cross = (line[0] - threshold[0]) * uz - (line[1] - threshold[1]) * ux;
  assert.ok(Math.abs(cross) < 0.5, 'on the extended centreline');
  assert.ok((line[0] - threshold[0]) * ux + (line[1] - threshold[1]) * uz > 0, 'downfield of the threshold');
  assert.ok(minLines(line[0], line[1], runways.map((r) => r.p)) < 1, 'and on the runway');
});

test('the stand is on an apron, clear of buildings, fences and the airfield machines', () => {
  const apron = aprons.find((a) => inRing(stand.x, stand.z, a));
  assert.ok(apron, 'the stand is on a mapped apron');
  const fp = footprint(stand.x, stand.z, stand.heading);
  for (const c of fp) assert.ok(inRing(c[0], c[1], apron), 'every corner of the aircraft is on that apron');
  assert.ok(!anyRing(stand.x, stand.z), 'the stand is not inside a building');
  const clearB = Math.min(...edgeSamples(fp).map(([x, z]) => minRing(x, z)));
  const clearF = Math.min(...edgeSamples(fp).map(([x, z]) => minFence(x, z)));
  assert.ok(clearB >= 35, 'at least 35 m from every building (' + clearB.toFixed(1) + ' m)');
  assert.ok(clearF >= 35, 'at least 35 m from every fence and wall (' + clearF.toFixed(1) + ' m)');
  assert.ok(Math.min(...fp.map(([x, z]) => minRing(x, z))) >= 35, 'the corners too');
  const near = Math.min(...machines.map(([x, z]) => Math.hypot(x - stand.x, z - stand.z)));
  assert.ok(machines.length === 4 && near >= 100, 'away from the helicopter and the fighters (' + near.toFixed(0) + ' m)');
  // roll-out: the nose points at the mapped taxiway, a few tens of metres ahead
  const [ax, az] = prg.taxiOut[1];
  const d = along([ax, az], [stand.x, stand.z]);
  const dot = ((ax - stand.x) * -Math.sin(stand.heading) + (az - stand.z) * -Math.cos(stand.heading)) / d;
  assert.ok(d < 90 && dot > 0.8, 'the first taxiway is ahead of the nose (' + d.toFixed(0) + ' m, cos ' + dot.toFixed(2) + ')');
  // by Prst B: within 100 m of its ring
  const prstB = tile.buildings.find((b) => b.n === 'Prst B').o;
  assert.ok(lineDist(stand.x, stand.z, prstB, true) < 100, 'by Terminál 1\'s pier B');
});

test('the desk stands on the ground in front of Terminál 1, off the bridges, and faces the terminal', () => {
  const desk = prg.desk;
  assert.ok(!anyRing(desk.x, desk.z), 'not inside a building');
  assert.ok(minRing(desk.x, desk.z) >= 6, 'clear of every building edge (' + minRing(desk.x, desk.z).toFixed(1) + ' m)');
  // the row, turned to the desk's heading: 3.2 m either side, 1.5 m behind the counter to 3.5 m in front
  const [fx, fz] = fwd(desk.heading), rx = Math.cos(desk.heading), rz = -Math.sin(desk.heading);
  const row = [[-3.2, -1.5], [3.2, -1.5], [3.2, 3.5], [-3.2, 3.5]].map(([l, f]) => [desk.x + rx * l + fx * f, desk.z + rz * l + fz * f]);
  assert.ok(edgeSamples(row).every(([x, z]) => !anyRing(x, z)), 'the whole row is clear of the buildings');
  assert.ok(minLines(desk.x, desk.z, bridges) >= 10, 'not on a bridge or ramp road (' + minLines(desk.x, desk.z, bridges).toFixed(0) + ' m)');
  assert.ok(minLines(desk.x, desk.z, walkways) <= 8, 'a footway runs to it, to walk in from the street');
  // the nearest point of Terminál 1 is in front of the agent, 8 to 14 m off
  let best = null;
  for (let i = 0; i < terminal.length; i++) {
    const a = terminal[i], b = terminal[(i + 1) % terminal.length];
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((desk.x - a[0]) * ex + (desk.z - a[1]) * ez) / L2));
    const p = [a[0] + ex * t, a[1] + ez * t], dd = Math.hypot(desk.x - p[0], desk.z - p[1]);
    if (!best || dd < best.dd) best = { p, dd };
  }
  assert.ok(best.dd >= 8 && best.dd <= 14, 'the terminal is ' + best.dd.toFixed(1) + ' m away');
  const toward = Math.atan2(-(best.p[0] - desk.x), -(best.p[1] - desk.z));
  assert.ok(angDiff(desk.heading, toward) < 0.05, 'the agent faces the terminal');
  // the passenger's spot, on the street side: clear of the fence and the buildings
  const pax = PRG_SPAWNS['prg-airport'];
  assert.ok(!anyRing(pax.x, pax.z) && minFence(pax.x, pax.z) >= 3, 'the passenger has room in front of the counter');
});

test('taxi out follows the mapped taxiways to the threshold, then the line-up', () => {
  const out = prg.taxiOut;
  assert.deepStrictEqual(out[0], [stand.x, stand.z], 'starts on the stand');
  assert.deepStrictEqual(out[out.length - 1], [prg.depart.x, prg.depart.z], 'ends on the line-up');
  // the first leg leaves the stand over the apron; the tile's apron stops short of the
  // taxilane, so a stretch of it is neither apron nor taxiway (see the stand's note)
  assert.ok(unpavedLength(out[0], out[1]) <= 30, 'the first leg is paved but for ' + unpavedLength(out[0], out[1]).toFixed(0) + ' m');
  for (const [x, z] of out.slice(1, -1)) {
    assert.ok(minLines(x, z, ways.map((w) => w.p)) < 2, 'vertex ' + x.toFixed(0) + ',' + z.toFixed(0) + ' lies on a taxiway');
  }
  const last = out[out.length - 2];
  assert.ok(minLines(last[0], last[1], runways.map((r) => r.p)) < 2, 'the last mapped point is on 24');
  const lastLeg = Math.atan2(-(out[out.length - 1][0] - last[0]), -(out[out.length - 1][1] - last[1]));
  assert.ok(angDiff(lastLeg, prg.depart.heading) < 0.02, 'the last leg runs along 24, WSW');
  const len = pathLength(out);
  assert.ok(len > 1000 && len < 2600, 'the taxi is ' + len.toFixed(0) + ' m');
});

test('taxi in starts on the runway at the exit and ends in the stand', () => {
  const inn = prg.taxiIn;
  // the approach from the taxilane's end to the point behind the stand is the same gap
  // in the tile's apron (33 m); the last few metres into the stand are on the apron
  const approach = unpavedLength(inn.at(-3), inn.at(-2));
  assert.ok(approach <= 35, 'the approach into the stand is paved but for ' + approach.toFixed(0) + ' m');
  assert.ok(unpavedLength(inn.at(-2), inn.at(-1)) < 1, 'the last metres into the stand are on the apron');
  const [ex, ez] = inn[0];
  assert.ok(minLines(ex, ez, runways.map((r) => r.p)) < 2, 'starts on 24');
  assert.ok(Math.hypot(ex - prg.exit.x, ez - prg.exit.z) < 2, 'at the exit');
  assert.deepStrictEqual(inn[inn.length - 1], [stand.x, stand.z], 'ends on the stand');
  for (const [x, z] of inn.slice(1, -2)) assert.ok(minLines(x, z, ways.map((w) => w.p)) < 2, 'the middle is on taxiway');
  const len = pathLength(inn);
  assert.ok(len > 400 && len < 2000, 'the taxi in is ' + len.toFixed(0) + ' m');
});

test('without the tile the routes are the plain ones, and they still reach the stand and the line-up', () => {
  const plain = prague();
  assert.ok(plain.taxiOut.length >= 3 && plain.taxiIn.length >= 3);
  assert.deepStrictEqual(plain.taxiOut[0], [stand.x, stand.z]);
  assert.deepStrictEqual(plain.taxiOut.at(-1), [prg.depart.x, prg.depart.z]);
  assert.deepStrictEqual(plain.taxiIn.at(-1), [stand.x, stand.z]);
  // and a roads function that has nothing yet gives the same plain routes
  assert.deepStrictEqual(prague(() => null).taxiOut, plain.taxiOut);
});

test('the spawns: the arrival is on the extended centreline of 24, the passenger faces the counter', () => {
  const arr = PRG_SPAWNS['prg-arrival'];
  const d = [arr.x - threshold[0], arr.z - threshold[1]];
  const range = Math.hypot(d[0], d[1]);
  assert.ok(range > 11000 && range < 14000, 'between 11 and 14 km out (' + (range / 1000).toFixed(2) + ' km)');
  const [ux, uz] = TRAVEL;
  assert.ok(d[0] * ux + d[1] * uz < 0, 'upstream of the threshold');
  assert.ok(Math.abs(d[0] * uz - d[1] * ux) < 1, 'on the extended centreline (' + Math.abs(d[0] * uz - d[1] * ux).toFixed(3) + ' m off)');
  assert.ok(angDiff(arr.heading, LKPR_PLAN.runway.heading) < 1e-9, 'heading along the approach');
  assert.equal(arr.y, LKPR_PLAN.elevM + 500, 'five hundred metres above the field');
  const pax = PRG_SPAWNS['prg-airport'];
  assert.ok(Math.abs(Math.hypot(pax.x - prg.desk.x, pax.z - prg.desk.z) - 2.2) < 1e-6, 'two metres from the counter on the street side');
  assert.ok(angDiff(pax.heading, prg.desk.heading) < 1e-9, 'facing the counter');
});
