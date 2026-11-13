// ---- Map marks: the gameplay glyphs both maps draw ----
// The HUD minimap and the region map show the same things (job offers, your
// car, the pumps), and "the orange square" has to be the same orange square on
// both or a glance at one tells you nothing about the other. So the glyphs are
// drawn by one function, and each map only decides WHERE.
//
// A mark is { x, z, kind, rim? }:
//   kind  'courier' | 'taxi' | 'car' | 'fuel' | 'goal'
//   rim   true = when it is off the minimap window, pin a chevron to the rim
//         on its bearing (your own car wants this, forty job offers do not)
//
// Shapes differ as well as colours, so the marks survive a colour-blind
// reader and a 150 px phone minimap: square parcel, round fare, pentagon car,
// small drop for fuel, ring for the introduction's goal.

const TAU = Math.PI * 2;
const DARK = 'rgba(14,18,26,0.92)';

export const MARK_COLOR = {
  courier: '#ff9d5c',
  taxi: '#ffd21a',
  car: '#8fe3a0',
  fuel: '#7fb6ff',
  goal: '#cfe0ff',
};

/** Draw one mark centred on (sx, sy). `s` is its half-size in canvas pixels. */
export function drawMark(g, kind, sx, sy, s) {
  g.fillStyle = MARK_COLOR[kind] ?? '#ffffff';
  g.strokeStyle = DARK;
  // the pump's drop is the smallest shape here: a full-weight outline eats it
  g.lineWidth = Math.max(1, s * (kind === 'fuel' ? 0.18 : 0.3));
  g.beginPath();
  if (kind === 'courier') {
    g.rect(sx - s * 0.85, sy - s * 0.85, s * 1.7, s * 1.7);
  } else if (kind === 'taxi') {
    g.arc(sx, sy, s, 0, TAU);
  } else if (kind === 'car') {
    // a little house-shaped pentagon: "this one is home"
    g.moveTo(sx, sy - s * 1.15);
    g.lineTo(sx + s, sy - s * 0.2);
    g.lineTo(sx + s * 0.72, sy + s);
    g.lineTo(sx - s * 0.72, sy + s);
    g.lineTo(sx - s, sy - s * 0.2);
    g.closePath();
  } else if (kind === 'fuel') {
    g.moveTo(sx, sy - s * 1.1);
    g.quadraticCurveTo(sx + s * 1.1, sy + s * 0.2, sx, sy + s * 0.95);
    g.quadraticCurveTo(sx - s * 1.1, sy + s * 0.2, sx, sy - s * 1.1);
  } else {
    g.arc(sx, sy, s, 0, TAU);
  }
  g.fill();
  g.stroke();
  if (kind === 'taxi' || kind === 'goal') {          // the dark eye: a marker, not a dot
    g.beginPath();
    g.arc(sx, sy, s * 0.34, 0, TAU);
    g.fillStyle = DARK;
    g.fill();
  }
}

/** A chevron on the rim of a circle of radius R around (0,0) in the CURRENT
 *  transform, pointing along (dx, dz). The minimap's own waypoint trick. */
export function drawRimMark(g, kind, dx, dz, R, a) {
  const len = Math.hypot(dx, dz) || 1, rr = R - a * 0.95;
  g.save();
  g.translate(dx / len * rr, dz / len * rr);
  g.rotate(Math.atan2(dz, dx));
  const s = a * 0.72;
  g.beginPath();
  g.moveTo(s, 0);
  g.lineTo(-s * 0.55, s * 0.72);
  g.lineTo(-s * 0.18, 0);
  g.lineTo(-s * 0.55, -s * 0.72);
  g.closePath();
  g.fillStyle = MARK_COLOR[kind] ?? '#ffffff';
  g.strokeStyle = DARK;
  g.lineWidth = 1.2;
  g.fill();
  g.stroke();
  g.restore();
}
