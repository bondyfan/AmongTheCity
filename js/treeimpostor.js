// ---- treeimpostor.js: the picture every far tree wears ------------------------
// The far tier (js/treeshapes.js) draws a crown as one quad facing the eye. This
// paints it: once, at start-up, every species build's NEAR model is rendered
// side-on into a cell of one atlas, so a lime at 200 m is the same lime you
// stand under, lobes, limbs, ragged edge and all, and an avenue of spruces is
// tiered boughs instead of green cones. Main thread only.
//
// A cell does not hold a colour, it holds what the far shader needs to LIGHT
// the picture as the model would be lit (js/treeshader.js, COLOR_F):
//   rg  the model's normal, seen from the front (x right, y up): the quad faces
//       the eye, so this IS the view-space normal and the sun lands on the
//       right side of the crown whichever way you look at it
//   b   the shade, leaves from IMP_LEAF0 up and wood up to IMP_WOOD1: for
//       leaves the baked creases and underside (the vertex colour) times the
//       clumps of the near shader's noise, 0..IMP_AO_MAX; for a limb seen
//       through a gap, how dark. The gap between the two ranges is what a
//       texel half leaf and half wood falls into, and it is drawn half of each
//   a   coverage: the lobes' ragged edge the near shader eats out of them
// The leaf colour itself is the instance colour, so species, lightness and
// the tag in its low bits all come through untouched.
//
// PREMULTIPLIED. The empty background is (0, 0, 0, 0) and every cell is drawn
// at twice its size and box-filtered down, so an edge texel holds coverage
// times the mean of what covers it, and so does every mip level after it. The
// shader divides by alpha and gets the leaf back. (Drawn straight, with a
// neutral background, an edge texel's shade fell under a half and read as
// wood: every far crown wore a brown fringe, and at a distance, where the mips
// average more background in, the whole crown turned the colour of bark.)
//
// Each cell is framed on the model's own foliage: half its size and the height
// of its centre, in crown radii, go to TREE_U.uTreeImpCell, and the quad is
// sized from those, so the picture sits exactly where the near model stands.
// The trunk below the crown is left out: the far template carries a real one.
// No foliage comes within 7 % of a cell's edge (MARGIN), which is what lets
// the shader read mips up to the one where a cell is 16 texels across without
// a neighbour bleeding in.

import * as THREE from 'three';
import { SPECIES, SP } from './treeshapes.js';
import { nearModel, shrubModel } from './treemodels.js';
import { TREE_U, IMP_COLS, IMP_ROWS, IMP_AO_MAX, IMP_LEAF0, IMP_WOOD1, leafNoise } from './treeshader.js';

const MARGIN = 1.08;       // room round the foliage, so mips do not bleed cells
const M_PER_UNIT = 3.6;    // metres in a crown radius, for the noise scale
const SS = 2;              // each cell is drawn this many times larger, then filtered

