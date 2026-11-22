// The Kampaně tab (Frank, 22 Nov 2026): a finished campaign can be played
// again from the settings, its reward is paid once, and a replay says so.
// And the briefcase at the end of part two is real money in the wallet.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

// ---- a browser thin enough for js/career.js (as in autosave.test.mjs) -------
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
function quit() {
  for (const type of ['visibilitychange', 'beforeunload', 'pagehide', 'freeze', 'unload'])
    for (const [t, fn] of listeners) if (t === type) { try { fn({ type, persisted: false }); } catch { /* not ours */ } }
}

const { SAVE_KEY, parse } = await import('../js/savegame.js');
const { PART_ONE_END } = await import('../js/autosave.js');
const { PRICE } = await import('../js/prices.js');
const wallet = await import('../js/wallet.js');
const vitals = await import('../js/vitals.js');
const wanted = await import('../js/wanted.js');
const { rewardLine } = await import('../js/campaignmenu.js');

const host = () => ({ game: { mode: 'play', car: null }, input: { onKey() {} }, parked: [], parkedFleet: [],
  player: { pos: { x: 10, z: 20 }, heading: 0, y: 0, grounded: true }, world: { city: { pois: [], paved: [] } },
  vehicles: { add: (kind, x, z, heading, color) => ({ kind, x, z, heading, color }), remove() {} } });
