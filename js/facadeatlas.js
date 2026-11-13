// ---- facadeatlas.js: the painted faces of the city, and their night ----
// MAIN THREAD ONLY. This module owns the three things about a facade that need
// a <canvas> or a material, and that a mesh worker therefore must never touch
// (the worker names the wall material by key and the main thread resolves it):
//
//   facadeAtlas()     one 2048 x 2048 texture, 8 x 8 cells, painted once. RGB is
//                     the wall, ALPHA is a window mask: 1 where there is glass a
//                     lamp behind would shine through, 0 on plaster and frames.
//   litTexture()      256 x 256, one texel per window bay, the colour of the
//                     light in that room (typology.litTexel, a pure function).
//   buildFacadeMaterial()  the Lambert wall material with two additions: roof
//                     triangles are tiled in METRES from their own position
//                     (an atlas cell cannot wrap, a 30 m roof has to) out of
//                     the roof atlas (js/roofatlas.js), and
//                     emissive = lit colour x window mask x the night.
//
// The night itself is ONE shared uniform, NIGHT, set by facadeNight(k) from
// main.js. The far tier's wall material and the near shell's glass both read
// it, so a single assignment per frame lights every window in the city.
//
// What a cell means is not decided here. typology.js lists the cells (family,
// role, variant) and where each family's window sits; this file only paints
// what that table says, and pieces.js cuts real openings from the same numbers.

import * as THREE from 'three';
import { ATLAS_N, ATLAS_M, ATLAS_PX, BAYS, CELL_LIST, FAMILIES, ROOF_ROWS, TRIM_CELL,
  PANEL_BALC, NOVA_RAIL, HOUSE_BLANK, LIT_N, litTexel, rnd } from './typology.js';
import { roofAtlas, ROOF_GRID, ROOF_CELL, ROOF_PX, ROOF_GUT } from './roofatlas.js';

const CW = ATLAS_PX / ATLAS_N, CH = ATLAS_PX / ATLAS_M, BAY = CW / BAYS;

// ---- the shared night ------------------------------------------------------
// x: how far the evening has got, 0..1. A lit texel carries a rank and comes on
//    when x passes it, so windows light up one by one through dusk.
// y: emissive gain. It was 1.45 ("above 1, the bloom only bites above 1"), which
//    under the night exposure (2.5, sky.js) is 3.6: every lit window, warm,
//    TV blue or office white, came out the same white card, and a glazed kiosk
//    was a blank sheet. The gain now FALLS as the exposure opens, so a window
//    is about as bright to the eye at dusk as at midnight and keeps its
//    colour. It no longer blooms, on purpose: a window is a lit surface, not
//    a lamp, and the bloom made a facade of them one smear.
export const NIGHT = { value: new THREE.Vector2(0, 0) };
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Drive every lit window in the city. `k` is sky.nightK, 0 by day, 1 at night. */
export function facadeNight(k) {
  NIGHT.value.set(ss(0.12, 0.8, k), (0.95 - 0.43 * k) * ss(0.05, 0.4, k));
}

// ---- a lit shop front, seen from the street --------------------------------
// The near shell's lit pane (destructible.js) is a pane of glass that glows:
// the room's colour, a little brighter under the ceiling. Behind the glazing
// bars of a flat's window that is a room with the lamp on. On a shop front,
// which is glass from jamb to jamb with no bars, and on the glazed walls of a
// kiosk, it was a pale flat panel the size of the wall.
//
// What tells the eye "glass with a lit room behind it" is PARALLAX: the back
// wall slides against the frame as you walk past. So a bar-less lit pane is
// drawn as the inside of a room, worked out per pixel from the ray through
// the glass (interior mapping, no geometry and no texture): a ceiling with
// light panels, a back wall of shelves with goods on them, a floor, a
// partition now and then, and a low gondola standing in the middle, dark
// against the light. Everything along the wall is placed in WORLD metres, so
// the room runs on behind the jambs from one bay to the next, and it looks
// the same from both faces of the pane.
//
// The pane's own axes come from the screen derivatives of its uv and of the
// view position: on a flat pane those give the metres per unit of u and of v
// exactly, so no attribute is added and destructible.js only calls this.
//   uv        the pane's 0..1
//   viewPos   the fragment in view space
//   shop      1 on a lit pane without glazing bars, else 0
//   card      what an ordinary lit window shows (the caller's old value)
// Returns the factor on the room's lamp colour.
export const PANE_GLOW_GLSL = /* glsl */`
  float atcRoomHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // a wall of the shop: shelving to head height with goods of every colour on
  // it, plain painted wall above. p: metres along the wall, metres above the floor
  vec3 atcShelfWall(vec2 p, float top) {
    float fy = fract(p.y / 0.40);
    vec2 id = vec2(floor(p.x / 0.24), floor(p.y / 0.40));
    float r = atcRoomHash(id);
    float goods = step(0.07, fy) * step(fy, 0.30 + 0.55 * r) * step(0.18, p.y) * step(p.y, 2.0)
      * step(0.10, atcRoomHash(id + 3.3));
    vec3 gh = vec3(atcRoomHash(id + 1.7), atcRoomHash(id + 5.3), atcRoomHash(id + 9.1));
    vec3 gc = 0.03 + 0.52 * gh * gh;                                  // packets: strong colours, most of them dark
    vec3 col = mix(vec3(0.30, 0.285, 0.26), gc, goods);
    // the back of a shelf bay is in its own shade, and so is the board's edge
    col *= 1.0 - 0.45 * step(p.y, 2.05) * (1.0 - goods) * step(0.18, p.y);
    col *= 1.0 - 0.55 * step(fy, 0.07) * step(p.y, 2.05);
    // an upright every 1.2 m
    col *= 1.0 - 0.5 * step(abs(fract(p.x / 1.2) - 0.5), 0.018) * step(p.y, 2.05);
    return col * (0.45 + 0.55 * smoothstep(0.0, top, p.y));           // the lamps are overhead
  }
  vec3 atcPaneGlow(vec2 uv, vec3 viewPos, float shop, float card) {
    vec3 dPx = dFdx(viewPos), dPy = dFdy(viewPos);
    vec2 dUx = dFdx(uv), dUy = dFdy(uv);
    if (shop < 0.5) return vec3(card);
    float det = dUx.x * dUy.y - dUx.y * dUy.x;
    if (abs(det) < 1e-12) return vec3(card * 0.4);
    vec3 T = (dPx * dUy.y - dPy * dUx.y) / det;      // metres per unit u, along the wall
    vec3 B = (dPy * dUx.x - dPx * dUy.x) / det;      // metres per unit v, up the wall
    float W = length(T), H = length(B);
    if (W < 0.05 || H < 0.05) return vec3(card * 0.4);   // the pane's own 2 cm edge
    vec3 tn = T / W, bn = B / H;
    vec3 nn = normalize(cross(tn, bn));
    vec3 d = normalize(viewPos);
    float dn = dot(d, nn);
    if (dn < 0.0) dn = -dn;                           // into the room, whichever face is seen
    dn = max(dn, 0.05);
    float dt = dot(d, tn), db = dot(d, bn);
    // along the wall in world metres, counted the same way from either face
    vec3 tw = tn * mat3(viewMatrix);
    float sgn = tw.x + 0.37 * tw.z < 0.0 ? -1.0 : 1.0;
    float x = dot(cameraPosition + viewPos * mat3(viewMatrix), tw) * sgn;
    dt *= sgn;
    float y = uv.y * H;
    // the room: 3.2 m deep, its floor under the stall riser, its ceiling over
    // the head of the glass, a cross wall every 9 m
    const float D = 3.2, YF = -0.45, S = 9.0;
    float YC = H + 0.30;
    float t = D / dn, kind = 0.0;
    if (db > 1e-4) { float tc = (YC - y) / db; if (tc < t) { t = tc; kind = 1.0; } }
    if (db < -1e-4) { float tf = (YF - y) / db; if (tf < t) { t = tf; kind = 2.0; } }
    if (abs(dt) > 1e-4) {
      float cell = floor(x / S);
      float tp = ((dt > 0.0 ? cell + 1.0 : cell) * S - x) / dt;
      if (tp < t) { t = tp; kind = 3.0; }
    }
    vec3 h = vec3(x + dt * t, y + db * t - YF, dn * t);   // along, above the floor, into the room
    float top = YC - YF;
    vec3 col;
    if (kind < 0.5) col = atcShelfWall(h.xy, top);
    else if (kind > 2.5) col = atcShelfWall(vec2(h.z + 0.07, h.y), top) * 0.8;
    else if (kind < 1.5) {
      // the ceiling: a grid of light panels in white tiles. These ARE the
      // light, and the one thing in the room allowed to be bright.
      vec2 f = abs(fract(vec2(h.x / 2.4, h.z / 1.4)) - 0.5);
      col = vec3(mix(0.30, 1.9, step(f.x, 0.27) * step(f.y, 0.21)));
    } else {
      // the floor: polished, so the far end of the shop shows in it
      col = vec3(0.12, 0.115, 0.105) * (1.0 + 1.1 * smoothstep(0.0, D, h.z));
    }
    col /= 1.0 + 0.04 * t;                                           // deeper is dimmer
    // a gondola on the shop floor: goods stacked to chest height, seen from the dark side
    float tg = 1.4 / dn;
    if (tg < t) {
      float gx = x + dt * tg, gy = y + db * tg - YF;
      float unit = floor(gx / 2.1);
      float there = step(0.38, atcRoomHash(vec2(unit, 3.0)))
        * step(abs(fract(gx / 2.1) - 0.5), 0.41)
        * step(gy, 1.05 + 0.30 * atcRoomHash(vec2(floor(gx / 0.35), 8.0)));
      col = mix(col, vec3(0.035, 0.033, 0.03), there);
    }
    // a wide pane is several sheets: a slim mullion between them
    float nS = max(1.0, floor(W / 1.6 + 0.5));
    float mu = abs(fract(uv.x * nS + 0.5) - 0.5) * (W / nS);
    col *= 1.0 - 0.88 * (1.0 - step(0.022, mu)) * step(1.5, nS);
    // far off the shelves are finer than a pixel: fade to what they average
    return mix(col, vec3(0.20), smoothstep(30.0, 85.0, length(viewPos)));
  }`;

