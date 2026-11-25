// The flight to the Seychelles, its pure parts: the ticket and the passenger's
// steps (js/flight-trip.js), the taxi routes as something a wheel can follow
// (js/flight-path.js) and the take-off and landing (js/flight-profile.js), all
// against Pardubice's real runway and taxiways (js/airport-plan.js). The
// numbers pinned here are the ones a pilot would recognise, so a retune that
// turns the airliner into a catapult or lands it in the grass fails here.
import test from 'node:test';
import assert from 'node:assert';

const { newTrip, buyTicket, advance, crewCheck, reached, departureMinute, clockText, carryFor, tripFromCarry,
  skyHour, arrivalHour, ROUTES } = await import('../js/flight-trip.js');
const { makePath, taxiStep, headingOf, TAXI } = await import('../js/flight-path.js');
const { airlinerState, takeoffStep, landingStep, onFinal, runwayLocal, FLY } = await import('../js/flight-profile.js');
const A = await import('../js/airport-plan.js');

const wallet = (money) => ({
  money,
  canPay(n) { return n <= this.money; },
  pay(n) { if (n > this.money) return false; this.money -= n; return true; },
});

test('a ticket costs the fare once, and nothing when there is not enough money', () => {
  const poor = wallet(2500);
  const r0 = buyTicket(newTrip(), poor, 'out', 0.5);
  assert.equal(r0.ok, false);
  assert.equal(r0.why, 'money');
  assert.equal(poor.money, 2500, 'a refused sale takes nothing');
  const rich = wallet(20000);
  const r1 = buyTicket(newTrip(), rich, 'out', 0.5);
  assert.ok(r1.ok);
  assert.equal(rich.money, 20000 - ROUTES.out.fare);
  assert.equal(r1.trip.state, 'ticket');
  assert.equal(r1.trip.seat, '14A');
  assert.equal(r1.trip.gate, '2');
  const again = buyTicket(r1.trip, rich, 'out', 0.5);
  assert.ok(again.ok && again.why === 'have');
  assert.equal(rich.money, 20000 - ROUTES.out.fare, 'the second visit to the counter is free');
  assert.equal(buyTicket(r1.trip, rich, 'home').why, 'busy');
});

test('the passenger goes through the airport in order and cannot skip a step', () => {
  let trip = buyTicket(newTrip(), wallet(1e6), 'out').trip;
  assert.equal(advance(trip, 'gate').ok, false, 'no gate before security');
  assert.equal(advance(trip, 'aboard').ok, false, 'no cabin before the gate');
  assert.ok(crewCheck(trip), 'the crew turn back somebody who walked round the terminal');
  for (const e of ['security', 'gate', 'aboard', 'sit', 'depart', 'land', 'leave']) {
    const r = advance(trip, e);
    assert.ok(r.ok, e + ' refused from ' + trip.state);
    trip = r.trip;
  }
  assert.equal(trip.state, 'done');
  assert.equal(crewCheck(newTrip()) !== null, true);
  const boarding = { ...newTrip(), state: 'boarding' };
  assert.equal(crewCheck(boarding), null, 'a scanned boarding pass is let in');
  assert.ok(reached({ ...newTrip(), state: 'seated' }, 'aboard'));
  // a used ticket can be followed by the next one
  assert.ok(buyTicket(trip, wallet(1e6), 'home').ok);
});

test('the boards show a departure half an hour ahead, on the five minutes', () => {
  assert.equal(clockText(departureMinute(21 / 24)), '21:30');
  assert.equal(clockText(departureMinute((21 * 60 + 2) / 1440)), '21:35');
  assert.equal(clockText(departureMinute((23 * 60 + 50) / 1440)), '0:20');
});

