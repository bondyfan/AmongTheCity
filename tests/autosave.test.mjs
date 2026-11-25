// Saving only at autosave points (Frank, 20 Nov 2026: "To se musí ukládat
// jenom jako na autosavy"). Each test is one rule of js/autosave.js:
//   playing, closing the tab and hiding it write nothing;
//   a mission's end writes, says "Uloženo", and a reload stands you THERE,
//   not where you were when the tab was closed;
//   the campaign writes nothing before its end, and its end is a point;
//   'sleep' is a point already (for the flat that comes later), nothing else is;
//   a save from before the points forgets where the tab was closed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// ---- a browser thin enough for js/career.js (as in fix-game.test.mjs) -------
// ...with one difference: every listener added to window or document is kept,
// so the test can close the tab the way a browser does and see what it writes.
const disk = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => { disk.set(k, String(v)); },
  removeItem: (k) => { disk.delete(k); },
} });
const said = [];
const listeners = [];
const dom = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : k === 'length' ? 0
    : k === 'addEventListener' ? (type, fn) => listeners.push([type, fn])
    : k === 'hidden' ? true : dom),
  set: (t, k, v) => { if ((k === 'textContent' || k === 'innerHTML') && typeof v === 'string') said.push(v); return true; },
  apply: () => dom, construct: () => dom,
});
globalThis.document = dom;
globalThis.window = dom;

let clock = 0;
mock.timers.enable({ apis: ['setTimeout'] });
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => clock });
const flushToasts = () => { for (let i = 0; i < 6; i++) { clock += 60000; mock.timers.tick(400); } };

/** Close the tab: everything a browser fires on the way out, in its order. */
function quit() {
  for (const type of ['visibilitychange', 'beforeunload', 'pagehide', 'freeze', 'unload'])
    for (const [t, fn] of listeners) if (t === type) { try { fn({ type, persisted: false }); } catch { /* not ours */ } }
}

const { SAVE_KEY, parse } = await import('../js/savegame.js');
const { POINTS, isPoint, notice, PART_ONE_END } = await import('../js/autosave.js');
const wallet = await import('../js/wallet.js');
const vitals = await import('../js/vitals.js');
const wanted = await import('../js/wanted.js');

const host = () => ({ game: { mode: 'play', car: null }, input: { onKey() {} }, parked: [], parkedFleet: [],
  player: { pos: { x: 10, z: 20 }, heading: 0, y: 0, grounded: true }, world: { city: { pois: [], paved: [] } },
  vehicles: { add: (kind, x, z, heading, color) => ({ kind, x, z, heading, color }), remove() {} } });
const onDisk = () => JSON.parse(disk.get(SAVE_KEY));
let loads = 0;
/** A page load: a fresh copy of career.js reads the save and stands you where it says. */
async function session(choice = { mode: 'single' }) {
  wanted.clear(); vitals.reset(); wallet.setMoney(wallet.START);
  const c = await import('../js/career.js?autosave=' + (++loads));
  c.choose(choice);
  const h = host();
  const sp = c.startPoint();
  await c.spawn(h.player, {});
  c.attach(h);
  flushToasts();
  said.length = 0;
  c.update(1 / 60);              // the first step applies the save
  return { c, h, sp };
}
const play = (c, h, s, walk = 0) => {
  for (let i = 0; i < s * 60; i++) { h.player.pos.x += walk / 60; c.update(1 / 60); }
};

test('play and quitting write nothing; a mission\'s end does, and a reload stands you there', async () => {
  disk.clear();
  let { c, h } = await session();
  wallet.setMoney(7300);
  play(c, h, 90, 1.4);           // a minute and a half of walking: no timer writes
  quit();
  assert.equal(disk.has(SAVE_KEY), false, 'the game was written without an autosave point');

  // the mission is over, the player stands where its last scene left him
  Object.assign(h.player.pos, { x: 1200, z: 1448 });
  h.player.heading = -Math.PI / 2; h.player.y = 225.5;
  const money = wallet.money();
  assert.equal(c.autosave('mission'), true);
  const s = onDisk();
  assert.equal(s.point, 'mission');
  assert.equal(s.money, money);
  assert.deepEqual([s.pos.x, s.pos.z, s.pos.y], [1200, 1448, 225.5], 'the point took last frame\'s spot, not this one');
  flushToasts();
  assert.ok(said.includes('Uloženo'), 'no "Uloženo" at the autosave point');
  assert.ok(said.includes('Mise splněna'));
  assert.ok(!said.join(' ').includes(String.fromCharCode(0x2014)), 'an em dash in UI text');

  // and then he carries on: earns, walks off, hides the tab, closes it
  const written = disk.get(SAVE_KEY);
  wallet.setMoney(99000);
  play(c, h, 45, 3);
  quit();
  assert.equal(disk.get(SAVE_KEY), written, 'quitting moved the save');

  let sp;
  ({ c, h, sp } = await session());
  assert.equal(sp.saved, true);
  assert.deepEqual([h.player.pos.x, h.player.pos.z], [1200, 1448], 'the reload stood him where he quit, not at the point');
  assert.equal(wallet.money(), money, 'money made after the point survived the reload');
  assert.ok(said.some((t) => t.includes('od posledního uložení')));
});

