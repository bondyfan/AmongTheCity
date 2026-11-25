// ---- the fight on the body: the action layer, the fist, the blood, the bars ----
// js/characters/actlayer.js (a recording laid over the walk), fist.js (fingers
// closed over the pose), human.js act() on the crash-test dummy, and the two
// small drawn pieces of the fight (js/fightfx.js, js/fighthud.js) headless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { upperMask, mixMasked, mixWorld } = await import('../js/characters/actlayer.js');
const { makeFist, applyFist } = await import('../js/characters/fist.js');
const { SLOT, SLOT_COUNT } = await import('../js/characters/skeletonmap.js');
const { worldOf } = await import('../js/characters/retarget.js');
const { installDummies } = await import('../js/characters/dummy.js');
const AV = await import('../js/characters/avatars.js');
const { makeHuman } = await import('../js/characters/human.js');
const { sampleClip } = await import('../js/characters/clipbank.js');
const { FightFx } = await import('../js/fightfx.js');
const { FightHud } = await import('../js/fighthud.js');

const [man] = installDummies();
const q = (x, y, z, w) => new THREE.Quaternion(x, y, z, w).normalize();
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
const at = (arr, i) => new THREE.Quaternion().fromArray(arr, i * 4);

test('the upper layer takes the trunk, the arms and the head, and leaves the legs alone', () => {
  const rig = man.rig, m = upperMask(rig);
  const w = (slot) => m[rig.slotBone[SLOT[slot]]];
  for (const s of ['chest', 'neck', 'head', 'upperArmL', 'lowerArmR', 'handL', 'clavicleR']) assert.equal(w(s), 1, s);
  for (const s of ['hips', 'upperLegL', 'lowerLegR', 'footL', 'toesR']) assert.equal(w(s), 0, s);
  assert.ok(w('spine') > 0 && w('spine') < 1, 'the small of the back is all or nothing');
  // a bone with no slot goes with the slot above it: the dummy's thumb with its hand
  const thumb = rig.names.findIndex((n) => /L.Finger0$/.test(n));
  assert.ok(thumb >= 0);
  assert.equal(m[thumb], 1, 'the fingers stayed behind the hand');
});

// The bug the world-space mix exists for: on a 3ds Max Biped the thighs hang
// from the spine, so a punch's spine angle laid on LOCALLY swung the legs, and
// the trunk leaned like a man looking for his keys.
test('a recording over the trunk does not swing a leg that hangs from the spine', () => {
  // pelvis -> spine -> thigh, the Biped way round
  const rig = { n: 3, parent: Int16Array.from([-1, 0, 1]), topQ: new THREE.Quaternion() };
  const base = new Float32Array(12), act = new Float32Array(12), out = new Float32Array(12);
  q(0.1, 0.2, 0, 1).toArray(base, 0); q(0.3, 0, 0.1, 1).toArray(base, 4); q(0, 0.4, 0.2, 1).toArray(base, 8);
  q(-0.2, 0.5, 0, 1).toArray(act, 0); q(0, -0.6, 0.3, 1).toArray(act, 4); q(0.7, 0, 0, 1).toArray(act, 8);
  const mask = Float32Array.from([0, 1, 0]);
  mixWorld(rig, out, base, act, 1, mask);
  const WB = worldOf(rig, base, new Float32Array(12)), WA = worldOf(rig, act, new Float32Array(12)), WO = worldOf(rig, out, new Float32Array(12));
  assert.ok(angle(at(WO, 0), at(WB, 0)) < 3e-3, 'the pelvis moved');
  assert.ok(angle(at(WO, 1), at(WA, 1)) < 3e-3, 'the trunk did not take the recording');
  assert.ok(angle(at(WO, 2), at(WB, 2)) < 3e-3, 'the leg swung with the trunk it hangs from');
  // the whole body at full weight is the recording; at none it is the base
  mixWorld(rig, out, base, act, 1, null);
  for (let i = 0; i < 3; i++) assert.ok(angle(at(out, i), at(act, i)) < 3e-3);
  mixWorld(rig, out, base, act, 0, null);
  for (let i = 0; i < 3; i++) assert.ok(angle(at(out, i), at(base, i)) < 3e-3);
  // the plain per-bone mix agrees at the ends
  const lin = mixMasked(new Float32Array(12), base, act, 1, null, 3);
  for (let i = 0; i < 3; i++) assert.ok(angle(at(lin, i), at(act, i)) < 3e-3);
});

// A hand at the origin pointing along +x, palm down (-y), the thumb forward
// and below the knuckles: the T pose of a right hand.
function handRig() {
  const names = [], parent = [], P = [];
  const add = (name, p, x, y, z) => { names.push(name); parent.push(p); P.push(x, y, z); return names.length - 1; };
  const hand = add('R Hand', -1, 0, 0, 0);
  const fingers = [];
  for (const [i, z] of [[1, -0.03], [4, 0.03]]) {          // index toward the thumb (-z), little finger at +z
    const a = add(`R Finger${i}`, hand, 0.09, 0, z);
    const b = add(`R Finger${i}1`, a, 0.13, 0, z);
    const c = add(`R Finger${i}2`, b, 0.16, 0, z);
    fingers.push([a, b, c]);
  }
  const t0 = add('R Finger0', hand, 0.03, -0.02, -0.05);
  const t1 = add('R Finger01', t0, 0.06, -0.03, -0.07);
  const n = names.length;
  const slotBone = new Int16Array(SLOT_COUNT).fill(-1), boneSlot = new Int16Array(n).fill(-1);
  slotBone[SLOT.handR] = hand; boneSlot[hand] = SLOT.handR;
  const worldQ = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) worldQ[i * 4 + 3] = 1;          // every bone's frame is the figure's
  return { rig: { n, names, parent: Int16Array.from(parent), worldP: Float32Array.from(P), worldQ, slotBone, boneSlot }, fingers, thumb: [t0, t1] };
}

