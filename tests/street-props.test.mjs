// ---- street props: dogs on leads, prams, and what people carry -----------------
// (the birds: tests/street-life.test.mjs)
//
//   js/pedprops.js     who carries what comes off the citizen's seed alone
//   js/citizen.js      a busy hand is held, in the same single draw call
//   js/dogwalk.js      the lead is a length: the dog is never further than it
//   js/dogs.js, js/pedpropdraw.js   one row per owner, three meshes for all of them
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const P = await import('../js/pedprops.js');
const W = await import('../js/dogwalk.js');
const { Dogs } = await import('../js/dogs.js');
const { Prams } = await import('../js/pedpropdraw.js');
const { makeCitizen } = await import('../js/citizen.js');

test('what a citizen carries comes off the seed alone, in sensible shares', () => {
  const keys = ['m30', 'f30', 'f60', 'm60', 'm90'], N = 8000;
  for (const a of keys) {
    const n = [0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const seed = Math.imul(i + 1, 2654435761) >>> 0, p = P.propFor(seed, a);
      assert.deepEqual(p, P.propFor(seed, a));
      assert.equal(p.key, P.PROP_KEYS[p.kind]);
      if (p.kind === P.PROP.DOG) assert.ok(P.DOG_BREEDS[p.breed] && P.DOG_TINTS.includes(p.tint));
      if (p.kind === P.PROP.PRAM) assert.ok(P.PRAM_TINTS.includes(p.tint));
      n[p.kind]++;
    }
    assert.ok(n[0] / N > 0.5, `${a}: most people have their hands free`);
    assert.ok(n[P.PROP.DOG] / N > 0.03 && n[P.PROP.DOG] / N < 0.14, `${a}: some walk a dog`);
    if (a === 'm90') {
      assert.equal(n[P.PROP.BAG] + n[P.PROP.PHONE] + n[P.PROP.PRAM], 0, 'the man with the stick has one hand, and it is for the dog');
    } else assert.ok(n[P.PROP.BAG] > 0 && n[P.PROP.PHONE] > 0 && n[P.PROP.PRAM] > 0);
  }
  for (let i = 0; i < 500; i++) {
    const p = P.propFor(Math.imul(i + 1, 40503) >>> 0, 'm90');
    if (p.kind === P.PROP.DOG) assert.ok(p.breed <= 1, 'and it is a small dog');
  }
  assert.deepEqual(P.holdFor('pram'), { L: 'push', R: 'push' });
  assert.deepEqual(P.holdFor('dog'), { L: null, R: 'leash' });
  assert.deepEqual(P.holdFor('dog', true), { L: 'leash', R: null }, 'the stick keeps the right hand');
  assert.equal(P.holdFor('phone', true), null);
  assert.equal(P.holdFor(null), null);
});

test('a busy hand is held while walking and standing, in the same one draw call', () => {
  const real = Math.random;
  let k = 0;
  Math.random = () => ((k = (k * 16807 + 11) % 2147483647) / 2147483647);
  try {
    const mk = (prop) => makeCitizen({ archetype: 'f30', prop, propTint: 0xc8452f, style: { bag: null } });
    const free = mk(null); k = 0;
    const meshes = (c) => { let n = 0; c.group.traverse((o) => { if (o.isMesh) n++; }); return n; };
    const swing = (c, arm) => {
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < 40; t++) { c.walk(t * 0.4, 1, 0, 1.4); const v = c.parts[arm].rotation.x; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      return hi - lo;
    };
    const base = swing(free, 'armR');
    assert.ok(base > 0.15, 'a free arm swings');
    for (const prop of ['bag', 'phone', 'pram', 'dog']) {
      k = 0;
      const c = mk(prop);
      assert.equal(c.prop, prop);
      assert.equal(meshes(c), meshes(free), `${prop}: no extra mesh`);
      assert.ok(swing(c, 'armR') < base * 0.35, `${prop}: the right arm has a job`);
      if (prop === 'bag' || prop === 'phone') assert.ok(c.tris.near > free.tris.near, `${prop} is a few triangles in the body's own mesh`);
      else assert.equal(c.tris.near, free.tris.near, `${prop} is drawn elsewhere`);
      if (prop === 'pram') assert.ok(swing(c, 'armL') < 0.02, 'both hands on the handle');
      else assert.ok(swing(c, 'armL') > 0.1, `${prop}: the other arm still swings`);
      // standing still keeps the hand where it was
      c.walk(3, 1, 0, 1.4);
      const elbow = c.parts.elbowR.rotation.x;
      c.standPose();
      assert.ok(Math.abs(c.parts.elbowR.rotation.x - elbow) < 1e-9, `${prop}: held while standing`);
      if (prop === 'phone') {
        assert.ok(elbow > 2, 'the phone is at the ear: the elbow is shut');
        c.sitPose(1, 0);
        assert.ok(c.parts.elbowR.rotation.x > 2, 'still on the phone on a bench');
        c.sitPose(1, 1);
        assert.ok(c.parts.elbowR.rotation.x < 1.5, 'but not at the wheel of a car');
      }
      c.dispose();
    }
    // the stick wins the right hand: the lead goes to the left
    k = 0;
    const old = makeCitizen({ archetype: 'm90', prop: 'dog' });
    assert.deepEqual(old.hold, { L: 'leash', R: null });
    old.dispose(); free.dispose();
  } finally { Math.random = real; }
});