const VERT = /* glsl */`
  attribute vec3 aGeoN;
  varying vec3 vN; varying vec3 vG; varying vec3 vCol; varying vec3 vP; varying float vLeaf;
  void main() {
    vN = normal; vG = aGeoN; vCol = color; vLeaf = uv.y;
    vP = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;

// The near shader's leaf rules (js/treeshader.js COLOR_F, TREE_NEAR), seen from
// straight ahead: the clumps shade the colour, the rim thins out where a lobe
// turns away from the eye. Same noise, same numbers.
const FRAG = /* glsl */`
  uniform mediump sampler3D uLeafTex;
  uniform vec4 uTreeK;
  uniform vec4 uTreeK2;
  uniform float uFoot;
  uniform float uNeedle;
  uniform vec3 uSeed;
  varying vec3 vN; varying vec3 vG; varying vec3 vCol; varying vec3 vP; varying float vLeaf;
  void main() {
    vec3 p = vP * ${M_PER_UNIT.toFixed(2)} + uSeed;
    vec2 tA = texture( uLeafTex, p * uTreeK2.x ).rg;
    vec2 tB = texture( uLeafTex, p * uTreeK2.y + 0.37 ).rg;
    vec3 n = normalize( vN );
    if ( vLeaf > 0.5 ) {
      float tEdge = abs( normalize( vG ).z ) - ( uTreeK.z + uTreeK.w * ( 1.0 - tB.r ) * ( 0.5 + 0.5 * tA.g ) );
      if ( tEdge < 0.0 ) discard;
      float f = ( 1.0 + uTreeK2.z * ( tA.r - 0.42 ) ) * ( 1.0 + uTreeK2.w * ( tB.r - 0.4 ) );
      float ao = vCol.g * 1.15 * f;
      // A spruce's tiers. Its vertex shade only runs 0.8 at a rim to 0.55 under
      // the next one, and from the side the rims are nearly all you see: baked
      // as it was, the cone came out one flat pale shade (lit whole by the
      // picture's normal, it read mint at street distance). Stretched, the
      // band under every bough goes dark, and the front of each skirt, where
      // the eye looks into the needles, is darker than the tips at its sides.
      // About 0.7 of the old mean, which is what the dark old cone had.
      if ( uNeedle > 0.5 ) {
        float side = clamp( abs( n.x ) / 0.88, 0.0, 1.0 );
        ao = 1.15 * f * ( 0.25 + 1.5 * max( vCol.g - 0.5, 0.0 ) ) * mix( 0.78, 1.0, side );
      }
      gl_FragColor = vec4( n.xy * 0.5 + 0.5, ${IMP_LEAF0.toFixed(2)} + ${(1 - IMP_LEAF0).toFixed(2)} * clamp( ao / ${IMP_AO_MAX.toFixed(2)}, 0.0, 1.0 ), 1.0 );
    } else {
      // the trunk under the crown is the far template's own
      if ( vP.y < uFoot ) discard;
      float l = dot( vCol, vec3( 0.3, 0.59, 0.11 ) );
      // (bark against the darker twigs: what is not leaf only needs to say
      // how dark it is next to the species' own bark, which the shader has)
      gl_FragColor = vec4( n.xy * 0.5 + 0.5, ${IMP_WOOD1.toFixed(2)} * clamp( 0.5 + l, 0.0, 1.0 ), 1.0 );
    }
  }`;

// 2:1 down, bilinear at the corner between four texels: their exact mean
const COPY_V = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;
const COPY_F = /* glsl */`
  uniform sampler2D tSrc;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D( tSrc, vUv ); }`;

/**
 * The framing of a model: half size and centre height in crown radii (foliage
 * only, from the side), and the height under which its wood is left out.
 */
export function impostorFrame(geo) {
  const p = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  let w = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.count; i++) {
    if (uv.getY(i) < 0.5) continue;
    w = Math.max(w, Math.abs(p.getX(i)), Math.abs(p.getZ(i)));
    lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i));
  }
  const half = Math.max(w, (hi - lo) / 2) * MARGIN, yc = (hi + lo) / 2;
  // The wood is cut a fifth of the way UP the foliage: everything under that is
  // the far template's own trunk, which runs to the crown's centre behind the
  // picture. Cut under the foliage (as it was), the picture carried the near
  // model's whole fork, wider and sunlit, over the darker real stem: every
  // far tree stood on a pale "Y" with a broken-off top. Never at the cell's
  // own edge either, where it would bleed into the cell below once mipped.
  return { half, yc, foot: Math.max(lo + 0.22 * (hi - lo), yc - half * 0.96) };
}

/**
 * Render the atlas and hand it to the tree shaders. `cell` is the pixels a
 * cell is wide (a power of two: the mips must stay inside their cells).
 * Returns the render target, which the caller keeps for the whole session.
 */
export function buildImpostors(renderer, cell = 256) {
  const W = IMP_COLS * cell, H = IMP_ROWS * cell;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    depthBuffer: false, stencilBuffer: false,
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  });
  rt.texture.name = 'tree-impostors';
  // one cell at a time, drawn large: 4 MB at 256, not an atlas-sized buffer
  const big = new THREE.WebGLRenderTarget(cell * SS, cell * SS, {
    depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const uniforms = {
    uLeafTex: { value: leafNoise() }, uTreeK: TREE_U.uTreeK, uTreeK2: TREE_U.uTreeK2,
    uFoot: { value: -1 }, uNeedle: { value: 0 }, uSeed: { value: new THREE.Vector3() },
  };
  // NoBlending on both: the alpha is data here, and blending would multiply
  // the colour by it a second time
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG,
    vertexColors: true, blending: THREE.NoBlending });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  cam.position.set(0, 0, 10);
  cam.updateMatrixWorld(true);
  const copy = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: big.texture } },
    vertexShader: COPY_V, fragmentShader: COPY_F, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const copyScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copy);
  quad.frustumCulled = false;
  copyScene.add(quad);

  const was = renderer.getRenderTarget(), auto = renderer.autoClear, alpha = renderer.getClearAlpha();
  const clear = new THREE.Color(); renderer.getClearColor(clear);
  // Whatever happens mid-bake (a lost context, an allocation that fails), the
  // renderer goes back as it was: js/trees.js catches the error and carries on
  // with the A/B balls, and the next frame must not draw into the atlas with
  // autoClear off and a clear colour of transparent black.
  let ok = false;
  try {
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
    const cells = TREE_U.uTreeImpCell.value;
    for (let sp = 0; sp < SPECIES.length; sp++) {
      for (let v = 0; v < 2; v++) {
        const geo = sp === SP.SHRUB ? shrubModel(v) : nearModel(sp, v);
        if (!geo) continue;
        try {
          const k = sp * 2 + v, f = impostorFrame(geo);
          cells[k].set(f.half, f.yc, 0, 0);
          cam.left = -f.half; cam.right = f.half; cam.bottom = f.yc - f.half; cam.top = f.yc + f.half;
          cam.updateProjectionMatrix();
          uniforms.uFoot.value = f.foot;
          uniforms.uNeedle.value = sp === SP.SPRUCE ? 1 : 0;
          uniforms.uSeed.value.set(k * 3.1, k * 1.7, k * 2.3);
          mesh.geometry = geo;
          renderer.setRenderTarget(big);
          renderer.clear(true, true, false);
          renderer.render(scene, cam);
          const x = (k % IMP_COLS) * cell, y = Math.floor(k / IMP_COLS) * cell;
          rt.viewport.set(x, y, cell, cell); rt.scissor.set(x, y, cell, cell); rt.scissorTest = true;
          renderer.setRenderTarget(rt);
          renderer.render(copyScene, cam);
        } finally {
          geo.dispose();
        }
      }
    }
    ok = true;
  } finally {
    rt.scissorTest = false;
    rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H);
    renderer.setRenderTarget(was);
    renderer.setClearColor(clear, alpha);
    renderer.autoClear = auto;
    mat.dispose(); copy.dispose(); quad.geometry.dispose(); big.dispose();
    if (!ok) rt.dispose();
  }
  TREE_U.uTreeImp.value = rt.texture;
  return rt;
}