test('the hand-over carries a flying trip across the region switch and nothing else', () => {
  let trip = buyTicket(newTrip(), wallet(1e6), 'out').trip;
  for (const e of ['security', 'gate', 'aboard', 'sit', 'depart']) trip = advance(trip, e).trip;
  const c = JSON.parse(JSON.stringify(carryFor(trip, { dep: 0.8 })));
  const back = tripFromCarry(c);
  assert.equal(back.state, 'flying');
  assert.equal(back.no, 'ATC 740');
  assert.equal(c.dep, 0.8);
  assert.equal(tripFromCarry({ ...c, v: 99 }), null);
  assert.equal(tripFromCarry({ v: 1, trip: { ...trip, state: 'seated' } }), null);
  assert.equal(tripFromCarry(null), null);
});

test('the window shows ten hours pass and lands at the far side\'s local hour', () => {
  const dep = 18 / 24;
  const arr = arrivalHour(ROUTES.out, dep);
  // 18:00 in Pardubice + 10.2 h + 3 h of time zones = 07:12 on Mahé
  assert.ok(Math.abs(arr * 24 - 7.2) < 0.01, 'arrives at ' + arr * 24);
  // sunset and night pass in between: the hour runs through 21:00 somewhere
  let night = false;
  for (let k = 0; k <= 1; k += 0.05) if (Math.abs(skyHour(ROUTES.out, dep, k) * 24 - 23) < 1.2) night = true;
  assert.ok(night);
  const home = arrivalHour(ROUTES.home, 9 / 24);
  assert.ok(Math.abs(home * 24 - 16.6) < 0.01, 'home at ' + home * 24);
});

test('a taxi route turns on fillets, slows in the turns and stops on its last point', () => {
  const p = makePath(A.TAXI_OUT, 25);
  const end = p.at(p.length), last = A.TAXI_OUT.at(-1);
  assert.ok(Math.hypot(end.x - last[0], end.z - last[1]) < 0.1);
  // never further than a few metres from the mapped line (a fillet cuts the corner)
  for (let s = 0; s < p.length; s += 5) {
    const q = p.at(s);
    let best = Infinity;
    for (let i = 1; i < A.TAXI_OUT.length; i++) {
      const [ax, az] = A.TAXI_OUT[i - 1], [bx, bz] = A.TAXI_OUT[i];
      const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
      const t = Math.max(0, Math.min(1, ((q.x - ax) * (bx - ax) + (q.z - az) * (bz - az)) / L2));
      best = Math.min(best, Math.hypot(q.x - ax - (bx - ax) * t, q.z - az - (bz - az) * t));
    }
    assert.ok(best < 9, 'the path strays ' + best.toFixed(1) + ' m from the taxiway at ' + s);
  }
  // it leaves facing the runway, and its last heading is 09's
  const [ax, az] = A.RUNWAY.a, [bx, bz] = A.RUNWAY.b;
  const h09 = headingOf(bx - ax, bz - az);
  assert.ok(Math.abs(Math.atan2(Math.sin(end.heading - h09), Math.cos(end.heading - h09))) < 0.05);
  // the crew's speeds: never over the straight limit, slow in the tightest turn, stopped at the end
  let vmin = Infinity;
  for (let s = 20; s < p.length - 40; s += 1) vmin = Math.min(vmin, p.limit(s));
  assert.ok(vmin < 6, 'it takes the turns at ' + vmin.toFixed(1) + ' m/s');
  const st = { s: 0, v: 0 };
  let t = 0, vmax = 0;
  while (st.s < p.length && t < 400) { taxiStep(p, st, 1 / 30); t += 1 / 30; vmax = Math.max(vmax, st.v); }
  assert.ok(st.s === p.length && st.v === 0, 'it stops on the line');
  assert.ok(vmax <= TAXI.fast + 1e-6);
  assert.ok(t > 60 && t < 240, 'taxi out takes ' + t.toFixed(0) + ' s');
});

const [ax, az] = A.RUNWAY.a, [bx, bz] = A.RUNWAY.b;
const RUNWAY_LEN = Math.hypot(bx - ax, bz - az);

