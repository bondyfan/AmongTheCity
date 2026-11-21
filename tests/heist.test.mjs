import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { heistLines, sendOff, farmTalk, rideTalk, swapAsk, swapInsist, byeTalk, villaCall, cityCall, garageTalk, dealTalk } from '../js/heist-dialogue.js';
import { farm, villa, villaAt, villaLocal, villaIn, villaOut, city, hours, dist, kombi, start } from '../js/heist-route.js';
register(new URL('./three-alias.mjs', import.meta.url));

test('every line of part two has a recording, a speaker and a voice', () => {
  const ids = new Set();
  for (const [id, who, words, role, direction] of heistLines) {
    assert.ok(!ids.has(id), 'twice: ' + id);
    ids.add(id);
    assert.ok(who && words && direction, id);
    assert.ok(['father', 'friend', 'farmer', 'radio', 'buyer'].includes(role), id);
    const dash = String.fromCharCode(0x2014);
    assert.ok(!words.includes(dash) && !direction.includes(dash), 'long dash in ' + id);
    assert.ok(existsSync(new URL('../public/assets/last-train/' + id + '.mp3', import.meta.url)), 'no recording for ' + id);
  }
  for (const id of ['reggae', 'villa-music', 'hens', 'forest-night', 'plate-rip', 'starter-fail', 'starter-catch', 'alarm-chirp', 'camera-flash', 'garage-door', 'window-climb', 'house-door', 'villa-alarm', 'key-pick'])
    assert.ok(existsSync(new URL('../public/assets/last-train/' + id + '.mp3', import.meta.url)), 'no sound ' + id);
});

test('the script says what Frank asked for', () => {
  assert.match(sendOff.map((l) => l[2]).join(' '), /Brozan/);
  assert.match(farmTalk.map((l) => l[2]).join(' '), /Vylez z toho auta/);
  assert.match(rideTalk.map((l) => l[2]).join(' '), /znamení/);
  assert.match(villaCall.map((l) => l[2]).join(' '), /značky.*urvi/s);
  // 21 Nov 2026: he weaves, the father asks twice for the wheel and gets it, and is wished luck
  assert.match(swapAsk[0][2], /ze strany na stranu.*budu řídit já/s);
  assert.equal(swapAsk[1][3], 'farmer');
  assert.match(swapAsk[1][2], /^Ne/);
  assert.match(swapInsist.map((l) => l[2]).join(' '), /Budu řídit já.*řiď ty/s);
  assert.match(byeTalk.at(-1)[2], /měj.*hodně štěstí/s);
  // the key is in the house, and he is told how to get in and what waits there
  assert.match(villaCall.map((l) => l[2]).join(' '), /klíč je v domě.*žebřík.*paprsky/s);
  // the buyer pays Vašek, and Vašek pays him
  assert.deepEqual(dealTalk.map((l) => l[3]), ['buyer', 'friend', 'buyer', 'friend', 'father', 'friend']);
  assert.match(dealTalk[3][2], /Dvě stě padesát tisíc/);
  assert.match(cityCall.map((l) => l[2]).join(' '), /zatarasenej.*třídu Míru/s);
  assert.equal(garageTalk.at(-1)[3], 'friend');
});

test('the villa frame runs up the drive and comes back', () => {
  const end = villaAt(52.95, 0);
  assert.ok(Math.abs(end.x - 3612.2) < 0.4 && Math.abs(end.z + 5222.7) < 0.4, JSON.stringify(end));
  const l = villaLocal(3612.9, -5213.5); // the house's north-west corner: right of the drive
  assert.ok(l.v > 2 && l.v < 3.2 && l.u > 43 && l.u < 45, JSON.stringify(l));
  // facing up the drive is the way the frame's u grows
  assert.ok(Math.abs(-Math.sin(villaIn) - Math.sin(villa.h)) < 1e-9);
  assert.ok(Math.abs(villaOut - villaIn - Math.PI) < 1e-9);
  assert.ok(villa.car.u > 44.5, 'the car stands clear of the house');
});

