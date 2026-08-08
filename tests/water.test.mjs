// ---- the river ------------------------------------------------------------
// Two complaints, both structural rather than a matter of taste:
//
//   "moc obrovské vlny"  — the vertex wave ran 12.7 cm of amplitude over 45–55 m
//   wavelengths. On a 40 m wide river that is the entire surface heaving as one
//   body: Atlantic swell in Pardubice. It also could not be fixed by shortening
//   the wavelength, because the water mesh is tessellated at 8 m and anything
//   under about 16 m simply aliases against the vertex spacing.
//
//   "i když je tma, ona svítí moc tyrkysová" — the fragment shader had NO light
//   input whatsoever. The sun direction was a hardcoded constant and the body
//   colour was a constant, so the river was exactly as bright at midnight as at
//   noon, with a sun glint on it that no sun in the sky could account for.
//
// These are the invariants that keep both fixed. They read the shader source
// because that is where the bug lived — there is no WebGL in node to render it.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { makeMaterials } = await import('../js/meshes.js');

const water = makeMaterials().water;
const VS = water.vertexShader, FS = water.fragmentShader;

test('the water is told the time of day at all', () => {
  for (const k of ['uSun', 'uNight', 'uSky'])
    assert.ok(water.uniforms[k], `no ${k} uniform — the water cannot know about the sky`);
  assert.ok(water.uniforms.uSun.value?.isVector3, 'uSun must survive UniformsUtils.merge as a Vector3');
  assert.ok(water.uniforms.uSky.value?.isColor, 'uSky must survive UniformsUtils.merge as a Color');
});

test('nothing in the shader hardcodes where the sun is', () => {
  assert.ok(!/sunDir\s*=\s*normalize\(\s*vec3\s*\(\s*-?[\d.]/.test(FS),
    'a literal sun direction is back in the fragment shader — it will glint at midnight');
  assert.ok(/uSun/.test(FS), 'the fragment shader never reads uSun');
});

test('the body colour goes dark when the night does', () => {
  // it must be SCALED by the day level, not merely mentioned
  assert.match(FS, /colour\s*\*=\s*[\d.]+\s*\+\s*[\d.]+\s*\*\s*day/,
    'the body colour is not multiplied by a day term');
  const m = FS.match(/colour\s*\*=\s*([\d.]+)\s*\+\s*([\d.]+)\s*\*\s*day/);
  const atNight = Number(m[1]), atNoon = Number(m[1]) + Number(m[2]);
  assert.ok(atNight < 0.15, `night still keeps ${(atNight*100).toFixed(0)}% of the daylight colour`);
  assert.ok(atNoon > 0.9, 'daylight water has been dimmed too');
  assert.ok(atNoon / atNight > 6, `only ${(atNoon/atNight).toFixed(1)}x darker at night — not enough to read as dark`);
});

test('the sun glint cannot fire while the sun is below the horizon', () => {
  assert.match(FS, /above\s*=\s*clamp\(\s*uSun\.y/,
    'the glint is not gated on the sun actually being up');
  for (const term of ['glint * above', 'max(dot(n, uSun), 0.0) * above'])
    assert.ok(FS.includes(term), `a sun term is ungated: expected "${term}"`);
});

test('the river is not turquoise', () => {
  // the old body colour was vec3(0.025, 0.19, 0.255): 0.90 saturation, bluest
  // channel — eighteen metres of clear tropical water over white sand
  const body = FS.match(/vec3 body\s*=\s*vec3\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
  assert.ok(body, 'no body colour found');
  const [r, g, b] = body.slice(1).map(Number);
  const sat = (Math.max(r,g,b) - Math.min(r,g,b)) / Math.max(r,g,b);
  assert.ok(sat < 0.45, `body colour saturation ${sat.toFixed(2)} — a lowland river is murky, not a lit sign`);
  assert.ok(g >= r && g >= b, `the greenest channel should win for a Czech river, got ${r}/${g}/${b}`);
});

test('the geometry waves are a breath, not a swell', () => {
  const disp = VS.match(/p\.y \+= ([^;]+);/);
  assert.ok(disp, 'no vertex displacement found');
  const amps = (disp[1].match(/\*\s*([\d.]+)/g) ?? []).map((s) => Number(s.replace(/[*\s]/g, '')));
  const crest = amps.reduce((a, b) => a + b, 0);
  assert.ok(crest < 0.04,
    `${(crest*100).toFixed(1)} cm crest (${(crest*200).toFixed(1)} cm peak-to-trough) — that is swell, not a river`);
});

test('…and no geometry wave is shorter than the 8 m mesh can carry', () => {
  // terrainTess builds the water surface at 8 m. A wave under ~16 m of
  // wavelength is below Nyquist for that spacing: it does not get smaller on
  // screen, it aliases into a shimmering mess that moves with the camera.
  const waves = [...VS.matchAll(/baseWorld\.x \* (-?[\d.]+) \+ baseWorld\.z \* (-?[\d.]+)/g)];
  assert.ok(waves.length, 'no wave terms found in the vertex shader');
  for (const [, fx, fz] of waves) {
    const lambda = 2 * Math.PI / Math.hypot(Number(fx), Number(fz));
    assert.ok(lambda >= 16,
      `a ${lambda.toFixed(0)} m wave on an 8 m mesh will alias — put it in rippleNormal instead`);
  }
});

test('the ripples you actually see are per-pixel, and river-sized', () => {
  assert.ok(/vec3 rippleNormal\(/.test(FS), 'the per-pixel ripple normal is gone');
  const ks = [...FS.matchAll(/vec2 k\d = vec2\((-?[\d.]+),\s*(-?[\d.]+)\)/g)]
    .map((m) => 2 * Math.PI / Math.hypot(Number(m[1]), Number(m[2])));
  assert.ok(ks.length >= 3, 'fewer than three ripple scales — one sine field reads as corduroy');
  for (const l of ks)
    assert.ok(l > 0.5 && l < 12, `a ${l.toFixed(1)} m "ripple" is not a ripple`);
});
