import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { props } from './story-props.js';
import { scanners } from './heist-lasers.js';

// Inside the villa (Frank, 21 Nov 2026: "tu vilu bych udělal průchozí... musí
// se tam nějak vloupat... tam bude klíč od toho auta někde, potom musí nějak
// vyjít ven, víc jako hra Hitman"). One floor, four rooms, a closed set far
// under the house like Vašek's kitchen, but this one is walked: its walls and
// furniture are in `walls` and `furniture`, its floor carries him, and it is
// looked into from above with the ceiling off (js/heist-villa.js camera).
//
//   z=5.8 +------------------------------------------+
//         | exit   D  corridor        s5        s4   |
//   z=4.0 +--------------------------------+   +-----+
//         | A hall   |  B  living room     | C study |
//         | (window) =      table  s1      =  s3 key |
//   z=0   +----------+--------------s2-----+---------+
//        x=0        3.4                   8.6       12
// Frame: x east, z north, y up from the floor. Pure numbers first (the tests
// read them), the set after.
export const SIZE = { x: 12, z: 5.8, h: 2.6 };
const T = 0.16;
// [x0, z0, x1, z1]
export const walls = [
  [-T, -T, SIZE.x + T, 0], [-T, SIZE.z, SIZE.x + T, SIZE.z + T], [-T, 0, 0, SIZE.z], [SIZE.x, 0, SIZE.x + T, SIZE.z],
  [3.32, 0, 3.48, 1.3], [3.32, 2.3, 3.48, 4.0], // hall | living room, door at z 1.3..2.3
  [8.52, 0, 8.68, 2.5], [8.52, 3.5, 8.68, 4.0], // living room | study, door at z 2.5..3.5
  [0, 3.92, 10.0, 4.08], [11.0, 3.92, SIZE.x, 4.08], // rooms | corridor, door at x 10..11
];
export const furniture = [
  [0.5, 0.05, 1.9, 0.6], // the chest under the window
  [0.05, 2.7, 0.45, 3.8], // shoe cabinet
  [4.2, 0.05, 7.8, 1.05], // sideboard, and the chairs pushed in on that side of the table
  [4.95, 1.05, 7.05, 2.05], // the dining table
  [4.35, 1.3, 4.95, 1.8], [7.05, 1.3, 7.65, 1.8], // a chair at each end
  [4.6, 3.3, 7.4, 3.9], // the sofa
  [9.0, 0.05, 10.7, 0.45], // bookcase
  [11.15, 0.95, 11.9, 2.65], // the desk
  [9.0, 0.75, 9.7, 1.45], // armchair
  [3.48, 1.3, 4.38, 1.36], [7.62, 3.44, 8.52, 3.5], [10.0, 3.02, 10.06, 3.92], // the three doors, standing open
];
export const spots = {
  enter: { x: 1.2, z: 1.25, h: Math.PI }, // under the window, facing into the house (north is +z)
  key: { x: 11.42, z: 1.8 },
  exit: { x: 0.35, z: 4.9 },
};
// The scanners: where each camera hangs and the two ends of its dot's swing.
export const scans = [
  { cam: [6.0, 2.3, 3.84], a: [6.0, 2.2], b: [6.0, 3.14], period: 3.6, phase: 0 }, // across the way round the table
  { cam: [8.44, 2.3, 3.0], a: [8.14, 2.15], b: [8.14, 3.85], period: 3.4, phase: 1.3 }, // along the study door
  { cam: [11.9, 2.3, 1.8], a: [10.74, 0.95], b: [10.74, 2.65], period: 3.8, phase: 0.6 }, // along the front of the desk
  { cam: [7.5, 2.3, 5.72], a: [7.5, 4.34], b: [7.5, 5.44], period: 3.2, phase: 0 }, // corridor, from the north wall
  { cam: [3.5, 2.3, 4.16], a: [3.5, 4.36], b: [3.5, 5.46], period: 3.2, phase: 1.9 }, // corridor, from the south wall
];
// Push a body of radius r out of the walls and the furniture. True if it moved.
export function pushOut(pos, r) {
  let moved = false;
  for (const list of [walls, furniture])
    for (const [x0, z0, x1, z1] of list) {
      const nx = Math.max(x0, Math.min(x1, pos.x)),
        nz = Math.max(z0, Math.min(z1, pos.z));
      let dx = pos.x - nx,
        dz = pos.z - nz;
      const d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d < 1e-6) {
        // inside the box: out through the nearest face
        const l = pos.x - x0, rr = x1 - pos.x, b = pos.z - z0, t = z1 - pos.z,
          m = Math.min(l, rr, b, t);
        if (m === l) pos.x = x0 - r;
        else if (m === rr) pos.x = x1 + r;
        else if (m === b) pos.z = z0 - r;
        else pos.z = z1 + r;
      } else {
        pos.x = nx + (dx / d) * r;
        pos.z = nz + (dz / d) * r;
      }
      moved = true;
    }
  return moved;
}
// Is a lens at (x, y, z) in a wall, over the ceiling or outside the house?
export function inWall(x, y, z, pad = 0) {
  if (y > SIZE.h - 0.12 - pad || y < 0.04) return true;
  if (x < pad || z < pad || x > SIZE.x - pad || z > SIZE.z - pad) return true;
  for (let i = 4; i < walls.length; i++) {
    const [x0, z0, x1, z1] = walls[i];
    if (x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad) return true;
  }
  return false;
}
export const roomOf = (x, z) => (z > 4 ? 'corridor' : x < 3.4 ? 'hall' : x < 8.6 ? 'living' : 'study');
const LAMP = { hall: [1.7, 2.0], living: [6.0, 2.0], study: [10.3, 2.0], corridor: [6.0, 4.9] };