test('the take-off rotates at VR, leaves the runway with room to spare and climbs onto its track', () => {
  const rw = { x: A.LINEUP.x, z: A.LINEUP.z, heading: headingOf(bx - ax, bz - az), y: 225 };
  const m = airlinerState(rw.x, rw.y, rw.z, rw.heading);
  let lof = null, rotateAt = null;
  const outbound = -2.46; // south-east
  for (let t = 0; t < 150; t += 1 / 60) {
    takeoffStep(m, rw, outbound, 1 / 60);
    if (!rotateAt && m.pitch > 0) rotateAt = m.speed;
    if (!lof && !m.onGround) lof = { s: runwayLocal(rw, m.x, m.z).s, v: m.speed, t };
  }
  assert.ok(Math.abs(rotateAt - FLY.vr) < 1, 'rotates at ' + rotateAt);
  assert.ok(lof.s > 1200 && lof.s < 1900, 'lifts off after ' + lof.s.toFixed(0) + ' m');
  const runwayLeft = RUNWAY_LEN - Math.hypot(A.LINEUP.x - ax, A.LINEUP.z - az);
  assert.ok(lof.s < runwayLeft - 500, 'not at the far end of the runway');
  assert.ok(lof.t > 30 && lof.t < 50, 'the roll takes ' + lof.t.toFixed(0) + ' s');
  assert.ok(m.y - rw.y > 700, 'climbs ' + (m.y - rw.y).toFixed(0) + ' m in two and a half minutes');
  assert.equal(m.gear, 0);
  assert.equal(m.flaps, 0);
  assert.ok(Math.abs(Math.atan2(Math.sin(m.heading - outbound), Math.cos(m.heading - outbound))) < 0.1, 'on its track');
});

test('the landing on 27 touches down in the zone, gently, and is slow before the exit', () => {
  const rw = { x: bx, z: bz, heading: headingOf(ax - bx, az - bz), y: 225 };
  const m = onFinal(rw, 9000);
  m.x += 60; // a little off the centreline, the way a real intercept is
  for (let t = 0; t < 400 && m.phase !== 'vacate'; t += 1 / 60) landingStep(m, rw, 1 / 60);
  assert.ok(m.touchdown, 'it lands');
  assert.ok(m.touchdown.s > 150 && m.touchdown.s < 750, 'touches down ' + m.touchdown.s.toFixed(0) + ' m in');
  assert.ok(m.touchdown.vy > -1.5, 'sinking at ' + m.touchdown.vy.toFixed(2) + ' m/s');
  const { s, e } = runwayLocal(rw, m.x, m.z);
  const exit = runwayLocal(rw, A.EXIT_27.x, A.EXIT_27.z).s;
  assert.ok(s < exit, 'taxi speed at ' + s.toFixed(0) + ' m, the exit is at ' + exit.toFixed(0));
  assert.ok(Math.abs(e) < 6, 'on the centreline, ' + e.toFixed(1) + ' m off');
});

