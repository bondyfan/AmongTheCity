// ---- carmerge.js: a whole car in one geometry --------------------------------
// cardetail.js builds a car as seven geometries because it used to be drawn
// with seven materials: the paint, the glass, the vertex-coloured trim, two
// lamp materials, the brake element and the decals (plates and badges, each
// with its own texture). On Václavské náměstí that was 11 draw calls for a
// near car and 4 for a far one, and the traffic was 160 of the 1 300 calls of
// the main pass. A draw call costs the same 6 to 7 us of CPU whether it is a
// whole bus or a badge 13 cm across, so the parts are merged here into ONE
// indexed geometry that a single material (carbodymat.js) knows how to shade,
// and every part says what it is in its vertex attributes:
//
//   color  linear rgb of a fixed finish (ignored where cfx.x says paint)
//   cpbr   roughness, metalness, environment gain, depth rung
//   cfx    paint weight, head lamp weight, lamp code (1 tail, 2 brake), night gate
//   duv    decal atlas u, v and weight (plates and badges)
//
// The depth rung replaces the polygonOffset ladder the separate materials had
// (glass and trim -2, lamps -3, brake -4, decals -5): a draped layer is pulled
// toward the eye in the vertex shader by an amount that grows with distance,
// which is what the offset bought, but per vertex, so one draw can hold all
// the layers.
//
// Pure geometry: no materials, no scene. Works headless.

import * as THREE from 'three';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

// What the part kinds are. Lamps keep the lens colours of the old Lambert lamp
// materials; their light is added by the shader from cfx. The brake element is
// the ruby lens it always covered while it was a separate, hidden mesh: dark
// until carbodymat.js's uBrake lights it.
export const PART = {
  paint: { c: [1, 1, 1], r: 0.5, m: 0, env: 1, rung: 0, fx: [1, 0, 0] },
  glass: { c: lin(0x0a0e13), r: 0.045, m: 0, env: 2.4, rung: 1, fx: [0, 0, 0] },
  detail: { c: null, r: null, m: null, env: 1, rung: 1, fx: [0, 0, 0] },
  head: { c: lin(0xc9d0d6), r: 0.18, m: 0, env: 1.2, rung: 2, fx: [0, 1, 0] },
  tail: { c: lin(0x3c0507), r: 0.14, m: 0, env: 1.2, rung: 2, fx: [0, 0, 1] },
  brake: { c: lin(0x4a0609), r: 0.07, m: 0.15, env: 1.2, rung: 3, fx: [0, 0, 2] },
  // a decal blends its texel over the paint by its alpha (carbodymat.js)
  plate: { c: [1, 1, 1], r: 0.45, m: 0, env: 0.6, rung: 4, fx: [0, 0, 0] },
  badge: { c: [1, 1, 1], r: 0.3, m: 0.3, env: 1, rung: 4, fx: [0, 0, 0] },
};

// Where the two decals live in the per-car atlas (vehicles.js decalTexFor):
// a 256 x 192 canvas, the badge in the top 128 rows, the plate in the bottom 56,
// 8 rows of transparent gutter between them so a coarse mip cannot bleed one
// into the other. Canvas textures are flipped, so v counts from the bottom.
export const ATLAS = { w: 256, h: 192, badge: [64 / 192, 1], plate: [0, 56 / 192] };

/**
 * parts: [{ geo, kind }] with kind one of PART's keys. Null geometries are
 * skipped. Returns one indexed BufferGeometry, or null if nothing was given.
 */
