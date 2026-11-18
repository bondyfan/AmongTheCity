// ---- the draw-call batching: signals in one mesh, wordmarks in one per chunk ----
// What a frame-time table cannot show: that the instanced masts keep the same
// bookkeeping the per-mast Groups had (who is drawn, which lens is lit, a felled
// mast stays down, a re-seated one moves), that the A/B switch goes back and
// forth without losing a mast, and that merging a chunk's wordmark quads keeps
// every quad where it was with its uvs inside its own label's slot.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { SignalBatch, SIG_DARK } = await import('../js/signalbatch.js');
const { BATCH } = await import('../js/batchflags.js');
const { atlasMark, atlasStats, mergeMarks, releaseMark } = await import('../js/wordmarkatlas.js');
const { sigAssets } = await import('../js/signalmodel.js');

const scene = () => new THREE.Group();
// where an instance stands in the world: its offset plus the mesh's anchor
const posOf = (b, slot) => {
  const e = b.mesh.instanceMatrix.array, o = slot * 16, a = b.mesh.position;
  return [e[o + 12] + a.x, e[o + 13] + a.y, e[o + 14] + a.z];
};

test('masts in range are compact instances, out of range give their slot back', () => {
  const s = scene(), b = new SignalBatch(s);
  const g1 = b.group(), g2 = b.group();
  const p = [b.pole(0, 1, 0, 0), b.pole(10, 2, 0, 0.5), b.pole(20, 3, 0, 1)];
  g1.add(p[0]); g1.add(p[1]); g2.add(p[2]);
  assert.equal(b.mesh, null, 'a mesh was made before anything was in range');
  g1.visible = true; g2.visible = true; b.flush();
  assert.equal(b.mesh.count, 3);
  assert.equal(s.children.length, 1, 'more than one object for all the masts');
  g1.visible = false; b.flush();
  assert.equal(b.mesh.count, 1);
  assert.equal(p[2]._slot, 0, 'the remaining mast was not moved into the freed slot');
  assert.deepEqual(posOf(b, 0), [20, 3, 0]);
  g1.visible = true; b.flush();
  assert.equal(b.mesh.count, 3);
  for (const q of p) assert.deepEqual(posOf(b, q._slot), [q.mesh.position.x, q.mesh.position.y, 0]);
});

test('a lens state is one float on the mast\'s own slot, and it follows a slot move', () => {
  const b = new SignalBatch(scene());
  const g = b.group(), a = b.pole(0, 0, 0, 0), c = b.pole(5, 0, 0, 0);
  g.add(a); g.add(c); g.visible = true; b.flush();
  const st = () => b.mesh.geometry.attributes.sigState.array;
  assert.equal(st()[a._slot], SIG_DARK);
  b.state(a, 2); b.state(c, 0); b.flush();
  assert.equal(st()[a._slot], 2); assert.equal(st()[c._slot], 0);
  b.fell(a); b.flush();
  assert.equal(b.mesh.count, 1);
  assert.equal(c._slot, 0); assert.equal(st()[0], 0, 'the moved mast took the felled one\'s lights');
  g.visible = false; g.visible = true; b.flush();
  assert.equal(b.mesh.count, 1, 'a felled mast came back with its junction');
});

test('re-seating a mast on late terrain moves its instance', () => {
  const b = new SignalBatch(scene());
  const g = b.group(), a = b.pole(3, 0, 4, 0);
  g.add(a); g.visible = true; b.flush();
  a.mesh.position.y = 221.5; b.reseat(a); b.flush();
  assert.deepEqual(posOf(b, a._slot), [3, 221.5, 4]);
});

test('far from the origin the instances are small offsets from an anchor near them', () => {
  // float32 has an 8 mm step at 95 km: world-sized instance offsets broke the
  // 2 mm gap between a lens and its housing into a ragged scrap (seen in game)
  const b = new SignalBatch(scene());
  const g = b.group(), a = b.pole(-94983.2, 212.7, -5334.8, 0), c = b.pole(-94990.4, 213.1, -5300.25, 0);
  g.add(a); g.add(c); g.visible = true; b.flush();
  for (const q of [a, c]) {
    const e = b.mesh.instanceMatrix.array, o = q._slot * 16;
    assert.ok(Math.abs(e[o + 12]) < 100 && Math.abs(e[o + 14]) < 100, 'an instance offset is world-sized');
    const w = posOf(b, q._slot);
    assert.ok(Math.abs(w[0] - q.mesh.position.x) < 1e-3 && Math.abs(w[2] - q.mesh.position.z) < 1e-3);
  }
  // 95 km away (Pardubice after Prague): the anchor follows and nothing moves
  const g2 = b.group(), d = b.pole(25, 220, -122, 0);
  g2.add(d); g2.visible = true; b.flush();
  assert.ok(Math.abs(b.mesh.position.x - 25) < 1, 'the anchor did not move to the new mast');
  for (const q of [a, c, d]) {
    const w = posOf(b, q._slot);
    assert.ok(Math.abs(w[0] - q.mesh.position.x) < 1e-2 && Math.abs(w[2] - q.mesh.position.z) < 1e-2, 'a mast moved on re-anchoring');
  }
});