// ---- small painting kit ----------------------------------------------------
const css = (r, g, b, a) => (a === undefined ? `rgb(${r | 0},${g | 0},${b | 0})`
  : `rgba(${r | 0},${g | 0},${b | 0},${a})`);
const grey = (v) => { const c = Math.round(Math.max(0, Math.min(1, v)) * 255); return css(c, c, c); };

function speckle(g, x, y, w, h, R, salt, n, dark, alpha) {
  for (let k = 0; k < n; k++) {
    const px = x + R(salt + k * 3) * (w - 2), py = y + R(salt + k * 3 + 1) * (h - 2);
    const d = R(salt + k * 3 + 2);
    g.fillStyle = d < 0.5 ? css(dark, dark, dark - 6, alpha * (0.4 + d))
      : css(255, 252, 244, alpha * (d - 0.3));
    g.fillRect(px, py, 1 + d * 2, 1 + (1 - d) * 2);
  }
}

// One cell's painter context. Coordinates are cell-local pixels, y DOWN.
function cellCtx(g, m, X, Y, seed) {
  const R = (n) => rnd(seed, n);
  const A = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(X + x, Y + y, w, h); };
  const K = (x, y, w, h, v) => { m.fillStyle = grey(v); m.fillRect(X + x, Y + y, w, h); };
  const grad = (ctx, y0, y1, stops) => {
    const gr = ctx.createLinearGradient(0, Y + y0, 0, Y + y1);
    stops.forEach((s, i) => gr.addColorStop(i / (stops.length - 1), s));
    return gr;
  };
  return { g, m, X, Y, R, A, K, grad };
}

// ---- walls -----------------------------------------------------------------
function plaster(c, tone = [237, 235, 228], rough = 1) {
  const { g, X, Y, R, A } = c;
  A(0, 0, CW, CH, css(tone[0] - 6 + R(0) * 10, tone[1] - 6 + R(1) * 9, tone[2] - 6 + R(2) * 8));
  speckle(g, X, Y, CW, CH, R, 2000, 260 * rough, 150, 0.10);
  // rain runs DOWN: every stain here is vertical, and whisper-quiet, because the
  // wall tint multiplies on top and a bold streak would double into soot
  const n = 7 + (R(50) * 8 | 0);
  for (let k = 0; k < n; k++) {
    const w = 3 + R(300 + k) * 11;
    A(4 + R(320 + k) * (CW - 10 - w), 0, w, CH, css(98, 92, 80, 0.018 + R(340 + k) * 0.03));
  }
}
function brickWall(c) {
  const { R, A } = c;
  A(0, 0, CW, CH, css(226 + R(60) * 12, 214 + R(61) * 10, 204 + R(62) * 10));
  const course = 6;                                // about 75 mm: the Czech brick format
  let row = 0;
  for (let y = 0; y < CH; y += course, row++) {
    for (let x = -((row % 2) * 4); x < CW; x += 8) {
      const k = R(700 + row * 37 + x);
      A(x, y, 7, course - 1, css(150 + k * 90, 120 + k * 80, 100 + k * 70, 0.16 + k * 0.2));
    }
    A(0, y + course - 1, CW, 1, css(240, 236, 226, 0.55));    // bed joint, light mortar
  }
}
// `k` is how much of the prefab shows: 1 raw exposed-aggregate panels with open
// joints, about 0.25 the same block after insulation and a coat of pastel
function concretePanels(c, k) {
  const { g, X, Y, R, A } = c;
  const v = 240 - 13 * k;
  A(0, 0, CW, CH, css(v, v - 1, v - 7));
  speckle(g, X, Y, CW, CH, R, 2100, 200 + 700 * k, 150 - 30 * k, 0.08 + 0.12 * k);
  for (let b = 0; b < BAYS; b++) {
    // every panel left the plant a slightly different grey
    A(b * BAY, 0, BAY, CH, css(60, 58, 52, R(400 + b) * 0.09 * k));
    A(b * BAY, 0, 2, CH, css(112, 110, 104, 0.85 * k));
    A(b * BAY + 2, 0, 1, CH, css(255, 255, 250, 0.35 * k));
  }
  A(CW - 1, 0, 1, CH, css(112, 110, 104, 0.6 * k));
  A(0, 0, CW, 3, css(112, 110, 104, 0.85 * k));
  A(0, CH - 2, CW, 2, css(112, 110, 104, 0.7 * k));
}
function corrugated(c, pitch = 4) {
  const { R, A } = c;
  A(0, 0, CW, CH, css(232, 232, 228));
  for (let x = 0; x < CW; x += pitch) {
    A(x, 0, pitch / 2, CH, css(255, 255, 255, 0.34));
    A(x + pitch / 2, 0, pitch / 2, CH, css(70, 74, 80, 0.26));
  }
  for (let k = 0; k < 5; k++)
    A(R(500 + k) * CW, 0, 6 + R(510 + k) * 18, CH, css(90, 86, 76, 0.03 + R(520 + k) * 0.04));
}
function sandwich(c, courses = 4) {
  const { g, X, Y, R, A } = c;
  A(0, 0, CW, CH, css(238, 238, 234));
  speckle(g, X, Y, CW, CH, R, 2200, 120, 160, 0.05);
  for (let k = 1; k < courses; k++) {
    A(0, k * CH / courses, CW, 2, css(96, 98, 100, 0.5));
    A(0, k * CH / courses + 2, CW, 1, css(255, 255, 255, 0.5));
  }
  for (let b = 0; b <= BAYS; b += 2) A(Math.min(b * BAY, CW - 2), 0, 2, CH, css(96, 98, 100, 0.4));
}
// bands across the whole cell, from the floor up (fractions of storey height)
function hBand(c, y0, y1, col) { c.A(0, CH * (1 - y1), CW, CH * (y1 - y0), col); }
function plinth(c, h, col = css(120, 116, 108, 0.62)) {
  hBand(c, 0, h, col);
  c.A(0, CH * (1 - h) - 2, CW, 2, css(255, 252, 244, 0.35));     // the ledge catches light
  c.A(0, CH * (1 - h), CW, 3, css(60, 56, 50, 0.3));
}
function cornice(c, h) {
  const { A } = c, H = CH * h;
  A(0, 0, CW, H, css(246, 244, 238));
  A(0, H * 0.34, CW, H * 0.16, css(120, 112, 100, 0.4));         // shadow under the top fillet
  A(0, H * 0.7, CW, H * 0.3, css(70, 64, 56, 0.34));             // and under the whole cornice
  for (let x = 4; x < CW; x += 10) A(x, H * 0.5, 5, H * 0.2, css(110, 104, 94, 0.35));   // dentils
  A(0, H, CW, 5, css(60, 56, 50, 0.2));
}

