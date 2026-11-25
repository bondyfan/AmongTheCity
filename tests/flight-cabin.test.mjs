// The passenger inside the airliner (js/flight-cabin.js): the plane-local
// frame turned with the aircraft's real stand heading at Pardubice, the
// shuffle along row 14 and the campaign's own sit-down (js/prologue-seat.js)
// onto 14A, standing up into the aisle again, the airstairs underfoot, and
// the cabin crew in the doorway for somebody without a boarding pass.
import test from 'node:test';
import assert from 'node:assert';

const { cabinPassenger } = await import('../js/flight-cabin.js');
const { AIRLINER, seatAt, STAIRS, STAIRS_FOOT_X, DOOR_L1 } = await import('../js/airliner-layout.js');
const { STAND } = await import('../js/airport-plan.js');

const rot = () => ({ x: 0, y: 0, z: 0 });
function stubPlayer(x, z) {
  return {
    pos: { x, z }, y: 0, vy: 0, speed: 0, grounded: true, heading: 0, walkT: 0,
    mesh: { position: { set(a, b, c) { this.x = a; this.y = b; this.z = c; } }, rotation: { y: 0 } },
    _cit: { parts: { torso: { rotation: rot() }, armR: { rotation: rot() }, head: { rotation: rot() } } },
    _sit() {}, _stand() {}, _animate() {},
  };
}
const pose = { x: STAND.x, y: 225, z: STAND.z, heading: STAND.heading };
const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
const world = (lx, lz) => ({ x: pose.x + lx * c + lz * s, z: pose.z - lx * s + lz * c });

test('down the aisle to row 14, along the row, and onto 14A with the campaign\'s sit-down', () => {
  const seat = seatAt(14, 'A');
  const aisle = world(-0.1, seat.z - 0.35);
  const p = stubPlayer(aisle.x, aisle.z);
  p.y = pose.y + AIRLINER.floorY;
  const cab = cabinPassenger(p, '14A');
  cab.setPose(pose, true, true, null, true);
  assert.ok(cab.aboard(), 'standing in the aisle is aboard');
  assert.ok(cab.nearSeat(), 'beside his row');
  assert.ok(cab.sit());
  for (let t = 0; t < 6 && !cab.seated; t += 1 / 30) cab.posePlayer(1 / 30);
  assert.ok(cab.seated, 'seated after the shuffle and the sit-down, stage ' + cab.stage);
  const cushion = world(seat.x, seat.z);
  assert.ok(Math.hypot(p.pos.x - cushion.x, p.pos.z - cushion.z) < 0.05, 'on the cushion');
  const d = Math.atan2(Math.sin(p.heading - pose.heading), Math.cos(p.heading - pose.heading));
  assert.ok(Math.abs(d) < 1e-6, 'facing forward with the aircraft');
  // standing up: back out of the row into the aisle
  assert.ok(cab.rise());
  for (let t = 0; t < 8 && cab.busy; t += 1 / 30) cab.posePlayer(1 / 30);
  assert.equal(cab.stage, 'off');
  assert.ok(Math.hypot(p.pos.x - aisle.x, p.pos.z - aisle.z) < 0.3, 'back in the aisle');
});

test('the airstairs climb step by step to the sill, and the floor inside is the cabin floor', () => {
  const p = stubPlayer(0, 0);
  const cab = cabinPassenger(p, '14A');
  cab.setPose(pose, true, true, null, true);
  let last = -1;
  for (let lx = STAIRS_FOOT_X + 0.05; lx < STAIRS.platformOuter; lx += STAIRS.run) {
    const q = world(lx, STAIRS.zCentre), y = cab.floor(q.x, q.z, 1e9) - pose.y;
    assert.ok(y > last && y < AIRLINER.floorY + 1e-6, 'a step at ' + y.toFixed(2));
    last = y;
  }
  const inside = world(0, -5);
  assert.equal(cab.floor(inside.x, inside.z, 1e9), pose.y + AIRLINER.floorY);
  assert.ok(cab.carrying(inside.x, inside.z));
  // the stair truck driven away: nothing under the door
  cab.setPose(pose, false, true, null, true);
  const step = world(STAIRS.platformOuter - 1, STAIRS.zCentre);
  assert.equal(cab.floor(step.x, step.z, 1e9), -Infinity);
  // in flight nobody walks: the world is told nothing
  cab.setPose(pose, true, true, null, false);
  assert.equal(cab.carrying(inside.x, inside.z), false);
});

