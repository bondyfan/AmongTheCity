// ---- carinstances.js: the parts of a car that are the same on every car ------
// Measured on the base commit at Legerova at noon (medium preset): of 145 cars
// 144 were in their distance dress, and the 40 or so in view cost 158 draw
// calls of the main pass, four each. Four wheels a near car were four more.
// None of those draws carries anything a neighbouring car of the same kind
// does not: the same geometry, the same material, a different matrix.
//
// So they are drawn instanced. A car keeps the meshes it always had (the four
// wheels every caller spins and steers, the distance dress setCarLod shows and
// hides), but while instancing is on they sit on POOL_LAYER, which no camera
// renders and no shadow camera sees: each is a MEMBER of a pool, and once a
// frame, after three has worked out the world matrices and before it walks
// the scene, every pool copies the matrices of its visible members into one
// InstancedMesh. A kind's wheels are one draw for the whole street, a kind's
// distance dress one draw for the whole city, colour and lamps riding a
// per-instance attribute (carbodymat.js iPaint).
//
// Visibility is the mesh's own: hidden, or under a hidden ancestor, or not in
// the scene being drawn, and it is skipped, so setCarLod, a co-op ghost hidden
// by its claim and a removed car all behave exactly as before. Members outside
// the view frustum (with a margin, so a shadow falling into view from a car
// just off screen is kept) are skipped too: the pools are not frustum culled
// by three, they are culled here, per member.
//
// The A/B switch (console: atcCars.instancing(false)) puts every member back
// on layer 0 and empties the pools, so the same meshes draw one by one, as
// they did before: same geometry, per-car material, nothing else differs.
//
// Lifetime: a car's members join when its group is added to a parent and
// leave when it is removed, so the registry holds only cars that exist.

import * as THREE from 'three';

export const POOL_LAYER = 31;      // main.js uses 2 for the first-person body; nothing else uses layers

const _pools = new WeakMap();      // scene -> Map(key -> pool)
const _members = new Set();
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere();
const _live = [], _want = new Map();
let _enabled = true;
try {
  // ?carinst=0 starts a session with the pools off (for a cold A/B)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('carinst') === '0') _enabled = false;
} catch { /* no location headless */ }

const applyLayer = (m) => m.node.layers.set(_enabled ? POOL_LAYER : 0);

/** Runtime switch for A/B measurements. */
export function setCarInstancing(on) {
  _enabled = !!on;
  for (const m of _members) applyLayer(m);
}
export const carInstancingOn = () => _enabled;

/**
 * A member: `node` is the mesh whose world matrix places the instance and
 * which draws on its own while instancing is off. `spec` names the pool
 * ({ key, geo, mat, cast, paint: bool }); `radius` is the bounding radius
 * around the node's origin for the frustum test. `paint` (optional) is a
 * Float32Array(4) the owner keeps current, for pools that carry iPaint.
 */
export function makeMember(node, spec, radius, paint = null) {
  const m = { node, spec, radius, paint };
  applyLayer(m);
  return m;
}

/** Join every member of a car group while it is in the scene graph. */
export function bindMembers(group, members) {
  group.userData.members = members;
  group.addEventListener('added', () => {
    for (const m of members) { _members.add(m); applyLayer(m); }
    hookScene(rootOf(group));
  });
  group.addEventListener('removed', () => { for (const m of members) _members.delete(m); });
}

function rootOf(o) { while (o.parent) o = o.parent; return o; }

/** Install the per-frame copy on a scene (idempotent). */
export function hookScene(scene) {
  if (!scene?.isScene || _pools.has(scene)) return;
  _pools.set(scene, new Map());
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, sc, camera, target) {
    fill(scene, camera);
    if (prev) prev.call(this, renderer, sc, camera, target);
  };
}

function poolFor(scene, spec, need) {
  const pools = _pools.get(scene);
  let p = pools.get(spec.key);
  if (p && p.cap >= need) return p;
  const cap = Math.max(16, need + 16, p ? p.cap * 2 : 0);
  if (p) { scene.remove(p.mesh); p.mesh.dispose(); }
  // a geometry of its own (sharing every vertex attribute, so nothing is
  // uploaded twice) so the instanced paint attribute belongs to this pool alone
  const geo = new THREE.BufferGeometry();
  for (const k in spec.geo.attributes) geo.setAttribute(k, spec.geo.attributes[k]);
  geo.setIndex(spec.geo.index);
  geo.boundingSphere = spec.geo.boundingSphere;
  let paint = null;
  if (spec.paint) {
    paint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    paint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPaint', paint);
  }
  const mesh = new THREE.InstancedMesh(geo, spec.mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = !!spec.cast;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;               // after the street-light quads, as every car part
  mesh.matrixAutoUpdate = false;
  mesh.name = 'carpool:' + spec.key;  // dev/gfxprobe.js lists it under this name
  scene.add(mesh);
  p = { mesh, cap, paint, n: 0 };
  pools.set(spec.key, p);
  return p;
}

// is the node drawn at all in this scene?
function shown(node, scene) {
  let o = node;
  while (o) {
    if (o.visible === false) return false;
    if (o === scene) return true;
    o = o.parent;
  }
  return false;
}

function fill(scene, camera) {
  const pools = _pools.get(scene);
  for (const p of pools.values()) p.n = 0;
  if (_enabled && _members.size) {
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    // first pass: count per pool, so a pool grows once, before it is written
    _live.length = 0;
    _want.clear();
    for (const m of _members) {
      if (!shown(m.node, scene)) continue;
      const e = m.node.matrixWorld.elements;
      _sph.center.set(e[12], e[13], e[14]);
      _sph.radius = m.radius;
      if (!_frustum.intersectsSphere(_sph)) continue;
      _live.push(m);
      _want.set(m.spec.key, (_want.get(m.spec.key) ?? 0) + 1);
    }
    for (let i = 0; i < _live.length; i++) {
      const m = _live[i];
      const p = poolFor(scene, m.spec, _want.get(m.spec.key));
      const j = p.n++;
      p.mesh.instanceMatrix.array.set(m.node.matrixWorld.elements, j * 16);
      if (p.paint && m.paint) p.paint.array.set(m.paint, j * 4);
    }
    _live.length = 0;
  }
  for (const p of pools.values()) {
    p.mesh.count = p.n;
    // an empty pool is hidden, not drawn with zero instances: a draw call is
    // what this whole module exists to save
    p.mesh.visible = p.n > 0;
    if (p.n) {
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.paint) p.paint.needsUpdate = true;
    }
  }
}

/** Counts for the probes: { pools, members, drawn }. */
export function carInstanceStats(scene) {
  const pools = _pools.get(scene);
  let drawn = 0, n = 0;
  if (pools) for (const p of pools.values()) { if (p.mesh.count) n++; drawn += p.mesh.count; }
  return { pools: n, members: _members.size, drawn, on: _enabled };
}
