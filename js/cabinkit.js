// ---- cabinkit.js: the furniture of a car's cabin ------------------------------
//
// vehicles.js buildCabin() lays the cabin out (it owns every dimension: the
// belt, the floor, the roof, where a seat stands). This module makes the
// pieces that go in it and decides how one car's cabin differs from the next:
//
//   seat        a cushion with side bolsters, a raked back with its own
//               bolsters and shoulders, a headrest on two posts, a base
//   wheel       three steering wheels: the plain round three-spoke, a flat
//               bottomed sport wheel, a four-spoke with a broad pad
//   variant     which wheel and which upholstery a car has. A function of the
//               kind and the paint, so the same car has the same cabin on every
//               screen and the glass shader (js/carglass.js) can draw the same
//               seats from outside that the driver sits on.
//
// Geometry only, no materials and no scene: it runs headless.

import * as THREE from 'three';

// ---- upholstery ---------------------------------------------------------------
// [name, colour, emissive floor]. The floor keeps an unlit cabin legible, as
// vehicles.js argues for its own trim.
export const SEATS = [
  ['charcoal', 0x3b3f47, 0x15171b],
  ['grey', 0x6c7178, 0x23262b],
  ['beige', 0xa8977c, 0x302b23],
  ['tan', 0x8a5a36, 0x2a1b10],
  ['wine', 0x6a2228, 0x220b0d],
  ['black', 0x1d1f23, 0x0b0c0e],
];
export const WHEELS = 3;

function hash(a, b) {
  let h = (a | 0) ^ 0x7f4a7c15;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

/** { wheel: 0..2, seat: index into SEATS } for a kind and a paint colour. */
export function cabinVariant(kind, hex) {
  const h = hash(strHash(String(kind)), hex | 0);
  let wheel = h % WHEELS;
  // the marques keep some character: the BMW is a sport wheel more often than
  // not, the commercial kinds never are
  if (kind === 'bmw' && (h >>> 8) % 3) wheel = 1;
  if ((kind === 'van' || kind === 'truck' || kind === 'bus') && wheel === 1) wheel = 2;
  return { wheel, seat: (h >>> 4) % SEATS.length };
}

// ---- a box with soft edges -----------------------------------------------------
// Every vertex is pulled onto the surface of a box rounded by r: clamp it into
// the inner box, then walk r back out along what was cut off. Smooth normals
// come from the same offset, so a cushion shades as upholstery and not as a
// crate.
export function roundBox(w, h, l, r, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, l, seg, seg, seg);
  const p = g.attributes.position, n = g.attributes.normal;
  const hx = w / 2 - r, hy = h / 2 - r, hz = l / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = Math.max(-hx, Math.min(hx, x)), cy = Math.max(-hy, Math.min(hy, y)), cz = Math.max(-hz, Math.min(hz, z));
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-6) {
      dx /= d; dy /= d; dz /= d;
      p.setXYZ(i, cx + dx * r, cy + dy * r, cz + dz * r);
      n.setXYZ(i, dx, dy, dz);
    }
  }
  return g;
}

const place = (g, x, y, z, rx = 0) => { if (rx) g.rotateX(rx); g.translate(x, y, z); return g; };

/**
 * One seat. x, z: where it stands; cy: the cushion top; fy: the floor;
 * ww: its width; top: the lowest roof over it (the back and the headrest stop
 * short of it). Pushes upholstery into `seat` and the hard parts into `trim`.
 * The back leans 0.20 rad, as the figure's sitting pose does.
 */
export function seatParts(seat, trim, x, z, cy, fy, ww, top) {
  const rake = 0.20, len = ww * 1.02;
  // cushion, a thigh roll at its front edge, two bolsters standing a little proud
  seat.push(place(roundBox(ww * 0.80, 0.11, len, 0.04), x, cy - 0.055, z));
  seat.push(place(roundBox(ww * 0.78, 0.07, 0.12, 0.03), x, cy - 0.03, z - len / 2 + 0.07));
  for (const sg of [-1, 1])
    seat.push(place(roundBox(ww * 0.16, 0.13, len * 0.92, 0.035), x + sg * ww * 0.44, cy - 0.035, z));
  // base: a shell under the cushion and the two rails it slides on
  trim.push(place(new THREE.BoxGeometry(ww * 0.86, 0.05, len * 0.9), x, cy - 0.125, z));
  const baseH = Math.max(0.04, cy - 0.15 - fy);
  for (const sg of [-1, 1])
    trim.push(place(new THREE.BoxGeometry(0.035, baseH, len * 0.8), x + sg * ww * 0.30, fy + baseH / 2, z));
  // back: the panel, its bolsters and the shoulders, all raked together
  const brTop = Math.min(cy + 0.56, top), H = brTop - cy + 0.02;
  if (H > 0.14) {
    const zb = z + 0.30, yb = (cy + brTop) / 2 - 0.025;
    seat.push(place(roundBox(ww * 0.78, H * 0.96, 0.10, 0.04), x, yb, zb, rake));
    for (const sg of [-1, 1])
      seat.push(place(roundBox(ww * 0.17, H * 0.72, 0.13, 0.035), x + sg * ww * 0.43, yb - H * 0.08, zb - 0.02, rake));
    // the hard shell behind it, which is what the back seat looks at
    trim.push(place(new THREE.BoxGeometry(ww * 0.84, H * 0.86, 0.03), x, yb - 0.01, zb + 0.065, rake));
  }
  // headrest on two posts
  const hrTop = Math.min(cy + 0.71, top + 0.02);
  if (hrTop > brTop + 0.04) {
    const zh = z + 0.41, yh = hrTop - 0.085;
    seat.push(place(roundBox(ww * 0.50, 0.17, 0.10, 0.04), x, yh, zh, rake * 0.6));
    for (const sg of [-1, 1]) {
      const post = new THREE.CylinderGeometry(0.007, 0.007, 0.12, 5);
      trim.push(place(post, x + sg * ww * 0.12, yh - 0.11, zh - 0.012, rake));
    }
  }
}