test('the crew stand in the door for somebody without a boarding pass, and let a passenger in', () => {
  const p = stubPlayer(0, 0);
  const cab = cabinPassenger(p, '14A');
  const feet = pose.y + AIRLINER.floorY;
  const opts = { interior: true, aboveY: feet + 0.3, yLo: feet + 0.49, yHi: feet + 2 };
  const door = world(DOOR_L1.x + 0.2, DOOR_L1.z);
  cab.setPose(pose, true, true, 'Palubní vstupenku, prosím.', true);
  const at = { x: door.x, z: door.z };
  assert.ok(cab.collide(at, 0.38, opts), 'turned back at the door');
  const lx = (at.x - pose.x) * c - (at.z - pose.z) * s;
  assert.ok(lx < DOOR_L1.x - 0.5, 'out on the platform, ' + lx.toFixed(2));
  cab.setPose(pose, true, true, null, true);
  const ok = { x: door.x, z: door.z };
  cab.collide(ok, 0.38, opts);
  const lx2 = (ok.x - pose.x) * c - (ok.z - pose.z) * s;
  assert.ok(lx2 > DOOR_L1.x - 0.3, 'a passenger walks in');
});

// Review, 25 Nov 2026: seated in 14A, or on the way along the row, the player
// has no car, heli or jet, so main.js read him as on foot and a left click
// threw a punch from the seat (and sent it to the other players). The cabin's
// `busy` is what keeps the fists down (flight.js cabinBusy, main.js fistsTaken):
// it has to hold from the first step along the row to the last one back.
test('the seat has the body from the first shuffle to the aisle again, and the fists know it', async () => {
  const seat = seatAt(14, 'A');
  const aisle = world(-0.1, seat.z - 0.35);
  const p = stubPlayer(aisle.x, aisle.z);
  p.y = pose.y + AIRLINER.floorY;
  const cab = cabinPassenger(p, '14A');
  cab.setPose(pose, true, true, null, true);
  assert.equal(cab.busy, false, 'standing in the aisle is not the seat');
  assert.ok(cab.sit());
  assert.equal(cab.busy, true, 'the shuffle along the row is free to punch from');
  let free = 0;
  for (let t = 0; t < 6 && !cab.seated; t += 1 / 30) { cab.posePlayer(1 / 30); if (!cab.busy) free++; }
  assert.ok(cab.seated);
  assert.equal(free, 0, 'a frame of the sit-down left the fists free');
  assert.ok(cab.rise());
  let steps = 0;
  for (let t = 0; t < 8 && cab.busy; t += 1 / 30) { cab.posePlayer(1 / 30); steps++; }
  assert.ok(steps > 3, 'standing up was over at once');
  assert.equal(cab.busy, false, 'back in the aisle the fists stay down');
  // the wiring: flight.js hands the cabin's state on, main.js reads it
  const { readFileSync } = await import('node:fs');
  const flight = readFileSync(new URL('../js/flight.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(flight, /get cabinBusy\(\)\s*\{\s*return cabin\.busy;/, 'flight.js does not expose the seat');
  const gate = main.slice(main.indexOf('function fistsTaken()'), main.indexOf('function fistsBusy()'));
  assert.match(gate, /flightNow\(\)\?\.cabinBusy/, 'main.js fistsTaken() does not ask about the seat');
});
