import * as THREE from 'three';

// The villa's scanners (Frank, 21 Nov 2026: "kamery s červeným laserem, který
// bude letět ze strany na stranu a já musím přejít, když ten laser tam
// nebude"). A scanner is a small camera high on a wall whose red beam comes
// down to the floor at a point that swings from one side to the other and
// rests a moment at each end. What it catches is a body in its way: the dot
// on the floor, and the beam as far up as a man's waist.
//
// A spec is { cam: [x, y, z], a: [x, z], b: [x, z], period, phase } in the
// frame of `parent` (a Group); y is height above that frame's floor. This file
// is geometry and time only: who is caught, and what happens then, is asked of
// `hit(x, z)` with a position in the same frame.
const WAIST = 1.2, // the beam is a danger below this height
  DOT = 0.2, // radius of the lit patch on the floor
  BODY = 0.3; // how wide a man is to a beam

// Where the dot is at time t: a cosine swing with a rest at both ends.
export function swing(spec, t) {
  const T = spec.period,
    u = (((t + (spec.phase ?? 0)) % T) + T) % T / T, // 0..1 through one there-and-back
    rest = spec.rest ?? 0.14, // share of the period spent standing at each end
    go = 0.5 - rest;
  let k;
  if (u < rest) k = 0;
  else if (u < 0.5) k = 0.5 - 0.5 * Math.cos(((u - rest) / go) * Math.PI);
  else if (u < 0.5 + rest) k = 1;
  else k = 0.5 + 0.5 * Math.cos(((u - 0.5 - rest) / go) * Math.PI);
  return { x: spec.a[0] + (spec.b[0] - spec.a[0]) * k, z: spec.a[1] + (spec.b[1] - spec.a[1]) * k, k };
}
// Is a body standing at (x, z) in the scanner's way at time t?
export function caught(spec, t, x, z) {
  const d = swing(spec, t),
    [cx, cy, cz] = spec.cam;
  if (Math.hypot(x - d.x, z - d.z) < DOT + BODY) return true;
  // the beam between waist height and the floor, seen from above
  const low = Math.min(1, WAIST / cy),
    ax = d.x + (cx - d.x) * low,
    az = d.z + (cz - d.z) * low,
    ex = ax - d.x,
    ez = az - d.z,
    len2 = ex * ex + ez * ez,
    s = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - d.x) * ex + (z - d.z) * ez) / len2)) : 0;
  return Math.hypot(x - (d.x + ex * s), z - (d.z + ez * s)) < BODY;
}

export function scanners(parent, specs) {
  const red = new THREE.MeshBasicMaterial({ color: 0xff2014, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    glow = new THREE.MeshBasicMaterial({ color: 0xff3a22, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    shell = new THREE.MeshLambertMaterial({ color: 0xd9dcde }),
    dark = new THREE.MeshLambertMaterial({ color: 0x1b1d20 }),
    lens = new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false });
  const beamGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 6),
    haloGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 6),
    dotGeo = new THREE.CircleGeometry(DOT, 20),
    bodyGeo = new THREE.BoxGeometry(0.13, 0.11, 0.24),
    armGeo = new THREE.BoxGeometry(0.04, 0.04, 0.16),
    eyeGeo = new THREE.SphereGeometry(0.022, 8, 6);
  const up = new THREE.Vector3(0, 1, 0),
    dir = new THREE.Vector3(),
    away = new THREE.Vector3();
  const units = specs.map((spec) => {
    const [cx, cy, cz] = spec.cam;
    const head = new THREE.Group();
    head.position.set(cx, cy, cz);
    const body = new THREE.Mesh(bodyGeo, shell),
      eye = new THREE.Mesh(eyeGeo, lens);
    body.position.z = -0.08;
    eye.position.z = -0.21;
    head.add(body, eye);
    const arm = new THREE.Mesh(armGeo, dark);
    arm.position.set(cx, cy + 0.09, cz);
    const beam = new THREE.Mesh(beamGeo, red),
      halo = new THREE.Mesh(haloGeo, glow),
      dot = new THREE.Mesh(dotGeo, red),
      pool = new THREE.Mesh(dotGeo, glow);
    dot.rotation.x = pool.rotation.x = -Math.PI / 2;
    pool.scale.setScalar(2.1);
    for (const m of [beam, halo, dot, pool]) m.renderOrder = 4;
    parent.add(head, arm, beam, halo, dot, pool);
    return { spec, head, arm, beam, halo, dot, pool };
  });
  let now = 0;
  return {
    get time() {
      return now;
    },
    update(dt) {
      now += dt;
      for (const { spec, head, beam, halo, dot, pool } of units) {
        const d = swing(spec, now),
          [cx, cy, cz] = spec.cam,
          fy = spec.floor ?? 0;
        dir.set(d.x - cx, fy - cy, d.z - cz);
        const len = dir.length();
        dir.divideScalar(len);
        head.lookAt(parent.localToWorld(away.set(cx - dir.x, cy - dir.y, cz - dir.z))); // its lens is at −z
        for (const m of [beam, halo]) {
          m.position.set((cx + d.x) / 2, (cy + fy) / 2, (cz + d.z) / 2);
          m.quaternion.setFromUnitVectors(up, dir);
          m.scale.set(1, len, 1);
        }
        dot.position.set(d.x, fy + 0.012, d.z);
        pool.position.set(d.x, fy + 0.008, d.z);
        // the beam breathes a little, the way a cheap diode does
        red.opacity = 0.78 + 0.1 * Math.sin(now * 23);
      }
    },
    // which scanner (its index) has a body at (x, z) in its way right now, or −1
    hit(x, z) {
      for (let i = 0; i < specs.length; i++) if (caught(specs[i], now, x, z)) return i;
      return -1;
    },
    dispose() {
      for (const u of units) for (const m of [u.head, u.arm, u.beam, u.halo, u.dot, u.pool]) m.removeFromParent();
      for (const g of [beamGeo, haloGeo, dotGeo, bodyGeo, armGeo, eyeGeo]) g.dispose();
      for (const m of [red, glow, shell, dark, lens]) m.dispose();
    },
  };
}