test('the yaw is the old Group\'s rotation.y: lenses look back down the approach', () => {
  const b = new SignalBatch(scene());
  const g = b.group(), a = b.pole(0, 0, 0, Math.PI / 2);
  g.add(a); g.visible = true; b.flush();
  const m = new THREE.Matrix4().fromArray(b.mesh.instanceMatrix.array, a._slot * 16);
  const ref = new THREE.Object3D(); ref.rotation.y = Math.PI / 2; ref.updateMatrix();
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(m.elements[i] - ref.matrix.elements[i]) < 1e-9, `element ${i}`);
});

test('the growing mesh keeps every mast and its state', () => {
  const b = new SignalBatch(scene());
  const g = b.group(), list = [];
  for (let i = 0; i < 600; i++) { const p = b.pole(i, 0, 0, 0); list.push(p); g.add(p); }
  g.visible = true;
  for (let i = 0; i < 600; i++) b.state(list[i], i % 3);
  b.flush();
  assert.equal(b.mesh.count, 600);
  assert.ok(b.cap >= 600);
  const st = b.mesh.geometry.attributes.sigState.array;
  for (let i = 0; i < 600; i += 37) {
    assert.equal(st[list[i]._slot], i % 3);
    assert.equal(posOf(b, list[i]._slot)[0], i);
  }
});

test('the merged mast carries every part, each lens tagged with its index', () => {
  const b = new SignalBatch(scene());
  const g = b.group(); g.add(b.pole(0, 0, 0, 0)); g.visible = true; b.flush();
  const A = sigAssets(), geo = b.mesh.geometry;
  const n = (x) => x.attributes.position.count;
  assert.equal(n(geo), n(A.pole) + n(A.head) + 3 * n(A.lamp) + 2 * n(A.ped));
  const seen = new Set(geo.attributes.sigLens.array);
  assert.deepEqual([...seen].sort(), [-1, 0, 1, 2, 3, 4]);
  assert.ok(geo.attributes.normal, 'the lit mast lost its normals');
});

test('__batch.signals flips between the instances and the old Groups, both ways', () => {
  const s = scene(), b = new SignalBatch(s);
  const g = b.group(), a = b.pole(0, 0, 0, 0), c = b.pole(4, 0, 0, 0);
  g.add(a); g.add(c); g.visible = true; b.state(a, 2); b.flush();
  try {
    BATCH.signals = false;
    assert.equal(b.mesh.count, 0, 'the instances kept drawing beside the Groups');
    assert.ok(a.obj && c.obj && a.obj.visible, 'no old mast for a mast in range');
    assert.equal(a.obj.children.length, 7);
    const S = sigAssets(), L = a.obj.userData.lamps;
    assert.equal(L[0].material, S.redOn); assert.equal(L[2].material, S.grnOff);
    assert.equal(L[3].material, S.redOff); assert.equal(L[4].material, S.grnOn);
    b.state(a, 0);
    assert.equal(L[0].material, S.redOff); assert.equal(L[2].material, S.grnOn);
    b.fell(c);
    assert.equal(c.obj.visible, false);
  } finally { BATCH.signals = true; }
  assert.equal(a.obj, null, 'an old mast stayed in the scene');
  assert.equal(b.mesh.count, 1, 'the felled mast came back, or the standing one did not');
  assert.equal(b.mesh.geometry.attributes.sigState.array[a._slot], 0);
  assert.equal(s.children.length, 1);
});

test('a junction leaving with its tile leaves nothing behind', () => {
  const s = scene(), b = new SignalBatch(s);
  const g = b.group(); g.add(b.pole(0, 0, 0, 0)); g.visible = true; b.flush();
  g.dispose(); b.flush();
  assert.equal(b.mesh.count, 0);
  assert.equal(b.groups.size, 0);
});

