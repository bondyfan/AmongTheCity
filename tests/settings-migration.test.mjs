// ---- a saved profile must not silently outvote a changed default ----------
// Ambient occlusion and the aerial ground layer were never in the preset table
// at all. That has two consequences and both of them look like "the setting
// does nothing":
//
//   * `ortho` defaulted off on every fresh profile, because an absent key is
//     whatever DEFAULTS says and DEFAULTS was built from PRESETS.medium;
//   * `ao` only ever appeared to work because an absent key reads as truthy at
//     the use site — nothing in the settings ever actually said it was on.
//
// Putting them in the table fixes the first kind of profile. It does NOT fix a
// 'custom' profile — the one you get the moment you touch any single graphics
// switch — because that branch deliberately keeps its values verbatim so a
// hand-tuned setup survives an update. So a user who had ever opened graphics
// settings would have got the old values forever and reported, for the second
// time, that the toggle does nothing.
//
// Hence the stamp: the new defaults are applied ONCE to a profile written
// before them, and after that the switches are the user's again.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));   // settings pulls in nametags

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
};
// The migration lives inside load(), which only runs from initSettings() — and
// initSettings builds the entire graphics panel. Rather than export load() just
// for a test, give it a DOM that answers anything: every property is another
// node, every call is a no-op. Nothing here is asserted on; the point is that
// the test drives the SAME entry point the game does, so a migration that only
// works when the panel is skipped cannot pass.
const node = () => new Proxy(function () {}, {
  get(t, k) {
    if (k === 'style' || k === 'classList' || k === 'dataset') return node();
    if (k === 'length') return 0;
    if (k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if (k === 'checked') return false;
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    return node();
  },
  set() { return true; },
  apply() { return node(); },
});
globalThis.document = node();
globalThis.window = node();
globalThis.location = new URL('https://example.invalid/');
globalThis.navigator ??= { userAgent: 'node' };

const SETTINGS = new URL('../js/settings.js', import.meta.url).href;
let bust = 0;
async function loadWith(blob) {
  store.clear();
  if (blob) store.set('atc-settings', JSON.stringify(blob));
  const m = await import(`${SETTINGS}?t=${++bust}`);   // fresh module = fresh S
  m.initSettings(() => {});                            // …and this is what loads it
  return m.getSettings();
}

test('a custom profile from before the change gets the new defaults once', async () => {
  const S = await loadWith({ preset: 'custom', ao: false, ortho: false, grass: false, peds: 0 });
  assert.equal(S.ao, true, 'ambient occlusion stayed off');
  assert.equal(S.ortho, true, 'the aerial ground layer stayed off');
  assert.equal(S.grass, true, '3D grass stayed off');
  assert.ok(S.peds > 0, `pedestrians stayed at ${S.peds} — it is a count, not a switch`);
});

test('…and once stamped, the switches are the user\'s again', async () => {
  const S = await loadWith({ preset: 'custom', v: 2, ao: false, ortho: false, grass: false, peds: 0 });
  assert.equal(S.ao, false, 'the migration re-ran and overrode a deliberate choice');
  assert.equal(S.ortho, false);
  assert.equal(S.peds, 0);
});

test('someone who deliberately chose "low" keeps low', async () => {
  const S = await loadWith({ preset: 'low' });
  assert.equal(S.ao, false, 'forced ambient occlusion onto a low-end machine');
  assert.equal(S.grass, false, 'forced 3D grass onto a low-end machine');
});

test('a named preset still takes the current table, not the stored numbers', async () => {
  // the reason the 'custom' branch is the only one that needs a stamp
  const S = await loadWith({ preset: 'medium', ao: false, ortho: false, traffic: 1 });
  assert.equal(S.ao, true);
  assert.equal(S.ortho, true);
  assert.ok(S.traffic > 1, 'a stale hand-edited number survived a named preset');
});

test('a fresh install has everything that was asked to be on by default', async () => {
  const S = await loadWith(null);
  assert.equal(S.preset, 'medium');
  for (const k of ['ao', 'ortho', 'grass', 'facades', 'trees'])
    assert.equal(S[k], true, `${k} is off on a fresh install`);
  assert.ok(S.peds > 0, 'no pedestrians on a fresh install');
});