// ---- windows ---------------------------------------------------------------
// The opening sits where typology says: `band` from the floor up, `frac` of a
// bay. Everything that makes it read as RECESSED is painted inside it: a head
// shadow, a dark left jamb, a lit sill.
function winRect(band, frac, b) {
  const ww = Math.round(BAY * frac);
  return { wx: b * BAY + Math.round((BAY - ww) / 2), wy: Math.round(CH * (1 - band[1])),
    ww, wh: Math.round(CH * (band[1] - band[0])) };
}
const GLASS = [[142, 164, 184], [92, 108, 124], [50, 58, 70]];
function window_(c, r, o = {}) {
  const { g, m, X, Y, A, K, R, grad } = c;
  const { wx, wy, ww, wh } = r, s = o.salt ?? 0;
  const fr = o.frame ?? css(238, 236, 228);
  const fw = o.fw ?? 3, fh = o.fh ?? 5;
  // surround, lintel and sill, outside the opening
  if (o.surround) {
    A(wx - 4, wy - 9, ww + 8, wh + 15, o.surround);
    A(wx - 4, wy + wh + 6, ww + 8, 2, css(70, 64, 56, 0.25));
  }
  if (o.lintel) A(wx - 4, wy - 10, ww + 8, 7, o.lintel);
  if (o.pediment) {
    g.fillStyle = css(244, 242, 234);
    g.beginPath(); g.moveTo(X + wx - 6, Y + wy - 9); g.lineTo(X + wx + ww / 2, Y + wy - 26);
    g.lineTo(X + wx + ww + 6, Y + wy - 9); g.closePath(); g.fill();
    A(wx - 6, wy - 10, ww + 12, 3, css(70, 64, 56, 0.4));
  }
  if (o.arch) {                                    // segmental brick arch
    g.strokeStyle = css(120, 86, 70, 0.7); g.lineWidth = 6;
    g.beginPath(); g.moveTo(X + wx - 3, Y + wy - 2);
    g.quadraticCurveTo(X + wx + ww / 2, Y + wy - 14, X + wx + ww + 3, Y + wy - 2); g.stroke();
  }
  // the opening: frame colour first, then glass inside it
  A(wx, wy, ww, wh, fr);
  const t = (R(s + 4) * 22) | 0;
  const gx = wx + fw, gy = wy + fh, gw = ww - 2 * fw, gh = wh - 2 * fh;
  g.fillStyle = grad(g, gy, gy + gh, GLASS.map(([a, b, d]) => css(a + t, b + t, d + t)));
  g.fillRect(X + gx, Y + gy, gw, gh);
  // sky sheen: one pale diagonal, different on every pane
  g.save(); g.beginPath(); g.rect(X + gx, Y + gy, gw, gh); g.clip();
  g.fillStyle = css(220, 232, 244, 0.10 + R(s + 5) * 0.12);
  const sx = gx + gw * (0.1 + R(s + 6) * 0.5);
  g.beginPath(); g.moveTo(X + sx, Y + gy); g.lineTo(X + sx + gw * 0.38, Y + gy);
  g.lineTo(X + sx + gw * 0.16, Y + gy + gh * 0.62); g.lineTo(X + sx - gw * 0.22, Y + gy + gh * 0.62);
  g.closePath(); g.fill(); g.restore();
  // the mask: a lamp-lit room is brightest under the ceiling
  m.fillStyle = grad(m, gy, gy + gh, [grey(1), grey(0.9), grey(0.72)]);
  m.fillRect(X + gx, Y + gy, gw, gh);
  // what hangs in it
  const cur = o.curtain ?? (R(s + 7) * 6 | 0);
  if (cur === 1) {                                 // net curtain, the whole pane
    A(gx, gy, gw, gh, css(226, 222, 212, 0.62));
    for (let x = gx + 2; x < gx + gw; x += 4) A(x, gy, 1, gh, css(150, 146, 138, 0.25));
    K(gx, gy, gw, gh, 0.8);
  } else if (cur === 2) {                          // drapes drawn to the sides
    const dw = Math.max(3, gw * 0.24 | 0), hue = R(s + 8);
    const dc = hue < 0.4 ? css(206, 196, 176, 0.86) : hue < 0.7 ? css(176, 150, 130, 0.86) : css(150, 164, 160, 0.86);
    A(gx, gy, dw, gh, dc); A(gx + gw - dw, gy, dw, gh, dc);
    K(gx, gy, dw, gh, 0.42); K(gx + gw - dw, gy, dw, gh, 0.42);
  } else if (cur === 3) {                          // a blind, part way down
    const bh = gh * (0.3 + R(s + 9) * 0.5) | 0;
    A(gx, gy, gw, bh, css(214, 210, 200, 0.9));
    for (let y = gy; y < gy + bh; y += 4) { A(gx, y + 3, gw, 1, css(120, 116, 108, 0.5)); }
    for (let y = gy; y < gy + bh; y += 4) K(gx, y, gw, 3, 0.34);
    for (let y = gy + 3; y < gy + bh; y += 4) K(gx, y, gw, 1, 0.7);
  } else if (cur === 4 && o.plants !== false) {    // things on the sill
    for (let k = 0; k < 2; k++) {
      const px = gx + 2 + R(s + 10 + k) * (gw - 8);
      A(px, gy + gh - 12, 5, 12, css(60, 96, 58, 0.8));
      K(px, gy + gh - 12, 5, 12, 0.3);
    }
  }
  // glazing bars
  const bar = (x, y, w, h) => { A(x, y, w, h, fr); K(x, y, w, h, 0); };
  const mu = o.mull ?? 'T';
  if (mu === 'T' || mu === 'cross' || mu === 'tallT') bar(gx + (gw / 2 | 0) - 1, gy, 2, gh);
  if (mu === 'T' || mu === 'tallT') bar(gx, gy + (gh * (mu === 'tallT' ? 0.26 : 0.3) | 0), gw, 3);
  if (mu === 'cross') bar(gx, gy + (gh * 0.45 | 0), gw, 3);
  if (mu === 'two') bar(gx + (gw / 2 | 0) - 1, gy, 2, gh);
  if (mu === 'three') { bar(gx + (gw / 3 | 0) - 1, gy, 2, gh); bar(gx + (gw * 2 / 3 | 0) - 1, gy, 2, gh); }
  if (mu === 'grid') {
    for (let k = 1; k < 4; k++) bar(gx + (gw * k / 4 | 0), gy, 1, gh);
    for (let k = 1; k < 4; k++) bar(gx, gy + (gh * k / 4 | 0), gw, 2);
  }
  // the reveal: head shadow over frame and glass, a dark left jamb, a lit right one
  g.fillStyle = grad(g, wy, wy + 14, [css(24, 22, 20, 0.62), css(24, 22, 20, 0)]);
  g.fillRect(X + wx, Y + wy, ww, 14);
  A(wx, wy, 2, wh, css(24, 22, 20, 0.42));
  A(wx + ww - 1, wy, 1, wh, css(255, 252, 244, 0.35));
  A(wx - 1, wy - 2, ww + 2, 2, css(40, 36, 32, 0.45));            // the arris above it
  // sill: a pale ledge standing proud, its shadow, and the rain marks off its ends
  if (o.sill !== false) {
    A(wx - 4, wy + wh, ww + 8, 6, o.sillCol ?? css(232, 229, 220));
    A(wx - 4, wy + wh + 6, ww + 8, 2, css(52, 48, 42, 0.6));
    g.fillStyle = grad(g, wy + wh + 8, wy + wh + 20, [css(52, 48, 42, 0.22), css(52, 48, 42, 0)]);
    g.fillRect(X + wx - 4, Y + wy + wh + 8, ww + 8, 12);
    const sl = Math.min(30, CH - (wy + wh + 10));
    if (sl > 4) { A(wx - 3, wy + wh + 8, 2, sl, css(96, 90, 78, 0.16)); A(wx + ww + 1, wy + wh + 8, 2, sl, css(96, 90, 78, 0.16)); }
  }
}
// a French-balcony rail across the lower part of an opening
function rail(c, r, h = 0.52) {
  const by = r.wy + (r.wh * (1 - h) | 0);
  for (let x = r.wx - 3; x <= r.wx + r.ww + 2; x += 5) c.A(x, by, 1, r.wy + r.wh - by + 4, css(40, 42, 44, 0.75));
  c.A(r.wx - 5, by, r.ww + 10, 3, css(40, 42, 44, 0.9));
}

