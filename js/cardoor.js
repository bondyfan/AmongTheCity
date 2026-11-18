// ---- cardoor.js: a front door that opens ---------------------------------------
//
// A car is one mesh (js/carmerge.js) and has no doors, only shut lines drawn on
// it. Opening one is therefore not "rotate the door node". It is three things
// done to ONE car for the second or two the door is open:
//
//   the hole   the body's material is swapped for the same material with the
//              door's outline discarded (js/carglass.js doorIn). Through it
//              the real cabin shows (vehicles.js attachCabin), which is put in
//              for as long as the door is open.
//   the leaf   the body's own geometry drawn a second time, on a hinge at the
//              front shut line, with everything OUTSIDE the outline discarded.
//              So the door that swings out is exactly the door that was there:
//              the paint, the glass, the handle, the mirror, the dents.
//   the card   the inside face of the leaf, which the body never had.
//
// One extra draw (two with the card) for one car, and no program is compiled:
// the hole and the leaf are uniforms on the program every car already uses.
//
// The outline comes from the same numbers cardetail.js draws its shut lines
// with, read off the kind's shape (vehicles.js carShape), so the cut falls on
// the painted line. Cab-over kinds (truck, bus) have no greenhouse and no
// door here: setDoor() returns false for them and the caller falls back.

import * as THREE from 'three';
import { carShape, attachCabin, cabinTrimMat } from './vehicles.js';
import { bodyMatFor } from './carbodymat.js';
import { setCarState } from './carmesh.js';

/** How far a door swings, radians. */
export const DOOR_MAX = 1.13;

const _specs = new Map();

/**
 * The door of `seat` (0 driver: left, 1 passenger: right) on a kind, in the
 * car's frame (nose at -z, +x right), or null where there is none:
 *   side            -1 left, +1 right
 *   zF, zB          the two shut lines; the hinge is at zF
 *   yLo, yTop       rocker to cant rail
 *   hingeX          half width of the body at the hinge
 *   handle {x,y,z}  where a hand takes it
 *   stand {x,z}     where somebody stands to open it, clear of its swing
 *   hole, leaf      the two regions for js/carbodymat.js bodyMatFor
 */
export function doorSpec(kind, seat = 0) {
  const side = seat % 2 ? 1 : -1, key = kind + '|' + side;
  if (_specs.has(key)) return _specs.get(key);
  let spec = null;
  const sh = carShape(kind);
  const G = sh?.S.green, gk = sh?.K.green;
  if (G && gk) {
    const { S } = sh, gs = gk.sts, n = gs.length, van = !!gk.capEnd;
    const hR = (z) => G.roof(z) - S.yShoulder(z);
    // where the side glass begins: the same march cardetail.js greenhouse() does
    let zs0 = G.z0;
    for (let k = 1; k <= 40; k++) { zs0 = G.z0 + (G.hdrZ - G.z0) * k / 40; if (hR(zs0) >= (van ? 0.22 : 0.17)) break; }
    const zF = zs0 - (van ? 0.12 : 0.10);
    const zB = n > 4 ? (gs[2][0] + gs[3][0]) / 2 : gs[2][0] + 0.06;
    const zm = (zF + zB) / 2;
    let yLo = 0, yTop = Infinity;
    for (let i = 0; i <= 8; i++) yLo = Math.max(yLo, S.fLo(zF + (zB - zF) * i / 8) + 0.05);
    for (let i = 0; i <= 8; i++) {
      const z = Math.max(zs0 + 0.2, G.hdrZ) + (zB - Math.max(zs0 + 0.2, G.hdrZ)) * i / 8;
      yTop = Math.min(yTop, G.roof(z) - 0.05);
    }
    const yBelt = S.yShoulder(zF), wy0 = S.yShoulder(G.z0);
    const wk = (G.hdrZ - G.z0) / Math.max(0.05, G.roof(G.hdrZ) - wy0);
    const xMin = S.edgeAt(zm, 9)[0] - 0.035;
    const A = [zF, zB, yLo, yTop], B = [yBelt, G.z0 + 0.02, wy0, wk];
    const zH = zB - 0.20, yH = S.yShoulder(zH) - 0.085;
    const flank = S.halfAt(zm, yBelt - 0.2);
    spec = {
      kind, side, zF, zB, yLo, yTop, yBelt,
      hingeX: S.halfAt(zF, yBelt - 0.12),
      cardX: flank - 0.075,
      handle: { x: side * S.halfAt(zH, yH), y: yH, z: zH },
      stand: { x: side * (flank + 0.48), z: zB - 0.05 },
      hole: { id: 'h' + side, A, B, C: [side, xMin, 1, 0] },
      leaf: { id: 'l' + side, A, B, C: [side, xMin, 2, 0] },
    };
  }
  _specs.set(key, spec);
  return spec;
}

