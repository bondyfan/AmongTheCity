// ---- semitrailer.js: the articulated lorry's trailer, and every car's indicators ----
// Round 8 (the D11). A third of the motorway is heavy goods vehicles, and on a
// Czech motorway that means tractor units with 13.6 m curtain-side trailers,
// not the 7.6 m box truck the town has. vehicles.js builds the TRACTOR (kind
// 'semi', the box truck's cab on a bare chassis, js/cardetail.js DRESS.semi);
// this module hangs the trailer on its fifth wheel and poses it every frame
// along the path the tractor has driven, so it follows a curve instead of
// sweeping across the next lane like a rigid 16 m plank.
//
// The trailer is one kinematic link: the kingpin rides the tractor, the
// trailer's axle group trails it, and its heading relaxes towards the
// tractor's at v / L per second (the bicycle model of a trailer: dpsi/dt =
// v/L sin(theta - psi)). Purely visual and local: traffic.js drives the
// tractor's pose, nothing reads the trailer's angle back.
//
// The indicators live here too: every AI car (traffic.js sets car.blink to
// -1 left, +1 right, 0 off) flashes amber at its four corners, the phase
// taken from the SHARED clock so two co-op screens blink together, and the
// lamp meshes only exist on a car that has blinked at least once.

import * as THREE from 'three';
import { Soup } from './carbody.js';
import { detailMat, tailMat, brakeMat } from './carpaint.js';
import { worldT } from './worldclock.js';

export const SEMI_LEN = 16.5;     // m, tractor + trailer overall (what physics and the follow model see)
export const SEMI_WID = 2.55;     // m, the trailer's width (the widest part)
const TRACTOR_LEN = 6.2;          // vehicles.js KIND.semi.len
const TR_OFF = -(SEMI_LEN - TRACTOR_LEN) / 2;   // tractor centre in the car's frame (nose at -SEMI_LEN/2)
const KINGPIN = TR_OFF + 1.4;     // fifth wheel, car frame (KIND.semi.axle - 0.45)
const T_FRONT = -1.2, T_LEN = 13.6, T_W = 2.55, T_FLOOR = 1.22, T_TOP = 4.0;
const AXLES = [8.75, 10.1, 11.45];  // trailer frame, from the kingpin
const AXLE_C = 10.1;              // m kingpin to the axle group's centre: the link length
const WHEEL_R = 0.5;

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const F = {
  dark: { c: lin(0x0d0f12), r: 0.6, m: 0 },
  rubber: { c: lin(0x111214), r: 0.9, m: 0 },
  satin: { c: lin(0xaeb4bb), r: 0.34, m: 0.9 },
  hub: { c: lin(0x9a9fa6), r: 0.4, m: 0.8 },
  amber: { c: lin(0xc8690f), r: 0.25, m: 0 },
};
// curtain colours: fleet white mostly, the odd blue, red, grey, green
const SKINS = [0xe2e3df, 0xe2e3df, 0xd3d6d8, 0x2f5597, 0xa8291f, 0x9aa0a6, 0x3d6b45, 0xe2e3df];
const boxG = (w, h, l, x, y, z) => { const g = new THREE.BoxGeometry(w, h, l); g.translate(x, y, z); return g; };

let _amber = null;
const amberMat = () => (_amber ??= new THREE.MeshBasicMaterial({
  color: new THREE.Color(0xff8a00).multiplyScalar(3.2), toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
}));
let _marker = null;
const markerMat = () => (_marker ??= new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff7a10).multiplyScalar(1.4), toneMapped: false }));

