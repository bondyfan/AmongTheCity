import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { heistLines, sendOff, farmTalk, rideTalk, villaCall, cityCall, garageTalk } from '../js/heist-dialogue.js';
import { farm, villa, villaAt, villaLocal, villaIn, villaOut, city, hours, dist, kombi, start } from '../js/heist-route.js';

test('every line of part two has a recording, a speaker and a voice', () => {
  const ids = new Set();
  for (const [id, who, words, role, direction] of heistLines) {
    assert.ok(!ids.has(id), 'twice: ' + id);
    ids.add(id);
    assert.ok(who && words && direction, id);
    assert.ok(['father', 'friend', 'farmer', 'radio'].includes(role), id);
    const dash = String.fromCharCode(0x2014);
    assert.ok(!words.includes(dash) && !direction.includes(dash), 'long dash in ' + id);
    assert.ok(existsSync(new URL('../public/assets/last-train/' + id + '.mp3', import.meta.url)), 'no recording for ' + id);
  }
  for (const id of ['reggae', 'hens', 'forest-night', 'glass-break', 'plate-rip', 'wires', 'starter-fail', 'starter-catch', 'alarm-chirp', 'camera-flash', 'garage-door'])
    assert.ok(existsSync(new URL('../public/assets/last-train/' + id + '.mp3', import.meta.url)), 'no sound ' + id);
});

test('the script says what Frank asked for', () => {
  assert.match(sendOff.map((l) => l[2]).join(' '), /Brozan/);
  assert.match(farmTalk.map((l) => l[2]).join(' '), /Vylez z toho auta/);
  assert.match(rideTalk.map((l) => l[2]).join(' '), /znamení/);
  assert.match(villaCall.map((l) => l[2]).join(' '), /značky.*urvi/s);
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
