// ---- the HUD disc's chrome: everything drawn over the map ------------------------
// Split out of js/minimap.js. Every function takes the disc's transform
//
//   T = { cx, cy, k, c, s, ox, oz, rot }
//   screen = (cx, cy) + k · R(rot) · (world − (ox, oz))
//
// so a world point lands where the turned map put it. North is no longer up:
// the disc turns with the camera (the way a car's satnav and every open-world
// radar does), so the flag, a friend and the job marks are rotated with it,
// and the N badge rides the rim to wherever north is.

import { drawMark, drawRimMark } from './mapmarks.js';

const TAU = Math.PI * 2;
// Waypoint yellow: HUD chrome that must never blend into the map, and the same
// flag colour the world map paints.
export const WP_COLOR = '#ffd21a';
// A co-op player with no colour of their own (peers are normally painted in
// their jacket colour, js/identity.js).
const PEER_FALLBACK = '#7fd8ff';
// A peer's colour may arrive as 0xrrggbb or as a css string. Anything else
// falls back: an unparsable fillStyle silently keeps the PREVIOUS fill.
const SAFE_CSS_COLOR = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i;
export function peerCss(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && SAFE_CSS_COLOR.test(c.trim())) return c.trim();
  return PEER_FALLBACK;
}

/** World offset (dx, dz) → screen offset from the disc centre, into `o`. */
export function toDisc(T, dx, dz, o) {
  o.x = (dx * T.c - dz * T.s) * T.k;
  o.y = (dx * T.s + dz * T.c) * T.k;
  return o;
}
const _o = { x: 0, y: 0 };

function clipDisc(g, T, R) {
  g.beginPath();
  g.arc(T.cx, T.cy, R, 0, TAU);
  g.clip();
}

// a chevron on the ring along screen offset (x, y), notched tail
function rimChevron(g, T, x, y, rr, s, fill, stroke) {
  const len = Math.hypot(x, y) || 1;
  g.save();
  g.translate(T.cx + x / len * rr, T.cy + y / len * rr);
  g.rotate(Math.atan2(y, x));
  g.beginPath();
  g.moveTo(s, 0);
  g.lineTo(-s * 0.55, s * 0.72);
  g.lineTo(-s * 0.18, 0);
  g.lineTo(-s * 0.55, -s * 0.72);
  g.closePath();
  g.fillStyle = fill;
  g.strokeStyle = stroke;
  g.fill();
  g.stroke();
  g.restore();
}

/** AI traffic: small pale dots, gated to the disc. */
export function drawCars(g, T, R, cars, px, pz, size) {
  g.fillStyle = 'rgba(214, 220, 230, 0.9)';
  const lim = (R - size) * (R - size), h = size / 2;
  for (const c of cars) {
    toDisc(T, c.x - px, c.z - pz, _o);
    if (_o.x * _o.x + _o.y * _o.y > lim) continue;
    g.fillRect(T.cx + _o.x - h, T.cy + _o.y - h, size, size);
  }
}

/** Gameplay marks (js/mapmarks.js): on their spot inside, `rim` ones as
 *  chevrons on the ring outside. */
export function drawMarks(g, T, R, marks, px, pz, ms, a) {
  if (!marks) return;
  const lim = R - ms * 1.4;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    toDisc(T, m.x - px, m.z - pz, _o);
    if (_o.x * _o.x + _o.y * _o.y < lim * lim) drawMark(g, m.kind, T.cx + _o.x, T.cy + _o.y, ms);
  }
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (!m.rim) continue;
    toDisc(T, m.x - px, m.z - pz, _o);
    if (_o.x * _o.x + _o.y * _o.y < lim * lim) continue;
    g.save();
    clipDisc(g, T, R);
    g.translate(T.cx, T.cy);
    drawRimMark(g, m.kind, _o.x, _o.y, R, a);
    g.restore();
  }
}

/** Co-op players: a dot in their jacket colour with the name under it inside
 *  the disc, a chevron on the rim on their bearing outside it. */