test('the places are where the map has them, and the clock runs to morning', () => {
  assert.ok(dist(kombi, start) < 6);
  const ride = farm.ride;
  let len = 0;
  for (let i = 1; i < ride.length; i++) len += Math.hypot(ride[i][0] - ride[i - 1][0], ride[i][1] - ride[i - 1][1]);
  assert.ok(len > 1400 && len < 1900, 'ride ' + len);
  assert.ok(dist({ x: ride.at(-1)[0], z: ride.at(-1)[1] }, villa) < 170);
  assert.ok(dist(city.garage, city.door) < 6);
  assert.ok(dist(city.block, city.centre) > 380 && dist(city.block, city.centre) < 460);
  const order = [hours.leave, hours.farm, hours.drop, hours.villa, hours.away, hours.centre, hours.garage];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(hours.centre >= 7 && hours.centre <= 8, 'seven to eight on třída Míru (Frank, 20 Nov 2026)');
});

test('the save remembers that part two is over, and nothing else about it', async () => {
  const { blank, sanitize, serialize } = await import('../js/savegame.js');
  assert.equal(blank().heist, null);
  assert.equal(sanitize({ ...blank(), prologue: 'done', heist: 'done' }).heist, 'done');
  assert.equal(sanitize({ ...blank(), prologue: 'done', heist: 'run' }).heist, null, 'a stage of part two is never written');
  assert.equal(JSON.parse(serialize({ ...blank(), prologue: 'done', heist: 'done' })).heist, 'done');
});

// ---- the villa (21 Nov 2026): rooms a man can get through, scanners he can time
const { walls, furniture, spots, scans, pushOut, inWall, SIZE } = await import('../js/heist-house.js');
const { swing, caught } = await import('../js/heist-lasers.js');
const R = 0.38;
const free = (x, z) => !pushOut({ x, z }, R);

test('a scanner swings from one end to the other and rests at both', () => {
  for (const s of scans) {
    const a = swing(s, -(s.phase ?? 0)), b = swing(s, s.period / 2 - (s.phase ?? 0));
    assert.ok(Math.hypot(a.x - s.a[0], a.z - s.a[1]) < 1e-9, 'starts at one end');
    assert.ok(Math.hypot(b.x - s.b[0], b.z - s.b[1]) < 1e-9, 'half a period later it is at the other');
    assert.equal(swing(s, 0.2 - (s.phase ?? 0)).k, 0, 'and stands there a moment');
    // the dot stays on the floor of the house, clear of the walls
    for (let t = 0; t < s.period; t += 0.05) {
      const d = swing(s, t);
      assert.ok(!inWall(d.x, 1, d.z), 'dot in a wall');
    }
    // a body on the dot is caught, a body across the house is not
    const d = swing(s, 1);
    assert.ok(caught(s, 1, d.x, d.z));
    assert.ok(!caught(s, 1, d.x > 6 ? 1 : 11, d.z));
  }
});

