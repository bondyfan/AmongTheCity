// Every part of the campaign has an end, nothing chains on, the next part
// waits at its start, and the part that runs can be quit (Frank, 25 Nov 2026:
// "kampan se musi dat ukoncit.. asi v nastaveni - kampan a tam ukoncit ... ty
// mise musí mít vždycky konec, a ne, že to automaticky začne další mise ...
// když já půjdu na nějaký místo, tak začne 2"). js/campaignparts.js,
// js/career.js (nextPart, beginPart, quitCampaign), js/campaignmenu.js, main.js.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

// ---- a browser thin enough for js/career.js (as in campaigns.test.mjs) ------
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

const { SAVE_KEY } = await import('../js/savegame.js');
const wallet = await import('../js/wallet.js');
const vitals = await import('../js/vitals.js');
const wanted = await import('../js/wanted.js');
const { PARTS, partOf, endCard, startGate, gateStep, quitSpot, START_R, START_R_CAR, ARM_OUT } = await import('../js/campaignparts.js');
const { quitWords, CONFIRM } = await import('../js/campaignmenu.js');
const { street, kolinPlatform, pardubicePlatform, roofFrame } = await import('../js/prologue-route.js');

const host = () => ({ game: { mode: 'play', car: null }, input: { onKey() {} }, parked: [], parkedFleet: [],
  player: { pos: { x: 10, z: 20 }, heading: 0, y: 0, grounded: true }, world: { city: { pois: [], paved: [] } },
  vehicles: { add: (kind, x, z, heading, color) => ({ kind, x, z, heading, color }), remove() {} } });
const onDisk = () => JSON.parse(disk.get(SAVE_KEY));
let loads = 0;
async function session(choice = { mode: 'single', start: 'pardubice' }) {
  wanted.clear(); vitals.reset(); wallet.setMoney(wallet.START);
  const c = await import('../js/career.js?flow=' + (++loads));
  c.choose(choice);
  const h = host();
  await c.spawn(h.player, {});
  c.attach(h);
  flushToasts();
  c.update(1 / 60);              // the first step applies the save
  said.length = 0;
  return { c, h };
}
const play = (c, h, s) => { for (let i = 0; i < s * 60; i++) { h.player.pos.x += 2 / 60; c.update(1 / 60); } };
const partOne = (c) => { for (const stage of ['station', 'coach', 'arrival', 'forecourt', 'done']) c.checkpointStory(stage); };

test('the parts, their starts and their end cards', () => {
  assert.deepEqual(PARTS.map((p) => p.id), ['part1', 'part2']);
  assert.ok(partOf('part1').at.x < -38000, 'part one begins in Kolín');
  assert.deepEqual([partOf('part1').at.x, partOf('part1').at.z], [street.x, street.z]);
  assert.deepEqual([partOf('part2').at.x, partOf('part2').at.z], [1213.6, 1448], 'part two at Vašek\'s door');
  assert.equal(partOf('nothing'), null);
  assert.deepEqual(endCard('part1'), ['Část 1 · Konec', 'Poslední vlak']);
  assert.deepEqual(endCard('part2'), ['Část 2 · Konec', 'Poslední vlak']);
});

test('the start mark: walked into, driven into, and never under the feet of a man who stands in it', () => {
  const p = partOf('part2');
  const walk = (g, from, to, steps, car = false) => {
    for (let i = 0; i <= steps; i++) {
      const x = from + (to - from) * (i / steps);
      if (gateStep(g, p, p.at.x + x, p.at.z, car)) return x;
    }
    return null;
  };
  // part one ends on this very spot: nothing begins until he has stepped out
  let g = startGate();
  assert.equal(gateStep(g, p, p.at.x, p.at.z, false), false);
  for (let i = 0; i < 100; i++) assert.equal(gateStep(g, p, p.at.x + 0.5, p.at.z, false), false);
  assert.equal(walk(g, 0, START_R + ARM_OUT - 0.5, 40), null, 'not armed yet');
  assert.equal(walk(g, START_R + ARM_OUT + 1, START_R + ARM_OUT + 2, 4), null, 'armed out there');
  const at = walk(g, 12, 0, 120);
  assert.ok(at !== null && at < START_R && at > START_R - 0.2, 'walked in at ' + at);
  assert.equal(gateStep(g, p, p.at.x, p.at.z, false), false, 'once');
  // at the wheel the ring is wider
  g = startGate();
  gateStep(g, p, p.at.x + 40, p.at.z, true);
  const car = walk(g, 40, 0, 400, true);
  assert.ok(car < START_R_CAR && car > START_R_CAR - 0.2, 'driven in at ' + car);
  // armed, then the part runs (no start open) and waits again with him on it:
  // it does not begin under his feet
  g = startGate();
  gateStep(g, p, p.at.x + 40, p.at.z, false);
  assert.equal(g.armed, true);
  for (let i = 0; i < 30; i++) gateStep(g, null, p.at.x, p.at.z, false);
  assert.equal(gateStep(g, p, p.at.x, p.at.z, false), false, 'part two began on the spot part one ended on');
  assert.equal(g.armed, false);
  // no part, no gate; another part arms afresh
  assert.equal(gateStep(g, null, 0, 0, false), false);
  assert.equal(g.part, null);
  gateStep(g, partOf('part1'), p.at.x, p.at.z, false);
  assert.equal(g.armed, true, 'part one\'s start is 40 km away');
});