test('the whole trip runs headless: stand, doors, taxi, take-off, climb, cruise, final, taxi in, parked', async () => {
  const { flightSequence, CRUISE_ALT } = await import('../js/flight-sequence.js');
  const { LKPD, destinationOf, seychelles } = await import('../js/flight-airports.js');
  const ground = () => 225;
  const seq = flightSequence(LKPD, ground);
  assert.equal(seq.phase, 'stand');
  assert.ok(seq.open, 'the stairs are docked and L1 is open at the stand');
  seq.begin();
  const seen = new Set();
  let t = 0;
  for (; t < 600 && seq.phase !== 'climb'; t += 1 / 30) { seq.update(1 / 30); seen.add(seq.phase); }
  assert.deepEqual([...seen], ['doors', 'taxiOut', 'takeoff', 'climb']);
  assert.ok(!seq.open);
  for (let k = 0; k < 30 * 40; k++) seq.update(1 / 30);
  seq.cruise();
  assert.equal(seq.phase, 'cruise');
  assert.equal(seq.m.y, CRUISE_ALT);
  // the placeholder destination is Pardubice itself, and it says so
  const dest = destinationOf({ to: 'SEZ' }, null);
  assert.ok(dest.placeholder);
  seq.arrive(dest.airport);
  for (t = 0; t < 900 && seq.phase !== 'parked'; t += 1 / 30) { seq.update(1 / 30); seen.add(seq.phase); }
  assert.equal(seq.phase, 'parked', 'stuck in ' + seq.phase);
  assert.ok(['final', 'landing', 'taxiIn'].every((p) => seen.has(p)));
  for (let k = 0; k < 30 * 15; k++) seq.update(1 / 30);
  assert.ok(seq.open, 'the stairs come back and the door opens');
  const st = LKPD.taxiIn.at(-1);
  assert.ok(Math.hypot(seq.m.x - st[0], seq.m.z - st[1]) < 1, 'parked on the stand');
  // a real Seychelles description is used as soon as there is one
  const sez = seychelles({ runway: { a: [0, 0], b: [2000, 2000] }, stand: { x: 500, z: 100, heading: 0 } });
  assert.equal(destinationOf({ to: 'SEZ' }, { runway: { a: [0, 0], b: [2000, 2000] }, stand: { x: 500, z: 100, heading: 0 } }).placeholder, false);
  assert.equal(sez.iata, 'SEZ');
});

// Seychelles International as the Mahé region describes it (js/regions.js of
// the other session, surveyed from OSM on 21 Nov 2026: 2 986 m on 13/31, the
// stand on the apron by the terminal near the 13 end, nose north-west)
const SEZ_DESC = {
  runway: { width: 46, ends: { '13': { x: 6745.8, z: -94847.6, elev: 3.8 }, '31': { x: 9197.2, z: -93142.5, elev: 4.4 } } },
  stand: { x: 6870.4, z: -94500.4, heading: 0.9631 },
  terminal: { landside: { x: 6792.8, z: -94327.2 } },
};

test('Mahé: land on 13, turn round on the runway, backtrack and park on the stand', async () => {
  const { flightSequence } = await import('../js/flight-sequence.js');
  const { seychelles } = await import('../js/flight-airports.js');
  const sez = seychelles(SEZ_DESC);
  assert.ok(sez && sez.iata === 'SEZ');
  const len = Math.hypot(9197.2 - 6745.8, -93142.5 + 94847.6);
  assert.ok(Math.abs(len - 2986) < 2, 'the runway is ' + len.toFixed(0) + ' m');
  const seq = flightSequence(sez, () => 3);
  seq.arrive(sez);
  const { runwayLocal } = await import('../js/flight-profile.js');
  const standE = Math.abs(runwayLocal(sez.land, 6870.4, -94500.4).e);
  let t = 0, td = null, wide = 0;
  for (; t < 900 && seq.phase !== 'parked'; t += 1 / 30) {
    seq.update(1 / 30);
    if (!td && seq.m.touchdown) td = seq.m.touchdown;
    // on the ground it keeps to the runway and the apron: never out over the grass beyond the stand
    if (seq.m.onGround) wide = Math.max(wide, Math.abs(runwayLocal(sez.land, seq.m.x, seq.m.z).e));
  }
  assert.ok(wide < standE + 30, 'strays ' + wide.toFixed(0) + ' m off the centreline (the stand is ' + standE.toFixed(0) + ')');
  assert.equal(seq.phase, 'parked', 'stuck in ' + seq.phase);
  assert.ok(td.s > 150 && td.s < 750, 'touchdown ' + td.s.toFixed(0) + ' m past 13');
  assert.ok(Math.hypot(seq.m.x - 6870.4, seq.m.z + 94500.4) < 1, 'on the stand');
  for (let k = 0; k < 30 * 15; k++) seq.update(1 / 30);
  assert.ok(seq.open);
});