export function mergeBody(parts) {
  const list = parts.filter((p) => p && p.geo && p.geo.attributes.position.count);
  if (!list.length) return null;
  let nv = 0, ni = 0;
  for (const p of list) {
    nv += p.geo.attributes.position.count;
    ni += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const pbr = new Float32Array(nv * 4), fx = new Float32Array(nv * 4), duv = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0, oi = 0;
  for (const { geo, kind } of list) {
    const P = PART[kind];
    if (!P) throw new Error('carmerge: unknown part ' + kind);
    const gp = geo.attributes.position, gn = geo.attributes.normal;
    const gc = geo.attributes.color, gq = geo.attributes.pbr, gg = geo.attributes.gate, gu = geo.attributes.uv;
    const n = gp.count;
    for (let k = 0; k < n; k++) {
      pos[(ov + k) * 3] = gp.getX(k); pos[(ov + k) * 3 + 1] = gp.getY(k); pos[(ov + k) * 3 + 2] = gp.getZ(k);
      if (gn) { nor[(ov + k) * 3] = gn.getX(k); nor[(ov + k) * 3 + 1] = gn.getY(k); nor[(ov + k) * 3 + 2] = gn.getZ(k); }
    }
    const dv = kind === 'plate' ? ATLAS.plate : kind === 'badge' ? ATLAS.badge : null;
    for (let k = 0; k < n; k++) {
      const v = ov + k;
      if (P.c) { col[v * 3] = P.c[0]; col[v * 3 + 1] = P.c[1]; col[v * 3 + 2] = P.c[2]; }
      else if (gc) { col[v * 3] = gc.getX(k); col[v * 3 + 1] = gc.getY(k); col[v * 3 + 2] = gc.getZ(k); }
      else { col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = 0.5; }
      pbr[v * 4] = P.r ?? (gq ? gq.getX(k) : 0.5);
      pbr[v * 4 + 1] = P.m ?? (gq ? gq.getY(k) : 0);
      pbr[v * 4 + 2] = P.env;
      pbr[v * 4 + 3] = P.rung;
      fx[v * 4] = P.fx[0]; fx[v * 4 + 1] = P.fx[1]; fx[v * 4 + 2] = P.fx[2];
      fx[v * 4 + 3] = gg ? gg.getX(k) : 0;
      if (dv && gu) {
        duv[v * 3] = gu.getX(k);
        duv[v * 3 + 1] = dv[0] + (dv[1] - dv[0]) * gu.getY(k);
        duv[v * 3 + 2] = 1;
      }
    }
    if (geo.index) {
      const a = geo.index.array;
      for (let k = 0; k < a.length; k++) idx[oi + k] = a[k] + ov;
      oi += a.length;
    } else {
      for (let k = 0; k < n; k++) idx[oi + k] = ov + k;
      oi += n;
    }
    ov += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('cpbr', new THREE.BufferAttribute(pbr, 4));
  g.setAttribute('cfx', new THREE.BufferAttribute(fx, 4));
  g.setAttribute('duv', new THREE.BufferAttribute(duv, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// ---- the two merged bodies of a kind ------------------------------------------
// g is a vehicles.js geomFor() set: near and far are cardetail.js buildCar()
// halves, plates and badges the decal quads. Built once per kind, on first use,
// and shared by every car of it forever (dentCar clones before it bends).
//   near  everything but the wheels (they spin, so they stay nodes of their own)
//   far   the distance dress, wheels already baked in by cardetail.js
export function mergedBodies(g) {
  if (g.merged) return g.merged;
  const N = g.near, F = g.far;
  g.merged = {
    near: mergeBody([
      { geo: N.paint, kind: 'paint' }, { geo: N.glass, kind: 'glass' }, { geo: N.detail, kind: 'detail' },
      { geo: N.head, kind: 'head' }, { geo: N.tail, kind: 'tail' }, { geo: N.brake, kind: 'brake' },
      { geo: g.plates, kind: 'plate' }, { geo: g.badges, kind: 'badge' },
    ]),
    far: mergeBody([
      { geo: F.paint, kind: 'paint' }, { geo: F.detail, kind: 'detail' },
      { geo: F.head, kind: 'head' }, { geo: F.tail, kind: 'tail' },
    ]),
  };
  return g.merged;
}
