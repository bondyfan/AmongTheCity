// ---- trolleypoles.js: two poles from the roof to the wire ----------------------
// A trolleybus is a bus until you look at its roof. This module is the two
// sprung poles: hinged on the turntables behind the traction container,
// reaching back and up, each with its shoe on one wire of the pair that hangs
// over the direction it is driving in. js/meshes.js trolleyInto draws that
// wire (5.5 m over the ground at each vertex of the road, straight between
// them, the pairs half-way out from the centreline on a wide street and over
// the middle of a narrow one), and wirePoint() below is the same arithmetic
// read back, so the shoe is ON the drawn wire and not near it.
//
// The head of a pole trails five metres behind its base, so it is found on
// the ROUTE the bus has driven (its schedule's steps), not on the edge the
// bus is on now: through a junction the body is already in the side street
// while the shoes are still coming round the corner on the old wire.
//
// Off the wire the poles come down and lie under the hooks at the tail: a
// street with no trolley_wire tag (the 32Tr has a battery for those), a bus
// somebody has stolen, a wire the poles could not reach, a stretch whose mast
// somebody has knocked down (js/trolleymasts.js deadAt).
//
// Pure pose arithmetic is kept apart from the meshes (poleAim, wirePoint) so
// it can be tested headless.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { LAYER_Y } from './config.js';
import { bridgeDeckHeight } from './geo.js';
import { TRANSIT_BODY } from './transitbody.js';

export const TW_H = 5.5, TW_GAP = 0.6;      // js/meshes.js: wire height, the two wires of a pair
const YAW_MAX = 0.82;         // rad a pole swings off the axis of the bus (about 4.5 m at the shoe)
const PITCH_MIN = 0.1, PITCH_MAX = 1.0;
const RAISE = 1.1, LOWER = 2.2;             // 1/s: up to the wire, and down off it

// cumulative length of a road's own polyline, the one the wire was drawn along
const _cum = new WeakMap();
function cumOf(road) {
  let c = _cum.get(road);
  if (!c) {
    const p = road.p;
    c = new Float32Array(p.length);
    for (let i = 1; i < p.length; i++) c[i] = c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    _cum.set(road, c);
  }
  return c;
}

/**
 * Where the wire is. `road` is a trolley way, `D` metres along it from its
 * first point, `dir` +1 when travelling the way it is stored and -1 against
 * it, `side` -1 for the left wire of the pair and +1 for the right (as the
 * driver sees them). Writes out = { x, y, z } and returns it, or null when
 * the road carries no wire.
 */
export function wirePoint(road, D, dir, side, terrain, out) {
  if (!road?.tw || !road.p || road.p.length < 2 || !terrain) return null;
  const p = road.p, cum = cumOf(road), n = p.length;
  let i = 0;
  while (i < n - 2 && D > cum[i + 1]) i++;
  const L = (cum[i + 1] - cum[i]) || 1e-6;
  let t = (D - cum[i]) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
  const px = -(bz - az) / L, pz = (bx - ax) / L;         // the right of the STORED direction
  const half = (road.w ?? 7) / 2;
  // the pair of this direction, then the wire of the pair
  const c = dir * ((half > 4.5 ? half * 0.5 : 0) + side * TW_GAP / 2);
  let y0, y1;
  if (road.br) {
    y0 = bridgeDeckHeight(road, cum[i], terrain) + LAYER_Y.road;
    y1 = bridgeDeckHeight(road, cum[i + 1], terrain) + LAYER_Y.road;
  } else {
    y0 = terrain.heightAt(ax + px * c, az + pz * c);
    y1 = terrain.heightAt(bx + px * c, bz + pz * c);
  }
  out.x = ax + (bx - ax) * t + px * c;
  out.z = az + (bz - az) * t + pz * c;
  out.y = y0 + (y1 - y0) * t + TW_H;
  return out;
}

/**
 * Aim a pole. (lx, ly, lz) is the wire point in the frame of the car, (bx,
 * by, bz) the hinge. Writes out = { yaw, pitch, len, ok }: the swing off the
 * axis, the lift, the distance hinge to wire, and whether a pole can do that.
 */
export function poleAim(lx, ly, lz, bx, by, bz, out) {
  const vx = lx - bx, vy = ly - by, vz = lz - bz;
  const h = Math.hypot(vx, vz);
  out.yaw = Math.atan2(vx, vz);
  out.pitch = Math.atan2(vy, h);
  out.len = Math.hypot(h, vy);
  out.ok = vz > 1 && Math.abs(out.yaw) < YAW_MAX && out.pitch > PITCH_MIN && out.pitch < PITCH_MAX;
  return out;
}

