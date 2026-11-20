// Traffic, the crowd and the police are not the player's (Frank, 20 Nov 2026):
// outside ?devmode the game runs on normal traffic, a busy crowd and normal
// patrols whatever was stored, and the three choices are not in the settings
// at all ("nesmí to tam být vůbec jako v možnostech nastavení"). Behind
// ?devmode they are on the dev tab; a co-op session locks them again, because
// every client has to build the same city from them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));   // settings pulls in nametags

import { WORLD, WORLD_ROWS, storedWorld, worldValues, forStorage } from '../js/worldsettings.js';

// localStorage as a Map, and a DOM that answers anything but keeps every bit of
// text written into it: the labels of the rows are how the panel is read.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
let text = [];
const node = () => new Proxy(function () {}, {
  get(t, k) {
    if (k === 'length') return 0;
    if (k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if (k === 'checked') return false;
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    return node();
  },
  set(t, k, v) { if ((k === 'innerHTML' || k === 'textContent') && typeof v === 'string') text.push(v); return true; },
  apply() { return node(); },
});
globalThis.document = node();
globalThis.window = node();
globalThis.navigator ??= { userAgent: 'node' };

const SETTINGS = new URL('../js/settings.js', import.meta.url).href;
let bust = 0;
/** A page load at `url` with `blob` in storage: a fresh settings.js, built the way the game builds it. */
async function open(url, blob) {
  store.clear();
  if (blob) store.set('atc-settings', JSON.stringify(blob));
  globalThis.location = new URL(url);
  text = [];
  const m = await import(`${SETTINGS}?w=${++bust}`);
  m.initSettings(() => {});
  return { m, S: m.getSettings(), panel: text.join('\n') };
}
const LABELS = ['Hustota provozu', 'Chodci', 'Policejní hlídky'];
const FIXED = { traffic: 120, peds: 60, police: 0.70 };
const world = (S) => ({ traffic: S.traffic, peds: S.peds, police: S.police });
const DEV_CHOICE = { preset: 'medium', traffic: 0, peds: 12, police: 1.3 };

test('the fixed values are normal traffic, a busy crowd and normal patrols', () => {
  assert.deepEqual({ ...WORLD }, FIXED);
  const said = (k) => { const [, , rungs] = WORLD_ROWS.find((r) => r[0] === k); return rungs.find(([v]) => v === WORLD[k])[1]; };
  assert.equal(said('traffic'), 'Běžná');
  assert.equal(said('peds'), 'Rušno');
  assert.equal(said('police'), 'Běžně');
});

test('outside ?devmode a stored choice never reaches the game, and the panel has no such rows', async () => {
  for (const blob of [null, DEV_CHOICE, { preset: 'low' }, { preset: 'custom', traffic: 240, peds: 0, police: 0 }, { traffic: 'x', police: NaN }]) {
    const { S, panel } = await open('https://amongthecity.pages.dev/', blob);
    assert.deepEqual(world(S), FIXED, JSON.stringify(blob));
    for (const l of LABELS) assert.ok(!panel.includes(l), `"${l}" is in the normal settings`);
    assert.ok(!panel.includes('Dev'), 'a dev tab without ?devmode');
  }
  // the presets do not carry them any more: low is still fast, the crowd is not its knob
  const { S } = await open('https://amongthecity.pages.dev/', { preset: 'low' });
  assert.equal(S.shadows, false);
  assert.deepEqual(world(S), FIXED);
});

test('with ?devmode they are on the dev tab and the stored choice is used', async () => {
  const { S, panel } = await open('http://localhost:5252/?devmode', DEV_CHOICE);
  assert.deepEqual(world(S), { traffic: 0, peds: 12, police: 1.3 });
  for (const l of LABELS) assert.ok(panel.includes(l), `"${l}" is missing from the dev tab`);
  assert.ok(panel.includes('🛠 Dev'));
  assert.ok(panel.includes('Provoz a lidé'));
  assert.ok(!panel.includes(String.fromCharCode(0x2014)), 'an em dash in UI text');
  // nothing stored yet: the same fixed values as everybody
  assert.deepEqual(world((await open('http://localhost:5252/?devmode', null)).S), FIXED);
  // ?devmode=1 and ?x=1&devmode count too; ?devmodex does not
  assert.deepEqual(world((await open('http://localhost:5252/?x=1&devmode', DEV_CHOICE)).S).traffic, 0);
  assert.deepEqual(world((await open('http://localhost:5252/?devmodex', DEV_CHOICE)).S), FIXED);
});

test('co-op locks them to the fixed values for every player, ?devmode or not', async () => {
  const { m, S } = await open('http://localhost:5252/?devmode', DEV_CHOICE);
  assert.equal(m.shareWorld(), S, 'shareWorld hands back the live object main.js holds');
  assert.deepEqual(world(m.getSettings()), FIXED);
  const plain = await open('https://amongthecity.pages.dev/', DEV_CHOICE);
  plain.m.shareWorld();
  assert.deepEqual(world(plain.S), FIXED);
});

test('the classic game neither reads a developer\'s choice nor writes over it', () => {
  const kept = storedWorld(DEV_CHOICE);
  const live = { preset: 'high', volume: 0.4, ...worldValues(DEV_CHOICE, false) };
  assert.deepEqual(world(live), FIXED);
  // locked: the blob keeps the choice, the fixed values are never stored in its place
  assert.deepEqual(world(forStorage(live, kept, false)), { traffic: 0, peds: 12, police: 1.3 });
  assert.equal(forStorage(live, kept, false).volume, 0.4, 'the rest of the settings were not stored');
  const none = forStorage(live, {}, false);
  for (const k of Object.keys(FIXED)) assert.ok(!(k in none), `the fixed ${k} was written into a clean profile`);
  // free (?devmode): what it runs on is what it stores
  const dev = { ...live, traffic: 240 };
  assert.equal(forStorage(dev, kept, true).traffic, 240);
  // a hand-edited number lands on the nearest offered rung, and junk is no choice at all
  assert.deepEqual(storedWorld({ traffic: 100000, peds: 33, police: -4 }), { traffic: 240, peds: 34, police: 0 });
  assert.deepEqual(storedWorld({ traffic: '240', peds: null, police: Infinity }), {});
  assert.deepEqual(storedWorld(null), {});
});
