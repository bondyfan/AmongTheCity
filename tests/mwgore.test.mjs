// ---- the gore of a slip road: two solid legs and the V 13 hatch between ----
// js/mwpaint.js on a synthetic diverge: a straight 2-lane carriageway along
// +x (right of travel is +z) and a 1-lane slip road leaving it from its
// centreline on a widening curve, as OSM draws every D11 exit.

import test from 'node:test';
import assert from 'node:assert';
import { motorwayPaint, gapAt, HATCH_STEP } from '../js/mwpaint.js';
import { laneLayout } from '../js/lanes.js';

const mw = { t: 'motorway', d: true, ow: 1, ln: 2, w: 12.5, _paved: true, p: [[0, 0], [600, 0]] };
const linkPts = [];
for (let x = 100; x <= 400; x += 10) linkPts.push([x, (x - 100) ** 2 * 0.00024]);
const link = { t: 'motorway_link', d: true, ow: 1, ln: 1, w: 5.5, _paved: true, p: linkPts };
const cell = { roads: [mw, link] };

// resampled every 4 m like meshes.js terrainResample, then framed like ribbonFrame
function frame(p) {
  const q = [[p[0][0], p[0][1]]], along = [0], per = [];
  for (let i = 0; i < p.length - 1; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) / 4));
    for (let k = 1; k <= n; k++) q.push([p[i][0] + (p[i + 1][0] - p[i][0]) * (k / n), p[i][1] + (p[i + 1][1] - p[i][1]) * (k / n)]);
  }
  for (let i = 1; i < q.length; i++) along.push(along[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  for (let i = 0; i < q.length; i++) {
    const a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    per.push([dz / l, -dx / l]);            // left, as meshes.js ribbonFrame
  }
  return { q, per, along, len: along[along.length - 1] };
}
function paint(f) {
  const quads = [];
  const sink = { quad(...a) { quads.push([[a[0], a[2]], [a[3], a[5]], [a[6], a[8]], [a[9], a[11]]]); } };
  motorwayPaint(sink, f, frame(f.p), { cell, js: [], inPads: () => null, yAt: () => 0, mark: 0.02, col: [1, 1, 1], s0: 0 });
  return quads;
}
const zOf = (x) => (x - 100) ** 2 * 0.00024;
const mwEdge = laneLayout(mw).edgeR, linkEdgeL = laneLayout(link).edgeL;

const isHatch = (qd) => {
  const dx = Math.abs(qd[1][0] - qd[0][0]), dz = Math.abs(qd[1][1] - qd[0][1]);
  return dz > 0.4 && Math.abs(dx - dz) < 0.3;
};

test('the slip road paints nothing on motorway asphalt itself', () => {
  for (const qd of paint(link)) for (const [x, z] of qd) {
    if (x > 0 && x < 600) assert.ok(z > laneLayout(mw).ribbonHalf - 0.3, `slip road paint at (${x.toFixed(1)}, ${z.toFixed(2)}) on the motorway`);
  }
});

test('the motorway paints the gore: the slip road legs on its asphalt and the V 13 hatch between', () => {
  const quads = paint(mw), half = laneLayout(mw).ribbonHalf;
  // nothing of the gore leaves this ribbon's asphalt
  for (const qd of quads) for (const [, z] of qd) assert.ok(z < half, `paint off the ribbon at z ${z.toFixed(2)}`);
  const hatch = quads.filter(isHatch);
  assert.ok(hatch.length >= 3, `${hatch.length} hatch lines`);
  for (const h of hatch) {
    for (const [x, z] of h) {
      // inside the V: right of the motorway edge line, left of the slip road's left edge line
      assert.ok(z > mwEdge && z < zOf(x) + linkEdgeL + 0.6, `hatch vertex (${x.toFixed(1)}, ${z.toFixed(2)}) outside the wedge`);
    }
  }
  // spaced by HATCH_STEP along the slip road
  const xs = hatch.map((h) => Math.max(h[0][0], h[1][0])).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - HATCH_STEP) < 0.6, 'uneven hatch spacing');
  // the slip road's left leg: a solid run on the motorway right of its edge line
  const leg = quads.filter((qd) => !isHatch(qd) && qd.every(([x, z]) => z > mwEdge + 0.3 && Math.abs(z - (zOf(x) + linkEdgeL)) < 0.3));
  const legLen = leg.reduce((s, qd) => s + Math.hypot(qd[1][0] - qd[0][0], qd[1][1] - qd[0][1]), 0);
  assert.ok(legLen > 8, `left leg ${legLen.toFixed(1)} m`);
});

test('the motorway right edge is the aux dash under the slip lane and solid again in the gore', () => {
  const quads = paint(mw);
  const right = quads.filter((qd) => qd.every(([, z]) => Math.abs(z - mwEdge) < 0.3));
  const covered = (x0, x1) => right.filter((qd) => Math.min(qd[0][0], qd[1][0]) < x1 && Math.max(qd[0][0], qd[1][0]) > x0)
    .reduce((s, qd) => s + Math.min(x1, Math.max(qd[0][0], qd[1][0])) - Math.max(x0, Math.min(qd[0][0], qd[1][0])), 0);
  // the slip lane covers the edge line while the link centre is 2 to 5.75 m out: x 191 to 255
  const mid = covered(200, 250) / 50;
  assert.ok(mid > 0.5 && mid < 0.8, `aux dash share ${mid.toFixed(2)}`);
  // the gore and beyond: solid
  assert.ok(covered(275, 340) / 65 > 0.97, 'the edge line is broken in the gore');
  assert.ok(covered(20, 90) / 70 > 0.97, 'the edge line is broken before the diverge');
});

test('gapAt measures from the motorway right edge line, + to the right, null off its asphalt', () => {
  const o = {};
  assert.ok(Math.abs(gapAt(cell, link, 50, mwEdge + 1, 0, o) - 1) < 1e-9);
  assert.ok(Math.abs(o.tx - 1) < 1e-9 && Math.abs(o.tz) < 1e-9);
  assert.ok(gapAt(cell, link, 50, 0, 0, null) < 0);
  assert.equal(gapAt(cell, link, 50, 7, 0, null), null);
  assert.ok(gapAt(cell, link, 50, 7, 0.8, null) > 0);
});