export function drawPeers(g, T, R, peers, px, pz, a, font) {
  const rim = R - a * 0.95;
  g.save();
  clipDisc(g, T, R);
  g.lineJoin = 'round';
  for (const p of peers) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    toDisc(T, p.x - px, p.z - pz, _o);
    const d = Math.hypot(_o.x, _o.y);
    const col = peerCss(p.color);
    g.lineWidth = 1.4;
    if (d < rim) {
      const r = Math.max(2.6, a * 0.42);
      g.beginPath();
      g.arc(T.cx + _o.x, T.cy + _o.y, r, 0, TAU);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(10,14,20,0.9)';
      g.fill();
      g.stroke();
      const name = typeof p.name === 'string' ? p.name.slice(0, 14) : '';
      if (name) {
        g.font = font;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(8,11,16,0.9)';
        g.strokeText(name, T.cx + _o.x, T.cy + _o.y + r + 1.5);
        g.fillStyle = '#f2f5fb';
        g.fillText(name, T.cx + _o.x, T.cy + _o.y + r + 1.5);
      }
    } else {
      rimChevron(g, T, _o.x, _o.y, rim, a * 0.72, col, 'rgba(10,14,20,0.9)');
    }
  }
  g.restore();
}

/** The flag: a yellow diamond on its spot, or a chevron on the rim. */
export function drawWaypoint(g, T, R, wp, px, pz, a) {
  toDisc(T, wp.x - px, wp.z - pz, _o);
  const d = Math.hypot(_o.x, _o.y);
  g.save();
  clipDisc(g, T, R);
  g.lineWidth = 1.2;
  if (d < R - a * 0.9) {
    const s = a * 0.72, x = T.cx + _o.x, y = T.cy + _o.y;
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s * 0.72, y);
    g.lineTo(x, y + s);
    g.lineTo(x - s * 0.72, y);
    g.closePath();
    g.fillStyle = WP_COLOR;
    g.strokeStyle = 'rgba(38,30,4,0.9)';
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(x, y, Math.max(1, s * 0.26), 0, TAU);
    g.fillStyle = 'rgba(38,30,4,0.9)';
    g.fill();
  } else {
    rimChevron(g, T, _o.x, _o.y, R - a * 0.95, a * 0.8, WP_COLOR, 'rgba(38,30,4,0.9)');
  }
  g.restore();
}

/**
 * The player: a white navigation arrow with a dark edge on a soft shadow, and
 * a faint cone straight up, which is where the camera looks on a disc that
 * turns with it. `rel` is the body's heading relative to the camera (0 = the
 * arrow points up).
 */
export function drawPlayerArrow(g, T, a, rel, cone) {
  const x = T.cx, y = T.cy;
  if (cone) {
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, a * 5.5, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    g.closePath();
    g.fill();
  }
  g.save();
  g.translate(x, y);
  g.rotate(rel);
  g.beginPath();
  g.arc(0, a * 0.1, a * 1.05, 0, TAU);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fill();
  g.beginPath();
  g.moveTo(0, -a);
  g.lineTo(a * 0.72, a * 0.78);
  g.lineTo(0, a * 0.38);
  g.lineTo(-a * 0.72, a * 0.78);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = Math.max(1.5, a * 0.16);
  g.strokeStyle = 'rgba(9,22,44,0.95)';
  g.stroke();
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
}

/** The ring, a thin inner shade, and the N badge riding the rim to north.
 *  (The shade is one solid stroke along the rim, not a radial gradient over
 *  the whole disc: that was a full extra raster pass every frame.) */
export function drawRim(g, T, R, font, badge) {
  const sw = R * 0.07;
  g.beginPath();
  g.arc(T.cx, T.cy, R - sw / 2, 0, TAU);
  g.lineWidth = sw;
  g.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  g.stroke();
  g.beginPath();
  g.arc(T.cx, T.cy, R, 0, TAU);
  g.lineWidth = Math.max(1.5, R * 0.012);
  g.strokeStyle = 'rgba(210, 222, 240, 0.28)';
  g.stroke();
  // north on screen is world (0, −1) turned by the map
  const nx = T.s, ny = -T.c, rr = R - badge * 1.15;
  const bx = T.cx + nx * rr, by = T.cy + ny * rr;
  g.beginPath();
  g.arc(bx, by, badge, 0, TAU);
  g.fillStyle = 'rgba(12, 16, 23, 0.92)';
  g.fill();
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(210, 222, 240, 0.45)';
  g.stroke();
  g.fillStyle = '#ff5a4f';
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('N', bx, by + badge * 0.06);
}
