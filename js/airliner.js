// ---- airliner.js: the generic narrowbody, as an object the world can place ----
// makeAirliner() builds the exterior once and returns the handle the flight and
// the stand code use: a group in the plane-local frame (ARCHITECTURE.md: origin on
// the ground between the main gear, nose at -z), and a few setters. The exterior
// is seven meshes (body skin with the flaps, dark glass and intakes, decals, gear,
// two fans, the L1 door) plus one Points object for every light: eight draw calls.
// The cabin is built only the first time it is shown, so a parked aircraft costs
// nothing inside.
//
// The owner positions and rotates `group`: position at the main gear contact,
// rotation.order 'YXZ', rotation.y = heading, rotation.x = pitch (nose up positive),
// rotation.z = roll. Nothing here touches the scene's lights: the lamps are glow
// sprites, because a new THREE.Light would recompile every material in the scene.

import * as THREE from 'three';
import { AIRLINER as A, FLAPS, ROW_Z } from './airliner-layout.js';
import { Bag, PAINT } from './airliner-geom.js';
import { fuselageGeometry, fuselagePaint, addGlass, tailCapGeometry, doorGeometry, DOOR_HINGE } from './airliner-body.js';
import { addAirframe, nacelleGeometry } from './airliner-wings.js';
import { addEngineDark, fanGeometry, fanPosition, addGear } from './airliner-engines.js';
import { decalGeometry, decalMaterial, makeAtlas, makeGlowTexture } from './airliner-decals.js';
import { buildCabin } from './airliner-cabin.js';

const DOOR_OPEN = 1.45; // rad: the L1 door swings about 83 degrees out
const GEAR_LIFT = 0.6; // m the gear slides up into the belly as it retracts
const FAN_MAX = 22; // rad/s at full N1; with 14 blades the spin stays forward at 60 fps
const LIGHT_N = 9; // lamps: nav red, nav green, tail white, beacon top, beacon belly,
// strobe left, strobe right, landing left, landing right

// Light positions, plane-local. The nav lamps sit at the wingtips, the tail lamp
// at the end of the cone, the beacons on the crown and the belly, the strobes just
// outside the nav lamps, the landing lights on the wing roots' leading edges.
const LIGHT_AT = [
  [-A.wingHalfSpan, 4.5, 6.0], [A.wingHalfSpan, 4.5, 6.0], [0, 5.0, 16.9],
  [0, A.fuselageTopY + 0.15, 1.0], [0, A.fuselageBottomY - 0.1, 1.0],
  [-A.wingHalfSpan, 4.5, 7.2], [A.wingHalfSpan, 4.5, 7.2],
  [-2.2, 2.45, -2.4], [2.2, 2.45, -2.4],
];

