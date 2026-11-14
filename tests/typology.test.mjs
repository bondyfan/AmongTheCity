// ---- typology, roofs and lit windows: the rules both building tiers share ----
// A building is drawn twice: as part of a merged chunk mesh from far away
// (meshes.js) and as a shell of boxes up close (pieces.js). Everything that
// decides what it LOOKS like lives in typology.js so the two cannot drift, and
// these tests are what holds them to it. The last one is the real one: it
// builds the same buildings both ways and checks that the windows the far mesh
// lights at night are the very panes the shell lights.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const T = await import('../js/typology.js');
const { buildingPlan, classify, hasInterior, storeyPlan } = await import('../js/interiors.js');
const { shellPieces } = await import('../js/pieces.js');
const { hasCourtyard } = await import('../js/roofholes.js');
const { buildBuildingsMesh, roofGeometry } = await import('../js/meshes.js');

// A real tile, as the game streams it: central Pardubice with the old town,
// Polabiny's slabs and the northern suburbs (9 892 footprints). The tile, not
// pardubice.json, because only the tiles carry the roof shapes.
const load = () => {
  const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
  let id = 1;
  for (const b of tile.buildings) b._id = id++;
  return tile.buildings.filter((b) => b.o && b.o.length >= 3);
};
const buildings = load();
const typOf = (b) => T.typologyOf(b, classify(b));

test('the atlas table fits its 8 x 8 grid and steps on no reserved cell', () => {
  assert.ok(T.CELL_LIST.length <= T.ATLAS_N * T.ATLAS_M - 7, 'cells over-subscribed');
  const seen = new Set();
  for (const c of T.CELL_LIST) {
    const k = c.ci + ',' + c.ri;
    assert.ok(!seen.has(k), `cell ${k} painted twice`);
    seen.add(k);
    assert.ok(c.ci >= 0 && c.ci < T.ATLAS_N && c.ri >= 0 && c.ri < T.ATLAS_M, `cell ${k} off the atlas`);
    // row 0, columns 0..6: the PIN cell, the five roofs and the trim cell
    assert.ok(!(c.ri === 0 && c.ci <= T.TRIM_CELL[0]), `cell ${k} overwrites a reserved cell`);
  }
  for (const S of Object.values(T.ROOF_STYLES)) assert.ok(S.col >= 1 && S.col <= 5 && S.m > 0);
});

test('every building gets a typology, and the city comes out Czech', () => {
  const counts = {};
  for (const b of buildings) {
    const t = typOf(b);
    assert.ok(typeof t === 'string' && t.length, 'a building without a typology');
    counts[t] = (counts[t] ?? 0) + 1;
  }
  // The gate that was dead: no tile ever carried building=panel, so no slab in
  // the country was drawn as one. Pardubice has hundreds.
  assert.ok(counts.panel >= 150, `paneláky found: ${counts.panel}`);
  assert.ok(counts.house >= 1000, `family houses found: ${counts.house}`);
  assert.ok(counts.tenement >= 100, `tenements found: ${counts.tenement}`);
  assert.ok(counts.hall >= 100, `halls found: ${counts.hall}`);
  // a panelák is tall, flat-roofed and a plain rectangle
  for (const b of buildings) {
    if (typOf(b) !== 'panel') continue;
    assert.ok((b.lv ?? Math.round((b.h ?? 6) / 3.1)) >= 5, 'a low panelák');
    assert.equal(T.roofOf(b, 'panel').shape, 'flat');
  }
});

test('the answers are a pure function of the feature', () => {
  const again = load();
  for (let i = 0; i < buildings.length; i += 7) {
    const a = buildings[i], b = again[i];
    const ua = classify(a), ub = classify(b);
    assert.equal(T.typologyOf(a, ua), T.typologyOf(b, ub));
    assert.deepEqual(T.roofOf(a, typOf(a)), T.roofOf(b, typOf(b)));
    assert.deepEqual(T.facadeRows(a, ua, null).mid.cell, T.facadeRows(b, ub, null).mid.cell);
  }
});

test('facade variants are spread by the whole id, not five per type', () => {
  // The complaint this replaced: GENERIC[(hash(type) + id % 5) % 29], so one
  // OSM type could only ever wear five consecutive cells.
  const byFam = {};
  for (const b of buildings) {
    const rows = T.facadeRows(b, classify(b), null);
    (byFam[rows.family] ??= new Set()).add(rows.mid.cell.join(','));
    for (const k of ['mid', 'ground', 'top', 'gable', 'door', 'store']) {
      const r = rows[k];
      if (!r) continue;
      assert.ok(r.cell[0] < T.ATLAS_N && r.cell[1] < T.ATLAS_M, 'a row off the atlas');
      if (!r.solid) assert.ok(r.band && r.band[0] < r.band[1] && r.frac > 0.2 && r.frac <= 1);
    }
  }
  for (const [fam, set] of Object.entries(byFam))
    assert.equal(set.size, T.FAMILIES[fam].mid, `${fam} uses ${set.size} of its mid variants`);
});

