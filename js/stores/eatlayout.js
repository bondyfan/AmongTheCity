// ---- stores/eatlayout.js: the inside of a fast-food restaurant ----
// Pure numbers (js/stores/layout.js roomOf gives the room and its axes: `a` in
// from the front wall, `b` along it). A Czech restaurant of these chains,
// walked from the door: self-order kiosks just inside, the counter with the
// pick-up screen straight ahead across the back, the kitchen in steel behind
// it, and tables on both sides of the way between the two.

import { roomOf } from './layout.js';
import { hashK } from './site.js';

const MODULE = 1.3;

/**
 * eatLayout(site) -> { room, fixtures, points, seats, staff, lane, counter }
 *   seats[]  { i, a, b, x, z, face: +1|-1 (looks toward +a or -a), table }
 *   staff[]  where the crew stand: { a, b, x, z, role: 'till'|'kitchen' }
 */
export function eatLayout(site) {
  const room = roomOf(site), { W, D, bd } = room, E = site.chain.eat ?? {};
  const fixtures = [], points = [], seats = [], staff = [];
  const fx = (t, a, b, along, len, o) => { const f = { t, a, b, along, len, ...o }; fixtures.push(f); return f; };
  const pt = (kind, a, b, o) => { const [x, z] = room.at(a, b); const p = { kind, a, b, x, z, ...o }; points.push(p); return p; };

  // ---- the kitchen across the back, the counter in front of it ----
  const kd = Math.max(2.8, Math.min(5.5, D * 0.32));
  const aC = D - kd - 0.45;                                  // the counter's line
  const cLen = Math.max(2 * MODULE, Math.floor(Math.min(W - 1.6, 9.2) / MODULE) * MODULE);
  const cb = Math.max(cLen / 2 + 0.6, Math.min(W - cLen / 2 - 0.6, bd));
  fx('counter', aC, cb, 'b', cLen);
  fx('menu', aC + 1.4, cb, 'b', cLen, { face: -1 });
  fx('steel', D - 0.5, cb, 'b', cLen);
  // what is left of the back strip beside the counter is closed off
  for (const [p, q] of [[0.1, cb - cLen / 2], [cb + cLen / 2, W - 0.1]]) {
    const n = Math.floor((q - p) / MODULE);
    if (n >= 1) fx('partition', aC, (p + q) / 2, 'b', n * MODULE);
  }
  const nT = Math.max(1, Math.min(E.tills ?? 2, Math.floor(cLen / 1.9)));
  const counter = [];
  for (let i = 0; i < nT; i++) {
    const b = cb - cLen / 2 + cLen * (i + 0.5) / nT;
    counter.push(pt('counter', aC - 0.95, b, { i }));
    const [x, z] = room.at(aC + 0.85, b);
    staff.push({ a: aC + 0.85, b, x, z, role: 'till' });
  }
  for (let i = 0; i < 2; i++) {
    const b = cb - cLen / 4 + i * cLen / 2, [x, z] = room.at(D - 1.35, b);
    staff.push({ a: D - 1.35, b, x, z, role: 'kitchen' });
  }

  // ---- kiosks inside the door, either side of the way in ----
  const aK = Math.min(3.0, aC * 0.35);
  let nK = 0;
  for (const off of [1.7, -1.7, 3.0, -3.0, 4.3, -4.3]) {
    if (nK >= (E.kiosks ?? 3)) break;
    const b = bd + off;
    if (b < 0.9 || b > W - 0.9 || aC < 6) continue;
    fx('kiosk', aK, b, 'b', 0.6, { single: true });
    pt('kiosk', aK - 0.85, b, { i: nK });
    pt('kiosk', aK + 0.85, b, { i: nK });
    nK++;
  }
  fx('bin', 0.75, bd + (bd > W / 2 ? -1 : 1) * 2.4, 'b', 0.7, { single: true });

  // ---- tables: a grid over the floor, the way from the door to the counter kept clear ----
  const a0 = 1.7, a1 = aC - 2.3;
  let ti = 0;
  for (let a = a0; a <= a1 + 0.01; a += 2.35) for (let b = 1.5; b <= W - 1.5 + 0.01; b += 2.6) {
    if (Math.abs(b - bd) < 2.0) continue;                              // the way in
    if (a < aK + 1.9 && Math.abs(b - bd) < 5.4 && nK) continue;        // the kiosks' floor
    fx('table4', a, b, 'b', 1.2, { single: true });
    for (const [da, db] of [[-0.72, -0.3], [-0.72, 0.3], [0.72, -0.3], [0.72, 0.3]]) {
      // a chair on the front side of its table looks into the room (+a), and the other way round
      const face = da < 0 ? 1 : -1;
      fx('chair', a + da, b + db, 'b', 0.4, { single: true, yaw: face > 0 ? Math.PI : 0 });
      const [x, z] = room.at(a + da, b + db);
      seats.push({ i: seats.length, a: a + da, b: b + db, x, z, face, table: ti });
    }
    ti++;
  }
  return { kind: 'fast', room, fixtures, points, seats, staff, counter, lane: { c: bd, b0: bd - 1.2, b1: bd + 1.2 },
    aC, aK, key: site.key, seed: (s) => hashK(site.key, s) };
}
