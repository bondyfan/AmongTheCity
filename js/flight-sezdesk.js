// ---- flight-sezdesk.js: the check-in for the flight home, at Seychelles International ----
// The Mahé region draws the island and the airport's buildings from OSM; the
// one thing the way home needs on top is somewhere to buy the ticket. So one
// small counter stands inside the terminal's landside door, on the passenger's
// way from the door to the aircraft (js/flight-airports.js puts it six metres
// in from the door toward the stand): a white desk under a sign naming the
// flight, an agent's screen, a queue post. stationKit, three draw calls.

import * as THREE from 'three';
import { stationKit, plate } from './stationkit.js';

/** @param desk { x, z, heading } the counter's middle; heading faces the way a passenger walks in */
export function sezDesk(scene, world, desk) {
  const g = new THREE.Group();
  g.name = 'Mahé • odbavení letu ATC 741';
  g.position.set(desk.x, world.heightAt(desk.x, desk.z), desk.z);
  g.rotation.y = desk.heading;
  const kit = stationKit(g);
  // the counter: the passenger stands on +z (toward the door), the agent behind at -z
  kit.box(0, 0.52, 0, 2.6, 1.04, 0.75, 'white');
  kit.box(0, 1.06, 0.05, 2.7, 0.05, 0.85, 'dark');
  kit.box(0, 0.12, 0.39, 2.6, 0.24, 0.04, 'teal');
  kit.box(0.6, 1.3, -0.15, 0.5, 0.36, 0.04, 'dark');
  kit.box(0.6, 1.3, -0.13, 0.44, 0.3, 0.01, 'screen');
  kit.box(-0.9, 0.24, -0.9, 0.5, 0.48, 0.5, 'steel');
  // the sign on two posts over it
  for (const x of [-1.5, 1.5]) kit.box(x, 1.55, -0.55, 0.1, 3.1, 0.1, 'steel');
  kit.box(0, 3.0, -0.55, 3.4, 0.7, 0.12, 'navy');
  kit.sign(0, 3.0, -0.48, 3.2, 0.6, 0, 640, plate(['ATC 741  PARDUBICE (PED)', 'via Dubaj · Odbavení / Check-in'], '#1b2f55'), 'sez-desk');
  // a queue post and its belt in front
  for (const x of [-1.2, 1.2]) kit.round(x, 0.5, 1.6, 0.06, 1.0, 'steel');
  kit.box(0, 0.92, 1.6, 2.4, 0.05, 0.02, 'red');
  kit.light(0, 0, 0.8, 4, 3);
  kit.finish();
  scene.add(g);
  return {
    update(nightK) { kit.night(nightK); },
    dispose() { kit.dispose(); },
  };
}
