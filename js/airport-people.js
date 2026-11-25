// ---- airport-people.js: the people of Terminál Jana Kašpara, as bodies ----
// Main thread. The bodies are the game's own people (js/citizen.js makeCitizen, the
// modelled humans when the bank is loaded), scaled with PLAYER_SCALE as
// js/stores/crowd.js scales its shoppers, and posed the way those and the
// prologue pose theirs:
//   'sit'    sitPose(1, 0) once, a bench-sitter's pose; the figure is dropped onto
//            the seat by DROP (js/prologue-seat.js, js/stores/crowd.js), and after
//            that only the head moves (js/prologue-waiting.js). An agent types.
//   'stand'  the staff at work: the gait's idle sway every frame, then the crew's
//            arms laid over it (js/stores/crowd.js, the counter staff).
//   'idle'   a passenger standing still: walk(0, 0, 0, 0) every frame, the gait's
//            own breathing and weight shift (js/prologue-waiting.js).
//
// Bodies exist only while the player is within RANGE of the terminal (or of a
// desk), a couple are made a frame, and they are disposed once he is HYST metres
// beyond that. A body costs one skinned mesh and one walk() solve a frame.

import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE } from './config.js';
import { archetypeAt } from './people.js';
import { AT } from './airport-plan.js';
import { airportPeoplePlan, SEAT } from './airport-people-plan.js';

const RANGE = 180;        // m: the bodies are made inside this
const HYST = 20;          // m: and disposed beyond RANGE + HYST
const MAKE = 2;           // bodies made a frame
const DROP = 0.425;       // origin down to the tiles when seated (js/prologue-seat.js, js/stores/crowd.js)
// The seat height DROP is measured for. At PLAYER_SCALE a seated figure has its hips
// 0.82 m above its origin and its feet about 0.45 m below it, so feet flat on the tiles
// put the seat's top near 0.31 to 0.34 m: 0.32, the height of the bench pans.
const SEAT0 = 0.32;

// The uniforms (js/wardrobe.js pins: jacket is the top's colour, pants the trousers').
const LOOK = {
  agent: { jacket: 0xe9edf2, pants: 0x1f2a44, style: { top: 'shirt' } },        // a light shirt, navy trousers
  gate: { jacket: 0x1f3557, pants: 0x1b2236 },                                   // navy
  security: { jacket: 0x3a3f47, pants: 0x17191c, style: { top: 'jacket', hat: null } }, // dark grey, black
  passenger: {},                                                                 // drawn from the wardrobe by seed
};

/** One body from a plan entry, standing on the floor at `base` (the floor's height at its place). */
function makeBody(scene, spec, base) {
  const uniform = spec.role !== 'passenger';
  const c = makeCitizen({
    archetype: uniform ? (spec.seed & 1 ? 'f30' : 'm30') : archetypeAt(spec.seed / 4294967296).key,
    seed: spec.seed,
    ...LOOK[spec.role],
  });
  c.group.scale.setScalar(PLAYER_SCALE);
  // a sitter's origin comes down by DROP from the seat's own height (the seat is SEAT0 in the
  // figure's proportions): a bench sitter's feet land on the tiles, a counter chair's hover ~6 cm
  const y = base + (spec.pose === 'sit' ? spec.y - SEAT0 - DROP : spec.y);
  c.group.position.set(spec.x, y, spec.z);
  c.group.rotation.y = spec.heading;
  c.group.name = 'airport-' + spec.role;
  scene.add(c.group);
  if (spec.pose === 'sit') c.sitPose(1, 0);
  else c.walk(0, 0, 0, 0);
  return { c, spec, phase: (spec.seed % 1000) / 1000 * 6.2832 };
}