test('the campaign writes nothing before its end, and its end is the mission point', async () => {
  disk.clear();
  const campaign = { mode: 'single', start: 'pardubice' };
  let { c, h } = await session(campaign);
  assert.equal(c.activeStory(), 'bridge');
  for (const stage of ['station', 'coach', 'arrival', 'forecourt']) {
    c.checkpointStory(stage);
    play(c, h, 5, 2);
    assert.equal(c.autosave('mission'), false, 'an autosave in the middle of ' + stage);
  }
  quit();
  assert.equal(disk.has(SAVE_KEY), false, 'a chapter of the campaign was saved');

  // part one ends at Vašek's door (js/prologue-parking.js): that is the point
  Object.assign(h.player.pos, { x: 1213, z: 1448 });
  c.checkpointStory('done');
  assert.equal(onDisk().prologue, 'done');
  assert.equal(onDisk().point, 'mission');
  assert.deepEqual([onDisk().pos.x, onDisk().pos.z], [1213, 1448]);

  play(c, h, 30, 4);
  quit();
  ({ c, h } = await session(campaign));
  assert.equal(c.activeStory(), 'done', 'the finished campaign started again');
  assert.deepEqual([h.player.pos.x, h.player.pos.z], [1213, 1448]);

  // part two (js/heist.js) waits at its start by Vašek's door (Frank, 25 Nov
  // 2026: a part never begins by itself); once started nothing is written while
  // it runs, and its end is the next mission point
  assert.equal(c.heistPending(), false, 'part two started by itself');
  assert.equal(c.nextPart()?.id, 'part2');
  assert.deepEqual(c.beginPart('part2'), { x: 1213.6, z: 1448, h: -Math.PI / 2 });
  assert.equal(c.heistPending(), true);
  play(c, h, 10, 3);
  assert.equal(c.autosave('mission'), false, 'an autosave in the middle of part two');
  assert.equal(onDisk().heist, null);
  Object.assign(h.player.pos, { x: 2400, z: -900 });
  c.completeHeist();
  assert.equal(onDisk().heist, 'done');
  assert.equal(onDisk().point, 'mission');
  assert.deepEqual([onDisk().pos.x, onDisk().pos.z], [2400, -900]);
});

test('the points: a mission and a night in your own flat, nothing else', async () => {
  assert.deepEqual(Object.keys(POINTS), ['mission', 'sleep']);
  for (const p of Object.keys(POINTS)) {
    assert.equal(isPoint(p), true);
    const n = notice(p);
    assert.equal(n.text, 'Uloženo');
    assert.ok(n.sub && !n.sub.includes(String.fromCharCode(0x2014)), p);
  }
  for (const p of ['quit', 'pagehide', 'timer', '', 'toString', '__proto__', null, undefined, 3]) assert.equal(isPoint(p), false, String(p));

  disk.clear();
  const { c, h } = await session();
  for (const p of ['quit', 'timer', 'toString', undefined]) assert.equal(c.autosave(p), false, String(p));
  assert.equal(disk.has(SAVE_KEY), false, 'a point that is not one wrote the save');
  // the flat is not built yet; its bed will make exactly this call
  Object.assign(h.player.pos, { x: 300, z: -40 });
  assert.equal(c.autosave('sleep'), true);
  assert.equal(onDisk().point, 'sleep');
  flushToasts();
  assert.ok(said.includes('Vyspal ses doma'));
});

test('a save from before the points forgets where the tab was closed, and keeps the rest', async () => {
  const v2 = (extra) => JSON.stringify({ v: 2, money: 41000, played: 3600, tod: 0.83,
    pos: { x: 640.2, z: -310.4, h: 2 }, car: { kind: 'fabia', color: 0x3a63a8, x: 700, z: -300, h: 0 },
    stats: { jobsCourier: 9 }, ...extra });
  // part one finished: back at its end, where a mission point would have left him
  const done = parse(v2({ prologue: 'done' }));
  assert.equal(done.ok, true);
  assert.equal(done.migrated, true);
  assert.deepEqual(done.state.pos, { x: 1213.7, z: 1448, h: -1.571 });
  assert.equal(done.state.tod, null, 'the hour the tab was closed came back');
  assert.equal(done.state.point, '');
  assert.equal(done.state.money, 41000);
  assert.equal(done.state.car.kind, 'fabia');
  assert.equal(done.state.stats.jobsCourier, 9);
  // never in the campaign (an older player, co-op): the square of the city
  assert.equal(parse(v2({})).state.pos, null);
  // written on the death card: that spot is the hospital, and the bill is open
  const card = parse(v2({ owed: { stars: 2 } }));
  assert.deepEqual(card.state.pos, { x: 640.2, z: -310.4, h: 2 });
  assert.deepEqual(card.state.owed, { stars: 2 });
  // a point that is not one, hand-edited in, reads as none
  assert.equal(parse(JSON.stringify({ v: 3, point: 'quit' })).state.point, '');

  // PART_ONE_END is where js/prologue-parking.js stands him when part one ends
  const { doorAt } = await import('../js/prologue-house.js');
  const door = doorAt(0, -1.8);
  assert.ok(Math.abs(door.x - PART_ONE_END.x) < 1e-9 && Math.abs(door.z - PART_ONE_END.z) < 1e-9, JSON.stringify(door));
});
