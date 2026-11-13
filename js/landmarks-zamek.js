// ---- landmarks-zamek.js: the chateau of the lords of Pernštejn ----
// A four-winged Renaissance palace round one courtyard, grown out of a Gothic
// water castle after 1491: white plaster, three storeys of stone-framed
// windows, steep hipped roofs (grey sheet today, as the aerial photo has them;
// the red ones belong to the outbuildings), round turrets on the eastern
// corners and one slim clock tower with a copper cupola over the west wing.
//
// THE WALLS FOLLOW THE REAL OUTLINE, all 112 vertices and both courtyards, so
// every buttress and both turrets stand where the survey put them. The roofs
// are laid wing by wing over rectangles measured off that outline in the
// palace's own axes (u east, v south), with a flat lead lid closing whatever
// lies between them.
//
// YOU CAN WALK IN. The portal stands in the little gate block of the north
// front, at the end of the bridge from the outer court, and a vaulted passage
// runs from it under the north wing into the courtyard (the tile draws the
// footway up to the portal and on from the courtyard wall, and nothing
// between). The ground climbs two metres on the way, so the passage does.
//
// The ramparts, the bastions' walls and the bridge are js/landmarks-valy.js,
// the gate through them js/landmarks-zamekbrana.js.

import { K } from './landmarkskit.js';
import { Frame, fitFrame } from './landmarksframe.js';
import { clockFace, onion, storeys, TILE } from './landmarks-parts.js';
import { vault, paving, paveRing, portal, cutPassage } from './landmarks-passage.js';

const WALL = 0xebe5d6, WALL_DK = 0xd6cebb, ROOF = 0x5f6c6e, PANE = 0x48586a, STONE = 0xb5a98f;
const HINT = [-0.33, 0.94];                       // the front looks a little west of south
const TOWER = [-12.4, -5.6, 0.6, 7.4], TOWER_H = 31;   // the clock tower: [u0, u1, v0, v1] and its cornice
// The way in, in the palace's axes: centre line and clear width, the crown of
// the vault over the floor, and where the north front and the courtyard wall
// are crossed (v, to a metre: the walls themselves are found in the outline).
const PASS = { uc: 0.02, w: 3.4, h: 4.2, vOut: -35.5, vIn: -7.9 };

// is this edge part of the wall the passage opens in (the wall crossing v = `v` round the centre line)?
function mouthEdge(F, e, v) {
  const a = F.local(e.a[0], e.a[1]), b = F.local(e.b[0], e.b[1]);
  return Math.abs(a[0] - PASS.uc) < 6.5 && Math.abs(b[0] - PASS.uc) < 6.5
    && Math.abs(a[1] - v) < 1.6 && Math.abs(b[1] - v) < 1.6 && Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
}

