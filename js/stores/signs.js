// ---- stores/signs.js: a store's lit signs, as quads of the chunk's wordmark stream ----
// WORKER SAFE. A sign is a textured quad in the same per-chunk stream the far
// shop fascias use (js/meshes.js brandSignage, js/wordmarkatlas.js), so a
// chunk's signs are still one draw call and a worker-built chunk names them the
// way it names every other wordmark.
//
// Only { label, sign, trim } of a brand record crosses from the worker
// (js/chunkspec.js), so WHAT to paint is carried in the label itself:
//   '@<chain id>/<variant>'    variant: 'sq' a square tile, 'band' a 4:1 panel,
//                              'hours' the opening-hours board
// js/stores/signpaint.js reads it back on the main thread.

/** The record of one of a chain's signs. */
export function signBrand(chain, variant) {
  const v = variant ?? (chain.sign.square ? 'sq' : 'band');
  return { label: '@' + chain.id + '/' + v, sign: v === 'hours' ? 0xf4f4f1 : chain.sign.bg, trim: chain.sign.fg };
}

/** Width over height of a sign variant's panel. */
export const signAspect = (variant) => (variant === 'sq' ? 1 : variant === 'hours' ? 0.8 : 4);

/** `label` back into { id, variant }, or null for an ordinary shop name. */
export function parseSign(label) {
  if (typeof label !== 'string' || label[0] !== '@') return null;
  const k = label.indexOf('/');
  return k < 0 ? null : { id: label.slice(1, k), variant: label.slice(k + 1) };
}

/**
 * One upright sign: centred on (cx, cz) at height yc (absolute), `w` wide and
 * `h` tall, facing (fx, fz). The winding and the direction of u are those of
 * meshes.js markWall, so the text reads the right way round.
 */
export function signQuad(marks, brand, cx, cz, yc, w, h, fx, fz) {
  if (!marks) return;
  let mk = marks.get(brand.label);
  if (!mk) marks.set(brand.label, mk = { brand, pos: [], uv: [] });
  // along the panel: screen-right for somebody looking at its face
  const tx = -fz, tz = fx;
  let ax = cx - tx * w / 2, az = cz - tz * w / 2, bx = cx + tx * w / 2, bz = cz + tz * w / 2;
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz < 0) { const sx = ax, sz = az; ax = bx; az = bz; bx = sx; bz = sz; }
  const yB = yc - h / 2, yT = yc + h / 2;
  mk.pos.push(ax, yT, az, bx, yT, bz, bx, yB, bz, ax, yT, az, bx, yB, bz, ax, yB, az);
  mk.uv.push(1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
}
