// ---- flight-sequence.js: what the aircraft does, from the stand to the stand ----
// Pure (no three.js, no DOM): js/flight.js reads the pose and the airframe's
// switches from it every frame and draws them; the test runs it headless from
// the stand at Pardubice to the stand at the other end.
//
//   stand ─begin─▶ doors ─▶ taxiOut ─▶ takeoff ─▶ climb ─cruise()─▶ cruise
//   cruise ─arrive(airport)─▶ final ─▶ landing ─▶ taxiIn ─▶ parked
//
// `doors` is the minute before pushback in eight seconds: L1 closes, the
// airstairs drive off, the beacon comes on, the engines spool to idle. The
// cruise is not flown: the montage (js/flight-cruise.js) holds the aircraft
// at altitude while the hours go by in the window, and the far side's final
// approach starts it again. Every airport is the shape js/flight-airports.js
// gives, so the sequence never knows which country it is in.

import { makePath, taxiStep } from './flight-path.js';
import { airlinerState, takeoffStep, landingStep, onFinal, runwayLocal, runwayWorld } from './flight-profile.js';

export const CRUISE_ALT = 10700; // m, FL350
const DOORS_T = 8;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param airport where the aircraft stands (js/flight-airports.js shape)
 * @param ground (x, z) → the ground's height there (world.heightAt)
 * @param from { x, z, heading } where it really stands, when that is not the
 *   stand (an aircraft that came in and parked facing the way the taxi line ends)
 */