test('where a quit part leaves him: off the roof, off the train, out of the villa\'s rooms, else where he stands', () => {
  const ground = 220;
  assert.equal(quitSpot({ x: 5, z: 5, y: ground + 0.3, ground }), null, 'on the street: where he is');
  assert.equal(quitSpot({ inCar: true, x: 5, z: 5, y: ground + 40, ground }), null, 'at the wheel: where he is');
  assert.deepEqual(quitSpot({ x: roofFrame.x + 2, z: roofFrame.z + 3, y: ground + 14, ground }), { x: street.x, z: street.z }, 'the roof in Kolín');
  assert.deepEqual(quitSpot({ chapter: 'station', aboard: true, x: 0, z: 0, y: ground + 0.8, ground }), { x: kolinPlatform.x, z: kolinPlatform.z });
  assert.deepEqual(quitSpot({ chapter: 'coach', aboard: true, x: 0, z: 0, y: ground + 0.8, ground }), { x: pardubicePlatform.x, z: pardubicePlatform.z });
  assert.deepEqual(quitSpot({ x: 3600, z: -5170, y: ground - 46, ground }), { drop: true }, 'the villa\'s rooms are under the house');
  assert.deepEqual(quitSpot({ x: 3600, z: -5170, y: ground + 3.5, ground }), { drop: true }, 'up the villa\'s ladder');
});

test('part one ends and part two does not begin: it waits at Vašek\'s door, and a save opens with it waiting', async () => {
  disk.clear();
  let { c, h } = await session();
  assert.equal(c.activeStory(), 'bridge', 'a new game opens on part one');
  assert.equal(c.nextPart(), null, 'nothing waits while a part runs');
  Object.assign(h.player.pos, { x: 1213.65, z: 1448 });
  said.length = 0;
  partOne(c);
  flushToasts();
  assert.equal(c.heistPending(), false, 'part two started by itself');
  assert.equal(c.nextPart()?.id, 'part2');
  assert.ok(said.some((t) => t.includes('Další: Poslední vlak · část 2')), said.join(' | '));
  assert.ok(said.some((t) => t.includes('Dražkovická 119')));
  assert.equal(onDisk().prologue, 'done');
  // free roam between the parts: the game saves at its points again
  play(c, h, 2);
  assert.ok(c.debug.marks.some((m) => m.kind === 'story' && m.x === 1213.6 && m.rim && m.label === 'Poslední vlak · část 2'), 'the mark is on the maps');
  assert.equal(c.autosave('mission'), true, 'a mission between the parts was not saved');
  // and the save opens in free roam with the mark, not in part two
  ({ c, h } = await session());
  assert.equal(c.heistPending(), false);
  assert.equal(c.nextPart()?.id, 'part2');
  assert.notDeepEqual([h.player.pos.x, h.player.pos.z], [1213.6, 1448], 'it opened at part two\'s start');
});

test('a save from an older build that finished part one opens with part two waiting, not running', async () => {
  disk.clear();
  // as written before 25 Nov 2026: part one done, part two never finished, at Vašek's door
  let { c } = await session();
  partOne(c);
  const old = onDisk();
  old.heist = null;
  delete old.point;
  disk.set(SAVE_KEY, JSON.stringify(old));
  ({ c } = await session());
  assert.equal(c.activeStory(), 'done');
  assert.equal(c.heistPending(), false, 'the old build\'s habit: part two began on its own');
  assert.equal(c.nextPart()?.id, 'part2');
  assert.equal(c.canStart('part2'), true);
  assert.equal(c.canStart('part1'), true, 'part one may be played again meanwhile');
});

test('the start begins part two; quitting it writes nothing and it waits again', async () => {
  disk.clear();
  let { c, h } = await session();
  partOne(c);
  const written = disk.get(SAVE_KEY);
  const at = c.beginPart('part2');
  assert.deepEqual(at, { x: 1213.6, z: 1448, h: -Math.PI / 2 });
  assert.equal(c.heistPending(), true);
  assert.equal(c.nextPart(), null);
  assert.equal(c.campaigns().running, 'part2');
  assert.equal(c.canStart('part1'), false, 'not over a running part');
  play(c, h, 3);
  assert.equal(c.autosave('mission'), false);
  assert.equal(c.quitCampaign(), true);
  assert.equal(c.heistPending(), false);
  assert.equal(c.nextPart()?.id, 'part2', 'the quit part waits at its start again');
  assert.equal(disk.get(SAVE_KEY), written, 'a quit wrote the save');
  assert.equal(c.campaigns().list[1].done, false);
  assert.equal(c.quitCampaign(), false, 'nothing to quit');
  // and it can be started again and finished
  c.beginPart('part2');
  c.completeHeist();
  assert.equal(onDisk().heist, 'done');
  assert.equal(c.nextPart(), null, 'the campaign is over');
  assert.equal(c.beginPart('part2') !== null, true, 'a finished part is a replay now');
});