// ---- the families ----------------------------------------------------------
const PAINT = {
  panel(c, role, v) {
    const F = FAMILIES.panel, raw = role === 'mid' && v < 2;
    concretePanels(c, role !== 'mid' ? 0.5 : raw ? 1 : 0.25);
    if (role === 'gable') {
      // the blank end wall: joints only, and one storey-high accent strip
      c.A(BAY * 1.5, 0, BAY, CH, css(60, 58, 52, 0.07));
      return;
    }
    if (role === 'ground') plinth(c, 0.2, css(108, 106, 100, 0.6));
    if (role === 'top') { hBand(c, 0.86, 1, css(250, 248, 242, 0.5)); c.A(0, CH * 0.14, CW, 3, css(70, 68, 62, 0.5)); }
    // insulated blocks carry a painted accent between the windows
    if (role === 'mid' && !raw) hBand(c, F.band[0] - 0.02, F.band[1] + 0.02, css(120, 112, 96, v === 2 ? 0.22 : 0.12));
    const balc = role === 'mid' ? PANEL_BALC[v] : null;
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20, mull: 'three', frame: css(244, 243, 238), sill: !balc?.[b] });
      if (balc?.[b]) {
        // the loggia: the slab above throws a shadow, the pastel board hides the sill
        const x0 = b * BAY + 3, w = BAY - 6, top = CH * 0.66 | 0;
        c.g.fillStyle = c.grad(c.g, 0, 44, [css(20, 20, 22, 0.6), css(20, 20, 22, 0)]);
        c.g.fillRect(c.X + x0, c.Y, w, 44);
        c.A(x0, 0, w, 7, css(196, 194, 188));
        const hue = c.R(900 + b);
        c.A(x0, top, w, CH - top - 4, hue < 0.33 ? css(206, 212, 216) : hue < 0.66 ? css(214, 206, 188) : css(190, 204, 186));
        c.K(x0, top, w, CH - top, 0);
        for (let x = x0; x < x0 + w; x += 11) c.A(x, top, 1, CH - top - 4, css(90, 92, 94, 0.5));
        c.A(x0, top, w, 3, css(70, 72, 74, 0.85));
        c.A(x0, CH - 6, w, 6, css(176, 174, 168));
        c.A(x0, top + 3, w, 5, css(30, 30, 30, 0.18));
      }
    }
  },
  tenement(c, role, v) {
    const F = FAMILIES.tenement;
    plaster(c);
    if (role === 'ground') {
      if (v === 0) for (let y = 6; y < CH; y += 26) { c.A(0, y, CW, 3, css(84, 78, 68, 0.42)); c.A(0, y + 3, CW, 2, css(255, 252, 244, 0.3)); }
      plinth(c, v === 0 ? 0.13 : 0.2, css(112, 104, 94, 0.62));
      c.A(0, 0, CW, 9, css(246, 244, 238)); c.A(0, 9, CW, 4, css(64, 58, 50, 0.4));      // string course
    } else {
      // floor line: a thin moulded band under every storey of windows
      c.A(0, CH - 9, CW, 6, css(246, 244, 238)); c.A(0, CH - 3, CW, 3, css(64, 58, 50, 0.32));
    }
    if (role === 'top') cornice(c, 0.13);
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b), sv = role === 'mid' ? v : (role === 'top' ? 0 : 2);
      window_(c, r, { salt: 100 + b * 20, mull: 'tallT', frame: sv === 3 ? css(120, 92, 70) : css(240, 238, 230),
        surround: sv !== 2 ? css(250, 248, 242) : null, pediment: sv === 1 && role === 'mid',
        lintel: sv === 0 ? css(250, 248, 242) : null });
      if (sv === 0 && role !== 'ground') {         // a keystone
        c.A(r.wx + r.ww / 2 - 3, r.wy - 16, 6, 10, css(250, 248, 242)); c.A(r.wx + r.ww / 2 + 3, r.wy - 16, 1, 10, css(64, 58, 50, 0.4));
      }
      if (sv === 3) c.A(r.wx - 2, r.wy + r.wh + 14, r.ww + 4, 22, css(120, 112, 100, 0.2));   // apron panel
      if (sv === 2) c.A(r.wx - 6, r.wy - 12, r.ww + 12, 4, css(250, 248, 242));
    }
  },
  block(c, role, v) {
    const F = FAMILIES.block;
    plaster(c, [236, 234, 227], 1.3);
    if (role === 'ground') plinth(c, v === 0 ? 0.16 : 0.24, v === 0 ? css(116, 110, 100, 0.6) : css(136, 108, 92, 0.55));
    if (role === 'top') {
      if (v === 0) { c.A(0, 0, CW, 14, css(244, 242, 236)); c.A(0, 14, CW, 6, css(60, 56, 50, 0.4)); }
      else { hBand(c, 0.84, 1, css(110, 104, 94, 0.2)); for (let b = 0; b < BAYS; b++) c.A(b * BAY + 26, 12, 12, 9, css(40, 40, 42, 0.8)); }
    }
    const sv = role === 'mid' ? v : role === 'ground' ? 0 : 1;
    if (sv === 3) hBand(c, F.band[0] - 0.03, F.band[1] + 0.03, css(112, 104, 90, 0.2));
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20, mull: sv === 1 ? 'three' : sv === 2 ? 'two' : 'T',
        frame: sv === 2 ? css(126, 96, 72) : css(240, 238, 230),
        lintel: sv === 0 ? css(118, 110, 98, 0.35) : null,
        surround: sv === 1 ? css(248, 246, 240) : null });
      if (sv === 2 && role === 'mid' && (b === 1 || b === 2)) rail(c, r, 0.45);
    }
  },
  functional(c, role, v) {
    const F = FAMILIES.functional;
    plaster(c, [242, 241, 236], 0.5);
    // the horizontal is the whole style: one continuous shadow line at sill and head
    c.A(0, CH * (1 - F.band[0]) + 6, CW, 2, css(60, 58, 54, 0.35));
    c.A(0, CH * (1 - F.band[1]) - 6, CW, 2, css(60, 58, 54, 0.25));
    if (role === 'ground') plinth(c, 0.22, css(122, 78, 62, 0.62));       // glazed tile
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20, mull: 'three', frame: css(58, 60, 62), fw: 2, fh: 3 });
      if (role === 'mid' && v === 1 && b === 3) rail(c, r, 0.5);
    }
  },
  nova(c, role) {
    const F = FAMILIES.nova;
    plaster(c, [244, 243, 240], 0.35);
    if (role === 'ground') plinth(c, 0.12, css(112, 114, 116, 0.6));
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20, mull: 'two', frame: css(52, 55, 60), fw: 2, fh: 3, sill: false,
        curtain: (c.R(600 + b) * 3 | 0) === 0 ? 3 : 0 });
      if (role === 'mid' && NOVA_RAIL[b]) rail(c, r, 0.48);
    }
  },
  house(c, role, v) {
    const F = FAMILIES.house;
    plaster(c, v === 1 ? [232, 229, 220] : [240, 238, 232], v === 1 ? 2.4 : 0.8);
    if (role === 'ground')
      plinth(c, v === 2 ? 0.2 : 0.14, v === 1 ? css(124, 92, 74, 0.6) : v === 2 ? css(118, 114, 106, 0.66) : css(128, 126, 122, 0.5));
    for (let b = 0; b < BAYS; b++) {
      if (HOUSE_BLANK[v][b]) continue;             // a house has fewer windows than bays
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20,
        mull: v === 0 ? 'two' : v === 1 ? 'T' : v === 2 ? 'cross' : 'two',
        frame: v === 0 ? css(64, 66, 70) : v === 1 ? css(122, 90, 66) : css(244, 243, 238),
        surround: v === 2 ? css(250, 248, 242) : v === 3 ? css(250, 249, 244) : null });
    }
  },
  brick(c, role, v) {
    const F = FAMILIES.brick;
    brickWall(c);
    if (v === 2) { c.A(0, CH - 12, CW, 9, css(236, 232, 222)); c.A(0, CH - 3, CW, 3, css(60, 54, 46, 0.4)); }
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      window_(c, r, { salt: 100 + b * 20, mull: v === 1 ? 'grid' : 'cross', arch: v !== 1,
        frame: v === 1 ? css(70, 74, 76) : css(238, 236, 228), fw: v === 1 ? 1 : 3,
        sillCol: css(214, 208, 196), curtain: v === 1 ? 0 : undefined });
    }
  },
  civic(c, role, v) {
    const F = FAMILIES.civic;
    plaster(c, [240, 238, 231], 0.7);
    for (let b = 0; b <= BAYS; b++) {              // lesenes between the bays
      const x = Math.min(b * BAY - 4, CW - 4);
      c.A(Math.max(0, x), 0, 8, CH, css(255, 254, 248, 0.5)); c.A(Math.max(0, x) + 8, 0, 2, CH, css(70, 64, 56, 0.2));
    }
    if (role === 'ground') plinth(c, 0.17, css(116, 110, 100, 0.62));
    else { c.A(0, CH - 8, CW, 5, css(246, 244, 238)); c.A(0, CH - 3, CW, 3, css(64, 58, 50, 0.3)); }
    for (let b = 0; b < BAYS; b++)
      window_(c, winRect(F.band, F.frac, b), { salt: 100 + b * 20, mull: v === 1 ? 'grid' : 'three',
        frame: css(240, 238, 230), curtain: (c.R(640 + b) * 4 | 0) === 0 ? 3 : 0 });
  },
  officeBands(c, role, v) { officeCell(c, FAMILIES.officeBands, v, true); },
  officeGrid(c, role, v) { officeCell(c, FAMILIES.officeGrid, v, false); },
  hall(c, role, v) {
    if (v === 2) sandwich(c, 5); else corrugated(c, v === 0 ? 4 : 6);
    plinth(c, 0.08, css(120, 120, 116, 0.7));
    if (v === 0) {
      // strip glazing under the eaves: translucent sheet, no view through
      const y = CH * 0.14 | 0, h = CH * 0.2 | 0;
      c.A(0, y, CW, h, css(196, 212, 222));
      c.g.fillStyle = c.grad(c.g, y, y + h, [css(120, 140, 156, 0.5), css(120, 140, 156, 0)]);
      c.g.fillRect(c.X, c.Y + y, CW, h);
      for (let x = 0; x < CW; x += 16) c.A(x, y, 2, h, css(84, 88, 92));
      c.A(0, y - 2, CW, 3, css(60, 62, 64, 0.8)); c.A(0, y + h, CW, 3, css(90, 92, 94));
    } else if (v === 1) {
      hBand(c, 0.82, 1, css(60, 70, 84, 0.42));                            // company colour band
    } else {
      // a sectional door two bays wide, and the person door beside it
      const x = BAY + 6, w = BAY * 2 - 12, y = CH * 0.3 | 0;
      c.A(x, y, w, CH - y, css(150, 154, 158));
      for (let yy = y; yy < CH; yy += 14) { c.A(x, yy, w, 2, css(60, 62, 66, 0.6)); c.A(x, yy + 2, w, 2, css(255, 255, 255, 0.3)); }
      c.A(x - 3, y - 4, w + 6, 5, css(214, 190, 40));
      c.A(x - 3, y, 3, CH - y, css(214, 190, 40)); c.A(x + w, y, 3, CH - y, css(214, 190, 40));
      c.A(BAY * 3 + 20, CH * 0.66, 24, CH * 0.34, css(96, 104, 114));
    }
  },
  retail(c, role, v) {
    sandwich(c, v === 0 ? 3 : 4);
    plinth(c, 0.07, css(120, 120, 116, 0.7));
    if (v === 0) hBand(c, 0.78, 0.92, css(70, 74, 82, 0.34));
    else for (let b = 0; b < BAYS; b += 2) {
      const x = b * BAY + 14, y = CH * 0.18 | 0;
      c.A(x, y, BAY * 2 - 28, 26, css(70, 84, 98)); c.A(x, y, BAY * 2 - 28, 3, css(30, 32, 36, 0.6));
    }
  },
  garage(c, role) {
    plaster(c, [226, 224, 216], 2.2);
    plinth(c, 0.07, css(110, 108, 102, 0.5));
    for (let k = 0; k < 4; k++) c.A(c.R(800 + k) * CW, CH * 0.5, 10 + c.R(810 + k) * 30, CH * 0.5, css(80, 76, 66, 0.07));
    if (role !== 'door') return;
    for (let b = 0; b < BAYS; b++) {
      // up-and-over doors, each owner's own colour
      const x = b * BAY + 5, w = BAY - 10, y = CH * 0.24 | 0, h = CH - y - 4, k = c.R(820 + b);
      const col = k < 0.3 ? [150, 118, 90] : k < 0.55 ? [150, 156, 160] : k < 0.75 ? [118, 140, 120] : k < 0.9 ? [120, 136, 158] : [196, 190, 176];
      c.A(x - 2, y - 3, w + 4, h + 3, css(70, 68, 64));
      c.A(x, y, w, h, css(col[0], col[1], col[2]));
      for (let yy = y + 10; yy < y + h; yy += 12) c.A(x, yy, w, 2, css(30, 30, 30, 0.3));
      c.g.fillStyle = c.grad(c.g, y, y + 12, [css(20, 20, 20, 0.5), css(20, 20, 20, 0)]);
      c.g.fillRect(c.X + x, c.Y + y, w, 12);
      c.A(x + w / 2 - 3, y + h * 0.55, 6, 3, css(40, 40, 40));
    }
  },
  church(c) {
    plaster(c, [240, 238, 230], 0.8);
    plinth(c, 0.08, css(112, 106, 96, 0.62));
    for (let b = 0; b < BAYS; b += 2) {
      // one tall round-headed window per two bays, set deep
      const x = c.X + b * BAY + BAY - 13, w = 26, y0 = c.Y + CH * 0.2, y1 = c.Y + CH * 0.74;
      const shape = (ctx) => { ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y0 + w / 2);
        ctx.arc(x + w / 2, y0 + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y1); ctx.closePath(); };
      c.g.fillStyle = css(250, 248, 242); c.g.fillRect(x - 5, y0 - 4, w + 10, y1 - y0 + 10);
      c.g.fillStyle = c.grad(c.g, CH * 0.2, CH * 0.74, [css(86, 96, 112), css(44, 48, 60)]);
      shape(c.g); c.g.fill();
      c.g.fillStyle = css(20, 18, 16, 0.5); c.g.fillRect(x, y0, 3, y1 - y0);
      c.A(b * BAY + BAY - 1, CH * 0.2, 2, CH * 0.54, css(30, 30, 34));
      c.A(b * BAY - 3, 0, 8, CH, css(255, 254, 248, 0.45)); c.A(b * BAY + 5, 0, 2, CH, css(70, 64, 56, 0.22));
    }
  },
  parking(c) {
    c.A(0, 0, CW, CH, css(226, 226, 220));
    speckle(c.g, c.X, c.Y, CW, CH, c.R, 2300, 400, 130, 0.12);
    c.A(0, CH * 0.1, CW, CH * 0.52, css(26, 28, 32));                       // the open deck
    c.g.fillStyle = c.grad(c.g, CH * 0.1, CH * 0.3, [css(0, 0, 0, 0.7), css(0, 0, 0, 0)]);
    c.g.fillRect(c.X, c.Y + CH * 0.1, CW, CH * 0.2);
    for (let b = 0; b <= BAYS; b += 2) c.A(Math.min(b * BAY, CW - 8), CH * 0.1, 8, CH * 0.52, css(206, 206, 200));
    c.A(0, CH * 0.62, CW, 4, css(250, 250, 246)); c.A(0, CH * 0.1 - 3, CW, 3, css(60, 60, 60, 0.5));
  },
  store(c, role, v) {
    const F = FAMILIES.store;
    plaster(c);
    const y0 = Math.round(CH * (1 - F.band[1])), y1 = Math.round(CH * (1 - F.band[0]));
    // fascia zone over the glass: where the shop's name goes
    c.A(0, 6, CW, y0 - 12, v === 1 ? css(232, 228, 214) : v === 2 ? css(212, 214, 216) : css(74, 66, 58));
    c.A(0, y0 - 6, CW, 6, css(30, 28, 26, 0.5));
    c.A(0, y1, CW, CH - y1, css(96, 92, 86));                                // stall riser
    const door = Math.min(BAYS - 1, c.R(7) * BAYS | 0);
    for (let b = 0; b < BAYS; b++) {
      const r = winRect(F.band, F.frac, b);
      c.A(r.wx - 2, r.wy, r.ww + 4, r.wh, v === 2 ? css(150, 154, 158) : css(52, 50, 48));
      const gx = r.wx + 2, gy = r.wy + 3, gw = r.ww - 4, gh = r.wh - 5;
      c.g.fillStyle = c.grad(c.g, gy, gy + gh, [css(120, 140, 158), css(70, 82, 96), css(40, 46, 56)]);
      c.g.fillRect(c.X + gx, c.Y + gy, gw, gh);
      shopNight(c, gx, gy, gw, gh, 900 + b * 37);
      if (b === door) {
        c.A(gx + gw / 2 - 1, gy, 2, gh, css(40, 40, 40)); c.K(gx + gw / 2 - 1, gy, 2, gh, 0);
        c.A(gx + gw / 2 - 8, gy + gh * 0.5, 6, 3, css(190, 170, 110)); c.A(gx + gw / 2 + 2, gy + gh * 0.5, 6, 3, css(190, 170, 110));
      } else {
        // goods in the window: shelves by day, silhouettes against the light by night
        const n = 2 + (c.R(30 + b) * 3 | 0);
        for (let k = 0; k < n; k++) {
          const sy = gy + gh * (0.45 + 0.5 * k / n);
          c.A(gx + 3, sy, gw - 6, 3, css(200, 190, 170, 0.5)); c.K(gx + 3, sy, gw - 6, 3, 0.10);
          for (let x = gx + 4; x < gx + gw - 8; x += 7) {
            const hh = 6 + c.R(40 + b * 9 + k * 5 + x) * 10;
            c.A(x, sy - hh, 5, hh, css(150 + c.R(x) * 80, 120 + c.R(x + 1) * 80, 90 + c.R(x + 2) * 80, 0.55));
            c.K(x, sy - hh, 5, hh, 0.07 + c.R(60 + b * 9 + k * 5 + x) * 0.16);   // dark against the light
          }
        }
        if (v === 2 && b % 2 === 0) { c.A(gx + 4, gy + 10, gw - 8, gh * 0.4, css(214, 60, 50, 0.8)); c.K(gx + 4, gy + 10, gw - 8, gh * 0.4, 0.34); }
      }
      c.g.fillStyle = c.grad(c.g, gy, gy + 16, [css(10, 10, 12, 0.6), css(10, 10, 12, 0)]);
      c.g.fillRect(c.X + gx, c.Y + gy, gw, 16);
      if (v === 1) {                                 // a striped awning over the glass
        for (let x = r.wx - 4; x < r.wx + r.ww + 4; x += 8) c.A(x, y0 - 4, 4, 20, css(176, 60, 48));
        for (let x = r.wx; x < r.wx + r.ww + 4; x += 8) c.A(x, y0 - 4, 4, 20, css(240, 236, 226));
        c.K(r.wx - 4, y0 - 4, r.ww + 8, 20, 0);
        c.A(r.wx - 4, y0 + 16, r.ww + 8, 6, css(10, 10, 10, 0.3));
      }
    }
  },
};
// The NIGHT of a shop window, painted into the mask. It was a gradient from 1
// to 0.8: multiplied by the shop's white light that is a blank bright card the
// size of the pane, on every shop front past the near shell and on every one
// at all where the near shell is off (the low preset). A lit shop seen from
// the street is not evenly bright: the light panels in the ceiling are, the
// back wall under them is a mid grey that falls off toward the floor, the
// shelves on it are rows of small things lighter and darker, and the floor is
// dark. The mask says how much of the room's light each texel lets out, so
// that is what is painted here, and the goods in the window (painted by the
// caller, where they are by day) stand dark against it.
function shopNight(c, gx, gy, gw, gh, salt) {
  const { m, X, Y, K, R, grad } = c;
  m.fillStyle = grad(m, gy, gy + gh, [grey(0.34), grey(0.44), grey(0.32), grey(0.22)]);
  m.fillRect(X + gx, Y + gy, gw, gh);
  // shelving on the back wall, to head height
  const y0 = gy + Math.round(gh * 0.36), y1 = gy + Math.round(gh * 0.88), rowH = 13;
  for (let y = y0, r = 0; y + rowH <= y1; y += rowH, r++) {
    for (let x = gx + 2, k = 0; x < gx + gw - 5; x += 5, k++) {
      const v = R(salt + r * 31 + k * 7);
      if (v > 0.12) K(x, y + 2 + Math.round(v * 4), 4, rowH - 4 - Math.round(v * 4), 0.16 + R(salt + r * 31 + k * 7 + 3) * 0.44);
    }
    K(gx + 1, y + rowH - 2, gw - 2, 2, 0.12);                       // the board
  }
  // the ceiling and its light panels: the one thing in the room that is bright
  const ch = Math.max(8, Math.round(gh * 0.09));
  K(gx, gy, gw, ch, 0.34);
  const pw = Math.max(6, Math.round(gw * 0.26));
  for (const fx of [0.24, 0.76]) K(gx + Math.round(gw * fx - pw / 2), gy + 3, pw, ch - 5, 1);
  m.fillStyle = grad(m, gy + ch, gy + ch + 26, ['rgba(255,255,255,0.20)', 'rgba(255,255,255,0)']);
  m.fillRect(X + gx, Y + gy + ch, gw, 26);                          // their light on the wall under them
  K(gx, gy + gh - Math.round(gh * 0.08), gw, Math.round(gh * 0.08), 0.15);   // the floor
}

