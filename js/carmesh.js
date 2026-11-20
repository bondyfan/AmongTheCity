// ---- carmesh.js: what a car is drawn with -------------------------------------
// vehicles.js makeCarMesh builds the scene-graph skeleton every caller relies
// on (group, body, the near and far groups, four wheels) and hands it here to
// be dressed. Two dresses:
//
// MERGED (the default). The near body is ONE mesh: paint, glass, trim, lamps,
// brake element, plates and badges in one geometry (carmerge.js) under one
// material (carbodymat.js). The distance dress is one mesh too, and it and the
// wheels are members of the instanced pools (carinstances.js), so a street of
// cars costs one draw per near car plus a handful for the whole fleet:
//
//              main pass                 shadow pass
//   near car   1 body (+ 0 brake)        1 body
//   wheels     1 per kind and side       the same pools
//   far car    1 per kind, whole city    the same pools
//
// against 11 + 1 and 4 a car before. The brake light and the lamps switching
// off on a parked car are material swaps (setCarState), not meshes.
//
// LEGACY (?carmerge=0 in the URL, for a cold A/B in one browser): exactly the
// eleven-part car of before, every part its own mesh and material.
//
// Nothing here runs headless differently: geometry and materials only, the
// canvas atlas comes in from vehicles.js.

import * as THREE from 'three';
import { bornCrew } from './carcrew.js';
import { mergedBodies, ATLAS } from './carmerge.js';
import { bodyMatFor, instancedBodyMat, paintInstance } from './carbodymat.js';
import { makeMember, bindMembers } from './carinstances.js';
import { paintMatFor, glassMat, detailMat, headMat, tailMat, brakeMat } from './carpaint.js';

let MERGE = true;
try {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('carmerge') === '0') MERGE = false;
} catch { /* headless */ }
export const carMergeOn = () => MERGE;
/** Headless tests only: build later cars legacy (false) or merged (true). */
export function setCarMerge(on) { MERGE = !!on; }

// shadow + matrix housekeeping for a part that never moves on its parent
function fixed(m, cast, receive) {
  m.castShadow = cast; m.receiveShadow = receive;
  m.matrixAutoUpdate = false;
  return m;
}

// the frustum margin of a pooled member: wide enough that a car just off the
// screen still lays the shadow that falls into it
const PAD = 4;

/**
 * Dress a car skeleton. o = { g, K, kind, hex, decal, near, far, wheels }:
 * g the vehicles.js geomFor() set, decal the per (kind, colour) atlas texture,
 * near / far the two LOD groups, wheels the four wheel meshes (already placed,
 * drawn with detailMat). Returns { hulls, brake, members, state }:
 *   hulls    what dentCar bends (paint first, as the crash code assumes)
 *   brake    an object with `visible`, the one vehicles.js and the trailer
 *            read and write (a real mesh in the legacy dress)
 *   members  for bindMembers (empty in the legacy dress)
 *   state    for setCarState (null in the legacy dress)
 */
export function dressCar(o) {
  const { g, K, kind, hex, decal, near, far, wheels } = o;
  return MERGE ? merged(g, K, kind, hex, decal, near, far, wheels) : legacy(g, K, kind, hex, decal, near, far);
}

function merged(g, K, kind, hex, decal, near, far, wheels) {
  const M = mergedBodies(g);
  const key = kind + '|' + hex;
  // who the glass shows at the wheel while the lamps burn (js/carcrew.js)
  const born = bornCrew();
  const mat = bodyMatFor(key, hex, decal, true, false, null, born);
  // the whole near body casts: the truck's cargo box lives in the trim, and a
  // plate's shadow costs nothing now that it is part of the same draw
  const body = fixed(new THREE.Mesh(M.near, mat), true, true);
  near.add(body);
  // the distance dress shares the car's material while it draws on its own
  // (instancing off); pooled, the fleet material reads paint from iPaint
  const farMesh = fixed(new THREE.Mesh(M.far, mat), true, true);
  far.add(farMesh);
  const paint = paintInstance(hex, true, new Float32Array(4));
  const members = [makeMember(farMesh,
    { key: 'far|' + kind, geo: M.far, mat: instancedBodyMat(), cast: true, paint: true },
    K.len * 0.6 + PAD, paint)];
  for (let i = 0; i < wheels.length; i++) {
    const side = i & 1;
    members.push(makeMember(wheels[i],
      { key: 'wheel|' + kind + '|' + side, geo: g.wheel[side], mat: detailMat, cast: true },
      K.wheelR + PAD));
  }
  const state = { body, far: farMesh, key, hex, decal, paint, lit: true, brake: false, born, tintShown: born };
  return { hulls: [body], brake: { visible: false }, members, state };
}

