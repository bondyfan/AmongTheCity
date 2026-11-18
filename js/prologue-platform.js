import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { trackNumber } from './prologue-route.js';
import { waitingPeople, luggage } from './prologue-waiting.js';

// The platform the last train leaves from, furnished like a station that is
// used: a steel canopy with strip lights, a clock and a departure screen,
// benches, bins, a coffee machine, the yellow line, lamps past the canopy and
// the people who are also going home. Station frame (js/station-passages.js):
// u along the platform, v across the tracks; the train stands on the +v side.
//   stop   v of the stairs from the underpass      lo..hi  the island's safe width
const islands = {
  2: { stop: 0, lo: -3.1, hi: 3.0, from: -24 },
  4: { stop: -41, lo: -44.7, hi: -38.4, from: 1 },
  5: { stop: -57, lo: -60.3, hi: -54.6, from: -8 },
};
const TO = 56, // the canopy and the furniture end here (u)
  green = 0x2c4a44,
  steel = 0x8d9698,
  wood = 0x8b6a47;

// Soft pools of light on the paving: additive discs that come up with the night.
function pools(group) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'),
    g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const spots = [];
  return {
    add(u, y, v, wide, long, colour = 0xffd9a6) {
      spots.push([u, y, v, wide, long, colour]);
    },
    finish() {
      const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
      const o = new THREE.Object3D(),
        c = new THREE.Color();
      spots.forEach(([u, y, v, wide, long, colour], i) => {
        o.position.set(u, y + 0.03 + i * 0.0004, v);
        o.scale.set(long, 1, wide);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
        mesh.setColorAt(i, c.setHex(colour));
      });
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      group.add(mesh);
    },
    night(k) {
      material.opacity = 0.5 * k;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}

export function dressPlatform(scene, world, station, platform) {
  const isle = islands[platform] ?? islands[2];
  const { stop, lo, hi, from } = isle;
  const col = stop - 2.25, // the line the canopy columns stand on
    mid = (col + hi) / 2;
  const at = (u, v) => ({ x: station.x + u * station.c - v * station.s, z: station.z + u * station.s + v * station.c });
  const origin = at(22, mid),
    ground = world.heightAt(origin.x, origin.z);
  // every prop stands on the paving under it, wherever the platform dips
  const Y = (u, v) => {
    const p = at(u, v);
    return world.heightAt(p.x, p.z) - ground;
  };
  const group = new THREE.Group(),
    k = scenery(group),
    light = pools(group);
  group.name = 'Kolín • nástupiště ' + platform;
  group.position.set(station.x, ground, station.z);
  group.rotation.y = -station.angle;
  const roofY = 3.95;
  // ---- canopy: a row of columns, cantilevers out to the edge, a boarded roof
  const start = Math.max(from, -2);
  const span = TO - start,
    centre = (TO + start) / 2,
    deep = hi + 0.2 - (col - 1.0),
    roofV = (hi + 0.2 + col - 1.0) / 2,
    top = Y(centre, mid) + roofY;
  for (let u = start + 1; u <= TO - 1; u += 6) {
    const y = Y(u, col);
    k.box(u, y + roofY / 2, col, 0.2, roofY, 0.24, green);
    k.box(u, y + 0.2, col, 0.36, 0.4, 0.4, 0x4a4f4c);
    k.box(u, top - 0.2, roofV, 0.14, 0.3, deep - 0.2, green);
    k.box(u, top - 0.45, col + 0.55, 0.1, 0.1, 1.0, green);
    // strip light between each pair of columns, and its pool on the paving
    if (u + 3 < TO) {
      k.box(u + 3, top - 0.13, mid + 0.4, 1.5, 0.05, 0.14, 0xfff1d2, 0, true);
      k.box(u + 3, top - 0.09, mid + 0.4, 1.62, 0.05, 0.22, 0x59605d);
      light.add(u + 3, Y(u + 3, mid), mid + 0.3, hi - lo + 1.5, 7);
    }
  }
  k.box(centre, top, roofV, span, 0.1, deep, 0x4d5653);
  k.box(centre, top + 0.07, roofV, span + 0.3, 0.05, deep + 0.3, 0x363c3b);
  for (const v of [hi + 0.28, col - 1.08]) k.box(centre, top - 0.1, v, span + 0.3, 0.3, 0.06, green);
  k.box(centre, top - 0.06, hi - 0.5, span, 0.03, 1.1, 0xa9c0c4, 0, false, 'glass');
  for (let u = start + 0.5; u < TO; u += 1.5) k.box(u, top - 0.055, roofV, 0.05, 0.02, deep, 0x3d4543);
  // gutter and a downpipe at each end
  k.box(centre, top - 0.2, col - 1.14, span + 0.3, 0.1, 0.12, 0x5a625f);
  for (const u of [start + 1, TO - 1]) k.box(u, Y(u, col) + roofY / 2, col - 0.2, 0.07, roofY - 0.3, 0.07, 0x5a625f);
  // ---- hanging under it: the station's name, a clock, the departure screen
  for (const u of [start + 9, start + 33]) {
    for (const s of [-0.9, 0.9]) k.box(u + s, top - 0.5, mid, 0.03, 0.7, 0.03, steel);
    for (const face of [0, Math.PI]) k.sign(u, top - 1.05, mid + (face ? -0.03 : 0.03), 2.5, 0.5, ['Kolín'], face, '#f3f1e8', '#1b3f77');
    k.box(u, top - 1.05, mid, 2.56, 0.56, 0.05, 0x1b3f77);
  }
  // the clock faces up and down the platform; it says nine, as it always does
  const clockU = start + 25;
  k.box(clockU, top - 0.42, mid, 0.04, 0.55, 0.04, steel);
  k.box(clockU, top - 0.95, mid, 0.16, 0.62, 0.62, 0x2a3033, 0, false, 'round');
  for (const s of [-1, 1]) {
    k.box(clockU + s * 0.075, top - 0.95, mid, 0.03, 0.54, 0.54, 0xf4f1e6, 0, true, 'round');
    k.box(clockU + s * 0.095, top - 0.95, mid + s * 0.08, 0.01, 0.035, 0.2, 0x1c1f21);
    k.box(clockU + s * 0.095, top - 0.85, mid, 0.01, 0.24, 0.025, 0x1c1f21);
  }
  // ---- along the edge: coping, the white tactile band and the yellow line
  for (let u = from; u < TO + 12; u += 6) {
    const y = Y(u + 3, hi - 0.4);
    k.box(u + 3, y + 0.012, hi - 0.12, 6.02, 0.02, 0.26, 0xb9b8ae);
    k.box(u + 3, y + 0.014, hi - 0.5, 6.02, 0.02, 0.3, 0xdedccf);
    k.box(u + 3, y + 0.016, hi - 0.86, 6.02, 0.022, 0.13, 0xf2c230);
    for (let n = 0; n < 12; n++) k.box(u + 0.25 + n * 0.5, y + 0.026, hi - 0.5, 0.06, 0.012, 0.26, 0xc9c7ba);
  }
  // ---- benches between the columns, backs to the column line
  for (const u of [22, 28, 34, 40, 46, 52].map((n) => start + n)) {
    const y = Y(u, col),
      v = col + 0.5;
    for (let n = 0; n < 4; n++) k.box(u, y + 0.45, v - 0.18 + n * 0.12, 1.9, 0.035, 0.1, wood);
    for (let n = 0; n < 3; n++) k.box(u, y + 0.62 + n * 0.13, v - 0.3, 1.9, 0.1, 0.035, wood);
    for (const s of [-0.8, 0.8]) {
      k.box(u + s, y + 0.23, v, 0.05, 0.46, 0.46, 0x3f4546);
      k.box(u + s, y + 0.7, v - 0.32, 0.05, 0.5, 0.05, 0x3f4546);
    }
  }
  // ---- bins, a ticket validator, the coffee machine with its glow
  for (const u of [start + 7.6, start + 25.6, start + 43.6]) {
    const y = Y(u, col);
    k.box(u, y + 0.42, col + 0.35, 0.4, 0.84, 0.4, 0x4a5456, 0, false, 'solid');
    k.box(u, y + 0.87, col + 0.35, 0.46, 0.06, 0.46, 0x2f3638);
    k.box(u, y + 0.62, col + 0.56, 0.24, 0.1, 0.02, 0x16191a);
  }
  const vend = start + 20,
    vy = Y(vend, col);
  k.box(vend, vy + 0.95, col + 0.42, 0.9, 1.9, 0.78, 0x23282b);
  k.box(vend - 0.14, vy + 1.18, col + 0.82, 0.56, 1.1, 0.02, 0xffe6bd, 0, true);
  k.box(vend + 0.3, vy + 1.2, col + 0.82, 0.2, 0.5, 0.02, 0x9fd6e8, 0, true);
  k.box(vend, vy + 0.32, col + 0.82, 0.5, 0.2, 0.03, 0x0f1112);
  k.sign(vend, vy + 1.82, col + 0.83, 0.9, 0.16, ['KÁVA • NÁPOJE'], 0, '#7a2a22', '#ffe9c4');
  light.add(vend, vy, col + 1.6, 2.6, 2.6, 0xffe2b0);
  const val = start + 13.8;
  k.box(val, Y(val, col) + 0.6, col + 0.3, 0.07, 1.2, 0.07, steel);
  k.box(val, Y(val, col) + 1.22, col + 0.3, 0.24, 0.34, 0.16, 0xf0b62a);
  k.box(val, Y(val, col) + 1.26, col + 0.39, 0.14, 0.1, 0.01, 0x8fe0a0, 0, true);
  // timetable case on two legs, lit from inside
  const tt = start + 10.4;
  for (const s of [-0.62, 0.62]) k.box(tt + s, Y(tt, col) + 0.95, col + 0.2, 0.06, 1.9, 0.06, steel);
  k.box(tt, Y(tt, col) + 1.45, col + 0.2, 1.36, 0.98, 0.09, 0x2a3033);
  k.sign(tt, Y(tt, col) + 1.45, col + 0.25, 1.26, 0.88, ['ODJEZDY', 'Pardubice hl. n.', 'Praha hl. n.', 'Česká Třebová', 'Nymburk hl. n.'], 0, '#f2efe2', '#1c2a3a');
  // ---- past the canopy: tall lamps with their own pools
  for (const u of [from + 3, from + 14, TO + 5, TO + 14]) {
    if (u > start - 2 && u < TO + 2) continue;
    const y = Y(u, col);
    k.box(u, y + 2.6, col, 0.11, 5.2, 0.11, 0x4b5352);
    k.box(u, y + 5.15, col + 0.55, 0.08, 0.08, 1.1, 0x4b5352);
    k.box(u, y + 5.08, col + 1.0, 0.24, 0.07, 0.46, 0xffe9c2, 0, true);
    light.add(u, Y(u, mid), mid + 0.2, hi - lo + 2, 9, 0xffd49a);
  }
  for (const [du, dv, w, h, d, colour] of luggage) {
    const u = start + du,
      v = col + dv;
    k.box(u, Y(u, v) + h / 2, v, w, h, d, colour);
    k.box(u, Y(u, v) + h + 0.04, v, w * 0.4, 0.07, 0.03, 0x2a2c2e);
  }
  // ---- the departure screen, hung where the stairs come up
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 200;
  const ctx = canvas.getContext('2d'),
    texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // (it faces along the platform, so whoever comes up the stairs reads it)
  const screenU = start + 20.6;
  const screens = [-1, 1].map((side) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.69), new THREE.MeshBasicMaterial({ map: texture }));
    m.position.set(screenU + side * 0.07, top - 1.02, mid + 0.2);
    m.rotation.y = (side * Math.PI) / 2;
    group.add(m);
    return m;
  });
  k.box(screenU, top - 1.02, mid + 0.2, 0.12, 0.78, 2.3, 0x1d2326);
  for (const s of [-0.9, 0.9]) k.box(screenU, top - 0.42, mid + 0.2 + s, 0.03, 0.5, 0.03, steel);
  k.finish();
  light.finish();
  scene.add(group);
  const people = waitingPeople(group, { start, col, hi, Y });
  // Under the canopy the game's camera comes in low, as it does indoors.
  const cover = (x, z) => {
    const u = (x - station.x) * station.c + (z - station.z) * station.s,
      v = (z - station.z) * station.c - (x - station.x) * station.s;
    return u > start - 0.5 && u < TO + 0.5 && v > col - 1.2 && v < hi + 0.4;
  };
  world.stationPassages.extraCover = cover;
  let shown = '';
  return {
    // where the story's lamp hangs: under the canopy beside the walker
    lampAt(x, z) {
      const u = (x - station.x) * station.c + (z - station.z) * station.s;
      const p = at(Math.max(start + 2, Math.min(TO - 2, u)), mid + 0.3);
      return { x: p.x, y: ground + roofY - 0.5, z: p.z };
    },
    update(dt, night, status, px, pz) {
      light.night(night);
      people.update(dt, px, pz, station, ground);
      if (status === undefined || status === shown) return;
      shown = status;
      ctx.fillStyle = '#0c1518';
      ctx.fillRect(0, 0, 640, 200);
      ctx.fillStyle = '#16323f';
      ctx.fillRect(0, 0, 640, 54);
      ctx.fillStyle = '#e9f1ee';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText('Nástupiště ' + platform + '   kolej ' + trackNumber[platform], 18, 38);
      ctx.fillStyle = '#ffcf68';
      ctx.font = 'bold 44px monospace';
      ctx.fillText('R  Pardubice hl. n.', 18, 112);
      ctx.font = '30px monospace';
      ctx.fillStyle = '#aec3cb';
      ctx.fillText(status, 18, 168);
      texture.needsUpdate = true;
    },
    dispose() {
      if (world.stationPassages.extraCover === cover) world.stationPassages.extraCover = null;
      people.dispose();
      for (const m of screens) {
        m.removeFromParent();
        m.geometry.dispose();
        m.material.dispose();
      }
      texture.dispose();
      light.dispose();
      k.dispose();
    },
  };
}
