// ---- the one-draw car and the instanced pools --------------------------------
// js/carmesh.js dresses a car as ONE body mesh (js/carmerge.js geometry under
// js/carbodymat.js) plus pool members for its wheels and its distance dress
// (js/carinstances.js). None of that needs a GPU to be pinned: the geometry is
// checked for what each part says it is, the pools are filled by calling the
// scene's own onBeforeRender with a real camera, and the A/B switch is thrown.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// a car paints its plate and badge on a <canvas>; nothing here reads a pixel
const ctx2d = new Proxy({}, {
  get: (_, k) => k === 'measureText' ? () => ({ width: 200 })
    : k === 'createLinearGradient' || k === 'createRadialGradient'
      ? () => ({ addColorStop() {} })
      : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
        : k === 'canvas' ? { width: 1, height: 1 } : () => {},
  set: () => true,
});
globalThis.document ??= { createElement: () => ({ width: 1, height: 1, style: {},
  getContext: () => ctx2d, toDataURL: () => '' }) };

const THREE = await import('three');
const VEH = await import('../js/vehicles.js');
const { ATLAS } = await import('../js/carmerge.js');
const { setCarState } = await import('../js/carmesh.js');
const { setCarInstancing, carInstanceStats, POOL_LAYER } = await import('../js/carinstances.js');

const meshesIn = (o) => o.children.filter((c) => c.isMesh);

test('every kind is one near body and one distance body, each a single merged mesh', () => {
  for (const kind of VEH.CAR_KINDS) {
    const { group, wheels } = VEH.makeCarMesh(0x2f4f72, kind);
    const { near, far } = group.userData.lod;
    assert.equal(meshesIn(near).length, 1, `${kind}: near dress is not one mesh`);
    assert.equal(meshesIn(far).length, 1, `${kind}: distance dress is not one mesh`);
    assert.equal(wheels.length, 4);
    assert.deepEqual(group.userData.hulls, meshesIn(near), `${kind}: dentCar would bend something else`);
    const g = meshesIn(near)[0].geometry;
    const n = g.attributes.position.count;
    for (const name of ['position', 'normal', 'color', 'cpbr', 'cfx', 'duv']) {
      const a = g.attributes[name];
      assert.ok(a && a.count === n, `${kind}: ${name} missing or short`);
      for (let i = 0; i < a.array.length; i++) assert.ok(Number.isFinite(a.array[i]), `${kind}: ${name}[${i}]`);
    }
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) assert.ok(ix[i] < n, `${kind}: index ${i} out of range`);
    // what the parts say they are
    const fx = g.attributes.cfx, duv = g.attributes.duv;
    let paint = 0, head = 0, tail = 0, brake = 0, plate = 0;
    for (let i = 0; i < n; i++) {
      const z = fx.getZ(i);
      assert.ok(z === 0 || z === 1 || z === 2, `${kind}: lamp code ${z}`);
      if (fx.getX(i) === 1) paint++;
      if (fx.getY(i) === 1) head++;
      if (z === 1) tail++;
      if (z === 2) brake++;
      if (duv.getZ(i) === 1) {
        plate++;
        const v = duv.getY(i);
        assert.ok((v >= ATLAS.plate[0] - 1e-6 && v <= ATLAS.plate[1] + 1e-6)
          || (v >= ATLAS.badge[0] - 1e-6 && v <= ATLAS.badge[1] + 1e-6), `${kind}: decal v ${v} outside the atlas`);
      }
    }
    assert.ok(paint > 100 && head > 0 && tail > 0 && plate >= 4, `${kind}: paint ${paint} head ${head} tail ${tail} decal ${plate}`);
    assert.ok(brake > 0, `${kind}: no brake element in the body`);
    // the distance dress has no brake element and no decals
    const f = meshesIn(far)[0].geometry;
    for (let i = 0; i < f.attributes.cfx.count; i++) assert.notEqual(f.attributes.cfx.getZ(i), 2);
  }
});

test('lamps and brake light are material swaps, and the pooled paint follows', () => {
  const { group } = VEH.makeCarMesh(0xb8433a, 'fabia');
  const s = group.userData.carState;
  const body = meshesIn(group.userData.lod.near)[0];
  const lit = body.material;
  setCarState(group, true, true);
  const braking = body.material;
  assert.notEqual(braking, lit, 'braking did not change the material');
  setCarState(group, false, true);
  assert.notEqual(body.material, braking);
  assert.equal(s.brake, false, 'a parked car cannot brake');
  assert.ok(s.paint[3] < 2, 'the pooled distance dress kept its lamps on');
  setCarState(group, true, false);
  assert.equal(body.material, lit, 'materials are cached per state, not rebuilt');
  assert.ok(s.paint[3] >= 2);
});

