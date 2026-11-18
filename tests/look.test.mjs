// ---- the round-11 look: the parts of it that are arithmetic ----
// What a frame looks like was judged in the game. What can be pinned here is
// the balance of the light rig (a city at noon must say where the sun is), the
// aerial perspective reaching the shaders, the grade being neutral where it
// claims to be, the occlusion pass being deterministic (two players, one
// picture), and every A/B switch in js/lookab.js giving back the old numbers
// exactly, because a verifier compares against them.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { makeSky, updateSky, LIGHT } = await import('../js/sky.js');
const { LOOK_AB } = await import('../js/lookab.js');
const { lookGLSL, LOOK } = await import('../js/heightfog.js');
const { gradeFor } = await import('../js/postfx.js');
const { aoKernel, AO_FRAG } = await import('../js/postao.js');

const rig = () => {
  const scene = new THREE.Scene();
  const sky = makeSky(scene);
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 5000);
  cam.position.set(-740, 236, -1040);
  cam.lookAt(-700, 230, -1000);
  cam.updateMatrixWorld();
  return { scene, sky, cam };
};
const NOON = 0.5;
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
// what lands on open ground in the sun and in shade, and on a shaded wall
const light = (sky) => {
  const sun = sky.sun.intensity * lum(sky.sun.color) * Math.max(0, sky.lightDir.y);
  const top = sky.hemi.intensity * lum(sky.hemi.color);
  const wall = sky.hemi.intensity * (lum(sky.hemi.color) + lum(sky.hemi.groundColor)) / 2;
  return { sunlit: sun + top, shade: top, wall };
};

test('noon says where the sun is: shade a fifth of the sunlit ground, walls readable', () => {
  const { scene, sky, cam } = rig();
  updateSky(sky, NOON, cam, scene, 230);
  const l = light(sky);
  const k = l.shade / l.sunlit;
  assert.ok(k > 0.15 && k < 0.3, `open shade gets ${(k * 100).toFixed(0)} % of the sunlit ground`);
  // the shaded face of a building, lit by the sky above and the street below
  assert.ok(l.wall / l.sunlit > 0.12, `a shaded wall gets ${(100 * l.wall / l.sunlit).toFixed(0)} %`);
  // the bounce off the sunlit street is warm
  assert.ok(sky.hemi.groundColor.r > sky.hemi.groundColor.b);
  // the fill is the sky's colour: blue by day
  assert.ok(sky.hemi.color.b > sky.hemi.color.r);
});

test('the light A/B gives back the old rig exactly, and the knobs are live', () => {
  const { scene, sky, cam } = rig();
  assert.strictEqual(sky.ab, LOOK_AB);
  assert.strictEqual(sky.light, LIGHT);
  try {
    LOOK_AB.light = false;
    updateSky(sky, NOON, cam, scene, 230);
    assert.ok(Math.abs(sky.hemi.intensity - 0.98) < 1e-9);
    assert.ok(Math.abs(sky.sunI - 1.8) < 1e-9, `old sun ${sky.sunI}`);
    assert.ok(Math.abs(sky.hemi.color.r - 0.72) < 1e-9 && Math.abs(sky.hemi.groundColor.b - 0.26) < 1e-9);
    const old = light(sky);
    assert.ok(old.shade / old.sunlit > 0.28, 'the old rig was the flat one');
    LOOK_AB.light = true;
    const was = LIGHT.hemiDay;
    LIGHT.hemiDay = 0.8;
    updateSky(sky, NOON, cam, scene, 230);
    assert.ok(Math.abs(sky.hemi.intensity - 0.8) < 1e-9, 'LIGHT.hemiDay is not read live');
    LIGHT.hemiDay = was;
  } finally {
    LOOK_AB.light = true;
  }
});

