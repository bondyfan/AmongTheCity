// ---- Victoria's landmarks ----
// The tiles extrude every footprint OSM has in Victoria, which gives the town
// its blocks and nothing that tells you it is Victoria. These are the pieces a
// visitor would name, built by hand where the map puts them
// (public/data/regions/mahe/landmarks.json, scripts/mahe/extras.mjs):
//
//   the Clock Tower   "Lorloz", the silver cast-iron clock in the middle of the
//                     crossing of Independence Avenue and Albert Street, a copy
//                     of the one at Vauxhall Bridge in London (1903)
//   the cathedral     the Immaculate Conception's free-standing white bell tower
//   the temple        the gopuram of Arul Mihu Navasakthi Vinayagar, its tiers
//                     painted red, yellow, blue and green
//   the market        the Sir Selwyn Selwyn-Clarke Market's name over its gate
//
// Low-poly, vertex-coloured Lambert like the rest of the town, one merged mesh,
// standing on the terrain. Static: nothing here runs per frame.

import * as THREE from 'three';
import { mergeGeometries } from '../../libs/BufferGeometryUtils.js';
import { dataUrl } from '../regions.js';

const _c = new THREE.Color();
function painted(geo, hex) {
  const n = geo.getAttribute('position').count, col = new Float32Array(n * 3);
  _c.setHex(hex);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo.index ? geo.toNonIndexed() : geo;
}
function box(w, h, d, x, y, z, hex) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); return painted(g, hex); }
function cyl(r0, r1, h, x, y, z, hex, seg = 8) { const g = new THREE.CylinderGeometry(r1, r0, h, seg); g.translate(x, y + h / 2, z); return painted(g, hex); }
function cone(r, h, x, y, z, hex, seg = 4, rot = Math.PI / 4) { const g = new THREE.ConeGeometry(r, h, seg); g.rotateY(rot); g.translate(x, y + h / 2, z); return painted(g, hex); }

// The Clock Tower: about 6.5 m. A white stepped plinth, a fluted iron column,
// the clock box with a face on each side, a small lantern and a finial.
function clockTower() {
  const SILVER = 0xc9ccd0, IRON = 0x8e949a, WHITE = 0xf2f0ea, FACE = 0xfbfaf2, HAND = 0x1d1f22;
  const p = [];
  p.push(box(2.6, 0.35, 2.6, 0, 0, 0, WHITE), box(2.0, 0.3, 2.0, 0, 0.35, 0, WHITE));
  p.push(box(1.1, 0.7, 1.1, 0, 0.65, 0, SILVER));                         // the base drum
  p.push(cyl(0.34, 0.24, 2.6, 0, 1.35, 0, SILVER, 12));                    // the column
  p.push(box(0.6, 0.12, 0.6, 0, 3.95, 0, IRON));                           // the capital
  p.push(box(0.95, 0.95, 0.95, 0, 4.07, 0, SILVER));                       // the clock box
  for (const [dx, dz, ry] of [[0, 0.48, 0], [0, -0.48, Math.PI], [0.48, 0, Math.PI / 2], [-0.48, 0, -Math.PI / 2]]) {
    const face = new THREE.CircleGeometry(0.36, 16); face.rotateY(ry); face.translate(dx * 1.02, 4.545, dz * 1.02); p.push(painted(face, FACE));
    const hand = new THREE.PlaneGeometry(0.03, 0.26); hand.rotateY(ry); hand.translate(dx * 1.04, 4.6, dz * 1.04); p.push(painted(hand, HAND));
  }
  p.push(cone(0.75, 0.45, 0, 5.02, 0, IRON));                              // the roof of the box
  p.push(cyl(0.18, 0.14, 0.5, 0, 5.47, 0, SILVER, 8));                    // lantern
  p.push(cone(0.22, 0.55, 0, 5.97, 0, IRON, 8, 0), cyl(0.03, 0.03, 0.4, 0, 6.5, 0, SILVER, 4));
  return p;
}

// The cathedral's bell tower: white, square, three stages and a pyramid roof.
function bellTower() {
  const WHITE = 0xf4f2ec, TRIM = 0xd9d3c4, ROOF = 0x6f7378, DARK = 0x3a3c40;
  const p = [box(5, 9, 5, 0, 0, 0, WHITE), box(5.4, 0.4, 5.4, 0, 9, 0, TRIM), box(4.4, 6, 4.4, 0, 9.4, 0, WHITE),
    box(4.8, 0.4, 4.8, 0, 15.4, 0, TRIM), box(3.8, 4, 3.8, 0, 15.8, 0, WHITE)];
  for (const [dx, dz, w, d] of [[0, 1.92, 1.2, 0.05], [0, -1.92, 1.2, 0.05], [1.92, 0, 0.05, 1.2], [-1.92, 0, 0.05, 1.2]])
    p.push(box(w, 2.2, d, dx, 16.6, dz, DARK));                           // the louvred openings
  p.push(cone(3.0, 5.0, 0, 19.8, 0, ROOF), cyl(0.05, 0.05, 1.6, 0, 24.8, 0, DARK, 4), box(0.9, 0.08, 0.08, 0, 25.8, 0, DARK));
  return p;
}

