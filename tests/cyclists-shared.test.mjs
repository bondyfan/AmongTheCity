// ---- shared cyclists: the same riders on every screen ------------------------
// The claim js/cyclists.js makes is the one js/pedestrians.js and js/traffic.js
// make: who is riding where is a pure function of the map and the shared
// clock, and no body appears or disappears where the player can see it. These
// tests state that as things two clients must agree about.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Cyclists, _tuning } = await import('../js/cyclists.js');
const { planAt } = await import('../js/cycleplan.js');
const { town, stubScene, T0, viewAt } = await import('./cyclists-fixture.mjs');

// One client. `tiles`: a function cutting the town into the batches it streams in.
function client({ tiles = null, t0 = T0, max = 34 } = {}) {
  const roads = town();
  const groups = tiles ? tiles(roads) : [roads];
  let onTile = null;
  const city = { roads: groups[0], onTileLoaded(f) { onTile = f; }, late(roads) { onTile({ roads }); } };
  const cy = new Cyclists(stubScene, city);
  for (let i = 1; i < groups.length; i++) onTile({ roads: groups[i] });
  let now = t0;
  cy.clock = () => now;
  cy.max = max;
  return {
    cy, now: () => now, at: (t) => { now = t; },
    // `view`: (t) => a viewer record, or null for a client that sees nothing
    run(secs, pos, view = null, each = null, hz = 20) {
      for (let i = 0; i < secs * hz; i++) {
        now += 1 / hz;
        const p = typeof pos === 'function' ? pos(now) : pos;
        cy.setViewer(view ? view(now, p) : { x: p.x, z: p.z, dirX: 1, dirZ: 0, hideR: 0 });
        cy.update(1 / hz, p);
        each?.(now, p);
      }
    },
  };
}

const HOME = { x: 0, z: 0 };

test('two clients whose tiles arrived in a different order ride the same riders', () => {
  const a = client();
  const b = client({ tiles: (r) => { const h = r.length >> 1; return [r.slice(h).reverse(), r.slice(0, h)]; } });
  a.run(60, HOME); b.run(60, HOME);
  let rows = 0;
  for (const dt of [0, 45, 150, 260, 480]) {
    a.run(dt, HOME); b.run(dt, HOME);
    const sa = a.cy.snapshot(0, 0, 700), sb = b.cy.snapshot(0, 0, 700);
    assert.ok(sa.length >= 4, 'somebody is riding: ' + sa.length);
    // which rows carry a body is each client's own business; the riders are not
    for (const s of [...sa, ...sb]) delete s.body;
    assert.deepEqual(sa, sb, 'at +' + (a.now() - T0));
    rows += sa.length;
  }
  assert.ok(rows > 30);
});

test('a tile that streams in after riders were minted: the two clients agree again within seconds', () => {
  // `a` has the whole town from the start; `b` only its west half for the
  // first thirty seconds (roads are cut at tile borders, so: every way that
  // lies wholly west). Before js/cyclistmint.js regraph(), one rider in five
  // was somewhere else on b for up to a whole generation afterwards.
  const a = client();
  let late = null;
  const b = client({ tiles: (r) => { late = r.filter((w) => !w.p.every((q) => q[0] <= 0)); return [r.filter((w) => w.p.every((q) => q[0] <= 0))]; } });
  a.run(30, HOME); b.run(30, HOME);
  const rows = (c) => { const s = c.cy.snapshot(0, 0, 700); for (const q of s) delete q.body; return new Map(s.map((q) => [q.key, q])); };
  const same = (p, q) => p.seed === q.seed && p.len === q.len && Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.z - q.z) < 1e-9;
  // (what b has that a has differently, and what a has that b has not at all)
  const compare = () => {
    const sa = rows(a), sb = rows(b);
    let wrong = 0, missing = 0;
    for (const [k, q] of sa) { const o = sb.get(k); if (!o) missing++; else if (!same(q, o)) wrong++; }
    return { n: sa.size, wrong, missing, extra: [...sb.keys()].filter((k) => !sa.has(k)).length };
  };
  assert.ok(compare().wrong > 5, 'half a town is not the town: riders near its edge are elsewhere');
  b.cy.city.late(late);
  // at once: nobody rides a trip planned over the half map any more…
  a.run(4, HOME); b.run(4, HOME);
  let c = compare();
  assert.equal(c.wrong, 0, `${c.wrong} of ${c.n} riders are somewhere else on the client whose tile came late`);
  assert.equal(c.extra, 0);
  // …and the slots are minted again a dozen a second, over the whole map
  a.run(45, HOME); b.run(45, HOME);
  c = compare();
  assert.ok(c.n > 100, 'a town full: ' + c.n);
  assert.deepEqual([c.wrong, c.missing, c.extra], [0, 0, 0], 'the same riders on both');
});