export function flightSequence(airport, ground, from = null) {
  const st = from ?? airport.stand;
  let at = airport;
  const m = airlinerState(st.x, ground(st.x, st.z), st.z, st.heading);
  const s = {
    m,
    phase: 'stand',
    t: 0, // seconds in this phase
    door: 1, // L1: 1 open
    stairs: 1, // 1 docked at L1, 0 driven away
    beacon: false, strobe: false, landing: false,
    path: null, taxi: { s: 0, v: 0 },
    rwDep: null, rwLand: null,
  };
  const runway = (f) => ({ ...f, y: ground(f.x, f.z) });
  function go(phase) { s.phase = phase; s.t = 0; }

  function begin() {
    if (s.phase === 'stand') go('doors');
  }
  function startTaxiOut() {
    s.path = makePath(at.taxiOut, 25, 0);
    s.taxi = { s: 0, v: 0 };
    go('taxiOut');
  }
  function startTakeoff() {
    s.rwDep = runway(at.depart);
    Object.assign(m, { x: s.rwDep.x, z: s.rwDep.z, y: s.rwDep.y, heading: s.rwDep.heading, speed: 0, vy: 0, pitch: 0,
      roll: 0, onGround: true, flaps: 0.35, gear: 1 });
    go('takeoff');
  }
  /** The climb is over: hold the aircraft at cruise for the montage. */
  function cruise() {
    if (s.phase !== 'climb' && s.phase !== 'takeoff') return;
    Object.assign(m, { y: CRUISE_ALT, pitch: 2.4 * Math.PI / 180, roll: 0, vy: 0, speed: 235, gear: 0, flaps: 0, n1: 0.82,
      onGround: false, heading: at.outbound });
    s.landing = false;
    go('cruise');
  }
  /** Start the far side: on final for `airport`'s landing runway, `dist` metres out. */
  function arrive(airport, dist = 9000) {
    at = airport;
    s.rwLand = runway(airport.land);
    Object.assign(m, onFinal(s.rwLand, dist));
    s.door = 0; s.stairs = 0; s.beacon = true; s.strobe = true; s.landing = true;
    go('final');
  }
  function startTaxiIn() {
    // The route in begins where the aircraft is. Where the way off lies ahead
    // (Pardubice: the high-speed link off 27) it drops the points already
    // rolled past; where it lies BEHIND (Seychelles: no parallel taxiway, the
    // apron by the 13 end) the crew turn round on the runway, a 180 on its
    // 46 m, and backtrack along the centreline.
    const here = runwayLocal(s.rwLand, m.x, m.z).s;
    const first = at.taxiIn[0], behind = runwayLocal(s.rwLand, first[0], first[1]).s < here - 20;
    let pts;
    if (behind) {
      const side = Math.sign(runwayLocal(s.rwLand, at.stand.x, at.stand.z).e) || 1;
      const p = (ss, e) => { const q = runwayWorld(s.rwLand, ss, e); return [q.x, q.z]; };
      pts = [p(here + 30, -12 * side), p(here + 34, 0), p(here + 30, 12 * side), p(here, 4 * side), p(here - 60, 0), ...at.taxiIn];
    } else {
      let i = 0;
      while (i < at.taxiIn.length - 1 && runwayLocal(s.rwLand, at.taxiIn[i][0], at.taxiIn[i][1]).s < here + 5) i++;
      pts = at.taxiIn.slice(i);
    }
    s.path = makePath([[m.x, m.z], ...pts], 25, 0);
    s.taxi = { s: 0, v: m.speed };
    go('taxiIn');
  }

  function update(dt) {
    s.t += dt;
    switch (s.phase) {
      case 'stand':
        m.n1 = Math.max(0, m.n1 - dt * 0.05);
        break;
      case 'doors': {
        s.door = clamp01(1 - s.t / 3);
        s.stairs = clamp01(1 - (s.t - 2.5) / 4);
        s.beacon = s.t > 4;
        m.n1 = Math.min(0.22, m.n1 + dt * 0.05);
        if (s.t >= DOORS_T) startTaxiOut();
        break;
      }
      case 'taxiOut': {
        taxiStep(s.path, s.taxi, dt);
        const p = s.path.at(s.taxi.s);
        m.x = p.x; m.z = p.z; m.y = ground(p.x, p.z);
        // a nosewheel steers onto the line: never a snap, even from a stand it was parked across
        const dh = Math.atan2(Math.sin(p.heading - m.heading), Math.cos(p.heading - m.heading));
        m.heading += dh * Math.min(1, dt * 2.5);
        m.speed = s.taxi.v;
        m.n1 = 0.22 + 0.08 * clamp01((s.taxi.v - 2) / 8);
        m.flaps = Math.min(0.35, m.flaps + dt * 0.03);
        if (s.taxi.s >= s.path.length) startTakeoff();
        break;
      }
      case 'takeoff':
      case 'climb':
        s.strobe = true; s.landing = m.y - s.rwDep.y < 3000;
        takeoffStep(m, s.rwDep, at.outbound, dt);
        if (!m.onGround) s.phase = 'climb';
        break;
      case 'cruise':
        break;
      case 'final':
      case 'landing':
        landingStep(m, s.rwLand, dt);
        if (m.onGround) s.phase = 'landing';
        if (m.phase === 'vacate') startTaxiIn();
        break;
      case 'taxiIn': {
        s.strobe = false;
        s.landing = false;
        taxiStep(s.path, s.taxi, dt);
        const p = s.path.at(s.taxi.s);
        m.x = p.x; m.z = p.z; m.y = ground(p.x, p.z);
        // turn smoothly onto the path's heading (the rollout ended on the runway's)
        const d = Math.atan2(Math.sin(p.heading - m.heading), Math.cos(p.heading - m.heading));
        m.heading += d * Math.min(1, dt * 3);
        m.speed = s.taxi.v;
        m.pitch = 0; m.roll = 0; m.reverse = 0;
        m.flaps = Math.max(0, m.flaps - dt / 15);
        m.n1 = 0.22 + 0.06 * clamp01((s.taxi.v - 2) / 8);
        if (s.taxi.s >= s.path.length) { go('parked'); s.beacon = true; }
        break;
      }
      case 'parked':
        // the engines run down, the beacon goes out, the stairs come, the door opens
        m.n1 = Math.max(0, m.n1 - dt * 0.06);
        s.beacon = s.t < 6;
        s.stairs = clamp01((s.t - 7) / 4);
        s.door = clamp01((s.t - 10.5) / 3);
        break;
    }
    return s;
  }

  /** T: what can be skipped now, and doing it. → true when something was skipped. */
  function skip() {
    if (s.phase === 'taxiOut') { startTakeoff(); return true; }
    if (s.phase === 'taxiIn') {
      s.taxi.s = s.path.length; s.taxi.v = 0;
      const p = s.path.at(s.path.length);
      Object.assign(m, { x: p.x, z: p.z, heading: at.stand.heading, y: ground(p.x, p.z), speed: 0 });
      go('parked');
      return true;
    }
    return false;
  }
  return {
    state: s, m, begin, update, cruise, arrive, skip,
    get phase() { return s.phase; },
    get airport() { return at; },
    /** Is the aircraft open for walking on and off (stairs docked, door open)? */
    get open() { return (s.phase === 'stand' || s.phase === 'parked') && s.stairs > 0.99 && s.door > 0.95; },
  };
}
