import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { makeCitizen } from './citizen.js';
export const offsets = [-26.7, 0, 26.7];
export const carriageAt = (u) =>
  offsets.reduce((a, b) => (Math.abs(u - b - 3) < Math.abs(u - a - 3) ? b : a));
export const doorX = 14;
// One coach takes this much of the train: its body and the gangway behind it.
export const PITCH = 26.7;
// Who sits where in every coach: [bay, side, facing].
export const riders = [
  [0, 1, -1],
  [2, -1, 1],
  [4, 1, 1],
  [6, -1, -1],
];
export const riderSeat = ([bay, side, facing]) => ({ x: -8.2 + bay * 2.62 + facing * 0.84, y: -0.26, z: side * 1.08, yaw: (facing * Math.PI) / 2 });

// A second-class open saloon, four seats around a table, with an end vestibule.
// `doors` 2 gives it a real door on the far side too (the trains of the open
// world, js/railcoach.js: a platform can be on either side); the campaign's
// own train keeps the one it boards by and a fixed panel across from it.
export function coach(k, { destination = 'Pardubice hl. n.', doors = 1 } = {}) {
  const { box, sign } = k,
    z = 0;
  const blue = 0x1b5791,
    cream = 0xe0dfd6,
    metal = 0x8797a0,
    seat = 0x245581;
  box(3, 0.04, z, 26.4, 0.25, 3.05, 0x656a70);
  box(3, 2.77, z, 26.5, 0.2, 3.14, cream);
  for (const x of [-10.1, 16.1]) {
    for (const side of [-1, 1]) box(x, 1.4, side * 1.05, 0.15, 2.63, 0.94, cream);
    box(x, 2.48, 0, 0.16, 0.41, 1.3, cream);
  }
  for (const side of [-1, 1]) {
    const edge = z + side * 1.51;
    for (const [a, b] of [
      [-10.14, 13.25],
      [14.75, 16.12],
    ]) {
      const mid = (a + b) / 2,
        w = b - a;
      box(mid, 0.56, edge, w, 0.81, 0.1, cream);
      box(mid, 0.39, edge + side * 0.06, w, 0.37, 0.045, blue);
      box(mid, 2.55, edge, w, 0.26, 0.11, cream);
      box(mid, 0.98, edge, w, 0.09, 0.13, metal);
    }
    // Each pane sits in a solid wall with its own rubber gasket and sill.
    const pitch = 2.34,
      pane = 1.43,
      first = -10.14;
    box(1.55, 1.13, edge, 23.39, 0.39, 0.13, cream);
    box(1.55, 2.32, edge, 23.39, 0.37, 0.13, cream);
    for (let i = 0; i < 10; i++) {
      const x = first + (i + 0.5) * pitch;
      for (const sign of [-1, 1]) {
        box(x + sign * (pane / 2 + (pitch - pane) / 4), 1.73, edge, (pitch - pane) / 2, 0.83, 0.13, cream);
        box(x + sign * (pane / 2 - 0.026), 1.73, edge, 0.052, 0.83, 0.14, 0x25363c);
        box(x, 1.73 + sign * 0.385, edge, pane, 0.061, 0.14, 0x293e47);
      }
      box(x, 1.73, edge, pane - 0.1, 0.71, 0.038, 0x708f9c, 0, false, 'glass');
      box(x, 1.95, edge, pane - 0.1, 0.024, 0.1, metal);
      box(x, 1.31, edge - side * 0.067, pane + 0.04, 0.047, 0.18, metal);
    }
    box(15.44, 1.71, edge, 1.37, 1.49, 0.12, cream);
    // Luggage rack with a lip, overhead reading lights, textured upholstery.
    box(1.44, 2.25, z + side * 1.21, 21, 0.075, 0.46, metal);
    box(1.44, 2.32, z + side * 0.99, 21, 0.13, 0.035, metal);
    for (let x = -8.3; x < 12; x += 2.27) {
      box(x, 2.618, z + side * 0.71, 1.51, 0.044, 0.125, 0xffedcd, 0, true);
    }
    for (let bay = 0; bay < 8; bay++) {
      const x = -8.2 + bay * 2.62;
      for (const facing of [-1, 1]) {
        const sx = x + facing * 0.84;
        for (let col = 0; col < 2; col++) {
          const sz = z + side * (0.6 + col * 0.48);
          box(sx, 0.55, sz, 0.57, 0.2, 0.45, seat, 0, false, 'round');
          box(sx + facing * 0.24, 0.94, sz, 0.13, 0.73, 0.44, seat, -facing * 0.085);
          box(sx + facing * 0.26, 1.24, sz, 0.18, 0.23, 0.4, 0xb3c4d4, 0, false, 'round');
          for (let band = 0; band < 3; band++)
            box(sx + facing * 0.155, 0.78 + band * 0.09, sz, 0.025, 0.019, 0.39, 0x5b85a4);
        }
        box(sx, 0.77, z + side * 0.37, 0.42, 0.055, 0.045, metal);
      }
      box(x, 0.83, z + side * 1.14, 0.67, 0.06, 0.58, 0xbba58b);
    }
  }
  for (const side of [-1, 1]) {
    box(12.64, 1.43, z + side * 1.0, 0.12, 2.5, 0.92, cream);
    box(12.57, 1.59, z + side * 0.99, 0.04, 0.58, 0.57, 0x708a98);
  }
  if (doors === 1) sign(14.16, 2.45, z + 1.58, 2.24, 0.33, ['2   ' + destination], 0, '#17222a', '#ffd46c');
  else for (const side of [-1, 1])
    sign(15.44, 2.27, z + side * 1.585, 1.3, 0.2, ['2   ' + destination], side > 0 ? 0 : Math.PI, '#17222a', '#ffd46c');
  sign(12.72, 2.32, z, 1.14, 0.21, ['2   TICHÝ ODDÍL'], Math.PI / 2);
  sign(4.3, 0.61, z + 1.58, 2.2, 0.27, ['České dráhy'], 0, '#255489');
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) box(doorX, -0.06 - i * 0.2, side * (1.5 + i * 0.28), 1.46, 0.18, 0.42, metal);
  }
  if (doors === 1) {
    box(doorX, 1.34, 1.51, 1.46, 2.56, 0.09, blue);
    box(doorX, 1.65, 1.57, 0.84, 0.93, 0.03, metal);
  }
  for (const x of [-7.8, -5.7, 11.4, 13.5]) box(x, -0.29, z, 0.63, 0.74, 2.18, 0x30383e);
}

