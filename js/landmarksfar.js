// ---- landmarksfar.js: the Prague skyline beyond the streamed ring ----
// MAIN THREAD ONLY (it owns meshes in the scene); the silhouettes themselves
// are built with the worker-safe landmark kit.
//
// A landmark lives in its home chunk, and a chunk exists only inside the
// streamed ring (480 m on the default preset). Prague is read by what stands
// a kilometre and more away: the castle and St Vitus 928 m from Charles
// Bridge, Žižkov 2.3 km from the Old Town Square. So the tall ones are also
// built a second time, once, as low-poly silhouettes (a few hundred triangles
// each) at fixed baked positions, and kept in the scene for as long as the
// camera is in Prague.
//
// HANDING OVER. A landmark normally fades into the haze between 70 and 95 %
// of the built radius R (its fog wall, js/landmarksmat.js). The near models of
// the far set are instead drawn in the silhouettes' own air while the skyline
// runs (farNearMaterial), and the silhouette comes in as a screen-door dither
// (a pixel is drawn or discarded, by an interleaved-gradient hash, as the
// share 0 at 0.70 R to 1 at 0.90 R) over a near model of the same colour, so
// the two hand over instead of popping, and the near mesh is
// switched off once ALL of its chunk's box lies beyond 0.92 R, where it is
// almost all fog and would otherwise paint fog-coloured specks over the
// silhouette. The silhouette has its own fog wall at FAR_R and the same haze
// as everything else, so it reads as distant.
//
// Co-op: nothing here depends on time, randomness or the order tiles came in.

import * as THREE from 'three';
import { Kit, LandmarkSink, K } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';
import { landmarkMaterial, WALL } from './landmarksmat.js';
import { chunkKey } from './geo.js';
import { vitFar } from './landmarks-vit.js';
import { hradFar } from './landmarks-hradfar.js';
import { FAR_EXTRA } from './landmarks-farset.js';
import { FAR_GROUND, groundReady, buildFarGround } from './landmarks-farground.js';
import { setFarHand } from './heightfog.js';

/** Where the silhouettes' own fog wall ends (m), and how far from Prague the set is kept at all. */
export const FAR_R = 4600;
const PRAGUE = [-95600, -5500], KEEP = 8000;
/** Is (x, z) where the far skyline is kept (main.js: the far landscape and the open fog stay out of it)? */
export const inSkyline = (x, z) => Math.hypot(x - PRAGUE[0], z - PRAGUE[1]) < KEEP;

/**
 * The silhouettes. at: [x, z] the mesh origin; ground: absolute founding
 * height; frame: [ox, oz, nx, nz] the near builder's own frame (baked from
 * fitFrame on the shipped tile, pinned by tests/landmarks-praha-wide.test.mjs);
 * box: the world box [x0, z0, x1, z1] of the near model, for the hand-over.
 */
export const FAR_SET = [
  { id: 'vit', ground: 255.81, frame: [-97118.98, -6578.19, -0.9363, 0.3511], box: [-97190, -6640, -97050, -6520], build: vitFar, flood: () => 0.85 },
  { id: 'hrad', ground: 0, frame: [-97137.0, -6528.3, 0.184, 0.983], box: [-97310, -6600, -96965, -6415], build: hradFar },
  ...FAR_EXTRA,
];

/**
 * THE HAZE OF THE SKYLINE. heightfog's haze is tuned for a 500 m world and,
 * measured in game, takes the castle at 928 m down to a ghost a shade off the
 * sky. For the silhouettes and their own near models only (so Pardubice and
 * every other streamed mesh keep the air they have), the distance the haze is computed from bends at a
 * knee: the same air as the street up to `knee.x` metres, and only `knee.y`
 * of every metre beyond it. Distant still reads as distant, just not as gone.
 */
export const FAR_UNI = { wall: { value: FAR_R }, knee: { value: new THREE.Vector2(220, 0.06) } };

let _mat = null, _near = null;
/**
 * The landmark material with the knee and its own fog wall at FAR_R; with
 * `dither`, also the screen-door fade-in (see the header).
 */
function kneeMaterial(dither) {
  const base = landmarkMaterial();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh, r) => {
    base.onBeforeCompile(sh, r);
    sh.uniforms.uLmFar = FAR_UNI.wall;
    sh.uniforms.uLmKnee = FAR_UNI.knee;
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float uLmWall;', 'uniform float uLmWall;\n        uniform float uLmFar;\n        uniform vec2 uLmKnee;')
      .replace('float lmK = length( vAtcRay ) * atcFogAir.x;', `float lmD = length( vAtcRay );
            float lmK = min( lmD, uLmKnee.x + ( lmD - uLmKnee.x ) * uLmKnee.y ) * atcFogAir.x;`)
      .replace('float lmR = fogFar * uLmWall;', dither ? `float lmNear = fogFar * uLmWall;
              float lmIn = smoothstep( lmNear * 0.70, lmNear * 0.90, vFogDepth );
              float lmIgn = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
              if ( lmIgn >= lmIn ) discard;
              float lmR = uLmFar;` : 'float lmR = uLmFar;');
  };
  mat.customProgramCacheKey = dither ? () => 'atc-landmark-far-v1' : () => 'atc-landmark-farnear-v1';
  return mat;
}
/** The silhouettes' material: the dither and its own fog wall (see the header). */
export function farMaterial() { return _mat ?? (_mat = kneeMaterial(true)); }
/**
 * What the NEAR model of a far-set landmark is drawn with while the skyline
 * runs: the silhouettes' air (the knee, no wall before FAR_R) without the
 * dither. With the shared landmark material the near model went to a pale
 * ghost through the hand-over band while the silhouette came in crisp and
 * dark, so the dither read as black specks over St Vitus from Malá Strana
 * (seen in game at 380 m). In one air the two pixels of the dither agree.
 */