test('aerial perspective reaches the fog uniform: bluer than the horizon by day, off by switch', () => {
  const { scene, sky, cam } = rig();
  const deep = THREE.UniformsLib.fog.atcFogDeep?.value;
  const col = THREE.UniformsLib.fog.atcFogCol?.value;
  assert.ok(deep && col, 'heightfog.js no longer shares atcFogDeep');
  try {
    updateSky(sky, NOON, cam, scene, 230);
    assert.ok(deep[3] > 0.4 && deep[3] <= 1, `thin haze weight ${deep[3]}`);
    const blue = (a) => a[2] / (a[0] + a[1] + a[2]);
    assert.ok(blue(deep) > blue(col), 'the thin haze is not bluer than the horizon');
    updateSky(sky, 0.0, cam, scene, 230);
    const night = deep[3];
    assert.ok(night > 0 && night < 0.6 * 0.6, `night weight ${night}`);
    LOOK_AB.air = false;
    updateSky(sky, NOON, cam, scene, 230);
    assert.strictEqual(deep[3], 0);
  } finally {
    LOOK_AB.air = true;
  }
});

test('the tone curve S: a gentle cubic that holds its ends, a uniform on the post path', async () => {
  // y + k y (1 - y)(2y - 1) is monotonic on 0..1 for k < 1 (its slope never
  // falls under 1 - k); a strong k would also crush the open toe
  assert.ok(LOOK.contrast > 0 && LOOK.contrast <= 0.4);
  assert.ok(lookGLSL('f').includes(`( ${LOOK.contrast.toFixed(3)} )`));
  assert.ok(lookGLSL('f', 'uLookK').includes('( uLookK )'));
  const src = await readFile(new URL('../js/postfx.js', import.meta.url), 'utf8');
  assert.ok(src.includes("lookGLSL('atcLookPost', 'uLookK')"), 'the post curve is not switchable');
});

test('the grade: neutral highlights at noon, blue hour cools, the switch gives the old grade', () => {
  try {
    const g = gradeFor(0, 0);
    assert.deepStrictEqual([g.gain.r, g.gain.g, g.gain.b], [1, 1, 1]);
    assert.strictEqual(g.sat, 1);
    const b = gradeFor(0.6, 0.5);
    assert.ok(b.gain.b > b.gain.r * 0.98, 'the blue hour does not cool the highlights');
    assert.ok(gradeFor(0, 1).sat < 1, 'night does not drain colour');
    LOOK_AB.grade = false;
    const o = gradeFor(1, 0);
    assert.ok(Math.abs(o.gain.r - 1.045) < 1e-9 && Math.abs(o.lift.b - 0.020) < 1e-9);
    assert.strictEqual(o.sat, 1);
    assert.strictEqual(o.vignette, 0.08);
  } finally {
    LOOK_AB.grade = true;
  }
  assert.strictEqual(gradeFor(0, 0).vignette, 0.1);
});

test('the occlusion pass is deterministic: fixed kernel, a 4 x 4 interleave of every angle', async () => {
  const a = aoKernel(THREE), b = aoKernel(THREE);
  assert.strictEqual(a.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.ok(a[i].equals(b[i]));
    assert.ok(a[i].z > 0 && a[i].length() <= 1 + 1e-9, `sample ${i} leaves the hemisphere`);
  }
  // two samples reach out to the radius: shade under a car, along a kerb
  assert.ok(a.filter((v) => v.length() > 0.79).length >= 2);
  const src = await readFile(new URL('../js/postao.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!code.includes('Math.random'), 'the kernel must not be random');
  // the Bayer order in the shader, ported: every 4 x 4 block holds all sixteen,
  // aligned or not (the composite's taps cover one that is not)
  assert.ok(AO_FRAG.includes('mod(p.x * 2.0 + p.y * 3.0, 4.0)'));
  const b2 = (x, y) => (x * 2 + y * 3) % 4;
  const b4 = (x, y) => 4 * b2(x % 2, y % 2) + b2(Math.floor(x / 2) % 2, Math.floor(y / 2) % 2);
  for (const [ox, oy] of [[0, 0], [4, 8], [1, 3], [6, 5]]) {
    const seen = new Set();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.add(b4(ox + x, oy + y));
    assert.strictEqual(seen.size, 16);
  }
});