// One sliding leaf of a door, about its own middle. `direction` is the way it
// slides open along the train, `side` the flank it is on (-1: the campaign's).
export function doorLeaf(k, direction, side = -1) {
  const z = side * 1.53;
  k.box(0, 1.42, z, 0.74, 2.51, 0.09, 0x245581);
  k.box(0, 1.73, z, 0.57, 0.83, 0.11, 0x293d4b);
  k.box(0, 1.74, z, 0.47, 0.7, 0.12, 0x839fa9);
  k.box(direction * 0.29, 1.42, z, 0.045, 2.48, 0.105, 0x283942);
  k.box(0, 0.32, z, 0.72, 0.1, 0.11, 0xf2c34d);
}
// Where a leaf is: `closed` 1 shut … 0 open. It plugs out of the wall, then slides.
export function leafAt(direction, closed, side = -1) {
  const open = 1 - closed;
  return { x: doorX + direction * (0.365 + 0.74 * Math.min(1, open * 1.17)), z: side * 0.12 * Math.min(1, open * 5) };
}
// The concertina between two coaches, at the back of the one in front of it.
export function gangway(k, x = 16.35) {
  k.box(x, 0.075, 0, 0.81, 0.18, 1.22, 0x505658);
  for (const side of [-1, 1])
    for (let j = 0; j < 5; j++)
      k.box(x - 0.24 + j * 0.12, 1.27, side * (0.66 + (j % 2) * 0.035), 0.13, 2.35, 0.12, 0x393b3c);
  k.box(x, 2.42, 0, 0.85, 0.19, 1.45, 0x3d4143);
}
// A driving cab's face at `end`, looking along `face`. `lamp` is the colour
// its two lamps burn, or null where somebody else lights them (js/railcoach.js).
export function cab(k, end, face, lamp) {
  k.box(end, 1.95, 0, 0.18, 0.95, 2.8, 0x273c4a);
  for (const side of [-1, 1]) {
    k.box(end + face * 0.11, 2.0, side * 0.65, 0.05, 0.66, 1.17, 0x738b99);
    if (lamp != null) k.box(end + face * 0.12, 0.88, side * 1.02, 0.06, 0.13, 0.25, lamp, 0, true);
    k.box(end + face * 0.21, -0.02, side * 0.9, 0.31, 0.18, 0.3, 0x384349);
  }
}
export const cabLamp = (end, face, side) => ({ x: end + face * 0.12, y: 0.88, z: side * 1.02, w: 0.06, h: 0.13, d: 0.25 });
// What is under and on top of one coach: bogies, the roof units, the underframe.
export function running(k, offset = 0) {
  for (const u of [-6.65, 12.45]) {
    k.box(offset + u, -0.39, 0, 3.12, 0.36, 2.23, 0x40494c);
    for (const axle of [-0.98, 0.98])
      for (const side of [-1, 1]) {
        k.box(offset + u + axle, -0.33, side * 0.82, 0.79, 0.79, 0.19, 0x41484a, 0, false, 'round');
        k.box(offset + u + axle, -0.33, side * 0.92, 0.62, 0.62, 0.05, 0x707879, 0, false, 'round');
      }
  }
  for (const u of [-6.2, 6.2]) {
    k.box(offset + u, 2.96, 0, 2.15, 0.22, 1.07, 0xa6aaa8);
    for (let x = -0.86; x < 0.9; x += 0.19) k.box(offset + u + x, 3.08, 0, 0.073, 0.035, 0.83, 0x65747a);
  }
  k.box(offset + 1, -0.34, 0, 5.4, 0.58, 1.92, 0x414a4e);
}
// The lettering on the flank the campaign boards by (and, mirrored, the other).
export function lettering(k, offset = 0, side = -1) {
  const yaw = side < 0 ? Math.PI : 0;
  k.sign(offset - 2, 0.63, side * 1.59, 2.4, 0.32, ['České dráhy'], yaw, '#1b5386');
  k.sign(offset + 12.42, 1.75, side * 1.59, 0.53, 0.61, ['2'], yaw, '#244f78');
}