// A gopuram: a tapering tower of painted tiers over a gate, crowned with a
// barrel roof and its row of finials.
function gopuram() {
  const BANDS = [0xd94b3a, 0xf2c14e, 0x3f7fc1, 0x4caf6a, 0xe8783a, 0xb04fa6];
  const p = [box(7, 4.5, 4.4, 0, 0, 0, 0xf1e6cf), box(2.2, 3.2, 4.5, 0, 0, 0, 0x5a3b2a)];
  let y = 4.5, w = 7, d = 4.4;
  for (let i = 0; i < 6; i++) {
    const h = 1.5;
    p.push(box(w, h, d, 0, y, 0, BANDS[i % BANDS.length]));
    // the little sculpted niches along each tier, as alternating blocks
    for (let k = -2; k <= 2; k++) p.push(box(0.5, h * 0.7, 0.2, k * w / 5.5, y + h * 0.15, d / 2 + 0.05, BANDS[(i + k + 7) % BANDS.length]));
    y += h; w *= 0.84; d *= 0.86;
  }
  const roof = new THREE.CylinderGeometry(d / 2, d / 2, w, 10, 1, false, 0, Math.PI);
  roof.rotateZ(Math.PI / 2); roof.translate(0, y, 0);
  p.push(painted(roof, 0xd94b3a));
  for (let k = -2; k <= 2; k++) p.push(cone(0.22, 0.9, k * w / 5, y + d / 2 - 0.1, 0, 0xf2c14e, 6, 0));
  return p;
}

// The market's name over its gate.
function marketSign(name) {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return null;
  cv.width = 1024; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#1f5f3f'; g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#f6efd8'; g.font = 'bold 54px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText((name || 'Sir Selwyn Selwyn-Clarke Market').toUpperCase(), 512, 66, 980);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), new THREE.MeshLambertMaterial({ map: tex }));
  return m;
}

/** Build every landmark the data places. Returns the group (added to the scene). */
export async function buildLandmarks(scene, terrain) {
  let marks = {};
  try { marks = await (await fetch(dataUrl('landmarks.json'))).json(); } catch { return null; }
  const group = new THREE.Group();
  group.name = 'mahe-landmarks';
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // ground under a point: the drawn terrain, asked for until its tile is in
  const ground = (x, z) => terrain?.heightAt?.(x, z) ?? 0;
  const place = (parts, x, z, h) => {
    const g = mergeGeometries(parts.filter(Boolean));
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, ground(x, z), z);
    mesh.rotation.y = h ?? 0;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.ground = [x, z];
    group.add(mesh);
    return mesh;
  };
  if (marks.clocktower) place(clockTower(), marks.clocktower.p[0], marks.clocktower.p[1], 0);
  if (marks.cathedral) {
    // the tower stands at the end of the church's long axis, just clear of it
    const c = marks.cathedral, hd = c.h ?? 0, o = c.o ?? [c.p];
    let far = 0;
    for (const q of o) far = Math.max(far, (q[0] - c.p[0]) * -Math.sin(hd) + (q[1] - c.p[1]) * -Math.cos(hd));
    place(bellTower(), c.p[0] - Math.sin(hd) * (far + 4), c.p[1] - Math.cos(hd) * (far + 4), hd);
  }
  if (marks.temple) place(gopuram(), marks.temple.p[0], marks.temple.p[1], marks.temple.h ?? 0);
  if (marks.market) {
    const s = marketSign(marks.market.name);
    if (s) {
      const m = marks.market, hd = m.h ?? 0;
      s.position.set(m.p[0], ground(m.p[0], m.p[1]) + 5.2, m.p[1]);
      s.rotation.y = hd;
      s.userData.ground = [m.p[0], m.p[1], 5.2];
      group.add(s);
    }
  }
  scene.add(group);
  return group;
}

/** Stand every piece back on the ground once the terrain under it has arrived. */
export function settleLandmarks(group, terrain) {
  if (!group) return;
  for (const m of group.children) {
    const g = m.userData.ground;
    if (g) m.position.y = (terrain?.heightAt?.(g[0], g[1]) ?? 0) + (g[2] ?? 0);
  }
}
