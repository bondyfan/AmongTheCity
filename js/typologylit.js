// ---- typologylit.js: which windows are lit at night ----
// Pure data (no three, no DOM), split out of typology.js, which re-exports all
// of it: the night texture's texel rule and the per-building lookups the far
// tier (uv1) and the near shell (litPane) share, so a pane lit far is lit near.

import { rnd, BAYS } from './typologycells.js';

// ---- lit windows -----------------------------------------------------------
// The night texture is 256 x 256 texels and every texel is ONE window bay: a
// wall run of up to four bays samples four neighbours on one row. Rows come in
// four palettes of 64 (homes, shops, offices, dim yards) and inside a palette
// the row index is the DENSITY: row q lights q/63 of its bays. So a building
// picks a row for how alive it is and a column for which pattern it gets, and
// pieces.js can ask this module for the very same texel to light the very same
// pane on the near shell.
export const LIT_N = 256;
export const LIT_BANDS = { home: 0, shop: 1, office: 2, dim: 3 };
const _lt = [0, 0, 0, 0];
/** Texel (x, y) -> out[r, g, b, rank] bytes (sRGB colour); returns lit or not. */
export function litTexel(x, y, out = _lt) {
  const band = y >> 6, q = y & 63, id = (y * 256 + x) | 0;
  out[0] = out[1] = out[2] = 0; out[3] = 255;
  if (x === 0 || rnd(id, 11) >= q / 63) return false;
  const k = rnd(id, 12), b = 0.62 + rnd(id, 13) * 0.38;
  let r, g, bl, rank = 0.04 + rnd(id, 14) * 0.9;
  if (band === 1) {                         // shop: neutral white, on early
    r = 1; g = 0.95; bl = 0.84; rank *= 0.35;
    if (k < 0.2) { g = 0.84; bl = 0.6; }
  } else if (band === 2) {                  // office: cool tubes
    r = 0.86; g = 0.94; bl = 1;
    if (k < 0.15) { r = 1; g = 0.9; bl = 0.72; }
  } else if (band === 3) {                  // yard and stair lights: sodium
    r = 1; g = 0.78; bl = 0.46;
  } else if (k < 0.70) {                    // a warm room, the common case
    r = 1; g = 0.74 + rnd(id, 15) * 0.1; bl = 0.40 + rnd(id, 16) * 0.16;
  } else if (k < 0.80) {                    // television
    r = 0.50; g = 0.66; bl = 1; rank = 0.3 + rank * 0.7;
  } else if (k < 0.89) {                    // a cold LED kitchen
    r = 0.88; g = 0.95; bl = 1;
  } else if (k < 0.95) {                    // one shaded lamp
    r = 1; g = 0.58; bl = 0.26;
  } else {                                  // coloured curtains
    r = 0.95; g = 0.72; bl = 0.62;
  }
  out[0] = Math.round(255 * r * b); out[1] = Math.round(255 * g * b);
  out[2] = Math.round(255 * bl * b); out[3] = Math.round(255 * rank);
  return true;
}

// How alive a typology is after dark: [palette, share of windows lit]
const LIT_OF = {
  panel: ['home', 0.4], tenement: ['home', 0.36], block: ['home', 0.38],
  functional: ['home', 0.36], nova: ['home', 0.42], house: ['home', 0.46],
  brick: ['home', 0.16], civic: ['office', 0.07], office: ['office', 0.12],
  shop: ['home', 0.26], retail: ['shop', 0], pavilion: ['shop', 0.5],
  hall: ['dim', 0], barn: ['dim', 0], garage: ['dim', 0], church: ['dim', 0],
  parking: ['dim', 0],
};
/** Per-building night character: { band, dens } */
export function litOf(f, typ) {
  if (f.sealed) return { band: 0, dens: 0 };   // nobody home, and nobody has been (js/geo.js)
  const [band, base] = LIT_OF[typ] ?? LIT_OF.block;
  // some houses are out, some have everybody home; a few offices work late
  let dens = base * (0.35 + rnd(f._id, 21) * 1.3);
  if (band === 'office' && rnd(f._id, 22) < 0.12) dens = 0.45;
  return { band: LIT_BANDS[band], dens: Math.min(0.9, dens) };
}
/** The texture row for storey `s` (shopfront rows are their own palette). */
export function litRow(lit, id, s, store) {
  if (store) return (LIT_BANDS.shop << 6) | Math.round((0.72 + rnd(id, 23) * 0.25) * 63);
  if (lit.dens <= 0) return 0;
  const d = Math.max(0, Math.min(1, lit.dens * (0.55 + rnd(id, 30 + s) * 0.9)));
  return (lit.band << 6) | Math.round(d * 63);
}
/** First texel column of bay run `run` on (storey, edge): 1..251, never wraps. */
export const litStart = (id, s, edge, run) =>
  1 + ((Math.floor(rnd(id, 400 + s * 37 + edge * 11) * 251) + run * BAYS) % 248);
/**
 * litPane(lit, id, s, edge, bay, store) -> [r, g, b, rank] bytes or null.
 * The near shell's twin of the far tier's uv1 lookup: same row, same column.
 */
export function litPane(lit, id, s, edge, bay, store) {
  const y = litRow(lit, id, s, store);
  const x = litStart(id, s, edge, (bay / BAYS) | 0) + (bay % BAYS);
  const o = [0, 0, 0, 0];
  return litTexel(x, y, o) ? o : null;
}