// ---- the card: the inside of the leaf -------------------------------------------
const _cards = new Map();
function cardGeo(spec) {
  const key = spec.kind + '|' + spec.side;
  let g = _cards.get(key);
  if (g) return g;
  const { side, zF, zB, yLo, yBelt, cardX } = spec;
  const parts = [], len = zB - zF - 0.09, zc = (zF + zB) / 2 + 0.005;
  const box = (w, h, l, x, y, z) => { const b = new THREE.BoxGeometry(w, h, l).toNonIndexed(); b.translate(x, y, z); parts.push(b); };
  box(0.05, yBelt - yLo - 0.045, len, side * cardX, (yLo + yBelt) / 2 + 0.012, zc);                 // the panel
  box(0.075, 0.05, len * 0.55, side * (cardX - 0.045), yBelt - 0.17, zc + 0.08);                    // armrest
  box(0.03, 0.03, 0.15, side * (cardX - 0.03), yBelt - 0.10, zc + 0.02);                            // pull handle
  box(0.02, 0.13, 0.19, side * (cardX - 0.028), yLo + 0.16, zF + 0.24);                             // speaker
  let nv = 0;
  for (const p of parts) nv += p.attributes.position.count;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o * 3); nor.set(p.attributes.normal.array, o * 3);
    o += p.attributes.position.count;
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  _cards.set(key, g);
  return g;
}

// ---- one car's open door ----------------------------------------------------------
function build(car, seat) {
  const group = car.mesh, st = group?.userData?.carState;
  if (!st?.body?.parent) return null;            // the legacy dress, or no mesh
  const spec = doorSpec(car.kind, seat);
  if (!spec) return null;
  const pivot = new THREE.Group(), hold = new THREE.Group();
  pivot.position.set(spec.side * spec.hingeX, 0, spec.zF);
  hold.position.set(-spec.side * spec.hingeX, 0, -spec.zF);
  pivot.add(hold);
  const leaf = new THREE.Mesh(st.body.geometry, bodyMatFor(st.key, st.hex, st.decal, st.lit, false, spec.leaf));
  leaf.castShadow = false; leaf.receiveShadow = true;
  leaf.renderOrder = st.body.renderOrder;
  const card = new THREE.Mesh(cardGeo(spec), cabinTrimMat);
  card.castShadow = card.receiveShadow = false;
  card.renderOrder = st.body.renderOrder;
  hold.add(leaf, card);
  st.body.parent.add(pivot);
  // the hole, and the leaf's own lamps-on / lamps-off twin (carmesh.js setCarState)
  st.door = spec.hole; st.leaf = leaf; st.leafDoor = spec.leaf;
  setCarState(group, st.lit, st.brake);
  // The cabin the hole looks into. Put in here so that it is there on the
  // very frame the hole appears, and taken out by whoever owns cabins (main.js
  // fpCabin, which keeps it for as long as a door is open or the driver's eyes
  // are in use).
  const cab = attachCabin(car);
  const mine = cab?.userData.doorCards?.[spec.side > 0 ? 1 : 0] ?? null;
  if (mine) mine.visible = false;
  return { seat, spec, pivot, leaf, cabCard: mine, k: 0 };
}

function drop(car) {
  const d = car._door, group = car.mesh, st = group?.userData?.carState;
  car._door = null;
  if (!d) return;
  d.pivot.parent?.remove(d.pivot);
  if (d.cabCard) d.cabCard.visible = true;
  if (st) {
    st.door = null; st.leaf = null; st.leafDoor = null;
    setCarState(group, st.lit, st.brake);
  }
}

/**
 * Open the door of `seat` by k (0 shut … 1 wide). The first call with k > 0
 * builds it, a call with k <= 0 takes it away again. Returns false when this
 * car has no door to open (cab-over kinds, a car without a mesh).
 */
export function setDoor(car, seat, k) {
  if (!car?.mesh) return false;
  let d = car._door;
  if (d && d.seat !== seat) { drop(car); d = null; }
  if (!(k > 0)) { if (d) drop(car); return !!doorSpec(car.kind, seat); }
  if (!d) {
    d = car._door = build(car, seat);
    if (!d) return false;
  }
  d.k = k > 1 ? 1 : k;
  d.pivot.rotation.y = d.spec.side * DOOR_MAX * d.k;
  return true;
}

// ---- who the glass shows at the wheel ----------------------------------------------
const _tints = new Map();
const NOBODY = { id: 'x', D: [0, 0, 0, 0] };
const _col = new THREE.Color();
/**
 * who: { jacket: hex } for somebody the player can name (themselves), null for
 * an empty seat whatever the lamps say, undefined to go back to the rule every
 * other car follows (a car with its lamps on has a driver).
 */
export function setDriver(car, who) {
  const group = car?.mesh, st = group?.userData?.carState;
  if (!st) return;
  let t = null;
  if (who === null) t = NOBODY;
  else if (who) {
    const hex = who.jacket ?? 0x22262c;
    t = _tints.get(hex);
    if (!t) { _col.set(hex); _tints.set(hex, t = { id: 'j' + hex.toString(16), D: [_col.r, _col.g, _col.b, 1] }); }
  }
  st.tint = t;
  setCarState(group, st.lit, st.brake);
}

/** How far this car's door stands open, 0..1. */
export const doorOpen = (car) => car?._door?.k ?? 0;

/** Shut and remove whatever door this car has open (a despawn, a wreck). */
export function shutDoors(car) { if (car?._door) drop(car); }