// Curtain wall. The near shell builds this grammar from flat boxes (pieces.js:
// spandrel, band, dark frame, pane), so the paint copies its proportions.
function officeCell(c, F, v, bands) {
  const { A, K } = c;
  A(0, 0, CW, CH, css(236, 238, 240));
  const y0 = Math.round(CH * (1 - F.band[1])), y1 = Math.round(CH * (1 - F.band[0]));
  A(0, y0, CW, y1 - y0, css(48, 52, 58));                                    // the dark frame band
  A(0, y1, CW, 3, css(255, 255, 255, 0.5)); A(0, y0 - 3, CW, 3, css(40, 42, 46, 0.5));
  for (let b = 0; b < BAYS; b++) {
    const r = winRect(F.band, F.frac, b);
    const tint = v === 0 ? [0, 0, 0] : [-14, 6, -8];
    c.g.fillStyle = c.grad(c.g, r.wy, r.wy + r.wh, [
      css(134 + tint[0], 160 + tint[1], 184 + tint[2]), css(82 + tint[0], 100 + tint[1], 120 + tint[2]),
      css(44, 54, 66)]);
    c.g.fillRect(c.X + r.wx, c.Y + r.wy + 2, r.ww, r.wh - 4);
    c.m.fillStyle = c.grad(c.m, r.wy, r.wy + r.wh, [grey(1), grey(0.9), grey(0.75)]);
    c.m.fillRect(c.X + r.wx, c.Y + r.wy + 2, r.ww, r.wh - 4);
    // a floor of desks: the ceiling grid shows through the top of the glass
    for (let x = r.wx + 4; x < r.wx + r.ww - 4; x += 10) A(x, r.wy + 8, 6, 2, css(230, 236, 240, 0.35));
    if (bands) { A(r.wx + r.ww / 2 - 1, r.wy + 2, 1, r.wh - 4, css(48, 52, 58, 0.8)); K(r.wx + r.ww / 2 - 1, r.wy + 2, 1, r.wh - 4, 0.2); }
    if ((c.R(660 + b) * 3 | 0) === 0) {              // blinds down on a few
      const bh = r.wh * (0.3 + c.R(670 + b) * 0.4) | 0;
      A(r.wx, r.wy + 2, r.ww, bh, css(206, 210, 212, 0.75)); K(r.wx, r.wy + 2, r.ww, bh, 0.5);
    }
    c.g.fillStyle = c.grad(c.g, r.wy, r.wy + 12, [css(10, 12, 14, 0.55), css(10, 12, 14, 0)]);
    c.g.fillRect(c.X + r.wx, c.Y + r.wy + 2, r.ww, 12);
  }
}