// ------------------------------------------------------------------ dogs ----
test('the lead is a length: the dog pulls, sniffs, sits and stays, and is never further than it', () => {
  for (const breed of P.DOG_BREEDS) {
    const o = { x: 0, z: 0, h: 0.6, speed: 1.3, side: 1, hx: 0, hz: 0, mode: 'walk' };
    const d = W.makeDog(1234, breed, o), seen = {};
    let sat = 0;
    const fx = -Math.sin(o.h), fz = -Math.cos(o.h);
    for (let i = 0; i < 60 * 150; i++) {
      if (i === 60 * 90) o.speed = 0;                       // the owner stops at a kerb
      if (i === 60 * 120) o.mode = 'down';                  // …and is knocked over
      o.x += fx * o.speed / 60; o.z += fz * o.speed / 60;
      o.hx = o.x + Math.cos(o.h) * 0.25; o.hz = o.z - Math.sin(o.h) * 0.25;
      const px = d.x, pz = d.z;
      W.stepDog(d, o, 1 / 60);
      seen[d.mode] = (seen[d.mode] ?? 0) + 1;
      assert.ok(Math.hypot(d.x - o.hx, d.z - o.hz) <= breed.lead + 1e-6, `${breed.key}: beyond its lead at step ${i}`);
      assert.ok(Math.hypot(d.x - px, d.z - pz) * 60 < 9, `${breed.key}: no dog runs at ${(Math.hypot(d.x - px, d.z - pz) * 60).toFixed(1)} m/s`);
      if (i > 60 * 90 && i < 60 * 120) sat = Math.max(sat, d.sit);
      for (const v of [d.x, d.z, d.h, d.phase, d.reach, d.head, d.wag, d.sit]) assert.ok(Number.isFinite(v));
    }
    assert.ok(seen.heel > 300 && seen.pull > 100 && seen.sniff > 60, `${breed.key}: heels, pulls and sniffs (${JSON.stringify(seen)})`);
    assert.ok(sat > 0.9, `${breed.key}: sits when its owner stands`);
    assert.ok(seen.nose > 30, `${breed.key}: and gets up for a sniff round their feet`);
    assert.equal(d.mode, 'stay');
    assert.ok(d.sit > 0.9 && Math.hypot(d.x - o.x, d.z - o.z) < 1.2, 'and waits by its owner');
  }
});

test('dogs and prams are rows: one per owner, none for anybody else', () => {
  const scene = new THREE.Scene();
  const dogs = new Dogs(scene, { groundY: () => 3 }), prams = new Prams(scene);
  assert.equal(scene.children.length, 3, 'dogs, leads, prams: three meshes for all of them');
  const ped = (prop, x) => ({ prop, propTint: 0x6b4a2a, breed: 2, pid: 77 + x, x, z: 0, heading: 0, speed: 1.2, state: 'walk', pose: 0,
    sitDrop: 0.4, hand: null, leadSide: 1, dog: null, pramX: NaN, pramY: 0, pramZ: 0, pramH: 0, mesh: { position: { y: 3 } } });
  const peds = [ped(P.PROP.DOG, 0), ped(P.PROP.NONE, 2), ped(P.PROP.PRAM, 4), ped(P.PROP.DOG, 6), ped(P.PROP.DOG, 900)];
  for (let i = 0; i < 30; i++) { dogs.update(1 / 30, peds, { x: 0, z: 0 }); prams.update(peds); }
  assert.equal(dogs.mesh.count, 2, 'the dog a kilometre off is not drawn');
  assert.equal(dogs.leads.geometry.drawRange.count, 2 * 6 * 12);
  assert.equal(prams.mesh.count, 1);
  assert.ok(peds[0].dog && !peds[1].dog && !peds[4].dog);
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  prams.mesh.getMatrixAt(0, m); v.setFromMatrixPosition(m);
  assert.ok(Math.abs(v.x - 4) < 1e-6 && v.z < -0.6 && v.z > -1.2 && v.y === 3, 'the pram is an arm ahead of its pusher');
  // knocked down: the lead is dropped and the pram stays where it was
  peds[0].state = 'rag'; peds[2].state = 'rag'; peds[2].x = 40;
  dogs.update(1 / 30, peds, { x: 0, z: 0 }); prams.update(peds);
  assert.equal(dogs.leads.geometry.drawRange.count, 1 * 6 * 12);
  prams.mesh.getMatrixAt(0, m); v.setFromMatrixPosition(m);
  assert.ok(Math.abs(v.x - 4) < 1e-6);
  dogs.enabled = false; dogs.update(1 / 30, peds, { x: 0, z: 0 });
  assert.equal(dogs.mesh.visible, false);
  dogs.dispose(); prams.dispose();
  assert.equal(scene.children.length, 0);
});