export function buildZamek(kit, f) {
  const { F } = fitFrame(kit, f.o, HINT[0], HINT[1]);
  const E = 13.6;
  kit.floodFn = (x, y) => (y < E + 0.5 ? 0.92 - 0.25 * (y / E) : 0.45);
  const rows = storeys(3, 1.5, 4.1, 2.1, 1.25, { hex: PANE, glow: 0.14 });
  rows[0] = { ...rows[0], h: 1.7, y: 1.8 };
  const grid = (e) => (e.len < 5.5 ? null : { pitch: 4.3, inset: 0.6, rows, seed: e.i });
  // ---- walls, with the two mouths of the passage left out of them ---------
  // (each mouth is a run of short edges in the outline: they are taken out as
  // a run and put back as ONE wall with the arch in it)
  // Round the courtyard the ground floor is an arcade (the court of the
  // Pernštejns is arcaded): deep round arches in place of the first row of
  // windows, their back wall in the arcade's own shade.
  const arcade = [{ y: 0, h: 3.7, w: 2.9, arch: 1, hex: 0x8c857a, kind: K.plaster, rev: 0.9 }, ...rows.slice(1)];
  const court = (e) => (e.len < 5.5 ? null : { pitch: 4.3, inset: 0.6, rows: arcade, seed: e.i + 50 });
  const runs = [[], []];
  const take = (k, v, g = grid) => (e) => {
    if (!mouthEdge(F, e, v)) return g(e);
    runs[k].push(e.a, e.b);
    return false;
  };
  kit.set(WALL, K.plaster);
  kit.ringWalls(f.o, 0, E, take(0, PASS.vOut));
  // The courtyard lies a storey's sill above the ground the palace is founded
  // on (the footprint falls three metres to the north): its walls start there.
  const yard = (h) => { let x = 0, z = 0; for (const p of h) { x += p[0]; z += p[1]; } return Math.max(0, kit.rel(x / h.length, z / h.length) - 0.3); };
  for (const h of f.i ?? []) {
    if (h.length < 3) continue;
    const yc = yard(h);
    kit.ringWalls(h, yc, E, take(1, PASS.vIn, court), true);
    kit.ringWalls(h, -1.6, yc, null, true);
    // and the court is paved wall to wall (see paveRing), never under the
    // photo ground, which the court's footway lifts up to 0.3 m over the
    // terrain here (landmarks-passage floorAt), and 4 cm over the tile's own
    // plaza (LAYER_Y.paved, drawn where there is no photo: the low preset)
    kit.set(0x9a948a, K.stone);
    paveRing(kit, h, 0.14);
    kit.set(WALL, K.plaster);
  }
  kit.set(WALL_DK, K.stone);
  kit.ringWalls(f.o, -1.8, 0);                        // the footing, where the ground falls away
  passage(kit, F, runs, E, rows);
  // the cornice line and the lid between the roofs
  kit.set(0x55504a, K.metal);
  kit.cap(f.o, f.i, E - 0.03, true);

  // ---- roofs, wing by wing -----------------------------------------------
  kit.set(ROOF, K.slate);
  const R = 7.4;
  F.roof(12.3, 28.5, -27.2, 34.0, E, E + R, { alongV: true, hip0: 8, hip1: 8, over: 0.5 });          // east wing
  F.roof(-10.0, 28.5, 16.3, 33.2, E, E + R, { hip0: 8.4, hip1: 8.4, over: 0.5 });                      // south wing
  F.roof(-18.4, -5.0, -13.2, 20.6, E, E + R * 0.86, { alongV: true, hip0: 6.7, hip1: 6.7, over: 0.5 }); // west wing
  F.roof(-23.2, 28.5, -28.8, -7.9, E, E + R * 1.15, { hip0: 10.4, hip1: 10.4, over: 0.5 });            // north wing
  F.roof(-31.0, -8.8, -38.6, -13.0, E, E + R * 1.2, { alongV: true, hip0: 11, hip1: 11, over: 0.5 }); // the old north-west palace
  F.roof(-8.6, 4.2, -35.6, -28.8, E, E + 3.6, { hip0: 3.3, hip1: 3.3, over: 0.4 });
  F.roof(17.8, 28.3, 31.6, 41.0, E, E + 4.6, { alongV: true, hip0: 0, hip1: 4.6, over: 0.4 });         // the gate house by the bridge
  // the two round turrets on the east side under their cones
  for (const [u, v, r] of [[28.8, -30.9, 4.1], [29.3, 37.6, 3.9]]) {
    const [x, z] = F.xz(u, v);
    kit.set(WALL, K.plaster);
    kit.lathe(x, z, [[r - 0.25, E - 0.4], [r - 0.25, E + 2.2]], 12);
    kit.set(ROOF, K.slate);
    kit.lathe(x, z, [[r + 0.35, E + 2.1], [0, E + 9.2]], 12);
  }
  // dormers along the long roofs, as the palace wears them
  kit.set(WALL_DK, K.plaster);
  for (const v of [-18, -6, 6, 18]) F.box(27.2, 28.9, v - 0.9, v + 0.9, E, E + 2.4, { r: { cols: 1, rows: [{ y: 0.5, h: 1.4, w: 0.9, hex: PANE }] } });
  for (const u of [-2, 8, 18]) F.box(u - 0.9, u + 0.9, 31.9, 33.6, E, E + 2.4, { f: { cols: 1, rows: [{ y: 0.5, h: 1.4, w: 0.9, hex: PANE }] } });

  // ---- the clock tower over the west wing --------------------------------
  const T = TOWER, TH = TOWER_H;
  const slit = { cols: 1, rows: [{ y: 4, h: 1.5, w: 0.8, hex: PANE }, { y: 9.5, h: 2.2, w: 1.1, arch: 1, hex: 0x221c16, kind: K.wood, rev: 0.3 }] };
  kit.set(WALL, K.plaster);
  const S = F.sub(0, 0, E - 0.5);
  S.box(T[0], T[1], T[2], T[3], 0, TH - E + 0.5, { f: slit, b: slit, l: slit, r: slit }, false);
  kit.set(WALL_DK, K.stone);
  F.box(T[0] - 0.3, T[1] + 0.3, T[2] - 0.3, T[3] + 0.3, TH - 0.6, TH, null, true, true);
  const um = (T[0] + T[1]) / 2, vm = (T[2] + T[3]) / 2, hs = (T[1] - T[0]) / 2;
  for (const [u, v, turn] of [[um, T[3], 0], [um, T[2], Math.PI], [T[1], vm, Math.PI / 2], [T[0], vm, -Math.PI / 2]])
    clockFace(kit, F.sub(u, v, 0, turn), TH - 4.2, 1.5, 0xe9e4d6);
  kit.set(TILE, K.tile);
  F.pyramid(T[0] - 0.3, T[1] + 0.3, T[2] - 0.3, T[3] + 0.3, TH, TH + 2.2, 0.5);
  const [tx, tz] = F.xz(um, vm);
  onion(kit, tx, tz, TH + 2.2, hs * 0.5);
}

