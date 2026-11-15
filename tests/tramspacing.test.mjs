// ---- tram spacing and the late clock (js/tramspacing.js, js/trams.js) ---------
// Round 7 left two defects on the real Prague network: two trams could stand
// in each other where lines share or cross track (they came into sight
// together, or met nose to nose at a junction and each waited for the
// other), and a tram held more than 60 m behind its timetable jumped to it
// when it was let go. What has to hold now:
//
//   over thousands of frames at the busiest junctions no two tram bodies
//     touch, along a shared rail or across a junction;
//   no tram ever moves backwards once drawn, or faster than the rail allows;
//   a tram held two minutes by a car on its rail waits short of it, pulls
//     away, and makes the time up gradually (its own clock 1.25 x) without
//     ever being ahead of the shared timetable;
//   the inverse of the timetable (sinceAtArc, dueAt) is the timetable's.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROUTES = path.join(ROOT, 'public/data/routes');
const T = await import('../js/tramlines.js');
const { Trams } = await import('../js/trams.js');
const files = readdirSync(ROUTES).map((f) => JSON.parse(readFileSync(path.join(ROUTES, f), 'utf8')));
const T0 = 17_899_320 + 1800;

function fleet(clock, traffic = null) {
  const tr = new Trams({ clock, traffic });
  for (const file of files) for (const r of file.routes) tr.addRoute(file, r);
  return tr;
}

// Do any two bodies come closer than `lim` between centrelines?
const at = { x: 0, z: 0, dx: 0, dz: 0 };
function touching(list, lim) {
  const pts = list.map((t) => {
    const p = [];
    for (let o = 0; o <= t.len + 1e-6; o += 1.5) { T.pathAtExt(t.line.P, t.sr - Math.min(o, t.len), at); p.push(at.x, at.z); }
    return p;
  });
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const A = list[a], B = list[b];
    if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > (A.len + B.len + 4) ** 2) continue;
    const pa = pts[a], pb = pts[b];
    for (let i = 0; i < pa.length; i += 2) for (let j = 0; j < pb.length; j += 2) {
      if ((pa[i] - pb[j]) ** 2 + (pa[i + 1] - pb[j + 1]) ** 2 < lim * lim) return [A.key, B.key, pa[i], pa[i + 1]];
    }
  }
  return null;
}

test('no two trams touch where lines share and cross track, and none moves backwards or jumps', () => {
  // Karlovo náměstí (ten lines), Národní třída, Jindřišská / Václavské náměstí,
  // and the Old Town Square start, whose ring takes in I. P. Pavlova: there a
  // new 31 m tram set back behind one body landed on a 14 m one it had not
  // looked at (its nose had moved 60 m from where it came into being)
  for (const [x, z] of [[-95760, -4945], [-95760, -5530], [-95330, -5590], [-95636, -6206]]) {
    let wt = T0 + (x % 977);
    const tr = fleet(() => wt);
    const pos = { x, z }, prev = new Map();
    let frames = 0;
    for (let i = 0; i < 2400; i++) {
      wt += 0.25;
      tr.update(0.25, pos, 0.5);
      for (const t of tr.list) {
        const p = prev.get(t.key);
        if (p !== undefined) {
          assert.ok(t.sr >= p - 1e-6, `${t.key} moved back ${(p - t.sr).toFixed(2)} m`);
          assert.ok(t.sr - p <= T.VMAX * 0.25 + 1e-3, `${t.key} jumped ${(t.sr - p).toFixed(1)} m in a quarter second`);
        }
        assert.ok(t.sr <= t.s + 1e-6, `${t.key} ahead of its timetable`);
      }
      prev.clear();
      for (const t of tr.list) prev.set(t.key, t.sr);
      if (i < 4) continue;
      frames++;
      const hit = touching(tr.list.filter((t) => !t.hidden), 1.4);
      assert.equal(hit, null, `bodies touch at ${hit}`);
    }
    assert.ok(frames > 2000 && tr.list.length > 20, `${tr.list.length} trams`);
  }
});

test('a tram held two minutes by a car waits short of it and makes the time up without a jump', () => {
  let wt = T0;
  const car = { x: 0, z: 0, half: 2.3 };
  const traffic = { actors: [], cars: [] };
  const tr = fleet(() => wt, traffic);
  const pos = { x: -95636, z: -6206 };
  for (let i = 0; i < 40; i++) { wt += 0.5; tr._t = 0; tr.update(0.5, pos, 0.5); }
  const t = tr.list.find((q) => q.v > 5 && q.line.P.L - q.sr > 3000 && q.delay === 0);
  assert.ok(t, 'a tram under way');
  T.pathAtExt(t.line.P, t.sr + 120, at);
  car.x = at.x; car.z = at.z;
  const carArc = t.sr + 120;
  traffic.actors.push(car);
  const dt = 0.1;
  let prev = t.sr, peak = 0, caught = -1;
  for (let i = 0; i < 9000; i++) {
    wt += dt; pos.x = t.x; pos.z = t.z + 30;
    if (i === 1200) traffic.actors.length = 0;       // the car drives off
    tr.update(dt, pos, 0.5);
    assert.ok(tr.live.has(t.key), 'the tram is still about');
    assert.ok(t.sr >= prev - 1e-6, 'never backwards');
    assert.ok((t.sr - prev) / dt <= T.VMAX + 1e-3, `${((t.sr - prev) / dt).toFixed(1)} m/s`);
    assert.ok(t.sr <= t.s + 1e-6, 'never ahead of the timetable');
    if (i < 1200) assert.ok(t.sr < carArc - 2.3, 'it stops short of the car');
    prev = t.sr;
    if (t.delay > peak) peak = t.delay;
    if (i > 1200 && caught < 0 && t.delay === 0) caught = i;
  }
  assert.ok(peak > 80, `held ${peak.toFixed(0)} s`);
  // made up at a quarter of a second a second: about four times the delay
  assert.ok(caught > 0, 'the tram never caught up with its timetable');
  assert.ok((caught - 1200) * dt < peak * 4 + 120, `caught up after ${((caught - 1200) * dt).toFixed(0)} s`);
});

test('sinceAtArc and dueAt invert the timetable', () => {
  const out = { s: 0, v: 0, i: 0, stop: false };
  const lines = [];
  for (const file of files) for (const r of file.routes) if (r.m === 2 && /Pražsk/.test(r.nw ?? '') && lines.length < 12) {
    const l = T.buildTramLine(file, r); if (l) lines.push(l);
  }
  for (const l of lines) {
    for (let t = 7; t < l.dur; t += l.dur / 37) {
      const a = T.arcAt(l, t, out).s;
      const back = T.sinceAtArc(l, a, t);
      assert.ok(back <= t + 1e-6 && Math.abs(T.arcAt(l, back, out).s - a) < 0.05, `line ${l.ref} at ${t.toFixed(0)} s`);
      const due = T.dueAt(l, 3, a) - T.departOf(l, 3);
      assert.ok(due <= t + 0.02 && Math.abs(T.arcAt(l, due + 0.02, out).s - a) < 0.5, `line ${l.ref}: due ${due} for ${t}`);
    }
  }
});