test('Mahé to Pardubice: backtrack to 13, take off, turn for Dubai, and come down on 27 at home', async () => {
  const { flightSequence } = await import('../js/flight-sequence.js');
  const { seychelles, LKPD } = await import('../js/flight-airports.js');
  const sez = seychelles(SEZ_DESC);
  const seq = flightSequence(sez, (x, z) => (z < -50000 ? 3 : 225));
  seq.begin();
  let t = 0;
  for (; t < 900 && seq.phase !== 'climb'; t += 1 / 30) seq.update(1 / 30);
  assert.equal(seq.phase, 'climb');
  assert.ok(t < 420, 'out to the runway and airborne in ' + t.toFixed(0) + ' s');
  for (let k = 0; k < 30 * 170; k++) seq.update(1 / 30);
  const err = Math.atan2(Math.sin(seq.m.heading - sez.outbound), Math.cos(seq.m.heading - sez.outbound));
  assert.ok(Math.abs(err) < 0.15, 'turned onto the track home');
  seq.cruise();
  seq.arrive(LKPD);
  for (t = 0; t < 900 && seq.phase !== 'parked'; t += 1 / 30) seq.update(1 / 30);
  assert.equal(seq.phase, 'parked');
});

test('the way through the terminal at Mahé: a door on the face that looks at the stand', async () => {
  const { doorToward } = await import('../js/flight-sez.js');
  // a 100 x 40 m terminal with the stand 60 m off its north face
  const ring = [[0, 0], [100, 0], [100, 40], [0, 40]];
  const d = doorToward(ring, { x: 70, z: -60 }, 3);
  assert.ok(Math.abs(d.x - 70) < 1e-9 && Math.abs(d.z + 3) < 1e-9, 'three metres out of the north face, opposite the stand');
  const corner = doorToward(ring, { x: 130, z: -30 }, 3);
  assert.ok(corner.x > 100 && corner.z < 0, 'off a corner it steps out diagonally');
});

test('at Mahé the routes follow the mapped taxiways of the real tile, not the grass', async () => {
  const { readFileSync } = await import('node:fs');
  const { seychelles } = await import('../js/flight-airports.js');
  const { makePath } = await import('../js/flight-path.js');
  const tile = JSON.parse(readFileSync(new URL('../public/data/regions/mahe/tiles/1_-20.json', import.meta.url), 'utf8'));
  const ways = tile.roads.filter((r) => r.t === 'taxiway' || r.t === 'taxilane' || r.t === 'runway');
  const { REGIONS } = await import('../js/regions.js');
  const sez = seychelles(REGIONS.mahe.airport, () => ways);
  const off = (x, z) => {
    let best = Infinity;
    for (const w of ways) for (let i = 1; i < w.p.length; i++) {
      const [ax, az] = w.p[i - 1], [bx, bz] = w.p[i], L2 = (bx - ax) ** 2 + (bz - az) ** 2;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
      best = Math.min(best, Math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t));
    }
    return best;
  };
  for (const [name, pts, skipHead, skipTail] of [['out', sez.taxiOut, 1, 0], ['in', sez.taxiIn, 0, 2]]) {
    const path = makePath(pts, 25, 0);
    // the stand and its lead-in are on the apron, off any line; everything between follows the taxiways
    const a = makePath(pts.slice(0, skipHead + 1), 25).length + 30, b = path.length - makePath(pts.slice(-skipTail - 1), 25).length - 30;
    let worst = 0;
    for (let s = a; s < b; s += 5) { const q = path.at(s); worst = Math.max(worst, off(q.x, q.z)); }
    assert.ok(worst < 30, name + ': ' + worst.toFixed(0) + ' m off the mapped taxiways');
    assert.ok(path.length > 300 && path.length < 2600, name + ' is ' + path.length.toFixed(0) + ' m');
  }
});