// ---- row 0: the trims (the roofs live in js/roofatlas.js) ------------------
function trimCell(g, X, Y) {
  const H = CH / 4, R = (n) => rnd(977, n);
  const A = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(X + x, Y + y, w, h); };
  for (let k = 0; k < 4; k++) { A(0, k * H, CW, H, css(238, 236, 229)); speckle(g, X, Y + k * H, CW, H, R, 100 + k * 900, 120, 150, 0.08); }
  // 0 coping: a concrete cap on a plain parapet
  A(0, 0, CW, 9, css(214, 213, 208)); A(0, 9, CW, 3, css(40, 38, 34, 0.5)); A(0, 12, CW, 10, css(40, 38, 34, 0.12));
  // 1 cornice: the moulded crown of a tenement
  A(0, H, CW, 26, css(248, 246, 240)); A(0, H + 9, CW, 4, css(110, 102, 90, 0.4)); A(0, H + 26, CW, 9, css(60, 54, 46, 0.42));
  for (let x = 4; x < CW; x += 10) A(x, H + 15, 5, 8, css(110, 104, 94, 0.4));
  A(0, H + 46, CW, 3, css(110, 102, 90, 0.3));
  // 2 metal: a folded sheet flashing
  A(0, 2 * H, CW, 12, css(120, 124, 128)); A(0, 2 * H, CW, 2, css(220, 224, 228)); A(0, 2 * H + 12, CW, 3, css(30, 30, 32, 0.5));
  // 3 eave: the soffit shadow under an overhanging roof
  g.fillStyle = (() => { const gr = g.createLinearGradient(0, Y + 3 * H, 0, Y + 4 * H); gr.addColorStop(0, 'rgba(30,26,22,0.62)'); gr.addColorStop(0.6, 'rgba(30,26,22,0.14)'); gr.addColorStop(1, 'rgba(30,26,22,0)'); return gr; })();
  g.fillRect(X, Y + 3 * H, CW, H);
}

