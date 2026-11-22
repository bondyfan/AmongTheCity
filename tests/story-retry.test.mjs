// A failed mission starts clean (Frank, 20 Nov 2026: "kdyz se mise nepodari
// (umre se a nebo busted..) tak mise jde od znova ale cutsceny uz jdou vsechny
// preskocit... a ten vasek musi znovu cekat na nadrazi"). Each test is one
// rule of that sentence:
//   a failure leaves a mark, the end of the part lifts it, a reload keeps it;
//   Vašek's estate goes back to its bay whole, so he waits at the station again;
//   a talk that is skipped still does what waited for its last word;
//   every film of the campaign has a way out, and main.js asks for all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const disk = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => { disk.set(k, String(v)); },
  removeItem: (k) => { disk.delete(k); },
} });
const { retry, setHome, parkHome, besideCar } = await import('../js/story-retry.js');
const source = (name) => readFileSync(new URL('../js/' + name, import.meta.url), 'utf8');

test('a failure leaves the mark, the end of the part lifts it, and a reload keeps it', async () => {
  assert.equal(retry.on, false, 'a first play skips nothing');
  retry.mark();
  assert.equal(retry.on, true);
  // the tab is closed and opened again: the module is read anew from the disk
  const again = await import('../js/story-retry.js?reload');
  assert.equal(again.retry.on, true, 'the mark outlives a reload');
  retry.clear();
  assert.equal(retry.on, false);
  assert.equal(disk.size, 0, 'nothing is left behind once the part is finished');
});

test('after a fail the estate is back in its bay, whole, and Vašek stands by it at the station', () => {
  // the bay in front of Pardubice station, as the fleet parks it
  const car = setHome({ x: 1012.4, z: -1630.2, heading: 0.74, y: 221.3, speed: 0, steer: 0, damage: 0, _grounded: true });
  const waits = besideCar(car);
  // the first try: he drove Vašek half way home and it ended against a wall
  Object.assign(car, { x: 1190.5, z: 720.8, heading: -2.1, y: 224.9, speed: 17, steer: 0.4, damage: 1.1, _roll: 0.2, _pitch: -0.1, ctl: {} });
  const strayed = besideCar(car);
  assert.ok(Math.hypot(strayed.x - waits.x, strayed.z - waits.z) > 2000, 'without the reset he waits where the car was left');
  assert.equal(parkHome(car), true);
  assert.deepEqual([car.x, car.z, car.heading], [1012.4, -1630.2, 0.74]);
  assert.deepEqual([car.speed, car.steer, car.damage, car._roll, car._pitch, car.ctl], [0, 0, 0, 0, 0, null]);
  assert.equal(car._grounded, false, 'it settles onto the car park again when that ground is known');
  assert.deepEqual(besideCar(car), waits, 'Vašek waits exactly where he waited the first time');
  // a car the story never met has no home to go back to
  assert.equal(parkHome({ x: 5, z: 5, heading: 0 }), false);
  assert.equal(parkHome(null), false);
});

test('a skipped talk still does what waited for its last word; a stopped one does not', async () => {
  const { talker } = await import('../js/heist-talk.js');
  const said = [];
  const talk = talker({ say: (who = '', what = '') => said.push(what) });
  let boarded = 0;
  const lines = [['none-1', 'Jarda', 'Nazdar.', 'farmer'], ['none-2', 'Ty', 'Dobrý den.', 'father'], ['none-3', 'Jarda', 'Tak nasedat.', 'farmer']];
  talk.run(lines, { done: () => boarded++ });
  assert.equal(talk.busy, true);
  assert.equal(said.at(-1), 'Nazdar.');
  talk.skip();
  assert.equal(boarded, 1, 'Jarda gets behind the wheel');
  assert.equal(talk.busy, false);
  assert.equal(said.at(-1), '', 'the caption is gone');
  talk.skip();
  assert.equal(boarded, 1, 'and only once');
  talk.run(lines, { done: () => boarded++ });
  talk.stop();
  assert.equal(boarded, 1, 'a talk cut off by a rewind finishes nothing');
});

test('every film of the campaign can be left with T on a retry, and only then', () => {
  for (const film of ['prologue-opening.js', 'prologue-table.js', 'heist-garage.js', 'heist-deal.js'])
    assert.match(source(film), /\n    skip\(\) \{/, film + ' has a way out');
  // the owners ask the mark before they let anything go
  assert.match(source('prologue.js'), /if \(film\?\.running\) \{\s+if \(retry\.on\) film\.skip\(\);/);
  for (const owner of ['prologue-parking.js', 'heist.js'])
    assert.match(source(owner), /skip\(\) \{\s+if \(!retry\.on \|\| over\) return false;\s+if \(film\?\.running\) return film\.skip\(\);/, owner);
  // the ride in Jarda's van is a film with a steering wheel in it (while he still drives)
  assert.match(source('heist.js'), /if \(stage === 'ride' && ride\.skippable\) return ride\.skip\(\);/);
  assert.match(source('heist-ride.js'), /farmer\.skipRide\(hud\)/);
});

test('main.js marks the failure, puts the estate home before part one starts again, and gives T to the story', () => {
  const main = source('main.js');
  assert.match(main, /vasekCar = setHome\(car\)/, 'the bay is remembered when the fleet is parked');
  const fail = main.slice(main.indexOf('function failStory('), main.indexOf('function pumpStoryOver('));
  assert.match(fail, /retry\.mark\(\)/);
  const again = main.slice(main.indexOf('function pumpStoryOver('), main.indexOf('let roadWorks'));
  // (`two`: part two running, or part two being replayed from the Kampaně tab)
  assert.match(again, /const two = heist \|\| o\.replay === 'part2';/);
  assert.match(again, /if \(!two && vasekCar && parkHome\(vasekCar\)\)/);
  assert.ok(again.indexOf('parkHome(vasekCar)') < again.indexOf("startJourney('bridge')"), 'home first, then the film');
  assert.ok(again.indexOf('meeting?.close?.()') < again.indexOf('parkHome(vasekCar)'), 'Vašek is out of the seat before the car moves');
  assert.match(main, /if \(journey\) journey\.skip\(\); else \(meeting \?\? heist\)\?\.skip\(\);/);
  // the end of each part lifts the mark
  const career = source('career.js');
  assert.match(career, /if \(stage === 'done'\) retry\.clear\(\);/);
  assert.match(career.slice(career.indexOf('export function completeHeist')), /^[^}]*retry\.clear\(\);/);
});