test('quitting part one the first time: unfinished again, waiting in Kolín; quitting a replay leaves it finished', async () => {
  disk.clear();
  let { c } = await session();
  c.checkpointStory('station');
  assert.equal(c.quitCampaign(), true);
  assert.equal(c.activeStory(), null, 'the chapter is gone');
  assert.equal(c.nextPart()?.id, 'part1');
  assert.equal(c.canStart('part1'), true);
  const at = c.beginPart('part1');
  assert.ok(at.x < -38000, 'it begins in Kolín again');
  assert.equal(c.activeStory(), 'bridge');
  partOne(c);
  c.beginPart('part2');
  c.completeHeist();
  // a replay of part one, quit half way: still finished, nothing waits
  c.beginPart('part1');
  assert.equal(c.replayOf(), 'part1');
  c.checkpointStory('coach');
  assert.equal(c.quitCampaign(), true);
  assert.equal(c.activeStory(), 'done');
  assert.equal(c.replayOf(), null);
  assert.equal(c.nextPart(), null);
  // a replay of part two, quit: finished as it was
  c.beginPart('part2');
  assert.equal(c.heistPending(), true);
  assert.equal(c.quitCampaign(), true);
  assert.deepEqual(c.campaigns().list.map((p) => p.done), [true, true]);
  assert.equal(c.heistPending(), false);
});

test('no start marks where there is no campaign: co-op, Prague, free roam', async () => {
  disk.clear();
  let { c } = await session();
  partOne(c);
  for (const choice of [{ mode: 'server', start: 'pardubice' }, { mode: 'single', start: 'praha' }, { mode: 'single', start: 'pardubice', freeroam: true }]) {
    ({ c } = await session(choice));
    assert.equal(c.nextPart(), null, JSON.stringify(choice));
    assert.equal(c.canStart('part2'), false, JSON.stringify(choice));
  }
});

test('the tab\'s words, and the quit is confirmed by a second click', () => {
  assert.equal(quitWords({ replaying: null }).label, 'Ukončit kampaň');
  assert.match(quitWords({ replaying: null }).note, /začít ji můžeš znovu na jejím startu/);
  assert.equal(quitWords({ replaying: 'part2' }).label, 'Ukončit opakování');
  assert.match(CONFIRM, /Klikni znovu/);
  const menu = fs.readFileSync(new URL('../js/campaignmenu.js', import.meta.url), 'utf8');
  assert.match(menu, /if \(armed\) \{ clearTimeout\(armed\); armed = 0; quit\(\); return; \}/, 'the first click only asks');
  assert.match(menu, /'Navigovat na start'/);
  for (const f of ['campaignmenu.js', 'campaignparts.js', 'campaignmark.js'])
    assert.ok(!fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)), 'an em dash in ' + f);
});

test('main.js starts a part at its mark, quits one in place, and makes part two only once it is started', () => {
  const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  // the gate hears of a closed start too (found in the game: armed before a
  // replay of part one, it began part two the frame part one ended on its spot)
  assert.match(main, /if \(gateStep\(campaignGate, open \? next : null, player\.pos\.x, player\.pos\.z, !!\(game\.car \|\| player\.inCar\)\)\) startCampaign\(next\.id\);/);
  const pump = main.slice(main.indexOf('function pumpCampaignStart('), main.indexOf("window.addEventListener('atc:campaigns'"));
  assert.ok(!/\) return;\s+if \(gateStep/.test(pump), 'no early return before the gate is told');
  assert.match(main, /pumpStoryOver\(dt\);\s+pumpArrest\(dt\);\s+pumpCampaignStart\(dt\);/);
  const quit = main.slice(main.indexOf('function quitCampaign() {'), main.indexOf('// The start of the part that waits'));
  assert.match(quit, /if \(game\.mode !== 'play' \|\| net \|\| storyOver \|\| arrest \|\| vitals\.down\(\)\) return false;/);
  for (const step of ['journey?.dispose()', 'meeting?.close?.()', 'heist?.close()', 'career.quitCampaign()', 'storyClock.release()', 'quitSpot('])
    assert.ok(quit.includes(step), step);
  assert.ok(!/failStory|overCard/.test(quit), 'a quit is no failure: no card, no restart');
  // part two is made only while career.heistPending() says it runs
  assert.match(main, /if \(!heist && !meeting && !journey && !storyOver && career\.heistPending\(\)\)\s+heist = createHeist\(/);
  assert.match(main, /quit: \(\) => \{ close\(\); quitCampaign\(\); \}/);
  assert.ok(!main.includes('location.reload()') || !/quit: \(\) => location\.reload\(\)/.test(main), 'the quit reloads the page');
  // the two films end on the part's own card
  const src = (f) => fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
  assert.match(src('prologue-table.js'), /hud\.veil\(true, \.\.\.endCard\('part1'\)\);/);
});
