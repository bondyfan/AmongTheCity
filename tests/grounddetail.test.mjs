// ---- the ground's street-level detail is wired, not just written ----------
// Both ground materials take their detail by string surgery on three's own
// shaders (onBeforeCompile): js/surfaces.js on MeshStandardMaterial for every
// mapped street, js/orthodetail.js on the aerial photo's Lambert. A replace
// whose target three renamed fails SILENTLY, the material compiles without the
// detail and the only symptom is a ground that looks as it did. Nothing here
// can compile GLSL, so it asserts what can be asserted headless: every hook
// landed, no template placeholder survived, the braces balance, and both
// programs hold the ONE shared switch, so the A/B toggle reaches all of them.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { GROUND_DETAIL } = await import('../js/groundglsl.js');
const { surfaceMaterial, surfaceTextures } = await import('../js/surfaces.js');
const { orthoDetail } = await import('../js/orthodetail.js');

// what WebGLRenderer hands onBeforeCompile, minus the program
function compile(mat, lib) {
  const sh = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[lib].uniforms),
    vertexShader: THREE.ShaderLib[lib].vertexShader,
    fragmentShader: THREE.ShaderLib[lib].fragmentShader,
  };
  mat.onBeforeCompile(sh, null);
  return sh;
}

const balanced = (src) => {
  let d = 0;
  for (const c of src) { if (c === '{') d++; else if (c === '}' && --d < 0) return false; }
  return d === 0;
};

test('the photo material takes the detail, the relief and the switch', () => {
  const mat = orthoDetail(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const sh = compile(mat, 'lambert');
  assert.match(sh.vertexShader, /vGroundXZ = atcWrapXZ\(transformed\)/, 'vertex hook missed');
  assert.match(sh.vertexShader, /vGroundY = /, 'camera-height varying missing');
  assert.match(sh.fragmentShader, /float atcNearK/, 'map_fragment hook missed');
  assert.match(sh.fragmentShader, /#include <normal_fragment_maps>\n[\s\S]*uDetailNrm, vec3/,
    'relief hook missed');
  assert.match(sh.fragmentShader, /textureLod\(map, vMapUv, max\(lod0/,
    'the blurred photo is read with a bias again (a bias does nothing while magnified)');
  assert.doesNotMatch(sh.fragmentShader + sh.vertexShader, /@[A-Z]+@/, 'a placeholder survived');
  assert.ok(balanced(sh.fragmentShader) && balanced(sh.vertexShader), 'unbalanced braces');
  assert.equal(sh.uniforms.uGroundDetail, GROUND_DETAIL, 'not the shared switch');
  assert.ok(sh.uniforms.uDetailAlb.value?.isDataArrayTexture);
  assert.ok(sh.uniforms.uDetailNrm.value?.isDataArrayTexture);
  // one program for every supertile, and a second call is a no-op
  assert.equal(mat.customProgramCacheKey(), 'ortho-detail-v2');
  const before = mat.onBeforeCompile;
  orthoDetail(mat);
  assert.equal(mat.onBeforeCompile, before);
});

test('the street material calls the detail it declares, behind the switch', () => {
  const sh = compile(surfaceMaterial(), 'standard');
  assert.match(sh.fragmentShader, /vec3 atcStreetDetail\(/, 'detail function not declared');
  assert.match(sh.fragmentShader, /if \(uGroundDetail > 0\.5\) \{\s*vec2 fwd/, 'detail not called');
  assert.match(sh.vertexShader, /vWorldXZ = atcWrapXZ\(position\)/, 'precise world xz missing');
  assert.doesNotMatch(sh.fragmentShader, /#include <map_fragment>/, 'map hook missed');
  assert.ok(balanced(sh.fragmentShader) && balanced(sh.vertexShader), 'unbalanced braces');
  assert.equal(sh.uniforms.uGroundDetail, GROUND_DETAIL, 'not the shared switch');
});

test('the wrap keeps every texture period whole', () => {
  // 4 800 m must be a whole number of repeats of every class's tile, or the
  // textures would jump at the wrap (js/groundglsl.js WRAP_GLSL)
  // (the scales are a Float32Array: 2.4 comes back as 2.4000000954, which the
  // GPU holds too, a 0.02-texel slip at the wrap; the DESIGN value is checked)
  for (const f of [...surfaceTextures().scale, 2.4 /* the photo's setts */]) {
    const s = Number(f.toFixed(4)), n = 4800 / s;
    assert.ok(Math.abs(n - Math.round(n)) < 1e-9, `${s} m does not divide 4800 m`);
  }
});