const onDisk = () => JSON.parse(disk.get(SAVE_KEY));
let loads = 0;
async function session(choice = { mode: 'single', start: 'pardubice' }) {
  wanted.clear(); vitals.reset(); wallet.setMoney(wallet.START);
  const c = await import('../js/career.js?campaigns=' + (++loads));
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
const BRIEFCASE = PRICE.story.briefcase;
/** Both parts played through once, in one session. */
async function finished() {
  disk.clear();
  const s = await session();
  for (const stage of ['station', 'coach', 'arrival', 'forecourt', 'done']) s.c.checkpointStory(stage);
  s.c.completeHeist();
  flushToasts();
  return s;
}

test('the briefcase at the end of part two is money in the wallet, once', async () => {
  disk.clear();
  const { c } = await session();
  for (const stage of ['station', 'coach', 'arrival', 'forecourt', 'done']) c.checkpointStory(stage);
  assert.equal(BRIEFCASE, 250000, 'Vašek says two hundred and fifty thousand');
  assert.equal(c.heistReward(), BRIEFCASE);
  assert.match(c.heistRewardNote(), /v kufříku 250\s000\sKč/);
  const before = wallet.money();
  said.length = 0;
  c.completeHeist();
  flushToasts();
  assert.equal(wallet.money(), before + BRIEFCASE, 'the money was not added to the wallet');
  assert.equal(onDisk().money, before + BRIEFCASE, 'and it is in the save');
  assert.equal(onDisk().heistPaid, true);
  assert.equal(onDisk().heist, 'done');
  assert.ok(said.some((t) => t.includes('Peníze z kufříku jsou tvoje')), said.join(' | '));
  assert.equal(c.heistReward(), 0);
});

test('a finished part two is played again: nothing is written until its end, and it pays nothing', async () => {
  let { c, h } = await finished();
  const info = c.campaigns();
  assert.deepEqual(info.list.map((p) => [p.id, p.done, p.paid]), [['part1', true, false], ['part2', true, true]]);
  assert.equal(info.busy, false);
  assert.equal(c.canReplay('part2'), true);
  assert.equal(c.heistPending(), false);

  const written = disk.get(SAVE_KEY), money = wallet.money();
  const at = c.beginReplay('part2');
  assert.deepEqual([at.x, at.z], [PART_ONE_END.x, PART_ONE_END.z], 'it begins at Vašek\'s door');
  assert.equal(c.replayOf(), 'part2');
  assert.equal(c.heistPending(), true, 'part two is on again');
  assert.equal(c.campaigns().busy, true);
  assert.equal(c.campaigns().list[1].done, true, 'the part he is replaying reads as unfinished');
  assert.equal(c.canReplay('part1'), false, 'not over a running one');
  assert.match(c.heistRewardNote(), /Opakování · odměnu 250\s000\sKč už máš, podruhé se nevyplácí/);
  play(c, h, 20);
  assert.equal(c.autosave('mission'), false, 'a replay was saved in the middle');
  quit();
  assert.equal(disk.get(SAVE_KEY), written, 'the save moved while the replay ran');

  said.length = 0;
  c.completeHeist();
  flushToasts();
  assert.equal(wallet.money(), money, 'a replay paid the briefcase a second time');
  assert.ok(said.some((t) => t.includes('podruhé se nevyplácí')), 'he is not told that he got nothing: ' + said.join(' | '));
  assert.equal(onDisk().heist, 'done');
  assert.equal(onDisk().heistPaid, true);
  assert.equal(c.replayOf(), null);
  assert.equal(c.campaigns().busy, false);

  // closing the tab in the middle of a replay loses the replay and nothing else
  c.beginReplay('part2');
  quit();
  ({ c, h } = await session());
  assert.equal(c.heistPending(), false, 'an abandoned replay came back as an unfinished campaign');
  assert.equal(c.replayOf(), null);
  assert.equal(c.canReplay('part2'), true);
});

test('a save that finished part two before the briefcase paid gets it on its first replay, once', async () => {
  let { c } = await finished();
  const old = onDisk();
  delete old.heistPaid;                       // as every save written before 22 Nov 2026
  old.money = 2800;
  disk.set(SAVE_KEY, JSON.stringify(old));
  assert.equal(parse(disk.get(SAVE_KEY)).state.heistPaid, false);
  ({ c } = await session());
  assert.equal(wallet.money(), 2800);
  assert.equal(c.campaigns().list[1].paid, false);
  assert.match(rewardLine(c.campaigns().list[1]), /ještě nebyla vyplacena/);
  c.beginReplay('part2');
  c.completeHeist();
  assert.equal(wallet.money(), 2800 + BRIEFCASE);
  c.beginReplay('part2');
  c.completeHeist();
  assert.equal(wallet.money(), 2800 + BRIEFCASE, 'paid twice');
});

test('part one again: from the street in Kolín, saved only at its end, and part two does not follow', async () => {
  const { c, h } = await finished();
  const written = disk.get(SAVE_KEY);
  const at = c.beginReplay('part1');
  assert.ok(at.x < -38000, 'it begins in Kolín: ' + at.x);
  assert.equal(c.activeStory(), 'bridge');
  assert.equal(c.replayOf(), 'part1');
  for (const stage of ['station', 'coach', 'arrival', 'forecourt']) {
    c.checkpointStory(stage);
    play(c, h, 3);
    assert.equal(c.autosave('mission'), false);
  }
  quit();
  assert.equal(disk.get(SAVE_KEY), written, 'a replayed chapter was saved');
  said.length = 0;
  Object.assign(h.player.pos, { x: 1213, z: 1448 });
  c.checkpointStory('done');
  flushToasts();
  assert.equal(onDisk().prologue, 'done');
  assert.equal(onDisk().heist, 'done', 'the replay of part one un-finished part two');
  assert.equal(c.heistPending(), false, 'part two started after a replay of part one');
  assert.equal(c.replayOf(), null);
  assert.ok(said.some((t) => t.includes('Kampaň zopakována')));
});

test('what cannot be replayed: an unfinished part, a co-op game, a start in Prague', async () => {
  disk.clear();
  let { c } = await session();
  assert.equal(c.canReplay('part1'), false, 'the campaign is still being played');
  assert.equal(c.beginReplay('part1'), null);
  for (const stage of ['station', 'coach', 'arrival', 'forecourt', 'done']) c.checkpointStory(stage);
  assert.equal(c.canReplay('part1'), false, 'part two is running');
  assert.equal(c.canReplay('part2'), false, 'never finished');
  c.completeHeist();
  assert.equal(c.canReplay('part1'), true);
  assert.equal(c.canReplay('nothing'), false);
  ({ c } = await session({ mode: 'server', start: 'pardubice' }));
  assert.equal(c.canReplay('part1'), false, 'co-op');
  ({ c } = await session({ mode: 'single', start: 'praha' }));
  assert.equal(c.canReplay('part1'), false, 'a start in Prague has no campaign');
  // ?devmode's free roam over a finished save may replay: the story comes on for it
  ({ c } = await session({ mode: 'single', start: 'pardubice', freeroam: true }));
  assert.equal(c.canReplay('part2'), true);
  c.beginReplay('part2');
  assert.equal(c.heistPending(), true);
});

test('the tab: one card a campaign, the reward and that it is paid once, and it is wired', () => {
  assert.equal(rewardLine({ done: true, reward: 0 }), 'Dohráno');
  assert.equal(rewardLine({ done: false, reward: 0 }), 'Ještě nedohráno');
  assert.match(rewardLine({ done: true, reward: 250000, paid: true }), /vyplacena, při opakování se nevyplácí/);
  assert.match(rewardLine({ done: false, reward: 250000, paid: false }), /Ještě nedohráno · odměna 250\s000\sKč/);
  const src = (f) => fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
  assert.match(src('settings.js'), /page\('story', 'Kampaně'\)/);
  assert.match(src('settings.js'), /atc:campaigns/);
  const main = src('main.js');
  assert.match(main, /addEventListener\('atc:campaigns'/);
  assert.match(main, /career\.beginReplay\(o\.replay\)/);
  assert.match(main, /reward: career\.heistRewardNote/);
  assert.match(src('heist-deal.js'), /hud\.veil\(true, 'Konec druhé části', note \?\? 'Poslední vlak'\)/);
  for (const f of ['campaignmenu.js', 'career.js', 'settings.js'])
    assert.ok(!src(f).includes(String.fromCharCode(0x2014)) || f !== 'campaignmenu.js', 'an em dash in ' + f);
});
