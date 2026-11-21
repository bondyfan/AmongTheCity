// ---- the other players, in the glass of the cars they ride (js/netcrew.js) ----
// The setters are js/cardoor.js's in the game; here they write a log.

import test from 'node:test';
import assert from 'node:assert';
import { makeNetCrew } from '../js/netcrew.js';

function rig() {
  const log = [];
  const crew = makeNetCrew({
    setDriver: (car, who) => log.push(['driver', car.id, who === undefined ? 'stock' : who === null ? 'nobody' : who.cit.id]),
    setPassenger: (car, cit) => log.push(['passenger', car.id, cit?.id ?? 'nobody']),
  });
  const car = (id) => ({ id, mesh: { id } });
  const cit = (id, jacket = 0x123456) => ({ id, look: { jacket } });
  const frame = (fn, keep) => { crew.begin(); fn?.(); crew.end(keep); };
  return { crew, log, car, cit, frame };
}

test('a peer at the wheel of their own proxy is the one the glass shows, told once', () => {
  const { crew, log, car, cit, frame } = rig();
  const c = car('ghost'), anna = cit('anna');
  for (let i = 0; i < 120; i++) frame(() => crew.show('a', c, 0, anna));
  assert.deepEqual(log, [['driver', 'ghost', 'anna']], 'the glass was rewritten ' + log.length + ' times');
});

test('a peer in OUR passenger seat is in our glass, and out of it when they get out', () => {
  const { crew, log, car, cit, frame } = rig();
  const mine = car('mine'), bob = cit('bob');
  frame(() => crew.show('b', mine, 1, bob));
  frame(() => crew.show('b', mine, 1, bob));
  frame();                                              // he stepped out
  frame();
  assert.deepEqual(log, [['passenger', 'mine', 'bob'], ['passenger', 'mine', 'nobody']]);
  assert.equal(crew.size, 0);
});

test('a driver who gets out hands the wheel back to the car\'s own rule', () => {
  const { crew, log, car, cit, frame } = rig();
  const c = car('ghost');
  frame(() => crew.show('a', c, 0, cit('anna')));
  frame();
  assert.deepEqual(log.at(-1), ['driver', 'ghost', 'stock']);
});

test('the back row has no picture, and nothing is written for it', () => {
  const { crew, log, car, cit, frame } = rig();
  frame(() => { crew.show('b', car('c'), 2, cit('bob')); crew.show('c', car('c'), 3, cit('cy')); crew.show('d', car('c'), 1.5, cit('d')); });
  assert.deepEqual(log, []);
  assert.equal(crew.size, 0);
});

test('nobody is shown without a body or without a car to show them in', () => {
  const { crew, log, car, cit, frame } = rig();
  frame(() => { crew.show('b', car('c'), 1, null); crew.show('b', null, 1, cit('bob')); crew.show('b', { id: 'meshless' }, 1, cit('bob')); });
  assert.deepEqual(log, []);
});

test('changing car, seat or body moves the picture; the old glass is cleared first', () => {
  const { crew, log, car, cit, frame } = rig();
  const a = car('a'), b = car('b'), bob = cit('bob');
  frame(() => crew.show('b', a, 1, bob));
  frame(() => crew.show('b', b, 1, bob));               // into another car
  assert.deepEqual(log.slice(1), [['passenger', 'a', 'nobody'], ['passenger', 'b', 'bob']]);
  log.length = 0;
  frame(() => crew.show('b', b, 0, bob));               // takes the wheel of it
  assert.deepEqual(log, [['passenger', 'b', 'nobody'], ['driver', 'b', 'bob']]);
  log.length = 0;
  const bob2 = cit('bob-new-look');
  frame(() => crew.show('b', b, 0, bob2));              // changed clothes
  assert.deepEqual(log, [['driver', 'b', 'stock'], ['driver', 'b', 'bob-new-look']]);
});

test('a car whose mesh was rebuilt is told again, and the old mesh is left alone', () => {
  const { crew, log, car, cit, frame } = rig();
  const c = car('ghost'), anna = cit('anna');
  frame(() => crew.show('a', c, 0, anna));
  c.mesh = { id: 'resprayed' };
  frame(() => crew.show('a', c, 0, anna));
  assert.deepEqual(log, [['driver', 'ghost', 'anna'], ['driver', 'ghost', 'anna']]);
  // dropped altogether: nothing to undo on a mesh that is gone
  c.mesh = null;
  frame();
  assert.equal(log.length, 2);
});

test('the local player takes the seat a peer just left: their own picture stays', () => {
  const { crew, log, car, cit, frame } = rig();
  const c = car('c');
  frame(() => crew.show('b', c, 1, cit('bob')));
  frame(null, (kc, seat) => kc === c && seat === 1);    // we sit there now
  assert.equal(log.length, 1, 'our own picture was wiped: ' + JSON.stringify(log.at(-1)));
});

test('two peers report one seat: when one goes, the other is still in the glass', () => {
  const { crew, log, car, cit, frame } = rig();
  const c = car('c'), bob = cit('bob'), cy = cit('cy');
  frame(() => { crew.show('b', c, 1, bob); crew.show('c', c, 1, cy); });
  frame(() => crew.show('b', c, 1, bob));
  assert.deepEqual(log.at(-1), ['passenger', 'c', 'bob']);
});