// ---- the eleven-part car of before ------------------------------------------
// The decals come from the same atlas through a window each (offset/repeat on
// a clone, which shares the canvas and its upload).
const _legacyDecal = new Map();
function legacyDecalMat(tex, which, brand) {
  const k = tex.uuid + which;
  let m = _legacyDecal.get(k);
  if (m) return m;
  const t = tex.clone();
  const [v0, v1] = ATLAS[which];
  t.offset.set(0, v0); t.repeat.set(1, v1 - v0);
  t.needsUpdate = true;
  m = new THREE.MeshLambertMaterial({ map: t, transparent: which === 'badge' && !!brand,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  _legacyDecal.set(k, m);
  return m;
}

function legacy(g, K, kind, hex, decal, near, far) {
  const paint = paintMatFor(hex);
  const part = (parent, geo, mat, cast, receive = true) => {
    if (!geo) return null;
    const m = fixed(new THREE.Mesh(geo, mat), cast, receive);
    parent.add(m);
    return m;
  };
  const N = g.near, F = g.far;
  const pm = part(near, N.paint, paint, true), gm = part(near, N.glass, glassMat, false);
  const dm = part(near, N.detail, detailMat, !!K.cargo);
  const hm = part(near, N.head, headMat, false, false), tm = part(near, N.tail, tailMat, false, false);
  const bm = part(near, N.brake, brakeMat, false, false);
  if (bm) bm.visible = false;
  if (g.plates) part(near, g.plates, legacyDecalMat(decal, 'plate', K.brand), false, false);
  if (g.badges) part(near, g.badges, legacyDecalMat(decal, 'badge', K.brand), false, false);
  part(far, F.paint, paint, true);
  part(far, F.detail, detailMat, true);
  part(far, F.head, headMat, false, false);
  part(far, F.tail, tailMat, false, false);
  return { hulls: [pm, gm, dm, hm, tm, bm].filter(Boolean), brake: bm, members: [], state: null };
}

/** Wire a dressed car's pool members to its group (no-op for the legacy dress). */
export function bindCar(group, dress) {
  if (dress.members.length) bindMembers(group, dress.members);
}

/**
 * Lamps on or off (a car somebody is driving, or one parked) and the brake
 * light. A material swap on the near body and the solo distance dress, and the
 * pooled distance dress's iPaint. Cheap to call every frame: it returns at once
 * when nothing changed.
 */
export function setCarState(group, lit, brake) {
  const s = group?.userData?.carState;
  if (!s) return;
  lit = !!lit; brake = !!brake && lit;
  // s.door: the region an open door has cut out of this car (js/cardoor.js)
  // s.tint: who the glass shows at the wheel (js/cardoor.js setDriver)
  const door = s.door ?? null, tint = s.tint ?? s.born ?? null;
  if (s.lit === lit && s.brake === brake && s.doorShown === door && s.tintShown === tint) return;
  const mat = bodyMatFor(s.key, s.hex, s.decal, lit, brake, door, tint);
  s.body.material = mat;
  s.doorShown = door; s.tintShown = tint;
  if (s.leaf) s.leaf.material = bodyMatFor(s.key, s.hex, s.decal, lit, false, s.leafDoor);
  if (s.lit !== lit) {
    // the distance dress has no brake element; only the lamps reach it
    s.far.material = bodyMatFor(s.key, s.hex, s.decal, lit, false, null, s.born ?? null);
    paintInstance(s.hex, lit, s.paint);
  }
  s.lit = lit; s.brake = brake;
}