// ---- the atlas -------------------------------------------------------------
let _atlas = null;
const tiny = (r, g, b, a) => {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
};
export function facadeAtlas() {
  if (_atlas) return _atlas;
  const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = ATLAS_PX; return cv; };
  const cv = mk(), mv = mk();
  const g = cv.getContext('2d', { willReadFrequently: true });
  const m = mv.getContext('2d', { willReadFrequently: true });
  // no 2D context under memory pressure: plain plaster beats a black city
  if (!g || !m) return (_atlas = tiny(237, 235, 228, 0));
  g.fillStyle = '#edebe4'; g.fillRect(0, 0, ATLAS_PX, ATLAS_PX);
  m.fillStyle = '#000'; m.fillRect(0, 0, ATLAS_PX, ATLAS_PX);
  // (row 0, columns 1 to 5 stay plain: a roof triangle's uv lands there only to
  // NAME its roofing, and the shader then samples the roof atlas instead)
  trimCell(g, TRIM_CELL[0] * CW, TRIM_CELL[1] * CH);
  for (const cell of CELL_LIST) {
    const X = cell.ci * CW, Y = cell.ri * CH;
    const c = cellCtx(g, m, X, Y, 1 + cell.ci + cell.ri * ATLAS_N);
    for (const ctx of [g, m]) { ctx.save(); ctx.beginPath(); ctx.rect(X, Y, CW, CH); ctx.clip(); }
    PAINT[cell.fam](c, cell.role, cell.v);
    g.restore(); m.restore();
  }
  // Fold the mask into alpha and flip the rows (a canvas is y-down, uv is y-up).
  // A canvas cannot carry this itself: 2D contexts store premultiplied colour,
  // so alpha 0 on a wall texel would throw the wall's colour away.
  let src = null, msk = null;
  try {
    src = g.getImageData(0, 0, ATLAS_PX, ATLAS_PX).data;
    msk = m.getImageData(0, 0, ATLAS_PX, ATLAS_PX).data;
  } catch { /* a tainted or lost canvas: fall through to plain plaster */ }
  if (!src || !msk || src.length < ATLAS_PX * ATLAS_PX * 4) return (_atlas = tiny(237, 235, 228, 0));
  const out = new Uint8Array(ATLAS_PX * ATLAS_PX * 4);
  const rowB = ATLAS_PX * 4;
  for (let y = 0; y < ATLAS_PX; y++) {
    const so = y * rowB, to = (ATLAS_PX - 1 - y) * rowB;
    for (let x = 0; x < rowB; x += 4) {
      out[to + x] = src[so + x]; out[to + x + 1] = src[so + x + 1];
      out[to + x + 2] = src[so + x + 2]; out[to + x + 3] = msk[so + x];
    }
  }
  const t = new THREE.DataTexture(out, ATLAS_PX, ATLAS_PX, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return (_atlas = t);
}

