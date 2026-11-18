import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { pigeons } from './prologue-birds.js';
import { streetHeading } from './prologue-street.js';
import { world2, deckY } from './prologue-roof.js';
import { roofFrame } from './prologue-route.js';

// The small life of the streets he crosses: pigeons on the pavement that
// clap away as he passes, more of them on the roof and in front of the
// station, and the cat on the bins by the house door that bolts when the
// door flies open.
export function streetLife(scene, world) {
  const birds = pigeons(scene, world);
  const cat = new THREE.Group(),
    k = scenery(cat);
  cat.name = 'Kolín • kočka';
  const fur = 0x2b2a2c;
  k.box(0, 0.16, 0, 0.15, 0.17, 0.42, fur, 0, false, 'round');
  k.box(0, 0.25, -0.22, 0.13, 0.13, 0.14, fur, 0, false, 'round');
  for (const s of [-1, 1]) {
    k.box(s * 0.04, 0.33, -0.23, 0.035, 0.07, 0.03, fur);
    k.box(s * 0.045, 0.06, -0.14, 0.04, 0.12, 0.04, fur);
    k.box(s * 0.045, 0.06, 0.14, 0.04, 0.12, 0.04, fur);
    k.box(s * 0.03, 0.26, -0.29, 0.02, 0.015, 0.01, 0xd9e36a, 0, true);
  }
  k.box(0, 0.24, 0.3, 0.035, 0.035, 0.3, fur);
  k.finish();
  scene.add(cat);
  const perch = world2(-1.1, -0.45);
  let bolt = -1, // seconds since it jumped, −1 while it sits
    sitY = 0;
  // along the foot of the wall, towards the corner
  const run = { x: Math.cos(roofFrame.h), z: -Math.sin(roofFrame.h) };
  return {
    scare: birds.scare,
    // `street` is the opening's walk (prologue-street.js), when there is one.
    populate(street) {
      const flock = (name, spots, radius) => birds.flock(name, spots, radius);
      if (street) {
        const right = { x: Math.cos(streetHeading), z: -Math.sin(streetHeading) };
        flock(
          'street',
          [
            [8.3, 0.7], [8.9, 1.5], [9.4, 0.5], [9.9, 1.2], [10.3, 2.0], [10.8, 0.8], [11.4, 1.6], [9.1, 2.4],
          ].map(([s, side]) => {
            const p = street.spot(s);
            return [p.x + right.x * side, p.z + right.z * side];
          }),
          3.6,
        );
      }
      const top = deckY(world) + 0.6;
      flock(
        'roof',
        [1.3, 1.85, 2.7, 3.6, 4.2].map((z) => {
          const p = world2(-4.64, z);
          return [p.x, p.z, top];
        }),
        0,
      );
      flock(
        'yard',
        [
          [3.4, -12.4], [4.2, -13.6], [5.1, -12.2], [5.6, -14.5], [6.5, -13.2], [7.0, -15.2], [4.6, -15.4], [3.6, -14.6],
        ].map(([x, z]) => {
          const p = world2(x, z);
          return [p.x, p.z];
        }),
        5,
      );
      const s = world.stationPassages.stations[0];
      flock(
        'forecourt',
        [
          [15, 53], [16.2, 54.4], [17.4, 52.6], [18.3, 55.2], [19.6, 53.5], [14.2, 55.6], [20.4, 55.9],
        ].map(([u, v]) => [s.x + u * s.c - v * s.s, s.z + u * s.s + v * s.c]),
        5,
      );
      sitY = world.terrain.heightAt(perch.x, perch.z) + 1.16;
      cat.position.set(perch.x, sitY, perch.z);
      cat.rotation.y = roofFrame.h;
    },
    update(dt, px, pz, py) {
      birds.update(dt, px, pz);
      if (bolt < 0) {
        // it sleeps through the man on the roof and wakes when he is nearly down
        if (Math.hypot(px - perch.x, pz - perch.z) < 6 && py < sitY + 3.2) bolt = 0;
        return;
      }
      if (bolt > 3.2) {
        cat.visible = false;
        return;
      }
      bolt += dt;
      // off the bin in one arc, then flat out along the wall
      const leap = Math.min(1, bolt / 0.38),
        ran = Math.max(0, bolt - 0.3) * 7.5 + leap * 1.3;
      const ground = world.heightAt(perch.x + run.x * ran, perch.z + run.z * ran);
      cat.position.set(
        perch.x + run.x * ran,
        leap < 1 ? sitY + (ground - sitY) * leap * leap + Math.sin(leap * Math.PI) * 0.25 : ground + Math.abs(Math.sin(bolt * 22)) * 0.07,
        perch.z + run.z * ran,
      );
      cat.rotation.y = roofFrame.h - Math.PI / 2;
      cat.rotation.x = leap < 1 ? 0.5 * (leap - 0.4) : 0;
    },
    dispose() {
      birds.dispose();
      k.dispose();
    },
  };
}
