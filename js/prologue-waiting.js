import { makeCitizen } from './citizen.js';

// The people on the platform. Two sit, two talk, one is on the phone and the
// guard waits by the open door. Standing figures breathe and shift their
// weight, and the guard turns his head to whoever comes running.
//   [u from the canopy's start, v from the column line, facing, kind, look]
const cast = [
  [21.6, 0.5, 0, 'sit', { archetype: 'f60', uid: 'kolin-ceka-1' }],
  [28.4, 0.5, 0, 'sit', { archetype: 'm60', uid: 'kolin-ceka-2' }],
  [33.2, 2.5, 1.2, 'stand', { archetype: 'm30', uid: 'kolin-ceka-3' }],
  [34.3, 2.9, -1.9, 'stand', { archetype: 'f30', uid: 'kolin-ceka-4' }],
  [38.6, 1.5, 0.4, 'phone', { archetype: 'f30', uid: 'kolin-ceka-5' }],
  [28, 0, -1.3, 'guard', { archetype: 'm60', uid: 'kolin-vypravci', jacket: 0x1f3552, pants: 0x1b2330 }],
  [45.7, 0.5, 0, 'sit', { archetype: 'm30', uid: 'kolin-ceka-6' }],
];
// Bags and cases beside them: [u, v, w, h, d, colour]
export const luggage = [
  [22.4, 1.0, 0.42, 0.6, 0.26, 0x7a2f2c],
  [33.8, 2.2, 0.36, 0.62, 0.24, 0x24415e],
  [27.7, 1.0, 0.34, 0.3, 0.3, 0x4e5a3a],
  [46.5, 1.0, 0.3, 0.44, 0.2, 0x2b2b2e],
];

export function waitingPeople(group, { start, col, hi, Y }) {
  const people = cast.map(([du, dv, facing, kind, look]) => {
    const person = makeCitizen(look);
    const u = start + du,
      v = kind === 'guard' ? hi - 1.25 : col + dv;
    // heading 0 faces the train (+v is local +z, a figure looks down −z)
    person.group.position.set(u, Y(u, v) - (kind === 'sit' ? 0.44 : 0), v);
    person.group.rotation.y = Math.PI + facing;
    if (kind === 'sit') person.sitPose(1, 0);
    group.add(person.group);
    return { person, kind, base: person.group.rotation.y, t: Math.random() * 10, u, v, look: 0 };
  });
  let near = false;
  return {
    update(dt, px, pz, station, ground) {
      const pu = (px - station.x) * station.c + (pz - station.z) * station.s,
        pv = (pz - station.z) * station.c - (px - station.x) * station.s;
      near = Math.abs(pu - (start + 30)) < 75 && Math.abs(pv - col) < 60;
      if (!near) return;
      for (const p of people) {
        p.t += dt;
        const j = p.person.parts;
        if (p.kind === 'sit') {
          j.head.rotation.y = 0.35 * Math.sin(p.t * 0.31);
          continue;
        }
        p.person.walk(p.t, 0, 0, 0);
        if (p.kind === 'phone') {
          j.armR.rotation.set(1.23, 0.14, -0.31);
          j.elbowR.rotation.x = 2.4;
          j.head.rotation.z = 0.12;
        } else if (p.kind === 'guard') {
          // he watches the runner come down the platform
          const want = Math.atan2(-(pu - p.u), -(pv - p.v)) - p.base;
          const d = ((((want % 6.2832) + 9.4248) % 6.2832) - 3.1416);
          p.look += (Math.max(-1.1, Math.min(1.1, d)) - p.look) * Math.min(1, dt * 3);
          j.head.rotation.y = p.look;
          j.armL.rotation.x = 0.25;
          j.elbowL.rotation.x = 1.5;
        } else j.head.rotation.y = 0.25 * Math.sin(p.t * 0.5 + p.u);
      }
    },
    dispose() {
      for (const p of people) p.person.dispose();
    },
  };
}
