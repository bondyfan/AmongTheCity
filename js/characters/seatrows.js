// ---- seatrows.js: whose picture is in which row of the seated atlas ---------------
//
// A car is one mesh and its glass is opaque (js/carglass.js draws the cabin by
// following the view ray into the car). The people in the front seats are
// drawn the same way, as PICTURES of the modelled bodies: each person sitting
// in a car seat is photographed once from sixteen sides into one row of an
// atlas (js/characters/seated.js), and the glass shows the picture taken from
// nearest to where the eye is. So five hundred cars carry real people at the
// price of one texture read on the pixels that are glass.
//
// This file is the bookkeeping, and pure: no three, no renderer. A row is
// claimed by a KEY:
//   '@civ3', '@police', '@medic'   stock drivers of the traffic, never given up
//   'm08+m07:d'                    a body with a head, driving (hands at the wheel)
//   'm07+m07:p'                    the same as a passenger (hands in the lap)
// Whoever shows a person holds a four-vector the glass reads (x: the driver's
// row, y: the passenger's, -1 for nobody modelled) and binds a component of it
// to a key; this file keeps the number right when rows are drawn, lost or
// drawn again.

export const VIEWS = 16;          // pictures round a person
export const ROWS = 16;           // people the atlas holds at once
export const TILE_W = 96, TILE_H = 128;
export const FRAME_W = 0.72;      // metres a picture is wide: shoulders, and the arms out to the wheel from the side
export const FRAME_H = 0.96;      // from the cushion to over the head
export const AHEAD = 0.14;        // the pictures turn about a line this far ahead of the hips (knees and hands are ahead)
export const BACK = 0.12;         // the hips sit this far behind the middle of the cushion, against the squab
export const ELEV = 0.2;          // radians the pictures are taken from above: between a walker's eye and the chase camera
export const CIVS = 8;            // stock civilian drivers

/** The atlas itself, shared by every car body material (a uniform's { value }). */
export const seatAtlas = { value: null };

const TAU = Math.PI * 2;
const rows = new Array(ROWS).fill(null);
const stamp = new Float64Array(ROWS);
const binds = new Map();          // key -> [{ v, c }]
let baker = null, tick = 0;

export const isStock = (key) => typeof key === 'string' && key.charCodeAt(0) === 64;

/**
 * The key of somebody's picture: role 'd' drives, 'p' rides. Null for a body
 * that is not a modelled one (the bank did not load): the glass then draws the
 * plain figure it always drew.
 */
export function seatKey(cit, role = 'd') {
  const av = cit?.human ? cit.avatar : null;
  return av ? av.id + '+' + (cit.headAvatar?.id ?? av.id) + ':' + role : null;
}

/**
 * Which of the pictures shows a person to an eye in the direction (nx, nz)
 * from their seat, flat, in the car's frame (nose at -z). 0 is from straight
 * behind, VIEWS / 2 from straight ahead through the windscreen.
 */
export function viewIndex(nx, nz) {
  const i = Math.round((Math.atan2(nx, nz) / TAU) * VIEWS);
  return ((i % VIEWS) + VIEWS) % VIEWS;
}
export const viewAzimuth = (i) => (i * TAU) / VIEWS;

/** A picture's rectangle in the atlas, in pixels from the bottom left. */
export function tileRect(row, view, out = [0, 0, 0, 0]) {
  out[0] = view * TILE_W; out[1] = row * TILE_H; out[2] = TILE_W; out[3] = TILE_H;
  return out;
}

function tell(key, row) {
  const b = binds.get(key);
  if (b) for (const { v, c } of b) v.setComponent(c, row);
}

function claim(key) {
  let r = rows.indexOf(key);
  if (r >= 0) { stamp[r] = ++tick; return r; }
  if (!baker) return -1;
  r = rows.indexOf(null);
  if (r < 0) {
    // full: the picture nobody has asked for the longest goes, never a stock one
    let old = Infinity;
    for (let i = 0; i < ROWS; i++) if (!isStock(rows[i]) && stamp[i] < old) { old = stamp[i]; r = i; }
    if (r < 0) return -1;
    const gone = rows[r];
    rows[r] = null;
    tell(gone, -1);
  }
  rows[r] = key; stamp[r] = ++tick;
  let ok = false;
  try { ok = baker(r, key, false) !== false; } catch (e) { console.warn('[seated] ' + key + ' could not be drawn:', e); }
  if (!ok) { rows[r] = null; return -1; }
  return r;
}

/**
 * Component `c` of the vector `v` (anything with setComponent) follows the row
 * of `key` from now on. Returns the row, -1 while there is no picture.
 */
export function bindSeat(v, c, key) {
  if (!key) { v.setComponent(c, -1); return -1; }
  let b = binds.get(key);
  if (!b) binds.set(key, b = []);
  b.push({ v, c });
  const r = claim(key);
  v.setComponent(c, r);
  return r;
}

/** Somebody is being shown again: keep their row young, or draw it afresh if it was given up. */
export function touchSeat(key) {
  if (!key || !binds.has(key)) return -1;
  const had = rows.indexOf(key), r = claim(key);
  if (r !== had) tell(key, r);
  return r;
}

/**
 * fn(row, key, again) draws a person's pictures and returns false when it
 * cannot (nobody of that name). Setting it draws everybody already bound;
 * null forgets every picture.
 */
export function setBaker(fn) {
  baker = fn;
  if (!fn) { rows.fill(null); for (const k of binds.keys()) tell(k, -1); return; }
  for (const k of binds.keys()) tell(k, claim(k));
}

/** Take a person's pictures again in the row they hold (their sharp texture came in). */
export function redrawSeat(key) {
  const r = rows.indexOf(key);
  if (r >= 0 && baker) { try { baker(r, key, true); } catch (e) { console.warn('[seated] redraw of ' + key, e); } }
  return r;
}

export const rowOf = (key) => rows.indexOf(key);
export const seatStats = () => ({ rows: rows.slice(), bound: binds.size, drawn: rows.filter(Boolean).length });
/** Tests only. */
export function resetSeats() { rows.fill(null); stamp.fill(0); binds.clear(); baker = null; tick = 0; seatAtlas.value = null; }