export function villaInside(scene, origin) {
  const group = new THREE.Group();
  group.name = 'Příběh • vila uvnitř';
  group.position.set(origin.x, origin.y, origin.z);
  scene.add(group);
  const k = scenery(group),
    kit = props();
  const { x: W, z: L, h: H } = SIZE;
  const wall = 0x9c968a, trim = 0x4a3a2a, wood = 0x6a4a30, dark = 0x3a2a1c;
  // floor boards, ceiling, the walls from the list (doors are the gaps)
  for (let i = 0; i < 24; i++) k.box(0.25 + i * 0.5, -0.04, L / 2, 0.49, 0.08, L, i % 2 ? 0x7d5a36 : 0x745232);
  // (no ceiling: the rooms are looked into from above, js/heist-villa.js camera)
  k.box(W / 2, -0.2, L / 2, 60, 0.1, 60, 0x030405, 0, true); // the dark the house stands in
  for (const [x0, z0, x1, z1] of walls) {
    k.box((x0 + x1) / 2, H / 2, (z0 + z1) / 2, x1 - x0, H, z1 - z0, wall);
    k.box((x0 + x1) / 2, H + 0.01, (z0 + z1) / 2, x1 - x0, 0.02, z1 - z0, 0x1b1a18); // the cut top of the wall
    k.box((x0 + x1) / 2, 0.06, (z0 + z1) / 2, x1 - x0 + 0.03, 0.12, z1 - z0 + 0.03, trim);
  }
  // door frames over the three inner doors, and the back door itself
  for (const [x, z, alongX] of [[3.4, 1.8, false], [8.6, 3.0, false], [10.5, 4.0, true]]) {
    k.box(x, 2.32, z, alongX ? 1.0 : 0.2, 0.56, alongX ? 0.2 : 1.0, wall);
    k.box(x, 2.03, z, alongX ? 1.08 : 0.22, 0.06, alongX ? 0.22 : 1.08, trim);
  }
  // the doors themselves, left standing open: hall, study, corridor
  for (const [x, z, w, d] of [[3.93, 1.33, 0.9, 0.045], [8.07, 3.47, 0.9, 0.045], [10.03, 3.47, 0.045, 0.9]]) {
    k.box(x, 1.0, z, w, 2.0, d, 0x5a3d26);
    k.box(x + (w > d ? 0.34 : 0.03) * (x > 8.5 ? 1 : x > 5 ? -1 : 1), 1.0, z + (w > d ? 0.03 : -0.34), 0.03, 0.1, 0.03, 0xc9b27a);
  }
  k.box(0.035, 1.03, 4.9, 0.07, 2.06, 0.94, 0x4d3423);
  k.box(0.08, 1.02, 5.25, 0.04, 0.12, 0.05, 0xc9b27a);
  k.box(0.03, 2.2, 4.9, 0.03, 0.12, 0.3, 0x39d353, 0, true); // the green EXIT lamp over it
  // ---- the hall: the window he came through, a chest, coats, a mirror
  k.box(1.2, 1.9, 0.02, 1.3, 0.9, 0.05, 0x2c2a26);
  k.box(1.2, 1.9, 0.045, 1.14, 0.76, 0.02, 0x1a2740, 0, true);
  k.box(0.52, 1.9, 0.12, 0.05, 0.76, 0.5, 0xe6e2d6, 0.25); // the sash swung in
  k.box(1.2, 0.3, 0.33, 1.4, 0.6, 0.55, wood);
  k.box(1.2, 0.61, 0.33, 1.44, 0.03, 0.59, dark);
  k.box(0.25, 0.4, 3.25, 0.4, 0.8, 1.1, 0x8b7355);
  k.box(0.09, 1.55, 1.9, 0.04, 0.9, 0.5, 0x9db3bd, 0, false, 'glass');
  k.box(0.08, 1.55, 1.9, 0.03, 1.0, 0.6, dark);
  for (const [z, c] of [[2.9, 0x3d4a3a], [3.2, 0x5a3a2a], [3.5, 0x2a3350]]) k.box(0.2, 1.45, z, 0.16, 0.85, 0.3, c, 0, false, 'round');
  k.box(1.7, 0.012, 2.3, 1.6, 0.02, 2.4, 0x7a3b33);
  // ---- the living room: sideboard, table, sofa, a lamp, pictures, the television
  k.box(6.0, 0.42, 0.3, 3.6, 0.84, 0.5, wood);
  k.box(6.0, 0.86, 0.3, 3.66, 0.04, 0.56, dark);
  for (let i = 0; i < 4; i++) k.box(4.65 + i * 0.9, 0.42, 0.56, 0.8, 0.7, 0.012, 0x7b5837);
  k.box(5.0, 1.08, 0.3, 0.2, 0.4, 0.2, 0xb9c4c9, 0, false, 'round'); // a vase
  k.box(7.1, 0.95, 0.3, 0.32, 0.14, 0.24, 0x2a2a2c); // a radio
  k.box(6.0, 0.74, 1.55, 2.1, 0.05, 1.0, 0x5a3d26);
  for (const x of [5.05, 6.95]) for (const z of [1.13, 1.97]) k.box(x, 0.36, z, 0.08, 0.72, 0.08, dark);
  k.box(6.0, 0.012, 1.6, 3.4, 0.02, 2.4, 0x41506a);
  k.box(6.0, 0.24, 3.6, 2.8, 0.44, 0.6, 0x6a5a4c);
  k.box(6.0, 0.62, 3.84, 2.8, 0.52, 0.16, 0x5c4d40);
  for (const x of [4.72, 7.28]) k.box(x, 0.42, 3.6, 0.24, 0.5, 0.6, 0x5c4d40);
  for (const [x, c] of [[5.3, 0xb8963e], [6.7, 0x7a2f2a]]) k.box(x, 0.56, 3.62, 0.44, 0.34, 0.14, c, 0.2, false, 'round');
  k.box(3.6, 0.3, 3.4, 0.5, 0.6, 0.9, dark);
  k.box(3.55, 0.95, 3.4, 0.06, 0.62, 1.0, 0x101214);
  k.box(5.2, 1.6, 0.03, 0.7, 0.5, 0.03, 0x8a6a3a);
  k.box(5.2, 1.6, 0.05, 0.6, 0.4, 0.02, 0x3d5a4a);
  k.box(7.0, 1.65, 0.03, 0.5, 0.64, 0.03, 0x8a6a3a);
  k.box(7.0, 1.65, 0.05, 0.4, 0.54, 0.02, 0x6a4a5a);
  // ---- the study: the desk with the key, a lamp, the bookcase, an armchair
  k.box(11.52, 0.74, 1.8, 0.72, 0.05, 1.7, 0x4a3020);
  for (const z of [1.05, 2.55]) k.box(11.52, 0.36, z, 0.66, 0.72, 0.1, dark);
  k.box(11.6, 0.79, 2.3, 0.4, 0.03, 0.3, 0xd8d3c4);
  k.box(11.62, 0.86, 1.15, 0.16, 0.16, 0.16, 0x2f5a3a, 0, false, 'round');
  k.box(11.62, 0.98, 1.15, 0.05, 0.2, 0.05, 0x1c1c1c);
  k.box(11.62, 1.12, 1.15, 0.24, 0.14, 0.24, 0x9aa67a, 0, false, 'round');
  k.box(9.85, 1.1, 0.25, 1.7, 2.2, 0.4, dark);
  for (let s = 0; s < 4; s++)
    for (let i = 0; i < 11; i++) k.box(9.12 + i * 0.146, 0.3 + s * 0.52, 0.42, 0.11, 0.36 - ((i * 7 + s * 3) % 5) * 0.02, 0.05, [0x7a2f2a, 0x2f4a6a, 0x6a5a2a, 0x3a5a3a, 0x8a7a5a][(i + s * 2) % 5]);
  k.box(9.35, 0.3, 1.1, 0.7, 0.36, 0.7, 0x5a3a3a);
  k.box(9.07, 0.62, 1.1, 0.16, 0.5, 0.7, 0x4d3030);
  k.box(10.3, 0.012, 2.0, 2.2, 0.02, 2.6, 0x5a2f2a);
  k.box(11.97, 1.75, 3.2, 0.03, 0.8, 0.6, 0x1a2740, 0, true); // a window on the forest
  // ---- the corridor: a runner, a console table, two pictures
  k.box(6.0, 0.012, 4.94, 11.2, 0.02, 0.9, 0x6a2f2a);
  k.box(1.9, 0.4, 5.62, 1.1, 0.8, 0.3, wood);
  for (const x of [5.2, 9.2]) {
    k.box(x, 1.6, 5.77, 0.6, 0.44, 0.03, 0x8a6a3a);
    k.box(x, 1.6, 5.75, 0.5, 0.34, 0.02, 0x4a5a6a);
  }
  k.finish();
  for (const [x, z, yaw] of [[5.4, 0.85, Math.PI], [6.6, 0.85, Math.PI], [4.62, 1.55, -Math.PI / 2], [7.38, 1.55, Math.PI / 2]]) {
    const c = kit.chair({ wood: 0x5a3d26, dark: 0x3a2618 });
    c.position.set(x, 0, z);
    c.rotation.y = yaw;
    group.add(c);
  }
  const bottle = kit.bottle({ glass: 0x2f4a1c, band: '#6a1d1d' });
  bottle.position.set(6.4, 0.765, 1.7);
  group.add(bottle);
  // the key: a fob and a blade on the desk, with a glint that says where to look
  const key = new THREE.Group();
  key.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.06), new THREE.MeshLambertMaterial({ color: 0x15171a })),
    new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.05), new THREE.MeshPhongMaterial({ color: 0xd8dde2, shininess: 120 })),
    new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0025, 6, 14), new THREE.MeshPhongMaterial({ color: 0xc8a348, shininess: 100 })),
  );
  key.children[1].position.z = -0.052;
  key.children[2].position.set(0, 0, 0.042);
  key.children[2].rotation.x = Math.PI / 2;
  key.position.set(spots.key.x, 0.772, spots.key.z);
  key.rotation.y = 0.7;
  const glint = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  glint.position.set(spots.key.x, 0.8, spots.key.z);
  group.add(key, glint);
  const scan = scanners(group, scans);
  const at = (x, y, z, out = new THREE.Vector3()) => out.set(origin.x + x, origin.y + y, origin.z + z);
  let age = 0;
  return {
    origin,
    scan,
    at,
    // world → the house's own frame
    local: (x, z) => ({ x: x - origin.x, z: z - origin.z }),
    takeKey() {
      key.visible = glint.visible = false;
    },
    putKey() {
      key.visible = glint.visible = true;
    },
    // where the room's light hangs for a man standing at (x, z) in the frame
    lamp(x, z, out) {
      const [lx, lz] = LAMP[roomOf(x, z)];
      return at(lx, 2.25, lz, out);
    },
    update(dt) {
      age += dt;
      scan.update(dt);
      glint.scale.setScalar(1 + 0.5 * Math.sin(age * 4.2));
    },
    dispose() {
      scan.dispose();
      for (const m of [...key.children, glint]) {
        m.geometry.dispose();
        m.material.dispose();
      }
      kit.dispose();
      k.dispose();
      group.removeFromParent();
    },
  };
}