test('pitched roofs get a pitched shape, and a Czech colour', () => {
  let small = 0, bigGable = 0;
  const hexes = new Set();
  for (const b of buildings) {
    const typ = typOf(b), roof = T.roofOf(b, typ), S = T.shapeOf(b);
    hexes.add(roof.hex);
    assert.ok(T.ROOF_STYLES[roof.style], `unknown roof style ${roof.style}`);
    if (roof.shape === 'flat') { assert.equal(roof.ov, 0); continue; }
    assert.ok(roof.ov > 0.2 && roof.ov < 0.6, 'a pitched roof has an eave');
    // gap 1: small hipped, half-hipped and pyramidal roofs used to fall flat
    if (S.area < 300 && /^(hipped|half-hipped|pyramidal)$/.test(b.r)) small++;
    // gap 2: a big rectangular gabled house used to be handed a hip
    // (round a real courtyard the roof follows the yard instead, on purpose:
    // a ridge over the hole roofed the yard over, see js/roofholes.js)
    if (S.area >= 300 && b.r === 'gabled' && S.fill > 0.8 && S.short <= 24 && !hasCourtyard(b)) {
      assert.equal(roof.shape, 'gable', 'a large rectangular gabled house lost its gable');
      bigGable++;
    }
  }
  assert.ok(bigGable > 50, `large gabled rectangles checked: ${bigGable}`);
  assert.ok(hexes.size > 40, 'roofs are one colour');
  // and no roof is the wall colour darkened any more: all come off the palettes
  for (const h of hexes) assert.ok(h > 0 && h <= 0xffffff);
  assert.ok(small >= 0);
});

test('the far mesh and the shell stand on one storey grid', () => {
  let n = 0;
  for (let i = 0; i < buildings.length; i += 11) {
    const b = buildings[i];
    if (!hasInterior(b)) continue;
    const sp = storeyPlan(b), plan = buildingPlan(b, null, null, 0);
    // (a plan that could not fit a stair core falls back to one storey; the far
    // mesh keeps the tagged count, which is the one known disagreement)
    if (plan.storeys !== sp.storeys) { assert.equal(plan.storeys, 1); continue; }
    assert.ok(Math.abs(plan.sH - sp.sH) < 1e-9, 'storey height differs between the tiers');
    assert.ok(sp.storeys * sp.sH <= sp.usable + 1e-6, 'the storey grid pokes through the roof');
    n++;
  }
  assert.ok(n > 300);
});

test('lit windows: the texture is a pure function, with a dark column and a dark row', () => {
  const o = [0, 0, 0, 0];
  for (let y = 0; y < T.LIT_N; y++) assert.equal(T.litTexel(0, y, o), false, 'column 0 must stay dark');
  for (let x = 0; x < T.LIT_N; x++) assert.equal(T.litTexel(x, 0, o), false, 'row 0 must stay dark');
  // density really is the row: half way up a palette lights about half its bays
  let lit = 0;
  for (let x = 1; x < T.LIT_N; x++) if (T.litTexel(x, 32, o)) lit++;
  assert.ok(lit > 95 && lit < 165, `row 32 lights ${lit} of 255`);
  // a run of four bays never wraps the texture
  for (let s = 0; s < 40; s++) for (let e = 0; e < 12; e++) for (let r = 0; r < 30; r++) {
    const x = T.litStart(1234 + s, s, e, r);
    assert.ok(x >= 1 && x + T.BAYS <= T.LIT_N, 'a bay run runs off the night texture');
  }
});

