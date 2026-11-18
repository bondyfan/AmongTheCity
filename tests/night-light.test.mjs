// The night's light debts (round 5): street light on the direct path, the
// fans' own map, the moon's shadow under a lamp, a bubble dimmed to the scene.
// Pure logic and shader contracts only: what is on screen was looked at in the
// game, on every preset, at midnight and at noon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LampMap, LAMP_GLSL, LAMP_DIRECT_GLSL, LAMP_DIRECT_WORLD, LAMP_DIRECT_U, lampDirectPatch, BEAM_SIZE, BEAM_COVER }
  = await import('../js/lampmap.js');
const { LightPools, TUNE } = await import('../js/lightpools.js');
const { bubbleDim } = await import('../js/chatbubbles.js');
const { PANE_GLOW_GLSL } = await import('../js/facadeatlas.js');

// a renderer that only keeps count: which target was bound when a scene was drawn
function fakeRenderer(target = null) {
  const r = {
    target, draws: [], clears: 0,
    getRenderTarget() { return r.target; },
    setRenderTarget(t) { r.target = t; },
    getClearAlpha() { return 1; },
    getClearColor(c) { return c; },
    setClearColor() {},
    clear() { r.clears++; },
    render(scene) { r.draws.push([r.target, scene]); },
  };
  return r;
}
const camera = { position: new THREE.Vector3(10.3, 225, -20.7) };
const sky = (nightK) => ({ nightK, hemi: { color: new THREE.Color(0.45, 0.58, 0.98), intensity: 0.12 },
  sun: { color: new THREE.Color(0.6, 0.72, 1), intensity: 0.085 }, lightDir: new THREE.Vector3(0.25, 0.61, 0.75) });
const mast = (x, z) => ({ x, y: 220, z, i: 0, kind: 'street', posts: { userData: { spots: [x, z, 0] } } });
const world = (poles) => ({ poles: { grid: new Map([['k', poles]]) }, terrain: { heightAt: () => 220 } });
const car = { x: 0, z: 0, heading: 0, mesh: { position: { y: 220.2 } } };

test('switching the street-lamp flare keeps the lamps and their road lighting on', () => {
  const lp = new LightPools(new THREE.Scene());
  const view = { ...camera, fov: 55 }, w = world([mast(10, -12)]);
  assert.equal(lp.glowMat.defines.STREET_LENS, 1);
  assert.equal(lp.far.mat.defines.STREET_LENS, undefined);
  for (const flare of [true, false, true]) {
    lp.update(0.016, view, w, sky(1), 900, [], null, flare);
    assert.equal(lp.glowMat.uniforms.uFlare.value, Number(flare));
    assert.ok(lp.glows.visible && lp.pools.visible);
    assert.ok(lp.glowMat.uniforms.uOn.value > 0 && lp.poolMat.uniforms.uOn.value > 0);
  }
});

test('a bubble is as it was by day and comes down with the scene at night, on both paths', () => {
  assert.equal(bubbleDim(0.86, true), 1);
  assert.equal(bubbleDim(0.86, false), 1);
  assert.equal(bubbleDim(0.5, true), 1, 'an exposure under the day value never brightens a bubble');
  // through the composite the colour passes the tone curve at 2.5: holding the
  // day's white would be 0.344, and the bubble is taken to about a third of that
  const post = bubbleDim(2.5, true), direct = bubbleDim(2.5, false);
  assert.ok(post > 0.09 && post < 0.15, `post path at midnight: ${post}`);
  assert.ok(direct > 0.3 && direct < 0.45, `direct path at midnight: ${direct}`);
  // what reaches the screen is about the same on both: colour x exposure / day
  assert.ok(Math.abs(post * 2.5 / 0.86 - direct) < 0.05);
  let prevP = 2, prevD = 2;
  for (let e = 0.86; e <= 2.5; e += 0.1) {
    const p = bubbleDim(e, true), d = bubbleDim(e, false);
    assert.ok(p < prevP && d <= prevD, 'never brighter as the night comes on');
    prevP = p; prevD = d;
  }
});