const _tgeo = new Map();
function trailerGeo(skin) {
  let g = _tgeo.get(skin);
  if (g) return g;
  const D = new Soup(true), body = { c: lin(SKINS[skin]), r: 0.7, m: 0 };
  const zc = T_FRONT + T_LEN / 2, zr = T_FRONT + T_LEN;
  // the body: curtains, roof, front wall, rear doors
  D.add(boxG(T_W, T_TOP - T_FLOOR - 0.12, T_LEN, 0, (T_TOP + T_FLOOR - 0.12) / 2 + 0.06, zc), body);
  D.add(boxG(T_W + 0.03, 0.12, T_LEN + 0.03, 0, T_TOP - 0.06, zc), F.satin);          // roof rail
  D.add(boxG(T_W + 0.03, 0.14, T_LEN + 0.03, 0, T_FLOOR + 0.07, zc), F.dark);         // floor rail
  for (const z of [T_FRONT + 0.03, zr - 0.03]) for (const sg of [1, -1]) D.add(boxG(0.06, T_TOP - T_FLOOR, 0.06, sg * T_W / 2, (T_TOP + T_FLOOR) / 2, z), F.satin);
  D.add(boxG(0.02, T_TOP - T_FLOOR - 0.3, 0.02, 0, (T_TOP + T_FLOOR) / 2, zr + 0.01), F.dark);   // door split
  // chassis, landing legs, side guards, rear under-run, mudguards
  D.add(boxG(1.1, 0.30, T_LEN - 0.4, 0, T_FLOOR - 0.17, zc + 0.1), F.dark);
  for (const sg of [1, -1]) {
    D.add(boxG(0.10, T_FLOOR - 0.25, 0.10, sg * 0.95, (T_FLOOR - 0.25) / 2 + 0.2, 1.9), F.dark);
    D.add(boxG(0.30, 0.06, 0.30, sg * 0.95, 0.18, 1.9), F.dark);
    D.add(boxG(0.04, 0.10, 5.6, sg * (T_W / 2 - 0.04), 0.62, 5.0), F.dark);
    D.add(boxG(0.04, 0.10, 5.6, sg * (T_W / 2 - 0.04), 0.86, 5.0), F.dark);
    D.add(boxG(0.62, 0.05, AXLES[2] - AXLES[0] + 1.3, sg * (T_W / 2 - 0.31), WHEEL_R * 2 + 0.12, AXLE_C), F.dark);
    for (const z of AXLES) {
      const w = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.42, 14);
      w.rotateZ(Math.PI / 2); w.translate(sg * (T_W / 2 - 0.25), WHEEL_R, z);
      D.add(w, F.rubber);
      const h = new THREE.CylinderGeometry(0.24, 0.24, 0.44, 10);
      h.rotateZ(Math.PI / 2); h.translate(sg * (T_W / 2 - 0.25), WHEEL_R, z);
      D.add(h, F.hub);
    }
  }
  D.add(boxG(2.3, 0.12, 0.10, 0, 0.58, zr - 0.25), F.dark);
  D.add(boxG(2.4, 0.16, 0.06, 0, 0.95, zr + 0.01), F.dark);                      // lamp bar
  // rear lamps: tail (lit with the car's own night gate), brake beside
  const T = new Soup(); T.g = [];
  for (const sg of [1, -1]) T.add(boxG(0.46, 0.17, 0.03, sg * 0.88, 0.95, zr + 0.05), null, 1);
  for (const sg of [1, -1]) T.add(boxG(0.05, 0.05, 0.03, sg * (T_W / 2 - 0.05), T_TOP - 0.12, zr + 0.04), null, 1);   // top outline lamps
  const B = new Soup();
  for (const sg of [1, -1]) B.add(boxG(0.18, 0.15, 0.035, sg * 0.50, 0.95, zr + 0.055));
  // amber side markers along the floor rail
  const M = new Soup();
  for (let z = 0.6; z < T_LEN - 1; z += 2.4) for (const sg of [1, -1]) M.add(boxG(0.03, 0.06, 0.10, sg * (T_W / 2 + 0.02), T_FLOOR - 0.02, T_FRONT + z));
  g = { detail: D.build(), tail: T.build(), brake: B.build(), marker: M.build() };
  _tgeo.set(skin, g);
  return g;
}

/**
 * Hang a trailer on a freshly made 'semi' car (vehicles.js add): the car
 * becomes SEMI_LEN long and SEMI_WID wide, its tractor parts move to the
 * front of that length, and the trailer group is added at the kingpin.
 */