test('the pools draw what is in view, and the switch puts the cars back on their own', () => {
  const scene = new THREE.Scene();
  const vehicles = new VEH.Vehicles(scene);
  vehicles.forceLod = 'far';
  const cars = [];
  for (let i = 0; i < 5; i++) cars.push(vehicles.add('octavia', i * 6, -40, 0));
  const behind = vehicles.add('octavia', 0, 80, 0);   // out of the view
  vehicles.update(1 / 60);
  const cam = new THREE.PerspectiveCamera(55, 1.6, 0.1, 1400);
  cam.position.set(12, 3, 0);
  cam.lookAt(12, 0, -40);
  const frame = () => {
    scene.updateMatrixWorld();
    cam.updateMatrixWorld();
    scene.onBeforeRender(null, scene, cam, null);
  };
  frame();
  const pool = scene.children.find((o) => o.name === 'carpool:far|octavia');
  assert.ok(pool?.isInstancedMesh, 'no distance-dress pool');
  assert.equal(pool.count, 5, 'the pool did not hold exactly the five cars in view');
  assert.equal(pool.visible, true);
  // every member sits on the pool layer, out of the camera's sight
  for (const c of [...cars, behind]) for (const w of c.wheels) assert.ok(w.layers.isEnabled(POOL_LAYER) && !w.layers.isEnabled(0));
  // a far car's wheels are hidden with its near dress: no wheel pool drawn
  const wheelPool = scene.children.find((o) => o.name?.startsWith('carpool:wheel'));
  assert.ok(!wheelPool || !wheelPool.visible);
  // the matrices are the cars' own
  const m = new THREE.Matrix4();
  pool.getMatrixAt(0, m);
  const p = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(cars.some((c) => Math.abs(c.x - p.x) < 1e-6 && Math.abs(c.z - p.z) < 1e-6));

  // near: four wheels each come from the wheel pools
  vehicles.forceLod = 'near';
  vehicles.update(1 / 60);
  frame();
  const wl = scene.children.filter((o) => o.name?.startsWith('carpool:wheel|octavia'));
  assert.equal(wl.reduce((a, o) => a + (o.visible ? o.count : 0), 0), 20, 'not 4 wheels a car in the wheel pools');
  assert.equal(pool.visible, false, 'an empty pool must not be drawn');

  // removed cars leave the pools
  vehicles.remove(cars[0]);
  frame();
  assert.equal(wl.reduce((a, o) => a + (o.visible ? o.count : 0), 0), 16);

  setCarInstancing(false);
  frame();
  for (const o of scene.children) if (o.name?.startsWith('carpool:')) assert.equal(o.visible, false);
  for (const w of cars[1].wheels) assert.ok(w.layers.isEnabled(0), 'a wheel stayed hidden with the pools off');
  assert.equal(carInstanceStats(scene).on, false);
  setCarInstancing(true);
  for (const w of cars[1].wheels) assert.ok(w.layers.isEnabled(POOL_LAYER) && !w.layers.isEnabled(0));
});

test('a dent bends a private copy of the merged body, and repair can hand the shared one back', () => {
  const scene = new THREE.Scene();
  const vehicles = new VEH.Vehicles(scene);
  const car = vehicles.add('octavia', 0, 0, 0);
  const body = car.mesh.userData.hulls[0];
  const shared = body.geometry;
  VEH.dentCar(car, 0, 0.6, -2.3, 0, 1, 0.3);
  assert.notEqual(body.geometry, shared, 'the shared geometry was bent in place');
  assert.ok(body.userData.owned);
  const fresh = VEH.makeCarMesh(car.color, car.kind).group.userData.hulls;
  assert.equal(fresh.length, car.mesh.userData.hulls.length);
  assert.equal(fresh[0].geometry, shared);
});

test('the body material patches every chunk it means to, in both variants', async () => {
  const { bodyMatFor, instancedBodyMat } = await import('../js/carbodymat.js');
  const tex = new THREE.Texture();
  for (const [m, inst] of [[bodyMatFor('probe|1', 0x22262c, tex, true, false), false], [instancedBodyMat(), true]]) {
    const L = THREE.ShaderLib.physical;
    const sh = { uniforms: THREE.UniformsUtils.clone(L.uniforms), vertexShader: L.vertexShader, fragmentShader: L.fragmentShader };
    m.onBeforeCompile(sh);
    const V = sh.vertexShader, F = sh.fragmentShader;
    for (const k of ['attribute vec4 cpbr', 'cpbr.w * uPull', 'vPbr = cpbr']) assert.ok(V.includes(k), `vertex: ${k}`);
    if (inst) assert.ok(V.includes('attribute vec4 iPaint') && F.includes('vPaint.rgb'));
    for (const k of ['float cPaint = vFx.x', 'roughnessFactor = mix(vPbr.x', 'metalnessFactor = mix(vPbr.y',
      'material.clearcoat *= cPaint', 'cBrake * uBrakeC * uBrake', 'float city = carCity(rd',
      'toneMapping(gl_FragColor.rgb), gl_FragColor.rgb', 'atcLampDirect', 'uniform vec3 uCarSky[3]']) {
      assert.ok(F.includes(k), `${inst ? 'instanced' : 'per car'} fragment: ${k}`);
    }
    assert.equal(F.includes('texture2D(uDecal'), !inst, 'the decal atlas belongs to the per-car variant only');
    for (const u of ['uHeadE', 'uTailE', 'uHeadC', 'uTailC', 'uBrakeC', 'uLit', 'uBrake', 'uPull', 'uCarNight', 'uCarSky', 'uCity']) {
      assert.ok(sh.uniforms[u], `uniform ${u} not handed to the program`);
    }
    // every chunk the patch replaces is replaced once (a renamed chunk in a
    // three upgrade would silently do nothing)
    assert.equal((F.match(/varying vec4 vFx;/g) ?? []).length, 1);
  }
});

test('a semi tows a one-draw trailer whose lamps follow the tractor', () => {
  const scene = new THREE.Scene();
  const vehicles = new VEH.Vehicles(scene);
  const car = vehicles.add('semi', 0, 0, 0);
  assert.ok(car._tr?.body, 'the trailer was not merged');
  assert.equal(car._tr.grp.children.filter((o) => o.isMesh).length, 2, 'trailer is body + side markers');
  vehicles.update(1 / 60);
  const parked = car._tr.body.material;
  car.ai = {}; car.speed = 10; car._pv = 10.2; car._acc = -6;
  vehicles.update(1 / 60);
  assert.equal(car.mesh.userData.carState.brake, true, 'a braking lorry did not light its brakes');
  assert.notEqual(car._tr.body.material, parked, 'the trailer kept the parked material');
});