test('the fans have a map of their own, drawn after the pools into a second target', () => {
  const lp = new LightPools({ add() {} });
  const map = new LampMap(lp.pools, lp.beams, 430, 190);
  lp.pools.count = 3; lp.beams.count = 2;
  const r = fakeRenderer('frame');
  const o = map.bake(r, camera, 600, 220, 1, 0.85, 0.6);
  assert.equal(r.draws.length, 2);
  assert.equal(r.draws[0][0], map.rt);
  assert.equal(r.draws[1][0], map.rtBeam);
  assert.notEqual(r.draws[0][1], r.draws[1][1], 'pools and fans in one scene would land in one target');
  assert.equal(r.target, 'frame', 'the render target is put back');
  assert.equal(o.tex, map.rt.texture);
  assert.equal(o.beamTex, map.rtBeam.texture);
  assert.equal(map.rtBeam.width, BEAM_SIZE);
  assert.equal(o.beamSize, BEAM_COVER);
  // each map is centred on the camera in whole texels of its OWN grid
  const tp = 600 / map.size, tb = BEAM_COVER / BEAM_SIZE;
  assert.ok(Math.abs(o.cx / tp - Math.round(o.cx / tp)) < 1e-6 && Math.abs(o.cx - camera.position.x) <= tp / 2 + 1e-9);
  assert.ok(Math.abs(o.bz / tb - Math.round(o.bz / tb)) < 1e-6 && Math.abs(o.bz - camera.position.z) <= tb / 2 + 1e-9);
  assert.equal(map.beamMat.uniforms.uMap.value.z, 2 / BEAM_COVER);
  assert.equal(map.beamMat.uniforms.uLevel.value, 0.6);
  // nothing to draw: the targets are still cleared (a stale fan must not stay)
  lp.pools.count = 0; lp.beams.count = 0;
  const r2 = fakeRenderer(null);
  map.bake(r2, camera, 600, 220, 1, 0.85, 0.6);
  assert.equal(r2.draws.length, 0);
  assert.equal(r2.clears, 2);
  map.dispose();
});

test('the composite bends pools and fans separately and reads the moon shadow', () => {
  assert.match(LAMP_GLSL, /uniform sampler2D tBeam;/);
  assert.match(LAMP_GLSL, /1\.0 \+ Lp \* uLampShape\.x/);
  assert.match(LAMP_GLSL, /1\.0 \+ Lb \* uLampShape\.w/, 'the fans keep a shoulder of their own');
  assert.doesNotMatch(LAMP_GLSL, /\(Lp \+ Lb\) \*/, 'pools and fans bent as one sum hide a fan on a lit road');
  assert.match(LAMP_GLSL, /uniform sampler2D tSunShadow;/);
  assert.match(LAMP_GLSL, /amb \*= \(H \+ M \* atcSunLit\(world, n\)\) \/ \(H \+ M\)/);
  // derivatives are taken by the caller, never inside lampLight's branches
  assert.doesNotMatch(LAMP_GLSL, /dFdx|dFdy|fwidth/);
});

