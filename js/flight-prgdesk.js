// ---- flight-prgdesk.js: the check-in for the flight home, at Václav Havel Airport Prague ----
// The Prague set on the ground-level forecourt by Terminál 1 (js/flight-lkpr.js
// puts the desk 10 m off the terminal's south-west face, by the bus stops). The
// Seychelles desk (js/flight-sezdesk.js) is one counter; this one is the check-in
// row an airport has: four counters with agent screens and a baggage belt behind
// them, a navy fascia over the row, a flight board on a free-standing post, a
// pylon for the terminal, and a queue of posts with red belts in front.
//
// Frame (the desk's own, as js/flight-sezdesk.js): the agents stand on -z, toward
// the terminal; the passengers stand on +z, on the street side; +x is across the
// row. stationKit, a few draw calls for the whole set.

import * as THREE from 'three';
import { stationKit, plate } from './stationkit.js';

// the counters: four of them, 1.6 m apart, centred on the desk
const COUNTERS = [-2.4, -0.8, 0.8, 2.4];

/**
 * @param desk { x, z, heading } the middle of the row; heading faces the terminal
 * @returns { update(nightK), dispose() }, the same shape as sezDesk
 */
export function prgDesk(scene, world, desk) {
  const g = new THREE.Group();
  g.name = 'Praha • odbavení letu ATC 750';
  g.position.set(desk.x, world.heightAt(desk.x, desk.z), desk.z);
  g.rotation.y = desk.heading;
  const kit = stationKit(g);

  // the counters and their agent screens
  for (const x of COUNTERS) {
    kit.box(x, 0.52, 0, 1.5, 1.04, 0.75, 'white');
    kit.box(x, 1.06, 0.05, 1.6, 0.05, 0.85, 'dark');
    kit.box(x, 0.12, 0.39, 1.5, 0.24, 0.04, 'teal');
    kit.box(x + 0.35, 1.3, -0.15, 0.5, 0.36, 0.04, 'dark');
    kit.box(x + 0.35, 1.3, -0.13, 0.44, 0.3, 0.01, 'screen');
  }

  // the baggage belt behind the row, on steel legs, with two bags on it
  kit.box(0, 0.96, -1.0, 5.4, 0.06, 0.5, 'dark');
  kit.box(0, 0.9, -1.0, 5.4, 0.08, 0.04, 'steel');
  for (const x of [-2.6, 0, 2.6]) kit.box(x, 0.46, -1.0, 0.08, 0.92, 0.08, 'steel');
  kit.box(-1.4, 1.1, -1.0, 0.5, 0.28, 0.32, 'yellow');
  kit.box(1.5, 1.09, -1.05, 0.44, 0.26, 0.3, 'teal');

  // the navy fascia over the row, on two posts, with its sign on the passenger side
  for (const x of [-3.0, 3.0]) kit.box(x, 1.55, -0.55, 0.1, 3.1, 0.1, 'steel');
  kit.box(0, 3.0, -0.55, 6.4, 0.7, 0.12, 'navy');
  kit.sign(0, 3.0, -0.48, 6.2, 0.6, 0, 1024, plate(['ATC · Odbavení / Check-in'], '#1b2f55'), 'prg-fascia');

  // the flight sign on two posts in front of the counters, for the passengers
  for (const x of [-1.9, 1.9]) kit.box(x, 1.1, 1.1, 0.07, 2.2, 0.07, 'steel');
  kit.box(0, 2.15, 1.1, 2.9, 0.5, 0.06, 'white');
  kit.sign(0, 2.15, 1.14, 2.8, 0.44, 0, 640, plate(['ATC 750 MAHÉ (SEZ) via Dubaj'], '#1f8f86'), 'prg-flight');

  // a queue of posts with red belts, across the front, the passengers' side
  for (const x of [-3.6, 0, 3.6]) kit.round(x, 0.5, 3.4, 0.06, 1.0, 'steel');
  kit.box(-1.8, 0.92, 3.4, 3.6, 0.05, 0.02, 'red');
  kit.box(1.8, 0.92, 3.4, 3.6, 0.05, 0.02, 'red');

  // a small departure board on a post at the left end, lit on both sides at night
  kit.box(-4.4, 1.2, -0.2, 0.1, 2.4, 0.1, 'steel');
  kit.box(-4.4, 2.1, -0.2, 1.7, 1.05, 0.1, 'dark');
  kit.both(-4.4, 2.1, -0.2, 1.6, 0.95, 0, 512, plate(['Odlety / Departures', 'ATC 750 · Mahé (SEZ)', 'Odbavení / Check-in'], '#0c1220', '#ffd56b', 600), 'prg-board', 0.06);

  // the pylon for the terminal, at the right end
  kit.box(4.4, 1.3, -0.2, 0.12, 2.6, 0.12, 'steel');
  kit.both(4.4, 2.75, -0.2, 2.6, 0.55, 0, 640, plate(['Terminál 1 · Odlety / Departures'], '#c4222c'), 'prg-pylon', 0.06);

  kit.light(0, 0, 0.8, 6, 3);
  kit.light(-4.4, 0, -1.2, 2, 2, 0xfff1d6);
  kit.finish();
  scene.add(g);
  return {
    update(nightK) { kit.night(nightK); },
    dispose() { kit.dispose(); },
  };
}