export function makeAirliner() {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';

  // ---- the paint: one merged buffer, vertex coloured -----------------------
  const body = new Bag();
  body.add(fuselageGeometry(), fuselagePaint);
  body.add(tailCapGeometry(), PAINT.white);
  const panels = addAirframe(body);
  body.add(nacelleGeometry(1), PAINT.white);
  body.add(nacelleGeometry(-1), PAINT.white);
  const bodyGeom = body.build();
  // the rest pose of the control surfaces' vertices, and the live array they move in
  const bodyPos = bodyGeom.attributes.position;
  const restPos = Float32Array.from(bodyPos.array);
  const paintMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const bodyMesh = new THREE.Mesh(bodyGeom, paintMat);
  group.add(bodyMesh);

  // ---- the dark things: glass, intakes, nozzles, fans -----------------------
  const dark = new Bag();
  addGlass(dark, ROW_Z);
  addEngineDark(dark, 1);
  addEngineDark(dark, -1);
  const trimMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  group.add(new THREE.Mesh(dark.build(), trimMat));

  // the fan, built once and shared by both engines; each engine has its own mesh
  const fanGeom = fanGeometry(new Bag()).build();
  const fans = [1, -1].map((side) => {
    const m = new THREE.Mesh(fanGeom, trimMat);
    const p = fanPosition(side);
    m.position.set(p.x, p.y, p.z);
    m.rotation.order = 'XYZ';
    group.add(m);
    return m;
  });

  // ---- decals: the registrations and the fin wave -----------------------------
  const atlas = makeAtlas();
  const decalMesh = new THREE.Mesh(decalGeometry(), decalMaterial(atlas));
  group.add(decalMesh);

  // ---- the gear -------------------------------------------------------------
  const gearBag = addGear(new Bag());
  const gear = new THREE.Mesh(gearBag.build(), paintMat);
  group.add(gear);

  // ---- the L1 door, hinged on its forward edge -------------------------------
  const doorBag = new Bag();
  doorBag.add(doorGeometry(), PAINT.white);
  const door = new THREE.Mesh(doorBag.build(), paintMat);
  door.position.set(DOOR_HINGE.x, DOOR_HINGE.y, DOOR_HINGE.z);
  group.add(door);

  // ---- the lamps: one Points object, its colours rewritten each frame --------
  const lampPos = new Float32Array(LIGHT_N * 3);
  LIGHT_AT.forEach(([x, y, z], i) => lampPos.set([x, y, z], i * 3));
  const lampCol = new Float32Array(LIGHT_N * 3);
  const lampGeom = new THREE.BufferGeometry();
  lampGeom.setAttribute('position', new THREE.BufferAttribute(lampPos, 3));
  const lampColAttr = new THREE.BufferAttribute(lampCol, 3);
  lampGeom.setAttribute('color', lampColAttr);
  const glow = makeGlowTexture();
  const lampMat = new THREE.PointsMaterial({
    size: 26, sizeAttenuation: false, map: glow, vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lamps = new THREE.Points(lampGeom, lampMat);
  lamps.frustumCulled = false;
  group.add(lamps);

  // ---- state -----------------------------------------------------------------
  let cabin = null;
  let cabinBrightness = 1;
  let flapK = -1; // the last flap setting written into the buffer (-1 forces a write)
  let t = 0; // this aircraft's own clock, for the lamps when none is given
  let gearK = 1;
  let doorK = 0; // the L1 door's setting, kept so a cabin built later swings to match
  const light = { nav: false, beacon: false, strobe: false, landing: false, logo: false, cabin: 1 };

  // Put the flaps and slats into the wing: each control surface turns on its hinge
  // by its share of the setting, and its vertices are rewritten from the rest pose.
  function writeFlaps(k) {
    const arr = bodyPos.array;
    for (const pn of panels) {
      const ang = pn.sign * (pn.kind === 'flap' ? FLAPS.trailing : FLAPS.slat) * k;
      const c = Math.cos(ang), s = Math.sin(ang), oc = 1 - c;
      const [px, py, pz] = pn.p0, [hx, hy, hz] = pn.h;
      for (let v = pn.start; v < pn.start + pn.count; v++) {
        const i = v * 3;
        // Rodrigues' rotation about the hinge line, applied to the rest position
        const rx = restPos[i] - px, ry = restPos[i + 1] - py, rz = restPos[i + 2] - pz;
        const d = hx * rx + hy * ry + hz * rz;
        const cx = hy * rz - hz * ry, cy = hz * rx - hx * rz, cz = hx * ry - hy * rx;
        arr[i] = px + rx * c + cx * s + hx * d * oc;
        arr[i + 1] = py + ry * c + cy * s + hy * d * oc;
        arr[i + 2] = pz + rz * c + cz * s + hz * d * oc;
      }
    }
    bodyPos.needsUpdate = true;
  }

  function writeLamps(now, L) {
    // beacon: a short red flash each second. strobe: a double white flash every
    // 1.2 s at the tips. nav: steady. landing: steady warm white at the roots.
    const bf = now % 1 < 0.1 ? 1 : 0;
    const sp = now % 1.2;
    const sf = (sp < 0.04 || (sp > 0.1 && sp < 0.14)) ? 1 : 0;
    const nav = L.nav ? 1 : 0.0;
    const set = (i, r, g, b) => {
      lampCol[i * 3] = r;
      lampCol[i * 3 + 1] = g;
      lampCol[i * 3 + 2] = b;
    };
    set(0, 1.0 * nav, 0.08 * nav, 0.06 * nav);
    set(1, 0.12 * nav, 1.0 * nav, 0.2 * nav);
    set(2, 0.8 * nav, 0.8 * nav, 0.8 * nav);
    const beacon = L.beacon ? bf : 0;
    set(3, 1.0 * beacon, 0.1 * beacon, 0.05 * beacon);
    set(4, 1.0 * beacon, 0.1 * beacon, 0.05 * beacon);
    const strobe = L.strobe ? sf : 0;
    set(5, strobe, strobe, strobe);
    set(6, strobe, strobe, strobe);
    const land = L.landing ? 0.9 : 0;
    set(7, land, land * 0.95, land * 0.8);
    set(8, land, land * 0.95, land * 0.8);
    lampColAttr.needsUpdate = true;
  }

  return {
    group,

    /** Spin the fans with engine speed n1 (0..1), and advance the lamps. */
    update(dt, state = {}) {
      t += dt;
      const n1 = Math.max(0, Math.min(1, state.n1 ?? 0));
      const w = FAN_MAX * n1 * dt;
      fans[0].rotation.z -= w;
      fans[1].rotation.z -= w;
      writeLamps(light.t ?? t, light);
    },

    /** The gear: 1 is down and locked, 0 is up and hidden in the belly. */
    setGear(k) {
      gearK = Math.max(0, Math.min(1, k));
      gear.visible = gearK > 0.02;
      gear.position.y = (1 - gearK) * GEAR_LIFT;
    },

    /** Flaps and slats: 0 retracted, 1 full. Only writes the buffer on a change. */
    setFlaps(k) {
      const kk = Math.max(0, Math.min(1, k));
      if (kk === flapK) return;
      flapK = kk;
      writeFlaps(kk);
    },

    /** The L1 door: 0 closed in the skin, 1 open, swung out and forward. */
    setDoor(k) {
      doorK = Math.max(0, Math.min(1, k));
      door.rotation.y = -doorK * DOOR_OPEN;
      if (cabin) cabin.setDoor(doorK);
    },

    /** Build the cabin the first time it is shown; then just show or hide it. */
    setCabin(visible) {
      if (visible && !cabin) {
        cabin = buildCabin();
        cabin.setBrightness(cabinBrightness);
        cabin.setDoor(doorK);
        group.add(cabin.group);
      }
      if (cabin) cabin.group.visible = !!visible;
    },

    /** Lamps and the cabin's own light: { nav, beacon, strobe, landing, logo, cabin, t }. */
    setLights(opts = {}) {
      Object.assign(light, opts);
      if (opts.cabin !== undefined) {
        cabinBrightness = opts.cabin;
        if (cabin) cabin.setBrightness(cabinBrightness);
      }
      decalMesh.material.emissive.setScalar(light.logo ? 0.35 : 0);
    },

    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      if (cabin) cabin.dispose();
      if (atlas) atlas.dispose();
      if (glow) glow.dispose();
      group.clear();
    },
  };
}