// ---- wordmarks ------------------------------------------------------------------
function fakeLabel(page, u0, v0) {
  const m = new THREE.MeshBasicMaterial();
  m.userData.mark = { page, slot: 0, u0, v0, ru: 0.25, rv: 0.125 };
  return m;
}
function quad(mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 1, 1, 0, 1, 0, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([1, 1, 0, 1, 0, 0]), 2));
  return new THREE.Mesh(g, mat);
}

test('mergeMarks: one mesh per page, quads where they were, uvs inside their slot', () => {
  const page = { mat: new THREE.MeshBasicMaterial() };
  const A = fakeLabel(page, 0.5, 0.25), B = fakeLabel(page, 0, 0.75);
  const root = new THREE.Group(), bld = new THREE.Group();
  root.add(bld);
  const qa = quad(A), qb = quad(B), other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  // the codec's dequantisation rides on the mesh transform: it must be baked in
  qb.position.set(10, 2, -3); qb.scale.setScalar(2);
  bld.add(qa, qb, other);
  mergeMarks(root);
  const merged = bld.children.filter((o) => o.name === 'wordmarks');
  assert.equal(merged.length, 1);
  assert.ok(bld.children.includes(other), 'a mesh that is not a wordmark was taken');
  assert.equal(bld.children.length, 2);
  const m = merged[0];
  assert.equal(m.material, page.mat);
  assert.deepEqual(m.userData.marks, [A, B]);
  const P = m.geometry.attributes.position.array, U = m.geometry.attributes.uv.array;
  assert.deepEqual([...P.slice(0, 9)], [0, 1, 0, 1, 1, 0, 1, 0, 0]);
  assert.deepEqual([...P.slice(9, 18)], [10, 4, -3, 12, 4, -3, 12, 2, -3]);
  assert.deepEqual([...U.slice(0, 6)], [0.75, 0.375, 0.5, 0.375, 0.5, 0.25]);
  assert.deepEqual([...U.slice(6, 12)], [0.25, 0.875, 0, 0.875, 0, 0.75]);
});

test('mergeMarks leaves plain-canvas labels and other pages apart', () => {
  const p1 = { mat: new THREE.MeshBasicMaterial() }, p2 = { mat: new THREE.MeshBasicMaterial() };
  const root = new THREE.Group();
  const own = new THREE.MeshBasicMaterial();            // a fallback label: no slot
  root.add(quad(fakeLabel(p1, 0, 0)), quad(fakeLabel(p2, 0, 0)), quad(own), quad(fakeLabel(p1, 0.25, 0)));
  mergeMarks(root);
  const mats = root.children.map((o) => o.material);
  assert.equal(root.children.length, 3);
  assert.ok(mats.includes(own) && mats.includes(p1.mat) && mats.includes(p2.mat));
  assert.equal(root.children.find((o) => o.material === p1.mat).geometry.attributes.position.count, 6);
});

test('loading the ordinary game URL enables all three optimizations', async (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'location', old);
    else delete globalThis.location;
  });
  for (const [search, expected] of [['', [true, true, true]], ['?batch=marks', [false, true, false]]]) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { search } });
    const { BATCH: flags } = await import('../js/batchflags.js?test=' + encodeURIComponent(search));
    assert.deepEqual([flags.signals, flags.marks, flags.shadows], expected);
  }
});

test('sweeping the last wordmark releases its atlas page', (t) => {
  const ctx = {
    save() {}, restore() {}, setTransform() {}, fillRect() {}, clearRect() {},
    drawImage() {}, fillText() {}, measureText() { return { width: 240 }; },
  };
  const old = globalThis.document;
  t.after(() => {
    if (old === undefined) delete globalThis.document;
    else globalThis.document = old;
  });
  globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
  const before = atlasStats().pages;
  const a = atlasMark({ sign: 0x224466 }, 'Kino');
  const b = atlasMark({ sign: 0x992200 }, 'Kavárna');
  const { page } = a.userData.mark;
  assert.equal(page, b.userData.mark.page);
  let freed = 0;
  page.tex.addEventListener('dispose', () => freed++);
  page.mat.addEventListener('dispose', () => freed++);
  releaseMark(a);
  assert.equal(freed, 0);
  releaseMark(b);
  assert.equal(freed, 2);
  assert.equal(atlasStats().pages, before);
});
