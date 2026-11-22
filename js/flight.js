// ---- flight.js: Pardubice to the Seychelles, and back ----
// The owner main.js holds while the player is at an airport (Frank, 21 Nov
// 2026: "aby na letisti v pardubicich se dalo letat na Seychelly"). It ties
// the rest together:
//   js/flight-trip.js       the passenger's steps and the ticket
//   js/flight-terminal.js   check-in, the security arch, the gate (Pardubice)
//   js/flight-cabin.js      up the stairs, down the aisle, into seat 14A
//   js/flight-sequence.js   what the aircraft does, stand to stand
//   js/flight-cruise.js     the ten hours in the window, shown as a minute
//   js/flight-airports.js   the two ends, and the placeholder for the far one
//   js/airliner.js          the aircraft itself (and its cabin, its stairs)
// and offers main.js the same hooks the campaign's owners do: use (E), skip
// (T), toggleView (C), update, frameCamera, posePlayer; plus the walker's
// support and collision for the cabin and the stairs (world.airport).
//
// THE OTHER REGION is another page (js/regions.js of the Mahé work reloads
// the game with ?region=mahe), so the hand-over is a JSON carry and the far
// side resumes the flight on final approach. Until Mahé exists the far end
// is a placeholder (js/flight-airports.js says which), flown in this page.

import { makeAirliner } from './airliner.js';
import { makeAirstairs } from './airstairs.js';
import { AIRLINER, STAIRS, STAIRS_FOOT_X, seatAt } from './airliner-layout.js';
import { newTrip, buyTicket, advance, crewCheck, reached, ROUTES, carryFor, tripFromCarry, skyHour, clockText } from './flight-trip.js';
import { flightSequence } from './flight-sequence.js';
import { LKPD, destinationOf, seychelles } from './flight-airports.js';
import { terminalSteps } from './flight-terminal.js';
import { cabinPassenger } from './flight-cabin.js';
import { cruiseDeck } from './flight-cruise.js';
import { flightCamera } from './flight-camera.js';
import { flightSound } from './flight-sound.js';
import { flightHud } from './flight-hud.js';
import { lines, phaseText } from './flight-lines.js';
import { flightPassengers } from './flight-passengers.js';
import { overrideTod, setSoloTime, tod } from './worldclock.js';
import { DAY_LENGTH } from './config.js';
import { chunkKey } from './geo.js';

// the montage: fade in, the first leg, the stop in Dubai, the second leg, fade out (seconds)
const MONTAGE = { fade: 2.5, leg1: 22, stop: 5, leg2: 22, out: 3 };
const K_STOP = 0.56; // Dubai, as a share of the hours
// the passenger's eyes in 14A: over the cushion, a seated eye height of 1.2 m
// above the floor, the head back against the rest, half a metre from the window
const SEAT_14A = seatAt(14, 'A');
const EYE_14A = { x: SEAT_14A.x - Math.sign(SEAT_14A.x) * 0.1, y: AIRLINER.floorY + 1.2, z: SEAT_14A.z + 0.12 };

/**
 * @param o { scene, world, player, map, sky, wallet, terminal, region, coop, home }
 *   region  { id, mahe (the SEZ description or null), enter(id, spawn, carry) or null }
 *   home    'LKPD' at Pardubice, 'SEZ' on Mahé: where the parked aircraft waits
 */