/** The per-frame pose of one body. Cheap: sitters move only their heads, the rest run one gait solve. */
function poseBody(b, t) {
  const { c, spec } = b, J = c.parts;
  if (spec.pose === 'sit') {
    if (spec.role === 'agent') {
      // typing at the desk: the till staff's arms (js/stores/crowd.js), the right hand working
      J.armR.rotation.set(-0.95, 0, 0.1); J.elbowR.rotation.x = 1.05 + 0.05 * Math.sin(t * 6 + b.phase);
      J.armL.rotation.set(-0.85, 0, -0.1); J.elbowL.rotation.x = 1.1;
    } else {
      // seated: now and then he looks about (js/prologue-waiting.js)
      J.head.rotation.y = 0.35 * Math.sin(t * 0.31 + b.phase);
    }
    return;
  }
  c.walk(0, 0, 0, 0);
  if (spec.role === 'gate' || spec.role === 'agent') {
    // the crew behind a standing desk: hands on the counter, the arms of js/stores/crowd.js's counter staff
    J.armR.rotation.x = -0.75 - 0.2 * Math.sin(t * 2.2 + b.phase); J.elbowR.rotation.x = 0.9;
    J.armL.rotation.x = -0.7; J.elbowL.rotation.x = 0.95;
  } else if (spec.role === 'security') {
    // hands clasped low in front, and the head turns to watch the queue
    J.armR.rotation.set(-0.45, 0, 0.12); J.elbowR.rotation.x = 1.0;
    J.armL.rotation.set(-0.45, 0, -0.12); J.elbowL.rotation.x = 1.0;
    J.head.rotation.y = 0.5 * Math.sin(t * 0.4 + b.phase);
  }
}

/**
 * A set of bodies that lives while the player is near `anchor`. `ready()` says
 * whether the floor they stand on exists yet; `floorAt(x, z)` gives its height
 * (null when it is not there yet).
 */
class PeopleSet {
  constructor(scene, specs, anchor, ready, floorAt) {
    this.scene = scene; this.specs = specs; this.anchor = anchor;
    this.ready = ready; this.floorAt = floorAt;
    this.bodies = null; this.next = 0; this.t = 0;
  }
  update(dt, player) {
    this.t += dt;
    const d = Math.hypot(player.pos.x - this.anchor.x, player.pos.z - this.anchor.z);
    if (!this.bodies) {
      if (d > RANGE || !this.ready()) return;
      this.bodies = []; this.next = 0;
    } else if (d > RANGE + HYST) {
      this.dispose();
      return;
    }
    // a couple a frame, so a whole terminal is not one hitch
    for (let n = 0; n < MAKE && this.next < this.specs.length; n++) {
      const spec = this.specs[this.next];
      const base = this.floorAt(spec.x, spec.z);
      if (base == null) break;
      this.bodies.push(makeBody(this.scene, spec, base));
      this.next++;
    }
    for (const b of this.bodies) poseBody(b, this.t);
  }
  dispose() {
    for (const b of this.bodies ?? []) b.c.dispose();
    this.bodies = null; this.next = 0;
  }
}

/**
 * The people of the Pardubice terminal. `plan` is airportPeoplePlan() (it is
 * the default). Returns { update(dt, player), dispose() }.
 */
export function airportPeople(scene, world, plan = airportPeoplePlan()) {
  const terminal = () => world.airport?.terminal;
  const set = new PeopleSet(scene, plan, { x: AT[0], z: AT[1] },
    () => !!terminal()?.ready,
    (x, z) => terminal()?.floor(x, z, Infinity) ?? null);
  return {
    update(dt, player) { set.update(dt, player); },
    dispose() { set.dispose(); },
  };
}

/**
 * n agents standing behind a check-in desk (js/flight-sezdesk.js): desk is
 * { x, z, heading }, where heading faces the way a passenger walks in, so the
 * agents stand at local -z and face back toward the passenger. Same API as
 * airportPeople.
 */
export function deskStaff(scene, world, desk, n) {
  const k = Math.max(1, Math.min(3, n | 0)), h = desk.heading;
  const seat0 = (Math.floor(desk.x * 16) ^ (Math.floor(desk.z * 16) * 31)) >>> 0;
  const specs = [];
  for (let i = 0; i < k; i++) {
    const lx = (i - (k - 1) / 2) * 0.7, lz = -0.85;   // along the desk, 85 cm behind its middle
    specs.push({
      x: desk.x + lx * Math.cos(h) + lz * Math.sin(h),
      z: desk.z - lx * Math.sin(h) + lz * Math.cos(h),
      y: 0, heading: h + Math.PI, pose: 'stand', role: 'agent', seed: (seat0 + i * 7919) >>> 0,
    });
  }
  const set = new PeopleSet(scene, specs, { x: desk.x, z: desk.z },
    () => true,
    (x, z) => world.heightAt(x, z));
  return {
    update(dt, player) { set.update(dt, player); },
    dispose() { set.dispose(); },
  };
}