test('a patched material reads the SHARED uniforms and adds what its surface sends back', () => {
  const frag = 'void main() {\n#include <common>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n}';
  const a = { uniforms: {}, fragmentShader: frag }, b = { uniforms: { own: 1 }, fragmentShader: frag };
  lampDirectPatch(a);
  lampDirectPatch(b, true);
  for (const k of Object.keys(LAMP_DIRECT_U)) {
    assert.equal(a.uniforms[k], LAMP_DIRECT_U[k], `${k} must be the one shared object`);
    assert.equal(b.uniforms[k], LAMP_DIRECT_U[k]);
  }
  assert.equal(b.uniforms.own, 1);
  assert.ok(a.fragmentShader.includes(LAMP_DIRECT_GLSL));
  assert.match(a.fragmentShader, /reflectedLight\.indirectDiffuse \+= atcLampDirect\( atcLampW, atcLampUp, 0\.0, material\.diffuseColor \);/);
  assert.match(b.fragmentShader, /atcLampDirect\( atcLampW, atcLampUp, 1\.0, material\.diffuseColor \)/, 'static things leave the foot to the quads');
  // the pale end is held back exactly as the composite holds it
  assert.match(LAMP_DIRECT_GLSL, /alb \/ \(1\.0 \+ alb \* uBeamDMap\.w\)/);
  assert.match(LAMP_GLSL, /alb \/= 1\.0 \+ alb \* uLampSurf\.y;/);
  assert.match(a.fragmentShader, /if \( uLampDK\.x > 0\.5 \)/, 'one uniform test is all the post path pays');
  // The world y of the normal is the view matrix's second COLUMN dotted with
  // the view-space normal. The second row (the camera's up axis) gave a level
  // roof 0.47 from a chase camera and a wall anything from -0.9 to 0.8 with
  // the camera's yaw, so the light on a car changed as the camera turned.
  assert.match(LAMP_DIRECT_WORLD, /atcLampUp = dot\( viewMatrix\[ 1 \]\.xyz, normal \)/);
  assert.doesNotMatch(LAMP_DIRECT_WORLD, /viewMatrix\[ 0 \]\[ 1 \]/);
  {
    // the same arithmetic on the CPU: the expression must return the world
    // normal's y for any camera
    const cam = new THREE.PerspectiveCamera(50, 1.33, 0.1, 100);
    for (const [p, n] of [[[0, 6, 10], [0, 1, 0]], [[8, 6, 6], [0, 1, 0]], [[3, 12, 1], [1, 0, 0]], [[10, 2, 0], [0, 0, 1]]]) {
      cam.position.set(...p); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
      const V = cam.matrixWorldInverse.elements;          // column-major, as GLSL indexes it
      const nv = new THREE.Vector3(...n).transformDirection(cam.matrixWorldInverse);
      const up = V[4] * nv.x + V[5] * nv.y + V[6] * nv.z;   // dot( viewMatrix[ 1 ].xyz, normal )
      assert.ok(Math.abs(up - n[1]) < 1e-6, `camera at ${p}: ${up} for a normal whose world y is ${n[1]}`);
    }
  }
  // the tokens other patches hang on are still there (citizen.js adds its sky wrap at the same place)
  assert.ok(a.fragmentShader.includes('#include <lights_fragment_begin>'));
  assert.ok(a.fragmentShader.indexOf('atcLampDirect( atcLampW') < a.fragmentShader.indexOf('#include <lights_fragment_end>'));
});

test('materials light themselves on the direct path only, and never from a stale map', () => {
  const k = LAMP_DIRECT_U.uLampDK.value;
  const lp = new LightPools({ add() {} });
  const w = world([mast(5, 5)]);
  lp.update(0.016, camera, w, sky(1), 720, [car], null);
  assert.equal(lp.count, 1);
  assert.equal(typeof lp.pools.onBeforeRender, 'function');

  // into a render target (the post stack draws the scene there): nothing happens
  const post = fakeRenderer('scene-target');
  lp.pools.onBeforeRender(post, null, camera);
  assert.equal(post.draws.length, 0);

  // straight to the canvas: the maps are baked from inside the frame, small
  const direct = fakeRenderer(null);
  lp.pools.onBeforeRender(direct, null, camera);
  assert.equal(direct.draws.length, 2);
  assert.equal(direct.target, null, 'the canvas is bound again for the object about to be drawn');
  assert.equal(lp.map.size, TUNE.mapDirect);
  assert.equal(k.x, 1);
  assert.equal(LAMP_DIRECT_U.tLampD.value, lp.map.rt.texture);
  assert.equal(LAMP_DIRECT_U.tBeamD.value, lp.map.rtBeam.texture);
  assert.equal(LAMP_DIRECT_U.uLampDMap.value.w, 220, 'heights ride relative to the ground under the camera');
  assert.ok(Math.abs(LAMP_DIRECT_U.uBeamDMap.value.z - 1 / BEAM_COVER) < 1e-12);
  assert.equal(LAMP_DIRECT_U.uBeamDMap.value.w, TUNE.soft);
  // with the pools up, the fans do not bake a second time in the same frame
  lp.beams.onBeforeRender(direct, null, camera);
  assert.equal(direct.draws.length, 2);

  // the post path takes over: the composite lights everything, materials add nothing,
  // and the pool map is the full size again
  const o = lp.bake(fakeRenderer('x'), camera);
  assert.equal(k.x, 0);
  assert.equal(lp.map.size, 1024);
  assert.equal(o.beamKnee, TUNE.beamKnee);
  assert.equal(o.leaf, TUNE.leaf);
  assert.ok(o.sun && o.hemi, 'the composite is handed the frame\'s own lights for the shadow fill');
  assert.equal(lp.pools.visible, false, 'and the quads are out of the scene for that frame');

  // back on the direct path, then the lamps and the cars are gone: no bake can
  // run, so the switch goes off rather than leave a map of somewhere else live
  lp.update(0.016, camera, w, sky(1), 720, [car], null);
  lp.pools.onBeforeRender(fakeRenderer(null), null, camera);
  assert.equal(k.x, 1);
  lp.update(0.6, camera, world([]), sky(1), 720, [], null);
  assert.equal(lp.count, 0);
  assert.equal(k.x, 0);

  // only fans (a car on an unlit road): the fans carry the bake
  lp.update(0.6, camera, world([]), sky(1), 720, [car], null);
  assert.equal(lp.pools.visible, false);
  const lone = fakeRenderer(null);
  lp.beams.onBeforeRender(lone, null, camera);
  assert.equal(lone.draws.length, 1, 'one target has something to draw, both were cleared');
  assert.equal(lone.clears, 2);
  assert.equal(k.x, 1);

  // by day nothing reads the maps
  lp.update(0.016, camera, w, sky(0), 720, [car], null);
  assert.equal(k.x, 0);
  const day = fakeRenderer(null);
  lp.pools.onBeforeRender(day, null, camera);
  assert.equal(day.draws.length, 0);
});

