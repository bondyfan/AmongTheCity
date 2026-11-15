// ---- the light rig: who holds the light, how far you can see, and whether
// the shadows hold still ----
// sky.js drives one DirectionalLight, one HemisphereLight, the fog and the
// tone-mapping exposure from a single number, the time of day. None of it can
// be seen from node, but all of it is arithmetic, and each test here pins a
// property that was broken (or absent) before and is invisible until it is
// wrong on screen: a night with no light in it, shafts toward a sun that has
// set, a fog wall outside the streamed world, shadows that crawl as you walk.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { makeSky, updateSky, EXPOSURE_DAY, EXPOSURE_NIGHT } = await import('../js/sky.js');
const { airFogAmount, FOG_WALL_START } = await import('../js/heightfog.js');

const rig = () => {
  const scene = new THREE.Scene();
  const sky = makeSky(scene);            // no renderer: no environment bake
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 5000);
  cam.position.set(3120.4, 228, -1877.3);
  cam.lookAt(3200, 222, -1900);
  cam.updateMatrixWorld();
  return { scene, sky, cam };
};
const NOON = 0.5, MIDNIGHT = 0.0, DUSK = 20.6 / 24;

test('at night the one light is the moon: up, dim, blue, and not the sun', () => {
  const { scene, sky, cam } = rig();
  updateSky(sky, NOON, cam, scene, 221);
  const sunI = sky.sun.intensity;
  assert.ok(sunI > 1.5, 'no sun at noon');
  assert.equal(sky.moonK, 0);
  updateSky(sky, MIDNIGHT, cam, scene, 221);
  assert.ok(sky.sunDir.y < -0.5, 'the sun is not under the horizon at midnight');
  assert.ok(sky.lightDir.y > 0.5, 'the light did not move to the moon side');
  assert.ok(sky.sun.intensity > 0.03 && sky.sun.intensity < sunI / 8,
    `moonlight is ${sky.sun.intensity}: it has to exist and stay far under the sun`);
  assert.ok(sky.sun.color.b > sky.sun.color.r, 'moonlight is not blue');
  // what main.js feeds god rays and the lens flare: the SUN's own level
  assert.equal(sky.sunI, 0, 'sky.sunI must be zero once the sun is down');
  // the shadow light stands above the ground it lights
  assert.ok(sky.sun.position.y > sky.sun.target.position.y + 10);
});

test('the light never jumps while it is lit: sun and moon change over in the dark', () => {
  const { scene, sky, cam } = rig();
  let prev = null, worst = 0;
  for (let h = 19; h <= 23; h += 1 / 120) {       // half a game-minute steps
    updateSky(sky, h / 24, cam, scene, 221);
    const d = sky.lightDir.clone();
    if (prev && prev.d.dot(d) < 0.9) worst = Math.max(worst, Math.min(prev.i, sky.sun.intensity));
    prev = { d, i: sky.sun.intensity };
  }
  assert.ok(worst < 1e-6, `the light swung round while at intensity ${worst}`);
});

test('the camera opens up at night and the ambient never goes to nothing', () => {
  const { scene, sky, cam } = rig();
  updateSky(sky, NOON, cam, scene, 221);
  assert.ok(Math.abs(sky.exposure - EXPOSURE_DAY) < 1e-9);
  const dayAmb = sky.hemi.intensity;
  updateSky(sky, MIDNIGHT, cam, scene, 221);
  assert.ok(Math.abs(sky.exposure - EXPOSURE_NIGHT) < 1e-9);
  assert.ok(EXPOSURE_NIGHT > EXPOSURE_DAY * 2, 'the night exposure does not open up');
  // a moonlit street, seen: ambient × exposure must stay a real fraction of day
  const seen = (sky.hemi.intensity * sky.exposure) / (dayAmb * EXPOSURE_DAY);
  assert.ok(seen > 0.35 && seen < 0.9, `night ambient reads as ${(seen * 100).toFixed(0)} % of day`);
  // …and it climbs monotonically through dusk: no dip, no flash
  let last = 0;
  for (let h = 12; h <= 24; h += 0.05) {
    updateSky(sky, h / 24, cam, scene, 221);
    assert.ok(sky.exposure >= last - 1e-9, `exposure fell at ${h.toFixed(2)} h`);
    last = sky.exposure;
  }
});

test('the fog wall ends inside the streamed world, day and night, at any scale', () => {
  const { scene, sky, cam } = rig();
  for (const fs of [0.47, 1, 3.4]) {
    sky.fogScale = fs;
    for (const tod of [NOON, DUSK, MIDNIGHT]) {
      updateSky(sky, tod, cam, scene, 221);
      const { near, far } = scene.fog;
      assert.ok(far <= 900 * fs + 1e-6, `fog.far ${far} is past the streamed edge at scale ${fs}`);
      assert.ok(Math.abs(near - far * FOG_WALL_START) < 1e-6);
      // traffic.js and pedestrians.js retire actors at 0.88 × fog.far and rely
      // on the fog having all but hidden them there
      assert.ok(airFogAmount(0.88 * far, 0, 2, near, far) > 0.85);
      assert.ok(airFogAmount(far, 0, 2, near, far) > 0.999);
    }
  }
});

