// ---- stores/props.js: the trolley, the basket and what is in them ----
// Main thread only. Wire baskets are drawn as bars, so a trolley is a cage you
// can see the shopping through: some thirty thin boxes, one geometry per handle
// colour (the handle is the chain's: blue at Lidl, red at Kaufland).

import * as THREE from 'three';
import { Geo } from './fixgeo.js';
import { fixtureMaterial } from './fixtures.js';

const WIRE = 0xc4c8cc, WHEEL = 0x2a2c30;
const _trolleys = new Map(), _baskets = new Map();

/** A shopping trolley, facing -z (the way it is pushed), its handle at +z. */
export function trolleyGeometry(handleHex) {
  let g = _trolleys.get(handleHex);
  if (g) return g;
  const G = new Geo(), t = 0.012;
  const x0 = -0.27, x1 = 0.27, z0 = -0.55, z1 = 0.3, y0 = 0.5, y1 = 1.0;
  // the basket: rims, floor bars, uprights along both sides and both ends
  for (const y of [y0, y1]) {
    G.box(x0, x1, y - t, y + t, z0 - t, z0 + t, WIRE).box(x0, x1, y - t, y + t, z1 - t, z1 + t, WIRE);
    G.box(x0 - t, x0 + t, y - t, y + t, z0, z1, WIRE).box(x1 - t, x1 + t, y - t, y + t, z0, z1, WIRE);
  }
  for (let i = 1; i < 7; i++) {
    const z = z0 + (z1 - z0) * i / 7;
    G.box(x0 - t, x0 + t, y0, y1, z - t, z + t, WIRE).box(x1 - t, x1 + t, y0, y1, z - t, z + t, WIRE);
    G.box(x0, x1, y0 - t, y0 + t, z - t, z + t, WIRE);
  }
  for (let i = 1; i < 5; i++) {
    const x = x0 + (x1 - x0) * i / 5;
    G.box(x - t, x + t, y0, y1, z0 - t, z0 + t, WIRE).box(x - t, x + t, y0, y1, z1 - t, z1 + t, WIRE);
  }
  // the frame under it, four castors, the handle
  G.box(x0, x0 + 0.03, 0.1, y0, z1 - 0.06, z1 - 0.03, WIRE).box(x1 - 0.03, x1, 0.1, y0, z1 - 0.06, z1 - 0.03, WIRE);
  G.box(x0, x0 + 0.03, 0.1, 0.13, z0 + 0.05, z1, WIRE).box(x1 - 0.03, x1, 0.1, 0.13, z0 + 0.05, z1, WIRE);
  for (const x of [x0 + 0.015, x1 - 0.015]) for (const z of [z0 + 0.1, z1 - 0.05]) G.box(x - 0.02, x + 0.02, 0, 0.1, z - 0.05, z + 0.05, WHEEL);
  G.box(x0 - 0.02, x1 + 0.02, y1 + 0.03, y1 + 0.075, z1 + 0.05, z1 + 0.095, handleHex);
  G.box(x0, x0 + 0.02, y1, y1 + 0.05, z1, z1 + 0.07, WIRE).box(x1 - 0.02, x1, y1, y1 + 0.05, z1, z1 + 0.07, WIRE);
  g = G.build();
  _trolleys.set(handleHex, g);
  return g;
}

/** A hand basket: a tub in the chain's colour with a dark handle laid flat. */
export function basketGeometry(hex) {
  let g = _baskets.get(hex);
  if (g) return g;
  const G = new Geo();
  G.box(-0.22, 0.22, 0, 0.02, -0.15, 0.15, hex);
  G.box(-0.22, 0.22, 0, 0.24, -0.15, -0.135, hex).box(-0.22, 0.22, 0, 0.24, 0.135, 0.15, hex);
  G.box(-0.22, -0.205, 0, 0.24, -0.15, 0.15, hex).box(0.205, 0.22, 0, 0.24, -0.15, 0.15, hex);
  G.box(-0.19, 0.19, 0.24, 0.26, -0.01, 0.01, 0x22252a);
  g = G.build();
  _baskets.set(hex, g);
  return g;
}

const GOODS_HEX = [0xc0392f, 0xd9b23c, 0x3f66a8, 0x4c7a42, 0xefede6, 0x8a6a3e, 0xe07b26, 0x7a4ea3];
let _box = null;
/**
 * The shopping in a trolley or a basket: up to `max` small packs, shown as the
 * count grows. Returns a Group with setCount(n).
 */
export function goodsPile(max, w, d, y0) {
  const g = new THREE.Group();
  _box ??= new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const m = new THREE.InstancedMesh(_box, mat, max);
  const M = new THREE.Matrix4(), c = new THREE.Color();
  for (let i = 0; i < max; i++) {
    const col = i % 3, row = Math.floor(i / 3) % 3, lay = Math.floor(i / 9);
    const sx = w / 3 * 0.8, sz = d / 3 * 0.8, sy = 0.1 + (i % 4) * 0.02;
    M.makeScale(sx, sy, sz).setPosition((col - 1) * w / 3, y0 + lay * 0.13 + sy / 2, (row - 1) * d / 3);
    m.setMatrixAt(i, M);
    m.setColorAt(i, c.setHex(GOODS_HEX[(i * 5 + lay) % GOODS_HEX.length]));
  }
  m.count = 0;
  m.frustumCulled = false;
  g.add(m);
  g.setCount = (n) => { m.count = Math.max(0, Math.min(max, n)); };
  g.dispose = () => { mat.dispose(); m.dispose(); };
  return g;
}

/** One trolley or basket as a mesh the player (or one shopper) carries. */
export function carrierMesh(kind, hex) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(kind === 'trolley' ? trolleyGeometry(hex) : basketGeometry(hex), fixtureMaterial());
  g.add(mesh);
  const pile = kind === 'trolley' ? goodsPile(27, 0.46, 0.7, 0.52) : goodsPile(9, 0.36, 0.22, 0.03);
  if (kind === 'trolley') pile.position.z = -0.12;
  g.add(pile);
  g.setCount = (n) => pile.setCount(kind === 'trolley' ? Math.ceil(n * 27 / 40) : Math.ceil(n * 9 / 14));
  g.dispose = () => { g.removeFromParent(); pile.dispose(); };
  return g;
}