// The passage: the two mouths as one wall each, the vault between them, its
// paving, and the stone portal on the north front.
function passage(kit, F, runs, E, rows) {
  const half = PASS.w / 2, uL = PASS.uc - half, uR = PASS.uc + half;
  // a run of edges as the one segment from its lowest u to its highest
  const span = (pts) => {
    let a = null, b = null, ua = Infinity, ub = -Infinity;
    for (const p of pts) { const u = F.local(p[0], p[1])[0]; if (u < ua) { ua = u; a = p; } if (u > ub) { ub = u; b = p; } }
    return a && b && ub - ua > PASS.w + 1 ? { a, b, la: F.local(a[0], a[1]), lb: F.local(b[0], b[1]) } : null;
  };
  const out = span(runs[0]), inn = span(runs[1]);
  if (!out || !inn) {
    // an outline that no longer offers the mouths: close the walls again
    kit.set(WALL, K.plaster);
    for (const r of runs) for (let i = 0; i + 1 < r.length; i += 2) {
      const [ax, az] = r[i], [bx, bz] = r[i + 1], L = Math.hypot(bx - ax, bz - az) || 1;
      for (const s of [1, -1]) kit.wall(r[i], r[i + 1], 0, E, s * (bz - az) / L, -s * (bx - ax) / L);
    }
    return;
  }
  const vAt = (m, u) => m.la[1] + (m.lb[1] - m.la[1]) * (u - m.la[0]) / (m.lb[0] - m.la[0]);
  const floor = (v) => kit.rel(...F.xz(PASS.uc, v));
  const yO = floor(vAt(out, PASS.uc)), yI = floor(vAt(inn, PASS.uc));
  // one wall with an arch in the middle of it, flanked by plain wall out to the run's ends
  const mouthWall = (m, y, facing, upper) => {
    const dir = F.dir(0, facing), lo = Math.min(0, y) - 0.4;
    const P = (u) => F.xz(u, vAt(m, u));
    const g0 = PASS.uc - half - 0.9, g1 = PASS.uc + half + 0.9;
    kit.set(WALL, K.plaster);
    if (g0 - m.la[0] > 0.05) kit.wall(P(m.la[0]), P(g0), lo, E, dir[0], dir[1]);
    if (m.lb[0] - g1 > 0.05) kit.wallGrid(P(g1), P(m.lb[0]), lo, E, dir[0], dir[1],
      m.lb[0] - g1 > 5 ? { pitch: 4.3, inset: 0.6, rows: upper.map((r) => ({ ...r, y: r.y - lo })), seed: 41 } : { rows: [] });
    kit.wallGrid(P(g0), P(g1), lo, E, dir[0], dir[1], { cols: 1, seed: 40,
      rows: [{ y: 0, h: y + PASS.h - lo, w: PASS.w, arch: 1, open: true }, ...upper.filter((r) => r.y > y + PASS.h + 1).map((r) => ({ ...r, y: r.y - lo }))] });
  };
  mouthWall(out, yO, -1, rows.slice(2));              // (the arms take the first floor's place)
  mouthWall(inn, yI, 1, rows.slice(1).map((r) => ({ ...r, y: r.y + 0.6 })).filter((r) => r.y + r.h < E - 0.4));
  kit.set(0xd6cfbd, K.plaster);
  vault(kit, F, { uc: PASS.uc, w: PASS.w, h: PASS.h, vL0: vAt(out, uL), vR0: vAt(out, uR), vL1: vAt(inn, uL), vR1: vAt(inn, uR), y0: yO, y1: yI });
  kit.set(0x8f8a80, K.stone);
  paving(kit, F, uL, uR, vAt(out, PASS.uc) - 0.3, vAt(inn, PASS.uc) + 0.3);
  // the portal of 1529 on the north front, in the plane of its own wall
  const [mx, mz] = F.xz(PASS.uc, vAt(out, PASS.uc));
  const ex = out.b[0] - out.a[0], ez = out.b[1] - out.a[1], n = F.dir(0, -1);
  const s = (ez * n[0] - ex * n[1]) > 0 ? 1 : -1;
  portal(kit, new Frame(kit, mx, mz, s * ez, -s * ex, 0), yO, PASS.w, PASS.h, STONE, true);
}

