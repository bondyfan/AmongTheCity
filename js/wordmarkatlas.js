// ---- wordmarkatlas.js: the chain wordmarks, a page of them per draw call -----
// The far-tier shop signs (js/meshes.js brandSignage) are a few quads per
// chain per chunk, and every chain used to be its own 1024 x 256 canvas
// texture and its own MeshBasicMaterial, so a chunk with five chains in it was
// five draw calls of two triangles each: 413 such meshes in the old town,
// 148 of them in view at Národní, each a full draw call in a frame whose cost
// is per draw call and not per triangle.
//
// Now every label is a SLOT of a shared 2048 x 1024 page (4 x 8 slots of
// 512 x 128) and a chunk's wordmark quads are merged, after they are built,
// into ONE mesh per page with their uvs remapped into their slots: one draw
// call per chunk. The worker path is untouched: the worker still hands back
// one quad stream per chain naming its label, js/meshpool.js resolves the
// name to the label material here, and mergeMarks() runs on the main thread
// after the decode, as js/meshes.js buildBuildingsMesh runs it after the
// synchronous build. Both therefore end in the same geometry (give or take
// the codec's millimetre of quantisation, which the decoded quads always had).
//
// A label material is still what everything else counts by: CityWorld's
// sweep collects the label materials a built chunk wears (the merged mesh
// lists them in userData.marks) and sweepBrandMats gives an idle label's slot
// back to its page. Its map is a clone of the page texture windowed onto the
// slot (the same GL texture, three shares it by source), so a quad that was
// never merged, `__batch.marks = false` or a mesh mergeMarks will not touch,
// still shows its own label.
//
// Half the old panel's texels: a slot is 512 x 128 where a chain had a
// 1024 x 256 canvas of its own. These are the FAR signs, legible from 300 m
// and gone at the LOD swap, and a 10 m fascia at 100 m is about 100 pixels
// wide on a 1728 pixel screen, so the full page is never magnified in play.
//
// Painting a new label touches only its slot on the GPU: the slot is drawn on
// a small canvas and copied in with copyTextureToTexture (one texSubImage2D
// and a mip rebuild), never a re-upload of the 8 MB page. Without a renderer
// (headless, or before main.js hands one over) the page re-uploads instead.
// Each slot keeps a margin of its own background colour round the label
// (PAD), so the mips of one chain do not bleed the next chain's colour onto
// its edge until the sign is under some 60 pixels across.

import * as THREE from 'three';

const PW = 2048, PH = 1024, SW = 512, SH = 128, COLS = PW / SW, SLOTS = COLS * (PH / SH);
const PAD = 8;            // texels of background round the label inside its slot
const MAX_PAGES = 8;      // 256 labels; past that a label gets its own canvas again

let renderer = null;
/** main.js hands the renderer over so a new label uploads only its own slot. */
export function setWordmarkRenderer(r) { renderer = r; }

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');

/**
 * Paint a chain's wordmark into the w x h rectangle at (ox, oy) of a 2D
 * context, laid out as on the original 1024 x 256 panel (a non-uniform scale
 * is fine: the quad stretches the slot back to the panel's own aspect).
 */
export function paintMark(g, brand, label, ox = 0, oy = 0, w = 1024, h = 256) {
  g.save();
  g.setTransform(w / 1024, 0, 0, h / 256, ox, oy);
  g.fillStyle = css(brand.sign);
  g.fillRect(0, 0, 1024, 256);
  // Ink: the chain's trim colour when it defines one (McDonald's writes red on
  // its yellow, KFC near-white on its red), else white, except on a LIGHT
  // fascia, where white would vanish: Billa is dark type on yellow, exactly
  // like the real shopfront. Perceived luminance off the sRGB bytes is enough
  // to make that call deterministically.
  const lum = 0.299 * (brand.sign >> 16 & 255) + 0.587 * (brand.sign >> 8 & 255)
    + 0.114 * (brand.sign & 255);
  g.fillStyle = css(brand.trim ?? (lum > 150 ? 0x23201a : 0xffffff));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 168;
  g.font = `bold ${size}px Arial, sans-serif`;
  const tw = g.measureText(label).width;
  if (tw > 920) {                       // "Penny Market" must fit the same panel
    size = Math.floor(size * 920 / tw);
    g.font = `bold ${size}px Arial, sans-serif`;
  }
  g.fillText(label, 512, 132);
  g.restore();
}

const pages = [];
let scratch = null, scratchG = null, scratchTex = null;
const _at = new THREE.Vector2();

function newPage() {
  const cv = globalThis.document?.createElement?.('canvas');
  if (!cv) return null;
  cv.width = PW; cv.height = PH;
  const g = cv.getContext?.('2d');
  if (!g) return null;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                  // fascias are read at grazing angles
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  mat.name = 'wordmarks';
  const free = [];
  for (let i = SLOTS - 1; i >= 0; i--) free.push(i);
  const p = { cv, g, tex, mat, free };
  pages.push(p);
  return p;
}

