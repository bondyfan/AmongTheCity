// ---- Ortho ground: real ČÚZK aerial photos under the low-poly city ----
// scripts/fetch-ortho.mjs stores one 1024² JPEG per 480 m supertile (4×4
// streaming chunks). At runtime each 120 m chunk gets a flat quad whose UVs
// window into its quarter-of-a-quarter of that shared photo, so a supertile
// costs ONE texture upload no matter how many chunks sit on it. meshes.js
// asks orthoGroundMesh(cx, cz) for the quad and falls back to the flat
// COLORS.groundBase plane when we return null (tile missing, or out of the
// fetched extent). Loading is lazy and fire-and-forget: the mesh is returned
// while the JPEG is still in flight — three renders it black until the
// texture pops in, which reads as ground streaming and is acceptable.

import * as THREE from 'three';
import { CHUNK, ORTHO } from './config.js';

export function initOrtho() {
  const loader = new THREE.TextureLoader();
  const S = ORTHO.tile / CHUNK;             // chunks per supertile edge (480/120 = 4)
  const range = ORTHO.extent / ORTHO.tile;  // supertile indices live in [−range, range)

  // Per-supertile cache: key → { tex, mat } once requested, or null once a
  // load FAILED (file never fetched / server offline). Failures are sticky so
  // a dead tile costs one HTTP request ever; every later chunk on it goes
  // straight to the flat-color fallback. NOTE: chunks built BEFORE the
  // failure keep their (black) quad until they stream out — we deliberately
  // don't dispose the entry either, because their meshes still reference the
  // material, and a texture that never loaded holds no GPU memory anyway.
  const tiles = new Map();

  function makeEntry(sx, sz) {
    const key = sx + ',' + sz;
    const tex = loader.load(`${ORTHO.dir}/${sx}_${sz}.jpg`, undefined, undefined,
      () => { tiles.set(key, null); });    // 404 → cache the failure (see note above)
    tex.colorSpace = THREE.SRGBColorSpace; // JPEGs are sRGB; skip this and the photo washes out
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;    // no mips: the ground never minifies hard at our
    tex.generateMipmaps = false;           // camera heights, and skipping them saves 33% VRAM
    tex.anisotropy = 4;                    // keeps far streets legible at grazing angles
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // each chunk samples strictly its own tile
    // Lambert (not Basic) so the photo takes the day/night cycle: hemi + sun
    // dim it at dusk and the sunset tint washes over it like everything else
    const entry = { tex, mat: new THREE.MeshLambertMaterial({ map: tex }) };
    tiles.set(key, entry);
    return entry;
  }

  // Ground quad for streaming chunk (cx, cz) — chunk GRID indices, not meters.
  function orthoGroundMesh(cx, cz) {
    const sx = Math.floor(cx / S), sz = Math.floor(cz / S);
    if (sx < -range || sx >= range || sz < -range || sz >= range) return null; // beyond fetched area
    const entry = tiles.get(sx + ',' + sz) ?? makeEntry(sx, sz);
    if (entry === null) return null;       // known-missing tile → flat-color fallback

    // UV window: the chunk sits at column lx, row lz inside its supertile
    // (both 0..S−1, counted from the tile's WEST and NORTH edges). u is easy:
    // lx/S → (lx+1)/S west→east. v needs care with signs: image row 0 is the
    // photo's TOP = latN = the SMALLEST z (our z axis points south), and
    // TextureLoader's default flipY puts that top row at v=1. PlaneGeometry's
    // v=1 edge is its local +y edge, which rotateX(−π/2) lands on world −z —
    // north again. North meets north with NO extra flip; the windowed v just
    // counts lz rows DOWN from 1: v ∈ [1−(lz+1)/S, 1−lz/S].
    const lx = cx - sx * S, lz = cz - sz * S;
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK);
    geo.rotateX(-Math.PI / 2);             // face up; local +y → world −z (north)
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, (lx + uv.getX(i)) / S, (S - 1 - lz + uv.getY(i)) / S);

    const mesh = new THREE.Mesh(geo, entry.mat);
    mesh.position.set(cx * CHUNK + CHUNK / 2, 0, cz * CHUNK + CHUNK / 2); // y=0 ground plane
    mesh.receiveShadow = true;             // buildings/trees drop real shadows onto the photo
    mesh.matrixAutoUpdate = false;         // static — chunk Groups sit at the origin
    mesh.updateMatrix();
    return mesh;
  }

  return { orthoGroundMesh };
}