/**
 * Solid as built: the four wings to their cornice (l.top) with the passage cut
 * through the north one, courtyards open, the masonry over the passage, and
 * the clock tower.
 */
export function zamekSolids(f, l) {
  const { F } = fitFrame(null, f.o, HINT[0], HINT[1]);
  const half = PASS.w / 2, uL = PASS.uc - half, uR = PASS.uc + half;
  const tower = { ring: F.ring(...TOWER), holes: null, top: TOWER_H, bot: 0 };
  // the courtyard the passage leads into: the hole its inner mouth crosses
  const holes = (f.i ?? []).filter((h) => h.length >= 3);
  for (const court of holes) {
    const cut = cutPassage(f.o, court, F, uL, uR, PASS.vOut, PASS.vIn);
    if (!cut) continue;
    const rest = holes.filter((h) => h !== court);
    return [{ ring: cut, holes: rest.length ? rest : null, top: l.top, bot: 0 },
      { ring: F.ring(uL, uR, PASS.vOut - 0.6, PASS.vIn), holes: null, top: l.top, bot: PASS.h + 1.9 }, tower];
  }
  return [{ ring: f.o, holes: f.i ?? null, top: l.top, bot: 0 }, tower];
}

/** The passage's centre line, portal to courtyard, for whoever walks it (js/landmarks-walks.js). */
export function zamekAxis(f) {
  const { F } = fitFrame(null, f.o, HINT[0], HINT[1]);
  return [F.xz(PASS.uc, PASS.vOut), F.xz(PASS.uc, PASS.vIn)];
}