test('a fist curls every finger segment toward the palm, the thumb less', () => {
  const { rig, fingers, thumb } = handRig();
  const f = makeFist(rig);
  assert.equal(f.bones.length, 8, `${f.bones.length} segments curl, a hand of two fingers and a thumb has 8`);
  const cur = new Float32Array(rig.n * 4);
  for (let i = 0; i < rig.n; i++) cur[i * 4 + 3] = 1;
  applyFist(f, cur, 1);
  const palm = new THREE.Vector3(0, -1, 0);
  for (const c of fingers) {
    for (let s = 0; s < 3; s++) {
      const r = at(cur, c[s]);
      const deg = angle(r, new THREE.Quaternion()) * 180 / Math.PI;
      assert.ok(deg > 50 && deg < 100, `a finger segment curled ${deg.toFixed(0)} degrees`);
      // the segment's own direction, turned by the curl, heads into the palm
      const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(r);
      assert.ok(dir.dot(palm) > 0.5, 'the finger curled out of the back of the hand');
    }
  }
  for (const b of thumb) {
    const deg = angle(at(cur, b), new THREE.Quaternion()) * 180 / Math.PI;
    assert.ok(deg > 10 && deg < 50, `the thumb folded ${deg.toFixed(0)} degrees`);
  }
  // half a fist is half the curl; none is none
  const half = new Float32Array(rig.n * 4); for (let i = 0; i < rig.n; i++) half[i * 4 + 3] = 1;
  applyFist(f, half, 0);
  for (let i = 0; i < rig.n; i++) assert.equal(half[i * 4 + 3], 1, 'a closed fist of nothing moved a finger');
  // the dummy's single thumb bone is no hand to close: nothing, and no throw
  assert.equal(makeFist(man.rig).bones.length, 0);
});

test('act() lays a recording over the body, lets go of it, and keeps the body near meanwhile', () => {
  AV.setRoles({ ...AV.roles(), fightJab: 'run' }, {});
  const h = makeHuman(man, {}, { near: true, seed: 0.3 });
  h.standPose();
  const wait = (ms) => { const t = performance.now() + ms; while (performance.now() < t) { /* the cross-fade runs on the wall clock */ } };
  h.pose();
  assert.equal(h.actDur('nothing-by-that-name'), 0);
  assert.equal(h.act('nothing-by-that-name', 0), 0, 'a role with no recording claimed to play');
  const dur = h.act('fightJab', 0.3, 1, 'full');
  assert.ok(dur > 0, 'a role with a recording did not play');
  h.pose(); wait(120); h.act('fightJab', 0.3, 1, 'full'); const on = Float32Array.from(h.pose());
  // what the recording is at 0.3 s, straight off the bake
  const clip = AV.clipFor(man, 'run'), want = new Float32Array(man.rig.n * 4);
  sampleClip(clip, 0.3, want, [0, 0, 0]);
  let worst = 0;
  for (let i = 0; i < man.rig.n; i++) worst = Math.max(worst, angle(at(on, i), at(want, i)));
  assert.ok(worst < 0.02, `the full layer is ${worst.toFixed(3)} rad off the recording`);
  assert.equal(h.state.actOn, true);
  assert.equal(h.state.kind === 'proc' ? false : true, true);
  // let go: a quarter second after the last call the base is back. The idle
  // moves with the clock, so the base is a twin body sampled at the same moment.
  const twin = makeHuman(man, {}, { near: true, seed: 0.3 });
  twin.standPose();
  wait(300); h.pose(); twin.pose(); wait(120);
  const off = h.pose(), ref = twin.pose();
  worst = 0;
  for (let i = 0; i < man.rig.n; i++) worst = Math.max(worst, angle(at(off, i), at(ref, i)));
  twin.dispose();
  assert.ok(worst < 0.05, `the body kept the recording ${worst.toFixed(3)} rad after it was let go`);
  // a held one stays until it is stopped
  h.act('fightJab', 0.3, 1, 'full', 0.08, true);
  wait(300); h.pose();
  assert.equal(h.state.actOn, true, 'a held recording let go by itself');
  h.actStop(); h.pose();
  assert.equal(h.state.actOn, false, 'actStop() did not stop it');
  h.dispose();
});

test('blood drops fly, fall and are gone, and nonsense makes none', () => {
  const fx = new FightFx(null);
  fx.blood(0, 1.5, 0, 0, -1, 1);
  assert.ok(fx.live >= 8, `a solid punch threw ${fx.live} drops`);
  const after = fx.live;
  fx.blood(0, 1.5, 0, 0, -1, 0.5);
  assert.ok(fx.live > after && fx.live - after < after, 'a jab bled as much as a hook');
  for (let i = 0; i < 120; i++) fx.update(1 / 60);
  assert.equal(fx.live, 0, 'drops hung in the air');
  fx.blood(NaN, 1, 0, 0, 0, 1);
  assert.equal(fx.live, 0);
  // the pool is fixed: a flurry reuses it rather than growing
  for (let i = 0; i < 50; i++) fx.blood(0, 1.5, 0, 1, 0, 1);
  assert.ok(fx.live <= 64);
});

test('the health bar is a no-op without a page, and never throws', () => {
  const hud = new FightHud(null);
  const p = { hp: 40, mesh: { position: { x: 0, y: 0, z: 0 }, parent: {} } };
  assert.doesNotThrow(() => { hud.foe(p, 0); hud.keep(p, 1); hud.update(null, 2, true); hud.update({}, 3, false); });
  assert.equal(hud.barOf(p), null);
});