let _geo = null, _mat = null;
function poleGeo(L) {
  if (_geo) return _geo;
  // a tapered tube along +z from the hinge, the spring box at its foot and
  // the shoe at its tip
  const rod = new THREE.CylinderGeometry(0.02, 0.034, L, 6);
  rod.rotateX(Math.PI / 2);
  rod.translate(0, 0, L / 2);
  const spring = new THREE.BoxGeometry(0.11, 0.1, 0.62);
  spring.translate(0, -0.02, 0.34);
  const shoe = new THREE.BoxGeometry(0.05, 0.09, 0.2);
  shoe.translate(0, 0.02, L - 0.06);
  _geo = mergeGeometries([rod, spring, shoe].map((g) => { const n = g.toNonIndexed(); n.deleteAttribute('uv'); return n; }), false);
  return _geo;
}

const _w = { x: 0, y: 0, z: 0 }, _aim = { yaw: 0, pitch: 0, len: 0, ok: false };

export class TrolleyPoles {
  /**
   * `terrain` has heightAt(x, z): the ground the wire was hung over. `deadAt`
   * (road, D) says a stretch of wire is dead (its mast is down), or is null.
   */
  constructor(terrain, deadAt = null) { this.terrain = terrain; this.deadAt = deadAt; }

  /** Give a trolleybus its poles. `body` is the group that leans with the suspension. */
  attach(body, kind, surface) {
    const P = TRANSIT_BODY[kind]?.poles;
    if (!P) return null;
    _mat ??= new THREE.MeshStandardMaterial({ color: 0x26282b, roughness: 0.55, metalness: 0.6 });
    // lying under the hooks: the tip a little above the roof at the tail
    const rest = Math.atan2(P.restY - P.y, surface.z1 - 0.55 - P.z);
    const piv = [];
    for (const sg of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(sg * P.gap / 2, P.y, P.z);
      g.rotation.order = 'YXZ';
      g.rotation.x = -rest;
      const m = new THREE.Mesh(poleGeo(P.len), _mat);
      m.matrixAutoUpdate = false;
      m.renderOrder = 1;             // with the car, after the street-light quads (js/vehicles.js)
      g.add(m);
      body.add(g);
      piv.push(g);
    }
    return { P, piv, rest, up: 0, reach: [5.5, 5.5], yaw: [0, 0], pitch: [rest, rest], len: [P.len, P.len], on: false };
  }

  /**
   * Once a frame for a trolleybus with a mesh. `p` is its traffic schedule
   * (car.ai) or null when nobody is driving it to a timetable.
   */
  update(rig, car, p, dt) {
    const P = rig.P;
    let on = false;
    if (p && p.route && p.route.length && !(car._rammedT > 0)) {
      on = true;
      const h = car.heading, ch = Math.cos(h), sh = Math.sin(h);
      const cy = car.mesh.position.y;
      for (let i = 0; i < 2 && on; i++) {
        const side = i ? 1 : -1;
        // the route step the shoe is over
        const arc = p.sR - P.z - rig.reach[i];
        let k = p.ri ?? 0;
        if (k >= p.route.length) k = p.route.length - 1;
        while (k > 0 && arc < p.route[k].base) k--;
        const st = p.route[k], e = st.e;
        let s = arc - st.base;
        s = s < 0 ? 0 : s > e.len ? e.len : s;
        const D = e.off0 + e.offSign * s;
        if (!wirePoint(e.road, D, e.offSign, side, this.terrain, _w) || this.deadAt?.(e.road, D)) { on = false; break; }
        const rx = _w.x - car.x, rz = _w.z - car.z;
        poleAim(rx * ch - rz * sh, _w.y - cy, rx * sh + rz * ch, side * P.gap / 2, P.y, P.z, _aim);
        if (!_aim.ok) { on = false; break; }
        rig.yaw[i] = _aim.yaw; rig.pitch[i] = _aim.pitch; rig.len[i] = _aim.len;
        // the shoe trails where a pole of this length reaches: move the point
        // asked for next frame until hinge to wire IS the length of the pole
        const flat = P.len * P.len - (_aim.len * Math.sin(_aim.pitch)) ** 2;
        const want = flat > 1 ? Math.sqrt(flat) : 1;
        rig.reach[i] += (want - _aim.len * Math.cos(_aim.pitch)) * 0.6;
        if (rig.reach[i] < 2) rig.reach[i] = 2; else if (rig.reach[i] > P.len) rig.reach[i] = P.len;
      }
    }
    rig.on = on;
    const tgt = on ? 1 : 0;
    if (rig.up !== tgt) {
      rig.up += (on ? RAISE : -LOWER) * dt;
      if (rig.up < 0) rig.up = 0; else if (rig.up > 1) rig.up = 1;
    } else if (!on) return;                       // down and staying down: nothing to write
    const u = rig.up * rig.up * (3 - 2 * rig.up);
    for (let i = 0; i < 2; i++) {
      const g = rig.piv[i];
      g.rotation.y = rig.yaw[i] * u;
      g.rotation.x = -(rig.rest + (rig.pitch[i] - rig.rest) * u);
      g.scale.z = 1 + (rig.len[i] / P.len - 1) * u;
    }
  }
}