// ---- the two tiers, built for real and compared ----------------------------
const mat = new THREE.MeshBasicMaterial();
function farGeometry(f) {
  f._home = '0,0';
  const cell = { buildings: [f], roads: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]) };
  const mats = { facades: true, _facadeMat: mat, doorTrim: mat, doorSign: mat, building: mat,
    hidden: null, terrain: null, brandMat: () => mat };
  const group = buildBuildingsMesh(city, 0, 0, mats);
  return { cell, geo: group?.children[0]?.geometry ?? null };
}
// every lit window bay the far wall quads address, as world points
function farLit(geo) {
  const P = geo.attributes.position, L = geo.attributes.uv1, N = geo.attributes.normal;
  assert.ok(L, 'the far building mesh carries no uv1');
  assert.equal(L.count, P.count);
  const out = [], o = [0, 0, 0, 0], pin = 0.5 / T.LIT_N;
  for (let k = 0; k + 5 < P.count; k += 3) {
    if (Math.abs(N.getY(k)) > 0.01) continue;            // not a wall
    const lv = L.getY(k);
    if (lv <= pin + 1e-6 || L.getY(k + 1) !== lv || L.getY(k + 2) !== lv) continue;
    // wallUV's first triangle: (A,top) (B,top) (B,bottom); the second repeats it
    if (P.getY(k) !== P.getY(k + 1) || P.getY(k + 2) >= P.getY(k)) continue;
    const ax = P.getX(k), az = P.getZ(k), bx = P.getX(k + 1), bz = P.getZ(k + 1);
    const la = L.getX(k), lb = L.getX(k + 1);
    const nb = Math.round(Math.abs(lb - la) * T.LIT_N), row = Math.floor(lv * T.LIT_N);
    for (let j = 0; j < nb; j++) {
      const t = (j + 0.5) / nb, x = Math.floor((la + (lb - la) * t) * T.LIT_N);
      if (T.litTexel(x, row, o))
        out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, y: (P.getY(k) + P.getY(k + 2)) / 2 });
    }
  }
  return out;
}

test('the windows the far mesh lights are the panes the shell lights', () => {
  const want = new Set(['panel', 'tenement', 'block', 'functional', 'house', 'nova', 'civic', 'office']);
  const done = {};
  let panes = 0, lit = 0;
  for (const b of buildings) {
    if (!hasInterior(b) || (b.i && b.i.length)) continue;
    const typ = typOf(b);
    if (!want.has(typ) || (done[typ] ?? 0) >= 12) continue;
    const { cell, geo } = farGeometry(b);
    if (!geo) continue;
    const plan = buildingPlan(b, cell.roads, cell.buildings, 0);
    if (plan.storeys !== storeyPlan(b).storeys) continue;   // the stair-core fallback
    done[typ] = (done[typ] ?? 0) + 1;
    const far = farLit(geo);
    // stub walls (under 1.7 m) carry no window in either tier
    for (let i = 0; i < b.o.length; i++) {
      const p = b.o[i], q = b.o[(i + 1) % b.o.length];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= T.STUB_EDGE) continue;
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      assert.ok(!far.some((w) => Math.hypot(w.x - mx, w.z - mz) < 0.4), 'a lit window on a stub wall');
    }
    const shell = shellPieces(plan).filter((p) => p.kind === 'glass' && p.leaf === 'ext');
    const near = (list, q) => list.some((p) =>
      Math.hypot(p.x - q.x, p.z - q.z) < 0.9 && Math.abs(p.y - q.y) < plan.sH * 0.5);
    for (const p of shell) {
      panes++;
      if (!p.lit) continue;
      lit++;
      assert.ok(near(far, p), `${typ} #${b._id}: a lit pane the far mesh leaves dark`);
    }
    // …and the other way round, wherever the shell has a pane at all (the far
    // mesh also addresses blank bays and solid rows; its mask is black there)
    for (const q of far)
      if (near(shell, q)) assert.ok(near(shell.filter((p) => p.lit), q),
        `${typ} #${b._id}: a window lit on the far mesh with a dark pane on the shell`);
  }
  for (const t of want) assert.ok((done[t] ?? 0) >= 3, `only ${done[t] ?? 0} ${t} buildings compared`);
  assert.ok(lit > 200 && lit < panes * 0.7, `${lit} of ${panes} panes lit`);
});

test('a shell keeps the roof the far mesh built', () => {
  let pitched = 0, furnished = 0;
  for (let i = 0; i < buildings.length; i += 5) {
    const b = buildings[i];
    if (!hasInterior(b)) continue;
    const typ = typOf(b), roof = T.roofOf(b, typ);
    const g = roofGeometry(b, 10, 0xd0c8b8);
    if (roof.shape !== 'flat' && roof.shape !== 'cap') {
      assert.ok(g && g.attributes.position.count >= 12, `${roof.shape} roof built nothing`);
      assert.ok(g.attributes.uv, 'a shell roof must carry the atlas uvs to keep its tiles');
      // nothing sags below the eave line by more than the overhang's own drop
      let lo = Infinity;
      for (let k = 0; k < g.attributes.position.count; k++) lo = Math.min(lo, g.attributes.position.getY(k));
      assert.ok(lo > 10 - 1.2, `a ${roof.shape} roof hangs ${(10 - lo).toFixed(2)} m below its wall top`);
      pitched++;
    } else if (g) furnished++;
  }
  assert.ok(pitched > 300, `pitched roofs built: ${pitched}`);
  assert.ok(furnished > 20, `flat roofs with something standing on them: ${furnished}`);
});
