// ---- facades: depth, weather and glass on both tiers, and a cheaper shell ----
// What a GPU-less test can pin of js/facadefx.js and its two users:
//   - the per-cell table the shader traces from says what typology says (the
//     window band and width the painter drew and pieces.js cuts, the blank and
//     loggia bays), at the address the shader computes from a uv;
//   - every material that runs the trace really got it: the three patched
//     programs resolve with three's own chunks, every fx* name they use is
//     declared, the brackets balance, the uniforms are bound;
//   - the near shell draws its solid pieces in the atlas batch (one InstancedMesh
//     fewer per building, in the main pass and the shadow pass) and culls
//     against one sphere that holds every piece, and both switch back;
//   - the near pane sits at the depth the far shader traces to.
// What it cannot pin (that the GLSL compiles, and how it looks) is for the game.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const T = await import('../js/typologycells.js');
const FX = await import('../js/facadefx.js');
const { buildFacadeMaterial } = await import('../js/facadeatlas.js');
const { BuildingModel } = await import('../js/destructible.js');
const { buildingPlan, classify, hasInterior } = await import('../js/interiors.js');
const { shellPieces } = await import('../js/pieces.js');
const { facadeCells, buildingWallHex } = await import('../js/meshes.js');
const { distPointToSegment } = await import('../js/geo.js');

// No <canvas> in node: the atlas and the wordmarks take their own no-context
// path (plain plaster, plain sign colour), and the shaders are the same.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
let _id = 1;
for (const b of tile.buildings) b._id = _id++;
const buildings = tile.buildings.filter((b) => b.o && b.o.length >= 3);

test('the cell table says what typology says, where the shader looks for it', () => {
  const N = T.ATLAS_N * T.ATLAS_M, d = FX.cellTable();
  assert.equal(d.length, N * 2 * 4);
  for (const c of T.CELL_LIST) {
    const F = T.FAMILIES[c.fam];
    // the shader's address: int(u * N) + (M - 1 - int(v * M)) * N, at the centre of the rect
    const r = T.cellRect(c.ci, c.ri);
    const u = (r[0] + r[2]) / 2, v = (r[1] + r[3]) / 2;
    const i = Math.floor(u * T.ATLAS_N) + (T.ATLAS_M - 1 - Math.floor(v * T.ATLAS_M)) * T.ATLAS_N;
    assert.equal(i, c.ci + c.ri * T.ATLAS_N, `${c.fam}/${c.role}: the shader reads another column`);
    const w = d.subarray(i * 4, i * 4 + 4), k = d.subarray((N + i) * 4, (N + i) * 4 + 4);
    const open = !F.solid && !!F.band && c.role !== 'gable' && c.role !== 'door';
    if (open) {
      assert.ok(Math.abs(w[0] - F.band[0]) < 1e-6 && Math.abs(w[1] - F.band[1]) < 1e-6, 'window band');
      assert.ok(Math.abs(w[2] - F.frac) < 1e-6, 'window width');
      assert.ok(Math.abs(k[1] - T.GLASS_DEPTH[c.fam]) < 1e-6, `${c.fam}: glass depth`);
    } else assert.equal(k[1], 0, `${c.fam}/${c.role} has no opening to trace`);
    const mask = Math.floor(w[3]), sill = w[3] - mask;
    assert.ok(sill >= 0 && sill < 0.1, 'a sill stands out less than 10 cm');
    const blank = c.fam === 'house' ? T.HOUSE_BLANK[c.v]
      : c.fam === 'panel' && c.role === 'mid' ? T.PANEL_BALC[c.v] : [0, 0, 0, 0];
    for (let b = 0; b < T.BAYS; b++)
      assert.equal((mask >> b) & 1, blank[b] ? 1 : 0, `${c.fam}/${c.role}/${c.v}: bay ${b}`);
    assert.ok(k[2] >= 0 && k[2] < 1.05 && k[3] >= 0 && k[3] < 0.5, 'a ledge in the storey, under half a metre');
    assert.ok(k[0] >= 0 && k[0] <= 4 && Number.isInteger(k[0]), 'role');
  }
  const tex = FX.cellTexture();
  assert.equal(tex.image.width, N);
  assert.equal(tex.type, THREE.FloatType);
  assert.equal(tex.minFilter, THREE.NearestFilter);
});

