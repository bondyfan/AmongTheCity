// Co-op across regions (js/netcity.js, js/regions.js). One room, two worlds:
// a player on Mahé and a player in Pardubice stay connected, but nothing one
// sends may be applied in the other's world, whose coordinates mean something
// else. And a Czech client must put on the wire exactly what it did before.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const probe = `
  globalThis.location = { search: process.env.Q };
  const { register } = await import('node:module');
  register(new URL('./tests/three-alias.mjs', 'file://' + process.cwd() + '/'));
  const N = await import('./js/netcity.js');
  const W = N.CityNetWS, sent = [], got = [];
  W._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  W._handlers = W._handlers ?? {};
  W.onEvent((ev) => got.push(ev.type));
  W.sendEvent({ type: 'hit', x: 1, z: 2 });
  W._dispatch({ t: 'event', ev: { type: 'czech' } });
  W._dispatch({ t: 'event', ev: { type: 'mahe', rg: 'mahe' } });
  console.log(JSON.stringify({ sent: sent.map((m) => m.ev), got,
    same: [N.sameRegion({}), N.sameRegion({ rg: 'mahe' }), N.sameRegion({ rg: 'cz' })] }));`;
const run = (search) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, Q: search } }).toString());

test('a Czech client sends what it always sent and hears only the Czech world', () => {
  const r = run('');
  assert.deepEqual(r.sent, [{ type: 'hit', x: 1, z: 2 }], 'no region field from Czechia');
  assert.deepEqual(r.got, ['czech'], 'an event from Mahé is not applied in Pardubice');
  assert.deepEqual(r.same, [true, false, true]);
});

test('a client on Mahé stamps its region and hears only Mahé', () => {
  const r = run('?region=mahe');
  assert.deepEqual(r.sent, [{ type: 'hit', x: 1, z: 2, rg: 'mahe' }]);
  assert.deepEqual(r.got, ['mahe'], 'an event from the Czech world is not applied on Mahé');
  assert.deepEqual(r.same, [false, true, false]);
});