test('the house can be walked: window to key to back door, between the beams, at a walk', () => {
  assert.ok(free(spots.enter.x, spots.enter.z), 'he lands in something');
  // Search over place and time: a step of 0.15 m every 0.1 s is a walk (1.5 m/s),
  // standing still is allowed, and no step may end in a wall, a table or a beam.
  const CELL = 0.15, DT = 0.1, NX = Math.ceil(SIZE.x / CELL), NZ = Math.ceil(SIZE.z / CELL), STEPS = 900;
  const open = new Uint8Array(NX * NZ);
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) open[i + j * NX] = free((i + 0.5) * CELL, (j + 0.5) * CELL) ? 1 : 0;
  const safe = (i, j, t) => scans.every((s) => !caught(s, t, (i + 0.5) * CELL, (j + 0.5) * CELL));
  function reach(from, done) {
    let now = from;
    for (let step = 0; step < STEPS; step++) {
      const t = (from.t0 ?? 0) + (step + 1) * DT, next = new Set();
      for (const key of now.cells) {
        const i = key % NX, j = (key / NX) | 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= NX || b >= NZ || !open[a + b * NX] || next.has(a + b * NX) || !safe(a, b, t)) continue;
          next.add(a + b * NX);
        }
      }
      assert.ok(next.size, 'nowhere left to stand at ' + t.toFixed(1) + ' s');
      const hits = [...next].filter((key) => done(((key % NX) + 0.5) * CELL, (((key / NX) | 0) + 0.5) * CELL));
      if (hits.length) return { cells: new Set(hits), t0: t };
      now = { cells: next, t0: from.t0 };
    }
    assert.fail('not reached in ' + STEPS * DT + ' s');
  }
  const start0 = { cells: new Set([Math.floor(spots.enter.x / CELL) + Math.floor(spots.enter.z / CELL) * NX]), t0: 0 };
  const atKey = reach(start0, (x, z) => Math.hypot(x - spots.key.x, z - spots.key.z) < 1.1);
  const out = reach(atKey, (x, z) => Math.hypot(x - spots.exit.x, z - spots.exit.z) < 1.2);
  assert.ok(atKey.t0 > 8, 'the key is not next to the window (' + atKey.t0.toFixed(1) + ' s)');
  assert.ok(out.t0 - atKey.t0 > 6, 'and the way out is a way');
  // and it is not a stroll: walking straight through without looking gets him caught
  let hit = false;
  for (let t = 0, x = 3.6; x < 8.4 && !hit; t += DT, x += 0.15) hit = caught(scans[0], t, x, 2.7) || caught(scans[1], t, x, 3.0);
  assert.ok(hit || scans.some((s) => caught(s, 2, s.a[0], s.a[1])), 'a beam is in the way of somebody who does not wait');
});

test('outside: the scanner sweeps the foot of the ladder, and leaves it free in between', async () => {
  const sc = villa.scan, lad = villa.ladder;
  const spec = { cam: [sc.cam.v, sc.cam.up, -sc.cam.u], a: [sc.v, -sc.u0], b: [sc.v, -sc.u1], period: sc.period };
  let taken = 0, clear = 0;
  for (let t = 0; t < sc.period; t += 0.05) caught(spec, t, lad.v - 0.35, -lad.u) ? taken++ : clear++;
  assert.ok(taken > 4, 'the dot passes over where he stands to climb');
  assert.ok(clear * 0.05 > 2.5, 'and there are seconds in which it does not (' + (clear * 0.05).toFixed(1) + ' s)');
  // the ladder leans on the house's west wall, inside the strip the camera watches
  assert.ok(lad.v > villa.cone.half && lad.v < 5.1 && lad.u > villa.cone.u0 && lad.u < villa.cone.u1);
  assert.ok(villa.back.u > 44 && Math.abs(villa.back.u - villa.car.u) < 3, 'the back door comes out beside the lean-to');
  assert.equal(walls.length, 10);
  assert.ok(furniture.length > 6);
});

test('the villa is a shut, dark, empty house: no inside of the city\'s making, no lit window, nobody about', async () => {
  const { hasInterior } = await import('../js/interiors.js');
  const { litOf } = await import('../js/typologylit.js');
  const house = { _id: 77, o: [[0, 0], [20, 0], [20, 12], [0, 12]], h: 4.3, t: 'house' };
  assert.equal(hasInterior(house), true, 'an ordinary house can be walked into');
  assert.equal(hasInterior({ ...house, sealed: 1 }), false, 'the villa cannot: the way in is the story\'s');
  assert.equal(litOf({ ...house, sealed: 1 }, 'house').dens, 0, 'and not one of its windows is lit');
  // the map's restaurant becomes that house when its tile is read (js/geo.js)
  const { readFileSync } = await import('node:fs');
  const geo = readFileSync(new URL('../js/geo.js', import.meta.url), 'utf8');
  assert.match(geo, /b\.n === 'Perníková chaloupka'\) \{ b\.t = 'house'; b\.sealed = 1; delete b\.u; delete b\.n; \}/);
  // nobody walks within this of the gate, and nobody lives in the houses there
  assert.ok(villa.quiet >= 200);
  assert.match(readFileSync(new URL('../js/pedestrians.js', import.meta.url), 'utf8'), /const q = this\.keepOut;\s+if \(q && Math\.hypot/);
  assert.match(readFileSync(new URL('../js/interiorsim.js', import.meta.url), 'utf8'), /const quiet = this\.keepOut;/);
});