// three's own include resolution, so the lint sees what the GPU would be given
const resolve = (s) => s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (m, k) => {
  assert.ok(THREE.ShaderChunk[k] !== undefined, `unknown chunk ${k}`);
  return resolve(THREE.ShaderChunk[k]);
});
function patched(mat) {
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  mat.onBeforeCompile(sh, null);
  return sh;
}
function lint(name, sh) {
  const fs = resolve(sh.fragmentShader);
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']])
    assert.equal(fs.split(o).length, fs.split(c).length, `${name}: unbalanced ${o}${c}`);
  const declared = new Set();
  for (const m of fs.matchAll(/\b(?:float|int|bool|vec[234]|ivec2|void)\s+(fx[A-Z]\w*)/g)) declared.add(m[1]);
  for (const m of fs.matchAll(/,\s*(fx[A-Z]\w*)\s*=/g)) declared.add(m[1]);
  for (const m of fs.matchAll(/\bfx[A-Z]\w*/g))
    assert.ok(declared.has(m[0]), `${name}: ${m[0]} used and never declared`);
  assert.ok(sh.uniforms.uFx === FX.FACADE_FX, `${name}: the shared switch is bound`);
  assert.ok(sh.uniforms.uCellTab?.value === FX.cellTexture(), `${name}: the cell table is bound`);
  assert.ok(!/\bfxMpp\b/.test(fs) || declared.has('fxMpp'));
  return fs;
}

test('the far wall material traces, weathers and reflects', () => {
  const sh = patched(buildFacadeMaterial());
  assert.ok(!sh.fragmentShader.includes('#include <map_fragment>'), 'the atlas lookup was replaced');
  const fs = lint('facade', sh);
  assert.ok(fs.includes('fxTrace(vMapUv'), 'walls are traced');
  assert.ok(fs.includes('reflectedLight.directDiffuse *= fxSun'), 'the traced sun reaches the light');
  assert.ok(fs.indexOf('reflectedLight.directDiffuse *= fxSun') > fs.indexOf('RE_Direct( directLight'),
    'after the lights have run');
  assert.ok(fs.includes('winMask = tx.a * step(fxKind, 0.5)'), 'a lit window does not light its own reveal');
  // the derivatives are taken before the roof/wall branch, never inside it
  assert.ok(fs.indexOf('fxDUx = dFdx(vMapUv)') < fs.indexOf('if (vMapUv.y >'));
  assert.ok(sh.fragmentShader.includes('uNight.y'), 'the night windows survive');
  assert.notEqual(buildFacadeMaterial().customProgramCacheKey(), 'atc-facade-v4');
});

// One real building through the real path interiorsim takes (plan, facade
// cells, wall colour, shell, then the rooms), so the materials and the mesh
// set under test are the ones the game makes.
function model() {
  for (const b of buildings) {
    if (!hasInterior(b) || classify(b) !== 'flats') continue;
    const plan = buildingPlan(b, null);
    if (plan.storeys < 3) continue;
    plan.wallHex = buildingWallHex(b);
    plan.cells = facadeCells(b);
    plan.facades = true;
    const m = new BuildingModel(new THREE.Scene(), b, plan, {}, { shellOnly: true });
    m.addShell();
    if (!m.alive) continue;
    m.ensureInterior();
    return m;
  }
  throw new Error('no block of flats in the tile');
}

test('the near shell and its glass run the same trace and sky', () => {
  const m = model();
  assert.ok(m._shell && m._glass, 'a block of flats has an atlas batch and glass');
  const shell = patched(m._shell.material);
  const fs = lint('shell', shell);
  assert.ok(fs.includes('fxSkip = vBounce'), 'an interior box is not weathered');
  assert.ok(resolve(shell.vertexShader).includes('vBounce = step(aUvRect.x, -0.5)'));
  const glass = patched(m._glass.material);
  const gs = lint('glass', glass);
  assert.ok(gs.includes('fxReflect(normal'), 'a near pane reflects the same sky');
  assert.ok(glass.uniforms.uNight, 'and still lights at night');
  m.dispose();
});