function upload(page, sx, sy) {
  if (!renderer?.copyTextureToTexture) { page.tex.needsUpdate = true; return; }
  if (!scratchTex) scratchTex = new THREE.Texture(scratch);
  // flipY: canvas row sy is texture row PH - sy - SH counted from the bottom
  _at.set(sx, PH - sy - SH);
  renderer.copyTextureToTexture(_at, scratchTex, page.tex);
}

/**
 * The label material for one chain, painted into a free slot of a page, or
 * null when there is no 2D canvas (headless, memory pressure) or every page
 * is full: the caller then falls back on a canvas of the label's own.
 */
export function atlasMark(brand, label) {
  let page = pages.find((p) => p.free.length);
  if (!page && pages.length < MAX_PAGES) page = newPage();
  if (!page) return null;
  if (!scratch) {
    scratch = globalThis.document.createElement('canvas');
    scratch.width = SW; scratch.height = SH;
    scratchG = scratch.getContext?.('2d') ?? null;
  }
  if (!scratchG) return null;
  const slot = page.free.pop();
  const sx = (slot % COLS) * SW, sy = Math.floor(slot / COLS) * SH;
  // the background fills the whole slot, margin included; the label proper
  // goes in the inner rectangle the uvs will window onto
  scratchG.fillStyle = css(brand.sign);
  scratchG.fillRect(0, 0, SW, SH);
  paintMark(scratchG, brand, label, PAD, PAD, SW - 2 * PAD, SH - 2 * PAD);
  page.g.clearRect(sx, sy, SW, SH);
  page.g.drawImage(scratch, sx, sy);
  upload(page, sx, sy);
  const u0 = (sx + PAD) / PW, ru = (SW - 2 * PAD) / PW;
  const v0 = 1 - (sy + SH - PAD) / PH, rv = (SH - 2 * PAD) / PH;
  const map = page.tex.clone();         // same image, windowed: a fallback only
  map.offset.set(u0, v0); map.repeat.set(ru, rv);
  const m = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  m.userData.mark = { page, slot, u0, v0, ru, rv };
  return m;
}

/** An atlas label nothing wears any more: its slot goes back to its page. */
export function releaseMark(m) {
  const k = m.userData?.mark;
  if (!k) return false;
  k.page.free.push(k.slot);
  m.userData.mark = null;
  m.map?.dispose();                     // the clone only: the page's image stays
  m.dispose();
  return true;
}

/**
 * Merge a chunk's wordmark quads into one mesh per (parent, atlas page), uvs
 * remapped into each label's slot. Only plain non-indexed meshes are taken
 * (what brandSignage builds and the codec gives back); their own transform,
 * the codec's dequantisation, is baked into the merged positions, which then
 * sit in the parent's frame like the quads did. Anything else is left as it
 * is and still draws right. The merged mesh names the label materials it
 * carries in userData.marks, which is what the wordmark sweep counts.
 */
export function mergeMarks(root) {
  if (!root) return root;
  let by = null;
  root.traverse((o) => {
    const k = o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material) ? o.material?.userData?.mark : null;
    if (!k || !o.parent || o.geometry.index || !o.geometry.attributes.uv || o.geometry.groups?.length) return;
    by ??= new Map();
    let perParent = by.get(o.parent);
    if (!perParent) by.set(o.parent, perParent = new Map());
    let a = perParent.get(k.page);
    if (!a) perParent.set(k.page, a = []);
    a.push(o);
  });
  if (!by) return root;
  for (const [parent, perPage] of by) for (const [page, list] of perPage) {
    let n = 0;
    for (const o of list) n += o.geometry.attributes.position.count;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), marks = [];
    let at = 0;
    for (const o of list) {
      const k = o.material.userData.mark, P = o.geometry.attributes.position, U = o.geometry.attributes.uv;
      if (o.matrixAutoUpdate) o.updateMatrix();
      const e = o.matrix.elements;
      for (let i = 0; i < P.count; i++, at++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        pos[at * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[at * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[at * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        uv[at * 2] = k.u0 + U.getX(i) * k.ru;
        uv[at * 2 + 1] = k.v0 + U.getY(i) * k.rv;
      }
      if (!marks.includes(o.material)) marks.push(o.material);
      o.removeFromParent();
      o.geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(g, page.mat);
    mesh.name = 'wordmarks';
    mesh.userData.marks = marks;
    parent.add(mesh);
  }
  return root;
}

/** Diagnostics: pages in use and free slots on them. */
export const atlasStats = () => ({ pages: pages.length, free: pages.reduce((t, p) => t + p.free.length, 0) });