export function attachTrailer(car) {
  const m = car.mesh, ud = m.userData;
  ud.body.position.z = TR_OFF;
  for (const w of car.wheels) w.position.z += TR_OFF;
  // the skin follows the tractor's paint, so one lorry is always one lorry
  const skin = ((car.color ?? 0) >>> 0) % SKINS.length;
  const g = trailerGeo(skin);
  const grp = new THREE.Group();
  grp.position.set(0, 0, KINGPIN);
  const mk = (geo, mat, cast) => { const o = new THREE.Mesh(geo, mat); o.castShadow = cast; o.receiveShadow = true; o.matrixAutoUpdate = false; o.updateMatrix(); grp.add(o); return o; };
  mk(g.detail, detailMat, true);
  mk(g.tail, tailMat, false);
  mk(g.marker, markerMat(), false);
  const br = mk(g.brake, brakeMat, false);
  br.visible = false;
  m.add(grp);
  car.len = SEMI_LEN; car.wid = SEMI_WID;
  car._tr = { grp, br, psi: car.heading, init: false };
}

const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Pose the trailer for this frame (vehicles.js update, after the tractor's pose). */
export function updateTrailer(car, dt) {
  const t = car._tr;
  if (!t.init) { t.psi = car.heading; t.init = true; }
  let d = angWrap(car.heading - t.psi);
  // a teleport, a respawn, a spin: no trailer swings through 60 degrees
  if (d > 1.05 || d < -1.05) { t.psi = car.heading; d = 0; }
  const k = Math.abs(car.speed) * dt / AXLE_C;
  t.psi = angWrap(t.psi + Math.sin(d) * (k < 1 ? k : 1));
  t.grp.rotation.y = angWrap(t.psi - car.heading);
  const bl = car.mesh.userData.brake;
  const on = !!bl && bl.visible;
  if (t.br.visible !== on) t.br.visible = on;
}

// ---- indicators ------------------------------------------------------------
// One merged geometry per side and vehicle size (front and rear lamp), cached;
// for a semi the rear lamps are a second pair on the trailer.
const _bgeo = new Map();
function blinkGeo(len, wid, y, side, front, rear) {
  const key = `${len}|${wid}|${y}|${side}|${front}|${rear}`;
  let g = _bgeo.get(key);
  if (g) return g;
  const s = new Soup(), x = side * (wid / 2 - 0.13);
  if (front) s.add(boxG(0.20, 0.09, 0.05, x, y, -len / 2 - 0.01));
  if (rear) s.add(boxG(0.20, 0.09, 0.05, x, y, len / 2 + 0.01));
  _bgeo.set(key, g = s.build());
  return g;
}
const lampY = (car) => (car.len > 6 ? 0.95 : 0.72);
function makeBlink(car) {
  const m = car.mesh, out = { L: [], R: [] };
  const add = (parent, geo, side, z = 0) => {
    const o = new THREE.Mesh(geo, amberMat());
    o.position.z = z; o.visible = false; o.matrixAutoUpdate = false; o.updateMatrix();
    parent.add(o); (side < 0 ? out.L : out.R).push(o);
  };
  for (const side of [-1, 1]) {
    if (car._tr) {
      // tractor nose; trailer tail
      add(m, blinkGeo(SEMI_LEN, 2.5, 0.95, side, true, false), side);
      add(car._tr.grp, blinkGeo(T_LEN, T_W, 0.95, side, false, true), side, T_FRONT + T_LEN / 2);
    } else add(m, blinkGeo(car.len, car.wid, lampY(car), side, true, true), side);
  }
  return out;
}

/** Flash car.blink's side (vehicles.js update). Cheap when the car never blinks. */
export function updateBlink(car) {
  // (only while traffic drives it: a car the player or a police unit has
  // taken over mid lane change keeps the car.blink it had, and blinked on
  // for ever)
  const b = car.ai ? car.blink | 0 : 0;
  if (!b && !car._bl) return;
  const L = car._bl ??= makeBlink(car);
  // 1.5 Hz, from the shared clock: every screen's indicator is lit together
  const on = b !== 0 && (worldT() * 1.5) % 1 < 0.5;
  const l = on && b < 0, r = on && b > 0;
  if (L.L[0].visible !== l) for (const o of L.L) o.visible = l;
  if (L.R[0].visible !== r) for (const o of L.R) o.visible = r;
}