// round 8 (HORIZON): where the view is open (sky.fogOpen, js/openness.js) the
// wall moves out over the far land and the haze is scaled to a few km; at 0
// it must be exactly the old fog, and the crowd and the cars keep their edge.
test('an open view moves the wall out to kilometres, and a street keeps it exactly', () => {
  const { scene, sky, cam } = rig();
  sky.fogScale = (480 * 0.88) / 900;                 // medium, on foot
  for (const tod of [NOON, MIDNIGHT]) {
    sky.fogOpen = 0;
    updateSky(sky, tod, cam, scene, 221);
    const street = { near: scene.fog.near, far: scene.fog.far, vis: sky.fogVis };
    assert.equal(sky.edgeFar, street.far, 'the edge wall is the wall in a street');
    assert.equal(street.vis, street.far, 'the haze is scaled to the wall in a street');
    if (tod === NOON) {
      assert.ok(Math.abs(street.far - 422.4) < 0.05 && Math.abs(street.near - 278.8) < 0.05,
        `medium noon at the station is ${street.near.toFixed(1)} / ${street.far.toFixed(1)}`);
    }
    sky.fogOpen = 1;
    updateSky(sky, tod, cam, scene, 221);
    const { near, far } = scene.fog;
    assert.equal(sky.edgeFar, street.far, 'the streamed edge moved with the view');
    assert.ok(far >= 3000, `the open wall is at ${far} m`);
    assert.ok(airFogAmount(1000, 0, 2, near, far, sky.fogVis) < 0.10, 'a kilometre is milk in the open');
    assert.ok(airFogAmount(far, 0, 2, near, far, sky.fogVis) > 0.999);
  }
  sky.fogOpen = 0;
});

test('haze: light at your feet, thick at the edge, thinner from above', () => {
  const near = 280, far = 422;                    // medium preset, on the ground
  // the next junction must not sit in milk
  assert.ok(airFogAmount(60, 0, 2, near, far) < 0.05);
  assert.ok(airFogAmount(120, 0, 2, near, far) < 0.14);
  // monotonic all the way out: no band, no dip where the wall takes over
  let last = 0;
  for (let d = 0; d <= far; d += 2) {
    const f = airFogAmount(d, 0, 2, near, far);
    assert.ok(f >= last - 1e-9, `fog thins at ${d} m`);
    last = f;
  }
  // height: the same slant range is clearer looking down from 300 m than
  // looking along the street, and a tower top is clearer than its foot
  const N = 2000, F = 3000;
  assert.ok(airFogAmount(1500, -300, 300, N, F) < airFogAmount(1500, 0, 2, N, F) * 0.8);
  assert.ok(airFogAmount(300, 80, 2, near, far) < airFogAmount(300, 0, 2, near, far));
});

test('the shadow box moves in whole texels, so shadows do not swim', () => {
  const { scene, sky, cam } = rig();
  updateSky(sky, 0.42, cam, scene, 221);
  const map = sky.sun.shadow.mapSize.x;
  const texel = (sky.sun.shadow.camera.right - sky.sun.shadow.camera.left) / map;
  // the light's own right and up, as three derives them
  const dir = sky.sun.position.clone().sub(sky.sun.target.position).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
  const up = dir.clone().cross(right);
  const t0 = sky.sun.target.position.clone();
  let moved = 0;
  for (let i = 1; i <= 400; i++) {
    // walk and climb in steps far smaller than a texel
    cam.position.x += 0.013; cam.position.z -= 0.021;
    cam.updateMatrixWorld();
    updateSky(sky, 0.42, cam, scene, 221 + i * 0.002);
    const d = sky.sun.target.position.clone().sub(t0);
    for (const axis of [right, up]) {
      const n = d.dot(axis) / texel;
      assert.ok(Math.abs(n - Math.round(n)) < 1e-4,
        `the box sits ${n.toFixed(3)} texels off its start: not a whole number`);
    }
    if (d.length() > 1e-9) moved++;
  }
  assert.ok(moved > 0, 'the box never followed the camera');
  // and the direction it is drawn from holds still while the sun creeps
  const before = dir.clone();
  updateSky(sky, 0.42 + 1e-5, cam, scene, 222);    // 0.9 s of game time
  const after = sky.sun.position.clone().sub(sky.sun.target.position).normalize();
  assert.ok(before.distanceTo(after) < 1e-12, 'the shadow direction crept between steps');
});

test('the shadow box is sized from the map, about ten centimetres a texel', () => {
  const { scene, sky, cam } = rig();
  for (const size of [1024, 2048, 4096]) {
    sky.sun.shadow.mapSize.set(size, size);
    updateSky(sky, NOON, cam, scene, 221);
    const sc = sky.sun.shadow.camera;
    const texel = (sc.right - sc.left) / size;
    assert.ok(texel > 0.06 && texel < 0.19, `${size}: ${(texel * 100).toFixed(1)} cm per texel`);
    // the far plane reaches the ground at the far corner of the box
    const reach = sky.sun.position.distanceTo(sky.sun.target.position) + sc.right * 1.42;
    assert.ok(sc.far > reach, `${size}: far plane ${sc.far} short of ${reach.toFixed(0)}`);
  }
});
