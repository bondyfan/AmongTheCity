// ---- dev/carprofile.mjs: a car's drawings, without a browser -------------------
// node dev/carprofile.mjs <kind> <out.png> [views=side,front,rear,top,q] [hex]
//
// Builds the kind with the game's own js/cardetail.js buildCar() and rasterises
// it orthographically (a z-buffer, flat Lambert, the parts in their own
// colours), one view beside the next, with a 0.5 m grid behind it. For getting
// a silhouette and its proportions right against a real car's dimensions
// before anything is booted: the showroom (dev/showroom.html) and the game are
// where the paint and the light are judged.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { register } from 'node:module';
// bare "three" resolves to the vendored module, as in the tests
register(new URL('../tests/three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { buildCar } = await import('../js/cardetail.js');
const { kindOf } = await import('../js/vehicles.js');

const [kind = 'tesla', out = 'car.png', viewsArg = 'side,front,rear,top', hexArg = 'b9bec4'] = process.argv.slice(2);
const K = kindOf(kind), car = buildCar(kind === 'octaviaCombi' && !process.env.COMBI_OWN ? 'octavia' : kind, K, null);
const paint = new THREE.Color(parseInt(hexArg, 16));
const PX = 230;                                  // pixels per metre

const parts = [];
const add = (geo, color, m = null) => {
  if (!geo) return;
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (m) g.applyMatrix4(m);
  parts.push({ pos: g.attributes.position.array, col: g.attributes.color?.array ?? null, color });
};
const N = car.near;
add(N.paint, [paint.r, paint.g, paint.b]);
add(N.glass, [0.03, 0.05, 0.07]);
add(N.detail, null);
add(N.head, [0.95, 0.95, 0.9]);
add(N.tail, [0.8, 0.05, 0.04]);
add(N.brake, [0.5, 0.03, 0.03]);
const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
for (let i = 0; i < 4; i++) {
  const side = i & 1 ? 1 : -1;
  add(car.wheel[i & 1], null, new THREE.Matrix4().makeTranslation(side * car.wx[i < 2 ? 0 : 1], K.wheelR, (i < 2 ? -1 : 1) * ax));
}

// a three-quarter view from eye level and a bit: yaw the car, then tip the eye up
function three4(x, y, z, a) {
  const c = Math.cos(a), s = Math.sin(a), X = x * c - z * s, D = x * s + z * c, e = 0.30;
  return [X, y * Math.cos(e) - D * Math.sin(e) + 0.55, D * Math.cos(e) + y * Math.sin(e)];
}
// a view: world -> (u right, v up, d toward the eye)
const VIEWS = {
  side: (x, y, z) => [z, y, -x], front: (x, y, z) => [-x, y, -z], rear: (x, y, z) => [x, y, z],
  top: (x, y, z) => [z, -x, y],
  q: (x, y, z) => three4(x, y, z, 3.81), rq: (x, y, z) => three4(x, y, z, 0.67),
};
const SPAN = { side: [K.len + 0.6, 2.0], front: [K.wid + 0.8, 2.0], rear: [K.wid + 0.8, 2.0], top: [K.len + 0.6, K.wid + 0.6], q: [K.len + 0.9, 2.6], rq: [K.len + 0.9, 2.6] };
const views = viewsArg.split(',').filter((v) => VIEWS[v]);
const tall = K.hull.sts.reduce((m, s) => Math.max(m, s[2]), 0) > 1.6;
const panels = views.map((v) => ({ v, w: Math.round(SPAN[v][0] * PX), h: Math.round((v === 'top' ? SPAN[v][1] : tall ? 3.6 : SPAN[v][1]) * PX) }));
const W = panels.reduce((s, p) => s + p.w, 0), H = Math.max(...panels.map((p) => p.h));
const img = new Uint8Array(W * H * 3).fill(238), zb = new Float32Array(W * H).fill(-1e9);
const L = new THREE.Vector3(-0.35, 0.8, 0.5).normalize();

let ox = 0;
for (const p of panels) {
  const f = VIEWS[p.v];
  const cu = p.w / 2, base = p.v === 'top' ? p.h / 2 : p.h - 0.12 * PX;     // ground line 12 cm above the bottom
  // grid every 0.5 m, the ground a darker line
  for (let gx = -8; gx <= 8; gx++) { const u = Math.round(ox + cu + gx * 0.5 * PX); if (u >= ox && u < ox + p.w) for (let y = 0; y < p.h; y++) { const o = (y * W + u) * 3; img[o] = img[o + 1] = img[o + 2] = gx ? 222 : 200; } }
  for (let gy = -4; gy <= 8; gy++) { const y = Math.round(base - gy * 0.5 * PX); if (y >= 0 && y < p.h) for (let u = ox; u < ox + p.w; u++) { const o = (y * W + u) * 3; img[o] = img[o + 1] = img[o + 2] = gy ? 222 : 150; } }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const part of parts) {
    const P = part.pos;
    for (let t = 0; t < P.length; t += 9) {
      const A = f(P[t], P[t + 1], P[t + 2]), B = f(P[t + 3], P[t + 4], P[t + 5]), C = f(P[t + 6], P[t + 7], P[t + 8]);
      a.set(...A); b.set(...B); c.set(...C);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      if (n.z <= 0) continue;                       // back face
      n.normalize();
      const sh = 0.38 + 0.62 * Math.max(0, n.dot(L));
      const col = part.color ?? (part.col ? [part.col[t / 3 * 3], part.col[t / 3 * 3 + 1], part.col[t / 3 * 3 + 2]] : [0.2, 0.2, 0.2]);
      const rgb = col.map((v) => Math.round(255 * Math.min(1, Math.pow(Math.max(0, v) * sh, 1 / 2.2))));
      const sx = (q) => ox + cu + q[0] * PX, sy = (q) => base - q[1] * PX;
      const x0 = sx(A), y0 = sy(A), x1 = sx(B), y1 = sy(B), x2 = sx(C), y2 = sy(C);
      const minX = Math.max(ox, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(ox + p.w - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(p.h - 1, Math.ceil(Math.max(y0, y1, y2)));
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(den) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = ((y1 - y2) * (x + 0.5 - x2) + (x2 - x1) * (y + 0.5 - y2)) / den;
        const w1 = ((y2 - y0) * (x + 0.5 - x2) + (x0 - x2) * (y + 0.5 - y2)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * A[2] + w1 * B[2] + w2 * C[2], k = y * W + x;
        if (d <= zb[k]) continue;
        zb[k] = d; img[k * 3] = rgb[0]; img[k * 3 + 1] = rgb[1]; img[k * 3 + 2] = rgb[2];
      }
    }
  }
  ox += p.w;
}

// ---- PNG -------------------------------------------------------------------------
const crcT = new Uint32Array(256).map((_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${kind}: ${W}x${H} -> ${out}  (len ${K.len} wid ${K.wid} axle ${ax} wheelR ${K.wheelR})`);