export function trainBody(scene) {
  const group = new THREE.Group(),
    shell = scenery(group);
  group.name = 'Poslední vlak • Kolín – Pardubice';
  const passengers = [],
    leaves = [],
    doorKits = [];
  for (const offset of offsets) {
    const shifted =
      (fn) =>
      (x, ...rest) =>
        fn(x + offset, ...rest);
    coach({ box: shifted(shell.box), sign: shifted(shell.sign) });
    lettering(shell, offset);
    for (const direction of [-1, 1]) {
      const panel = new THREE.Group(),
        k = scenery(panel);
      doorLeaf(k, direction);
      k.finish();
      group.add(panel);
      leaves.push({ panel, x: offset + doorX + direction * 0.365, direction });
      doorKits.push(k);
    }
    for (const rider of riders) {
      const seat = riderSeat(rider),
        x = offset - 8.2 + rider[0] * 2.62 + rider[2] * 0.84;
      const person = makeCitizen({ uid: 'kolin-' + x, archetype: rider[0] === 2 ? 'woman' : 'man' });
      person.sitPose(1, 0);
      person.group.position.set(x, seat.y, seat.z);
      person.group.rotation.y = seat.yaw;
      group.add(person.group);
      passengers.push(person);
    }
  }
  for (const offset of [-26.7, 0]) gangway(shell, offset + 16.35);
  // The last car has a driving cab beyond the through aisle.
  for (const end of [-36.88, 42.88]) cab(shell, end, end < 0 ? -1 : 1, end < 0 ? 0xa63e32 : 0xffe6b7);
  for (const offset of offsets) running(shell, offset);
  for (const x of [-36.8, 42.8]) shell.box(x, 1.42, 0, 0.12, 2.56, 1.24, 0xadb3b0);
  shell.finish();
  scene.add(group);
  const walker = makeCitizen({ uid: 'kolin-pruvodci', jacket: 0x263e51, archetype: 'man' });
  walker.group.position.set(-34, 0.165, 0.05);
  group.add(walker.group);
  passengers.push(walker);
  let destination = 37,
    pause = 5,
    gait = 0,
    heard = false;
  function aisle(dt, listener) {
    if (pause > 0) {
      pause -= dt;
      return false;
    }
    const x = walker.group.position.x,
      direction = Math.sign(destination - x);
    const step = Math.min(Math.abs(destination - x), dt * 1.04);
    walker.group.position.x += direction * step;
    walker.group.rotation.y = (-direction * Math.PI) / 2;
    gait += step * 1.6;
    walker.walk(gait, 0.7, 0, 1.04);
    if (Math.abs(walker.group.position.x - destination) < 0.01) {
      destination = destination < 0 ? 37 : -34;
      pause = 5 + Math.random() * 16;
      walker.standPose();
    }
    const distance = Math.abs((listener ?? Infinity) - walker.group.position.x);
    if (distance > 7) heard = false;
    if (!heard && distance < 3.3) {
      heard = true;
      return true;
    }
    return false;
  }
  return {
    group,
    aisle,
    doors(closed) {
      const open = 1 - closed;
      for (const { panel, x, direction } of leaves) {
        panel.position.x = x + direction * 0.74 * Math.min(1, open * 1.17);
        panel.position.z = -0.12 * Math.min(1, open * 5);
      }
    },
    close() {
      for (const person of passengers) person.dispose();
      for (const kit of doorKits) kit.dispose();
      shell.dispose();
    },
  };
}