export function farNearMaterial() { return _near ?? (_near = kneeMaterial(false)); }

/** One silhouette as a geometry about its own origin (float64 offset kept for Mesh.position). */
export function buildFar(e) {
  const sink = new LandmarkSink();
  const kit = new Kit(sink, e.ground);
  kit.ao = false;
  kit.floodFn = e.flood ?? ((x, y) => (y < 60 ? 0.6 : 0.45));
  const [ox, oz, nx, nz] = e.frame;
  e.build(kit, new Frame(kit, ox, oz, nx, nz), e);
  for (let i = 0; i < sink.pos.length; i += 3) { sink.pos[i] -= ox; sink.pos[i + 2] -= oz; }
  return sink.geo();
}

export class FarSkyline {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'landmarks-far';
    this.items = null;          // built on the first frame in Prague: Pardubice never pays for it
    this.group.visible = false;
    scene.add(this.group);
    this._lm = new WeakMap();   // chunk group -> its landmark mesh (or null)
    this._ground = FAR_GROUND.map((g) => ({ g, mesh: null }));
    this._groundTodo = FAR_GROUND.length;   // a count, so a frame asks without a closure
    this._handBoxes = [];                    // the far-ground boxes already built, for setFarHand
  }

  /** The silhouettes, once (a few hundred triangles each; the castle's outline is the bulk). */
  _build() {
    this.items = [];
    const mat = farMaterial();
    for (const e of FAR_SET) {
      const g = buildFar(e);
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.position.set(e.frame[0], 0, e.frame[1]);
      m.castShadow = m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      // the chunks the near model may live in
      const keys = new Set();
      const [x0, z0, x1, z1] = e.box;
      for (let x = x0; x <= x1 + 119; x += 120) for (let z = z0; z <= z1 + 119; z += 120) keys.add(chunkKey(Math.min(x, x1), Math.min(z, z1)));
      this.items.push({ e, mesh: m, keys: [...keys] });
    }
  }

  /** The far ground of a box, once its height field has arrived (a box is built once). */
  _grounds() {
    const terrain = this.world.terrain;
    if (!terrain) return;
    for (const it of this._ground) {
      if (it.mesh || !groundReady(terrain, it.g.box)) continue;
      const sink = new LandmarkSink(), kit = new Kit(sink, 0);
      kit.ao = false;
      buildFarGround(kit, terrain, it.g.box);
      const [x0, z0, x1, z1] = it.g.box, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      for (let i = 0; i < sink.pos.length; i += 3) { sink.pos[i] -= cx; sink.pos[i + 2] -= cz; }
      const m = new THREE.Mesh(sink.geo(), farMaterial());
      m.position.set(cx, 0, cz);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      it.mesh = m;
      this._groundTodo--;
      this._handBoxes.push(it.g.box);
    }
  }

  /** Once a frame, after the city has streamed: what is shown, and which near meshes hand over. */
  update(camera, fogFar) {
    const cx = camera.position.x, cz = camera.position.z;
    const on = Math.hypot(cx - PRAGUE[0], cz - PRAGUE[1]) < KEEP;
    this.group.visible = on;
    if (on && fogFar) {
      if (!this.items) this._build();
      if (this._groundTodo > 0) this._grounds();
    }
    // streamed geometry over a far-ground box gives way to it (heightfog.js
    // setFarHand); only once that ground is actually drawn (from the frame it
    // is built), never outside Prague
    setFarHand(fogFar * WALL.value, this._handBoxes, on && !!fogFar && this._handBoxes.length > 0);
    if (!on || !fogFar) return;
    const R = fogFar * WALL.value, hand = 0.92 * R;
    const built = this.world.built, lmMat = landmarkMaterial(), nearMat = farNearMaterial();
    const mat = farMaterial(), solid = nearMat;
    for (const it of this.items) {
      const [x0, z0, x1, z1] = it.e.box;
      const dx = Math.max(x0 - cx, 0, cx - x1), dz = Math.max(z0 - cz, 0, cz - z1);
      const d = Math.hypot(dx, dz);
      const fx = Math.max(Math.abs(cx - x0), Math.abs(cx - x1)), fz = Math.max(Math.abs(cz - z0), Math.abs(cz - z1));
      const nearOn = d < hand;
      let near = false;
      for (const k of it.keys) {
        const g = built.get(k);
        if (!g) continue;
        let lm = this._lm.get(g);
        if (lm === undefined || (lm && !lm.parent)) {    // a re-meshed batch is a new mesh
          lm = null;
          g.traverse((o) => { if (o.isMesh && (o.material === lmMat || o.material === nearMat)) lm = o; });
          if (lm) lm.material = nearMat;     // the silhouette's air (farNearMaterial)
          this._lm.set(g, lm);
        }
        if (lm) { lm.visible = nearOn; near = true; }
      }
      // While the near model's chunk is still streaming in there is nothing
      // under the dither, and the silhouette showed holes for a moment (round
      // 7 review). Until the near model exists the silhouette is drawn whole,
      // in the same air without the dither, and at any distance up to FAR_R.
      it.mesh.material = near ? mat : solid;
      it.mesh.visible = d < FAR_R && (!near || Math.hypot(fx, fz) > 0.7 * R);    // nearer, every dithered pixel is discarded
    }
  }
}