test('somebody who joins late sees the riders who were already there', () => {
  const a = client();
  a.run(400, HOME);
  const b = client({ t0: a.now() });
  // a few sweeps, to mint what is within reach
  a.run(40, HOME); b.run(40, HOME);
  const sa = a.cy.snapshot(0, 0, 700), sb = b.cy.snapshot(0, 0, 700);
  for (const s of [...sa, ...sb]) delete s.body;
  assert.ok(sa.length >= 4);
  assert.deepEqual(sa, sb);
});

test('the same rider is the same person on the same bicycle', () => {
  const a = client(), b = client();
  // a camera looking away from everything: bodies everywhere within reach
  const away = (t, p) => viewAt(p.x, p.z, 0, 1);
  a.run(40, { x: 0, z: -400 }, away); b.run(40, { x: 0, z: -400 }, away);
  assert.ok(a.cy.riders.length >= 2, 'bodies: ' + a.cy.riders.length);
  const look = (cy) => cy.riders.map((r) => [r.s.key, r.type, r.paint, r.s.arch, r.c.look.jacket, r.c.look.pants, r.c.look.hair].join('|')).sort();
  assert.deepEqual(look(a.cy), look(b.cy));
  // …and every body is on its plan or behind it, never ahead
  const N = {};
  for (const r of a.cy.riders) {
    planAt(r.s.plan, a.now(), { k: 0, s: 0 }, N);
    assert.ok(r.arc <= N.arc + 1e-6 && r.arc > N.arc - 5, 'on the plan: ' + (N.arc - r.arc));
  }
});

test('the hour and the slider set how many ride', () => {
  const count = (t0, max) => {
    const c = client({ t0, max });
    c.run(60, HOME);
    return c.cy._pool.size;
  };
  const noon = count(T0, 34);
  // the same day, 03:00: js/dayrhythm.js has three walkers in a hundred out
  const night = count(T0 - (12.5 - 3) * 60, 34);
  assert.ok(noon >= 20, 'noon: ' + noon);
  assert.ok(night < noon / 5, `few at night: ${night} against ${noon}`);
  assert.equal(count(T0, 0), 0, 'the slider at zero is nobody');
  const half = count(T0, 17);
  assert.ok(half < noon * 0.75 && half > noon * 0.25, `half the slider is about half: ${half} against ${noon}`);
});

test('nobody appears or vanishes where the player is looking', () => {
  const c = client();
  const cy = c.cy;
  // a player walking east along a cycleway and looking where they go, turning
  // round now and then
  const pos = (t) => ({ x: -500 + (t - T0) * 1.4, z: 2 });
  const dir = (t) => (Math.floor((t - T0) / 47) % 3 === 2 ? -1 : 1);
  const view = (t, p) => viewAt(p.x, p.z, dir(t), 0);
  const seen = (x, z) => {
    const v = cy.view, dx = x - v.x, dz = z - v.z, d = Math.hypot(dx, dz);
    if (d >= _tuning.NOTICE_R) return false;
    if (d <= 40) return true;
    // the protected cone: the screen's half angle plus the modules' margin
    const half = Math.atan(Math.tan(55 * Math.PI / 360) * 16 / 9) + 0.42;
    return (dx * v.dx + dz * v.dz) / d >= Math.cos(half);
  };
  let appeared = 0, vanished = 0, bad = [];
  const attach = cy._attach.bind(cy), drop = cy._drop.bind(cy);
  cy._attach = (s, wt) => { const r = attach(s, wt); appeared++; if (seen(r.x, r.z)) bad.push(['appeared', r.x, r.z]); return r; };
  cy._drop = (i) => { const r = cy.riders[i]; if (r) { vanished++; if (seen(r.x, r.z) && r.ghostT < 89) bad.push(['vanished', r.x, r.z]); } return drop(i); };
  let most = 0;
  c.run(480, pos, view, () => { if (cy.riders.length > most) most = cy.riders.length; });
  assert.ok(appeared > 15 && vanished > 8, `a town with riders coming and going: ${appeared} in, ${vanished} out`);
  assert.deepEqual(bad, []);
  assert.ok(most >= 3 && most <= 16, 'bodies at once: ' + most);
});

test('a rider whose generation rolls on screen rides on, and the slot is refilled on time', () => {
  const c = client();
  const cy = c.cy;
  // stare at everything: nothing may be taken away
  const stare = (t, p) => ({ x: p.x, z: p.z, dirX: 1, dirZ: 0, fovRad: 3, aspect: 3, hideR: 5000 });
  c.run(30, HOME);                       // blind: bodies everywhere
  const before = cy.riders.length;
  assert.ok(before >= 3);
  let ghosts = 0;
  c.run(_tuning.TRIP_T + 20, HOME, stare, () => { ghosts = Math.max(ghosts, cy.riders.filter((r) => r.ghost).length); });
  assert.ok(ghosts >= 1, 'somebody outlived their generation in view');
  for (const s of cy._pool.values()) {
    assert.equal(Math.floor((c.now() + s.ph) / _tuning.TRIP_T), s.gen, 'every slot is on the current generation');
  }
  // walk away: the ghosts go
  c.run(5, { x: 6000, z: 6000 });
  assert.equal(cy.riders.filter((r) => r.ghost).length, 0);
});