const meshes = (m) => [m._solid, m._glass, m._shell, m._sign, ...(m._words ?? [])].filter(Boolean);
test('the shell draws its solid pieces in the atlas batch, and culls on one true sphere', () => {
  const m = model();
  assert.equal(m._solid, null, 'no second opaque InstancedMesh per building');
  const live = m.pieces.filter((p) => !p.dead);
  const solid = live.filter((p) => !p.uv && p.kind !== 'glass' && p.kind !== 'sign').length;
  assert.ok(solid > 50, `the rooms are in (${solid} solid pieces)`);
  const rect = m._uvRect.array;
  let bounce = 0;
  for (let i = 0; i < m._shell.count; i++) if (rect[i * 4] < -0.5) bounce++;
  assert.equal(bounce, solid, 'every solid piece rides in the batch as a bounce instance');
  const shellN = m._shell.count;
  // one sphere, holding every piece, on every mesh, culled
  for (const mesh of meshes(m)) {
    assert.equal(mesh.frustumCulled, true);
    assert.equal(mesh.boundingSphere, m._sphere);
  }
  for (const p of m.pieces) {
    const c = m._sphere.center, r = m._sphere.radius;
    const far = Math.hypot(Math.abs(p.x - c.x) + p.ax, Math.abs(p.y - c.y) + p.hy, Math.abs(p.z - c.z) + p.az);
    assert.ok(far <= r + 1e-6, 'a piece outside the bounding sphere would be culled while in view');
  }
  // the console switches put the old arrangement back, and the counts add up
  FX.facadeFxApi.merge(false);
  FX.facadeFxApi.cull(false);
  try {
    assert.ok(m._solid, 'merge(false): the solid batch is back');
    assert.equal(m._solid.count, solid);
    assert.equal(m._shell.count, shellN - solid);
    for (const mesh of meshes(m)) assert.equal(mesh.frustumCulled, false);
  } finally {
    FX.facadeFxApi.merge(true);
    FX.facadeFxApi.cull(true);
  }
  assert.equal(m._solid, null);
  assert.equal(m._shell.count, shellN);
  m.dispose();
});

test('the switch: the preset drives it, the console overrides it and hands it back', () => {
  assert.deepEqual(FX.facadeFxApi.fx(false), { depth: false, weather: false, glass: false, console: true, preset: true });
  FX.syncFacadeFx();
  assert.equal(FX.FACADE_FX.value.x, 0, 'a console override survives the per-frame sync');
  FX.facadeFxApi.fx(true, false, true);
  assert.deepEqual([FX.FACADE_FX.value.x, FX.FACADE_FX.value.y, FX.FACADE_FX.value.z], [1, 0, 1]);
  const s = FX.facadeFxApi.fx();
  assert.deepEqual(s, { depth: true, weather: true, glass: true, console: false, preset: true });
});

test('a near pane sits at the depth the far shader traces its painted glass to', () => {
  let checked = 0;
  for (const b of buildings) {
    if (checked > 400) break;
    if (!hasInterior(b)) continue;
    const use = classify(b);
    if (use !== 'flats' && use !== 'house') continue;
    const plan = buildingPlan(b, null);
    if (!plan.rows || plan.rows.front || plan.nova || plan.use === 'office') continue;
    const want = T.GLASS_DEPTH[plan.rows.family];
    if (want === undefined) continue;
    const ring = plan.ring, probe = { x: 0, z: 0, t: 0 };
    for (const p of shellPieces(plan)) {
      if (p.kind !== 'glass' || p.leaf !== 'ext') continue;
      // its own wall: the nearest edge running the pane's way, in the same
      // sense (pieces.js gives a pane its edge's yaw), because a sliver of a
      // footprint can put the opposite wall 20 cm behind the one it is set in
      let dmin = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const yaw = Math.atan2(-(c[1] - a[1]), c[0] - a[0]);
        if (Math.cos(yaw - p.yaw) < 0.9998) continue;
        dmin = Math.min(dmin, distPointToSegment(p.x, p.z, a[0], a[1], c[0], c[1], probe));
      }
      const face = dmin - p.hz;                  // the pane's outer face, behind the wall's
      assert.ok(Math.abs(face - want) < 0.012,
        `${plan.rows.family} #${b._id}: glass ${face.toFixed(3)} m in, the far tier traces ${want}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} panes compared`);
});