export function createFlight(o) {
  const { scene, world, player, map, wallet } = o;
  const ground = (x, z) => world.heightAt(x, z);
  const sez = seychelles(o.region?.mahe);
  const homeAirport = o.home === 'SEZ' && sez ? sez : LKPD;
  const hud = flightHud(), cam = flightCamera(), sound = flightSound(), deck = cruiseDeck(scene);
  const steps = terminalSteps();
  const plane = makeAirliner(), stairs = makeAirstairs();
  plane.group.name = 'Let • dopravní letadlo OK-ATC';
  scene.add(plane.group);
  plane.group.add(stairs.group);
  plane.group.rotation.order = 'YXZ';
  const people = flightPassengers(plane.group);
  let trip = newTrip(), route = null, dest = null, seq = flightSequence(homeAirport, ground);
  let cabin = cabinPassenger(player);
  let montage = null, said = new Set(), sayT = 0, guideT = 0, done = 0, depTod = null, arrTod = null;

  function say(who, what, secs = 7, chime = false) {
    hud.say(who, what);
    sayT = secs;
    if (chime) sound.chime();
  }
  const once = (key, fn) => { if (!said.has(key)) { said.add(key); fn(); } };

  function syncPlane(dt) {
    const s = seq.state, m = seq.m;
    plane.group.position.set(m.x, m.y, m.z);
    plane.group.rotation.set(m.pitch, m.heading, m.roll);
    plane.setGear(m.gear);
    plane.setFlaps(m.flaps);
    plane.setDoor(s.door);
    // the stair truck backs away from the door and is gone
    stairs.group.visible = s.stairs > 0.01;
    stairs.group.position.set(-(1 - s.stairs) * 14, 0, 0);
    const night = o.sky?.nightK ?? 0;
    plane.setLights({ nav: true, beacon: s.beacon, strobe: s.strobe, landing: s.landing, logo: night > 0.3,
      cabin: seq.phase === 'cruise' && night > 0.5 ? 0.35 : 1, t: performance.now() / 1000 });
    plane.update(dt, { n1: m.n1 });
  }
  // The cabin always knows where the aircraft is (the seat rides it); it is
  // WALKED only at the stand, before the doors close and after they open.
  function poseForCabin() {
    const walk = seq.phase === 'stand' || seq.phase === 'parked';
    cabin.setPose(seq.m, seq.state.stairs > 0.99, seq.state.door > 0.95,
      seq.phase === 'parked' && reached(trip, 'flying') ? null : crewCheck(trip), walk);
  }

  // ---- the passenger's E -------------------------------------------------------
  function use() {
    if (montage) return true;
    if (cabin.seated) {
      if (seq.phase === 'parked' && seq.open) { cabin.rise(); return true; }
      say('Palubní průvodčí', lines.stayBelted, 4);
      return true;
    }
    if (cabin.busy) return true;
    if (cabin.aboard() && cabin.nearSeat() && reached(trip, 'aboard') && !reached(trip, 'arrived')) {
      cabin.sit();
      trip = advance(trip, 'sit').trip;
      return true;
    }
    const at = player.pos;
    if (homeAirport === LKPD && steps.counterAt(at.x, at.z)) {
      const r = buyTicket(trip, wallet, 'out', tod());
      if (r.ok && r.why !== 'have') {
        trip = r.trip; route = ROUTES.out; said.clear();
        if (seq.phase !== 'stand') seq = flightSequence(homeAirport, ground, seq.m);
        say('Přepážka ' + steps.counterAt(at.x, at.z).no, lines.sold(trip), 8);
      } else if (r.why === 'have') say('Přepážka', lines.haveTicket(trip), 5);
      else if (r.why === 'money') say('Přepážka', lines.noMoney(ROUTES.out.fare), 6);
      return true;
    }
    if (homeAirport === LKPD && trip.state === 'airside' && steps.deskAt(at.x, at.z, trip.gate)) {
      trip = advance(trip, 'gate').trip;
      o.terminal?.setGate(trip.gate, true);
      say('Gate ' + trip.gate, lines.boarding, 8);
      return true;
    }
    // at Mahé the desk sells, checks and boards in one go (a small set by the terminal)
    if (homeAirport !== LKPD && sez && nearDesk(at)) {
      const r = buyTicket(trip, wallet, 'home', tod());
      if (r.ok && r.why !== 'have') {
        trip = advance(advance(r.trip, 'security').trip, 'gate').trip; route = ROUTES.home; said.clear();
        if (seq.phase !== 'stand') seq = flightSequence(homeAirport, ground, seq.m);
        say('Odbavení', lines.soldHome(trip), 8);
      } else if (r.why === 'money') say('Odbavení', lines.noMoney(ROUTES.home.fare), 6);
      return true;
    }
    return false;
  }
  // the passenger's side of the SEZ counter: a metre in front of it, toward the door
  const nearDesk = (p) => {
    const d = homeAirport.desk;
    if (!d) return false;
    return Math.hypot(p.x - (d.x + Math.sin(d.heading) * 1.1), p.z - (d.z + Math.cos(d.heading) * 1.1)) < 1.6;
  };

  function skip() {
    if (montage) { montage.t = Math.max(montage.t, montageLength() - MONTAGE.out); return; }
    if (seq.skip()) {
      hud.veil(true, '', '', true);
      setTimeout(() => hud.veil(false), 60);
    }
  }
  const montageLength = () => MONTAGE.fade + MONTAGE.leg1 + MONTAGE.stop + MONTAGE.leg2 + MONTAGE.out;

  // ---- the montage: ten hours as a minute ---------------------------------------
  function startMontage() {
    depTod = tod();
    dest = destinationOf(route, o.region?.mahe);
    arrTod = skyHour(route, depTod, 1);
    montage = { t: 0, veiled: false };
    hud.veil(true, route.toName, lines.cruise(route), false);
    once('cruise', () => say('Kapitán', lines.climbing(route), 8, true));
  }
  function montageStep(dt) {
    const M = MONTAGE;
    montage.t += dt;
    const t = montage.t;
    if (t > M.fade * 0.6 && seq.phase !== 'cruise') { seq.cruise(); deck.show(true); cam.set(true); cam.reset(); }
    if (t > M.fade && !montage.lifted) { montage.lifted = true; hud.veil(false); }
    // where in the trip we are, 0..1 of the hours
    let k;
    const a = M.fade, b = a + M.leg1, c = b + M.stop, d = c + M.leg2;
    if (t < b) k = 0.04 + (K_STOP - 0.04) * Math.max(0, (t - a) / M.leg1);
    else if (t < c) k = K_STOP;
    else k = K_STOP + (0.97 - K_STOP) * Math.min(1, (t - c) / M.leg2);
    if (t >= b && t < c && !montage.stopShown) { montage.stopShown = true; hud.veil(true, route.via, lines.stop(route)); }
    if (t >= c && montage.stopShown && !montage.stopDone) { montage.stopDone = true; hud.veil(false); }
    overrideTod(skyHour(route, depTod, k));
    hud.trip(route, k, K_STOP, route.hours * k, skyHour(route, depTod, k));
    const sea = route.dir === 'out' ? (k < 0.42 ? 0 : k < K_STOP ? 0.8 : 1) : (k < 0.44 ? 1 : k < 0.6 ? 0.8 : 0);
    deck.update(dt, seq.m, cameraEye, o.sky, scene.fog?.color, sea);
    if (t >= d && !montage.out) { montage.out = true; hud.veil(true, route.toName, lines.approach(route, dest)); }
    if (t >= d + M.out && !montage.handed) { montage.handed = true; handOff(); }
  }
  const cameraEye = { x: 0, y: 0, z: 0 };

  function handOff() {
    const r = route.region;
    const carry = carryFor(trip, { dep: depTod, arr: arrTod });
    if (o.region?.enter && !dest.placeholder && r !== o.region.id) {
      // another page: the far side reads this back (resume) and lands us
      o.region.enter(r, route.dir === 'out' ? 'sez-arrival' : 'pce-arrival', { flight: carry });
      montage.t = -1e9; // nothing more happens in this page
      return;
    }
    land(dest.airport);
  }
  // The far side's final approach. The black card stays up until the ground
  // under the aircraft has streamed in (at most eight seconds), the way the
  // campaign's skipped train waits for Pardubice.
  function land(airport) {
    montage = null;
    deck.show(false);
    hud.trip(null);
    overrideTod(arrTod);
    seq.arrive(airport);
    cam.set(true);
    world.city?.ensureTiles?.(seq.m.x, seq.m.z)?.catch?.(() => {});
    world.terrain?.ensure?.(seq.m.x, seq.m.z);
    arriving = 8;
    once('final', () => say('Kapitán', lines.landing(route, arrTod, dest?.placeholder), 9, true));
  }
  let arriving = 0;
  const groundReady = () => (world.terrain?.ready?.(seq.m.x, seq.m.z) ?? true) && (world.built?.has?.(chunkKey(seq.m.x, seq.m.z)) ?? true);
  /** The far side of a page switch: put the passenger in 14A on final. */
  function resume(c) {
    const t = tripFromCarry(c);
    if (!t) return false;
    trip = t; route = ROUTES[t.dir]; depTod = c.dep; arrTod = c.arr;
    dest = destinationOf(route, o.region?.mahe);
    seq = flightSequence(dest.airport, ground);
    hud.veil(true, route.toName, lines.approach(route, dest), true);
    land(dest.airport);
    cabin = cabinPassenger(player, t.seat);
    poseForCabin();
    cabin.seatNow();
    return true;
  }

  // ---- every frame ------------------------------------------------------------
  function update(dt) {
    if (arriving > 0) {
      // behind the black card the aircraft waits on final for the ground to arrive
      arriving -= dt;
      if (groundReady() || arriving <= 0) { arriving = 0; hud.veil(false); }
    } else if (montage) montageStep(dt);
    else seq.update(dt);
    syncPlane(dt);
    poseForCabin();
    const cabinOn = cabin.aboard() || cabin.busy || Math.hypot(player.pos.x - seq.m.x, player.pos.z - seq.m.z) < 45;
    plane.setCabin(cabinOn);
    // the others board with him: nobody aboard before the gate opens, everybody once he is in
    people.show(cabinOn && reached(trip, 'boarding') && trip.state !== 'done');
    const at = player.pos;
    if (homeAirport === LKPD) {
      const ev = steps.step(at.x, at.z, trip);
      if (ev === 'security') { trip = advance(trip, 'security').trip; say('Bezpečnostní kontrola', lines.cleared, 5); }
    }
    if (trip.state === 'boarding' && cabin.aboard()) {
      trip = advance(trip, 'aboard').trip;
      say('Palubní průvodčí', lines.welcome(trip), 7);
    }
    if (cabin.crewLine && !cabin.aboard() && nearDoor()) once('crew' + trip.state, () => say('Palubní průvodčí', cabin.crewLine, 6));
    // seated: the doors close and the flight begins
    if (trip.state === 'seated' && cabin.seated && seq.phase === 'stand') {
      trip = advance(trip, 'depart').trip;
      seq.begin();
      cam.set(true); cam.reset();
      say('Kapitán', lines.aboard(route), 9, true);
      o.terminal?.setGate(trip.gate, false);
    }
    if (seq.phase === 'taxiOut') once('taxi', () => say('Palubní rozhlas', lines.taxi, 6));
    if (seq.phase === 'climb' && !montage && (seq.m.y - seq.state.rwDep.y > 900 || seq.state.t > 70)) startMontage();
    if (seq.phase === 'parked' && reached(trip, 'flying') && trip.state === 'flying' && seq.state.t > 3) {
      trip = advance(trip, 'land').trip;
      say('Palubní rozhlas', lines.arrived(route, dest), 9, true);
    }
    if (trip.state === 'arrived' && !cabin.busy && !cabin.aboard() && !onStairs()) finish();
    // hearing it: inside it is a muffled rush, outside the whole machine
    const inside = cabin.aboard() && cam.inside ? 1 : cabin.aboard() ? 0.6 : 0;
    const near = Math.hypot(at.x - seq.m.x, at.z - seq.m.z) < 600;
    if (near || cabin.aboard()) sound.update(seq.m.n1, seq.m.speed, inside, seq.m.reverse ?? 0);
    else sound.stop();
    if (arrTod != null && !montage && trip.state !== 'done') overrideTod((arrTod += dt / DAY_LENGTH));
    if (done > 0 && (done -= dt) <= 0) hud.guide('', '', '');
    if ((sayT -= dt) <= 0 && sayT > -1) hud.say();
    if ((guideT -= dt) <= 0) { guideT = 0.2; refresh(); }
  }
  const nearDoor = () => Math.hypot(player.pos.x - seq.m.x, player.pos.z - seq.m.z) < 26 && player.y > seq.m.y + 1.5;
  const onStairs = () => Math.hypot(player.pos.x - seq.m.x, player.pos.z - seq.m.z) < 24 && player.y > seq.m.y + 0.4;

  function finish() {
    trip = advance(trip, 'leave').trip;
    hud.pass(null);
    hud.guide(dest?.placeholder ? 'Letiště Pardubice' : route.toName, lines.welcomeTo(route, dest), lines.welcomeHelp(route, dest));
    done = 8;
    // the hour the window ended on becomes the world's (solo; co-op keeps the shared clock)
    if (!o.coop?.() && arrTod != null) setSoloTime(arrTod);
    overrideTod(null);
    arrTod = null;
    map?.setWaypoint?.(null);
  }

  function refresh() {
    const at = player.pos;
    // (during the montage the trip's map says it all, and on a small screen they would overlap)
    if (route) hud.pass(trip.state === 'done' || trip.state === 'none' || montage ? null : trip, route, phaseText(trip, seq.phase));
    let action = '';
    if (cabin.seated) action = seq.phase === 'parked' && seq.open ? 'Vstát' : '';
    else if (cabin.aboard() && cabin.nearSeat() && reached(trip, 'aboard') && !reached(trip, 'arrived')) action = 'Sednout si (' + trip.seat + ')';
    else if (homeAirport === LKPD && steps.counterAt(at.x, at.z)) {
      action = reached(trip, 'ticket') && trip.state !== 'done' ? '' : 'Koupit letenku (' + ROUTES.out.fare.toLocaleString('cs-CZ') + ' Kč)';
    } else if (homeAirport === LKPD && trip.state === 'airside' && steps.deskAt(at.x, at.z, trip.gate)) action = 'Naskenovat palubní vstupenku';
    else if (homeAirport !== LKPD && nearDesk(at) && !reached(trip, 'ticket')) action = 'Koupit letenku domů (' + ROUTES.home.fare.toLocaleString('cs-CZ') + ' Kč)';
    hud.action(action);
    hud.offer(montage ? 'Přeskočit let' : seq.phase === 'taxiOut' || seq.phase === 'taxiIn' ? 'Přeskočit pojíždění' : '');
    if (done > 0) return;
    if (montage) { hud.guide('', '', ''); return; }
    const g = lines.guide(trip, seq.phase, homeAirport === LKPD ? steps.zone(at.x, at.z) : null, route ?? ROUTES[homeAirport === LKPD ? 'out' : 'home']);
    hud.guide(...g);
    // the waypoint: the counter, the lanes, the gate, then the aircraft
    let target = homeAirport === LKPD ? steps.target(trip, trip.gate) : null;
    if (!target && (trip.state === 'boarding' || (homeAirport !== LKPD && trip.state === 'boarding'))) target = stairsFoot();
    if (cabin.aboard() || reached(trip, 'aboard')) target = null;
    if (steps.inside(at.x, at.z) || reached(trip, 'ticket')) map?.setWaypoint?.(target ? target.x : null, target?.z);
  }
  function stairsFoot() {
    const m = seq.m, c = Math.cos(m.heading), s = Math.sin(m.heading);
    const lx = STAIRS_FOOT_X - 1.5, lz = STAIRS.zCentre;
    return { x: m.x + lx * c + lz * s, z: m.z - lx * s + lz * c };
  }

  // the HUD's own buttons do what E and T do (a click, or a touch screen)
  hud.button.onclick = () => use();
  hud.skip.onclick = () => skip();
  hud.guide('', '', '');

  return {
    use, skip, update, resume,
    toggleView() { return seq.phase !== 'stand' && cabin.seated ? cam.toggle() : false; },
    get aboard() { return cabin.aboard(); },
    get flying() { return seq.phase !== 'stand' && seq.phase !== 'parked'; },
    get busy() { return trip.state !== 'none' && trip.state !== 'done'; },
    get phase() { return seq.phase; },
    get trip() { return trip; },
    get plane() { return seq.m; },
    frameCamera(camera, dt, drag) {
      if (!cabin.seated && !(cabin.busy && seq.phase !== 'stand')) return false;
      const r = cam.frame(camera, dt, drag, plane.group, EYE_14A, ground);
      cameraEye.x = camera.position.x; cameraEye.y = camera.position.y; cameraEye.z = camera.position.z;
      return r;
    },
    // Seated, the body rides the airframe (the seat's frame follows the
    // aircraft every frame), so the world streams round wherever it is.
    posePlayer(dt) { return cabin.posePlayer(dt); },
    hooks: {
      carrying: (x, z) => cabin.carrying(x, z),
      floor: (x, z, maxY) => cabin.floor(x, z, maxY),
      collide: (pos, r, opts) => cabin.collide(pos, r, opts) || (homeAirport === LKPD && opts?.interior ? steps.collide(pos, r, trip) : false),
    },
    dispose() {
      sound.stop();
      deck.dispose();
      hud.close();
      if (!trip || trip.state === 'done' || trip.state === 'none') overrideTod(null);
      people.dispose();
      scene.remove(plane.group);
      plane.dispose();
      stairs.dispose();
      map?.setWaypoint?.(null);
    },
  };
}