let _lit = null;
export function litTexture() {
  if (_lit) return _lit;
  const d = new Uint8Array(LIT_N * LIT_N * 4), o = [0, 0, 0, 0];
  for (let y = 0; y < LIT_N; y++) for (let x = 0; x < LIT_N; x++) {
    litTexel(x, y, o);
    d.set(o, (y * LIT_N + x) * 4);
  }
  const t = new THREE.DataTexture(d, LIT_N, LIT_N, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter;   // a texel is a room, never a blend of two
  t.needsUpdate = true;
  return (_lit = t);
}

// ---- the wall material -----------------------------------------------------
// Shared by the far tier (meshes.js) and by a near shell's pitched roof
// (destructible.js), so a roof keeps its tiles when its building turns to boxes.
let _mat = null;
export function buildFacadeMaterial() {
  if (_mat) return _mat;
  const atlas = facadeAtlas(), lit = litTexture(), roof = roofAtlas();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: atlas });
  const f = (n) => n.toFixed(6);
  const RN = ROOF_GRID * ROOF_GRID;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = { value: lit };
    sh.uniforms.uNight = NIGHT;
    sh.uniforms.uRoof = { value: roof.tex };
    sh.uniforms.uRoofAvg = { value: roof.avg };
    sh.uniforms.uRoofM = { value: roof.metres };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        #ifndef USE_UV1
        attribute vec2 uv1;       // three declares it itself when the geometry has one
        #endif
        varying vec2 vLitUv;
        varying vec3 vRoofP;
        varying vec3 vRoofN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLitUv = uv1;
        // WORLD space, not the raw attribute. A worker-built chunk arrives with
        // int16 positions normalised to [-1, 1] and its half extent and centre in
        // the mesh transform (geomcodec), a main-thread chunk with float metres
        // about the chunk centre, a near shell's roof in its own frame. Only the
        // model matrix makes all three agree on the size of a tile AND on where
        // a course starts, so a roof does not change when its chunk is re-meshed.
        // The dequant scale is uniform, so the normal needs no inverse transpose
        // (the fragment normalises it).
        vRoofP = (modelMatrix * vec4(position, 1.0)).xyz;
        // The normal picks the direction the courses run in, and world
        // coordinates give it a lever kilometres long: the codec's int8 normal
        // is up to 0.3 degrees off the float one, which three kilometres from
        // the origin slides the pattern by 15 m. So every encoding is snapped
        // to the codec's own grid (geomcodec: Math.round(n * 127)) and all of
        // them lay the courses from the very same direction.
        vRoofN = mat3(modelMatrix) * (floor(normal * 127.0 + 0.5) / 127.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uLit;
        uniform sampler2D uRoof;
        uniform vec2 uNight;
        uniform float uRoofAvg[${RN}];
        uniform float uRoofM[${RN}];
        varying vec2 vLitUv;
        varying vec3 vRoofP;
        varying vec3 vRoofN;
        // weather: value noise in world space (six metres, and a little at a
        // metre and a half), so a roof is not one flat sheet once its courses
        // are too small to see
        float roofHash(vec2 p) {
          p = fract(p * vec2(0.1031, 0.1030));
          p += dot(p, p.yx + 33.33);
          return fract((p.x + p.y) * p.y);
        }
        float roofWeather(vec2 p) {
          vec2 i = floor(p), w = fract(p);
          w = w * w * (3.0 - 2.0 * w);
          return mix(mix(roofHash(i), roofHash(i + vec2(1.0, 0.0)), w.x),
            mix(roofHash(i + vec2(0.0, 1.0)), roofHash(i + vec2(1.0, 1.0)), w.x), w.y);
        }`)
      .replace('#include <map_fragment>', `
        float winMask = 0.0;
        {
          float rcol = floor(vMapUv.x * ${f(ATLAS_N)});
          vec4 tx;
          if (vMapUv.y > ${f(1 - 1 / ATLAS_M)} && rcol >= 1.0 && rcol <= 5.0) {
            // A roof. Its uv only names the surface (typology.roofPin: the
            // column, and one of ${ROOF_ROWS} bands of v); the pattern comes out of
            // the roof atlas, laid out in metres from where the fragment is:
            // along the eave, and up the slope.
            float rsty = rcol - 1.0 + 5.0 * floor((1.0 - vMapUv.y) * ${f(ATLAS_M * ROOF_ROWS)});
            int ri = int(rsty);
            vec3 rn = normalize(vRoofN);
            float sl = sqrt(max(1.0 - rn.y * rn.y, 0.0));
            vec2 hd = sl > 0.17 ? vec2(-rn.z, rn.x) / sl : vec2(1.0, 0.0);
            float ra = dot(vRoofP.xz, hd);
            float rb = sl > 0.17 ? vRoofP.y / sl : dot(vRoofP.xz, vec2(-hd.y, hd.x));
            vec2 t = vec2(ra, rb) / uRoofM[ri];
            vec2 inner = vec2(${f((ROOF_CELL - 2 * ROOF_GUT) / ROOF_PX)});
            float rcy = floor(rsty / ${f(ROOF_GRID)});
            vec2 org = vec2(rsty - rcy * ${f(ROOF_GRID)}, ${f(ROOF_GRID - 1)} - rcy) / ${f(ROOF_GRID)}
              + vec2(${f(ROOF_GUT / ROOF_PX)});
            vec2 gx = dFdx(t) * inner, gy = dFdy(t) * inner;
            tx = textureGrad(uRoof, org + fract(t) * inner, gx, gy);
            float lod = 0.5 * log2(max(dot(gx, gx), dot(gy, gy)) * ${f(ROOF_PX * ROOF_PX)} + 1e-8);
            tx.rgb = mix(tx.rgb, vec3(uRoofAvg[ri]), smoothstep(2.0, 3.4, lod)) / uRoofAvg[ri];
            tx.rgb *= 0.925 + 0.11 * roofWeather(vRoofP.xz * 0.17 + vRoofP.y * 0.13)
              + 0.04 * roofWeather(vRoofP.zx * 0.61);
          } else {
            tx = texture2D(map, vMapUv);
            winMask = tx.a;
          }
          diffuseColor.rgb *= tx.rgb;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec4 lt = texture2D(uLit, vLitUv);
          totalEmissiveRadiance += lt.rgb * (winMask * step(lt.a, uNight.x) * uNight.y);
        }`);
  };
  mat.customProgramCacheKey = () => 'atc-facade-v4';
  return (_mat = mat);
}