test('a lit shop front is a room behind glass: a plain window keeps its card', () => {
  // GLSL ES 3 reserves these as words; a parameter named so compiles nowhere
  for (const word of ['flat', 'smooth', 'sample', 'centroid', 'patch', 'input', 'output', 'filter'])
    assert.doesNotMatch(PANE_GLOW_GLSL, new RegExp(`(float|vec[234]|int) ${word}\\b`), `"${word}" is reserved`);
  assert.match(PANE_GLOW_GLSL, /if \(shop < 0\.5\) return vec3\(card\);/);
  // the derivatives come before that early return: inside a branch they are undefined
  assert.ok(PANE_GLOW_GLSL.indexOf('dFdy(uv)') < PANE_GLOW_GLSL.indexOf('if (shop < 0.5)'));
  assert.doesNotMatch(PANE_GLOW_GLSL, /texture2D|texture\(/, 'the room is worked out, not fetched');
});

test('only the dark wood floor is lifted, not everything in the forest class', async () => {
  // The forest surface class is shared: the wood's own dark fill, but also
  // scrub, a wood drawn without its trees and the planted crown of a
  // roundabout, each in a lighter green. Lifted by class alone those came out
  // straw yellow. The shader tells the floor by its vertex tint, read from
  // vColor (three multiplies the vertex colour in AFTER <map_fragment>, so
  // diffuseColor is still the material's white there).
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../js/surfaces.js', import.meta.url), 'utf8');
  assert.match(src, /float floorK = 1\.0 - smoothstep\(0\.07, 0\.11, dot\(vColor\.rgb, vec3\(0\.2126, 0\.7152, 0\.0722\)\)\);/);
  assert.match(src, /tone \*= mix\(vec3\(1\.0\), vec3\(2\.2, 1\.6, 1\.4\), floorK\);/);
  // the tints it has to tell apart (linear luminance)
  const lum = (hex) => {
    const c = new THREE.Color(hex);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  };
  const meshes = await readFile(new URL('../js/meshes.js', import.meta.url), 'utf8');
  const floorHex = Number(meshes.match(/const FOREST_FLOOR = (0x[0-9a-f]{6})/i)[1]);
  const { COLORS } = await import('../js/config.js');
  assert.ok(lum(floorHex) < 0.07, `the wood floor's fill gets the whole lift: ${lum(floorHex)}`);
  for (const k of ['bush', 'wood', 'grass', 'park'])
    assert.ok(lum(COLORS.green[k]) * 0.8 > 0.11, `${k} keeps its own colour (even at the 0.8 a planter's wall is drawn at)`);
});