/** A rear bench: one cushion, one back, three headrests (the middle one low). */
export function benchParts(seat, trim, z, cy, fy, half, top) {
  const w = half * 2, rake = 0.24;
  seat.push(place(roundBox(w, 0.12, 0.52, 0.045), 0, cy - 0.06, z));
  trim.push(place(new THREE.BoxGeometry(w * 0.96, Math.max(0.05, cy - 0.12 - fy), 0.46), 0, (fy + cy - 0.12) / 2, z));
  const brTop = Math.min(cy + 0.54, top), H = brTop - cy + 0.02;
  if (H > 0.14) {
    const zb = z + 0.30, yb = (cy + brTop) / 2 - 0.025;
    seat.push(place(roundBox(w, H * 0.96, 0.11, 0.045), 0, yb, zb, rake));
    // the two seams that split the bench into places
    for (const sg of [-1, 1])
      trim.push(place(new THREE.BoxGeometry(0.012, H * 0.8, 0.012), sg * w * 0.19, yb, zb - 0.058, rake));
  }
  const hrTop = Math.min(cy + 0.68, top + 0.02);
  if (hrTop > brTop + 0.03)
    for (const sx of [-1, 0, 1])
      seat.push(place(roundBox(0.24, sx ? 0.16 : 0.11, 0.09, 0.035), sx * w * 0.32, hrTop - (sx ? 0.08 : 0.11), z + 0.41, rake * 0.6));
}

// ---- steering wheels -------------------------------------------------------------
// Built flat in the XY plane with the axis on +z, centred on the origin: the
// caller rakes and places every part. Returns { rim: [...], pad: [...] } where
// `rim` is the leather and `pad` the boss a badge sits on.
export function wheelParts(type, R) {
  const tube = Math.max(0.017, R * 0.095);
  const rim = [], pad = [];
  const spoke = (a, w, len, t = 0.024) => {
    const sp = new THREE.BoxGeometry(len, w, t);
    sp.translate(len / 2 + R * 0.12, 0, 0);
    sp.rotateZ(a);
    rim.push(sp);
  };
  if (type === 1) {
    // sport: a thicker rim cut flat across the bottom, thumb rests at ten and two
    const tor = new THREE.TorusGeometry(R, tube * 1.25, 8, 24);
    const p = tor.attributes.position, flat = -R * 0.74;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < flat) p.setY(i, flat + (p.getY(i) - flat) * 0.12);
    tor.computeVertexNormals();
    rim.push(tor);
    spoke(0, 0.05, R * 0.86); spoke(Math.PI, 0.05, R * 0.86); spoke(-Math.PI / 2, 0.04, R * 0.62);
    for (const sg of [-1, 1]) rim.push(place(roundBox(0.045, 0.07, 0.035, 0.012, 2), sg * R * 0.80, R * 0.36, 0.008));
    const hub = new THREE.CylinderGeometry(R * 0.30, R * 0.34, 0.05, 6);
    hub.rotateX(Math.PI / 2);
    pad.push(hub);
  } else if (type === 2) {
    // comfort: four spokes and a broad soft pad
    rim.push(new THREE.TorusGeometry(R, tube, 6, 20));
    for (const a of [0.22, Math.PI - 0.22, -0.9, Math.PI + 0.9]) spoke(a, 0.034, R * 0.86);
    pad.push(place(roundBox(R * 1.05, R * 0.62, 0.055, 0.02, 2), 0, -R * 0.04, 0));
  } else {
    // the plain one: two across, one down, a round boss
    rim.push(new THREE.TorusGeometry(R, tube, 6, 18));
    for (const a of [0, Math.PI, -Math.PI / 2]) spoke(a, 0.030, R * 0.86);
    const hub = new THREE.CylinderGeometry(R * 0.30, R * 0.30, 0.05, 10);
    hub.rotateX(Math.PI / 2);
    pad.push(hub);
  }
  return { rim, pad, tube };
}
