// ---- js/characters/animset.js: which clip, how fast -------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

const A = await import('../js/characters/animset.js');

const clip = (name, dur, travel) => ({ name, dur, travel });
const BANK = {
  m_walk_slow: clip('m_walk_slow', 1.4, 1.2), m_walk: clip('m_walk', 1.1, 1.5), m_run: clip('m_run', 0.7, 2.8),
  f_walk: clip('f_walk', 1.0, 1.3), still: clip('still', 2, 0),
};
const ROLES = { walkSlow: { m: 'm_walk_slow' }, walk: { m: 'm_walk', f: ['missing', 'f_walk'] }, run: { m: 'm_run' }, jog: 'still',
  idle: ['idleA', 'idleB'] };
const have = (n) => BANK[n] ?? null;

test('a role resolves by sex, falls back to the other one, and is always a list', () => {
  assert.deepEqual(A.clipsFor(ROLES, 'walk', 'f'), ['missing', 'f_walk']);
  assert.deepEqual(A.clipsFor(ROLES, 'run', 'f'), ['m_run']);
  assert.deepEqual(A.clipsFor(ROLES, 'idle', 'f'), ['idleA', 'idleB']);
  assert.deepEqual(A.clipsFor(ROLES, 'nothing', 'm'), []);
  assert.deepEqual(A.clipsFor(null, 'walk'), []);
});

test('the gait table is sorted by speed and skips clips that go nowhere', () => {
  const g = A.gaitTable(ROLES, 'm', have);
  assert.deepEqual(g.map((x) => x.clip.name), ['m_walk_slow', 'm_walk', 'm_run']);
  assert.ok(g[0].speed < g[1].speed && g[1].speed < g[2].speed);
  // the woman has one walk of her own (the first name is not baked) and borrows the rest
  assert.deepEqual(A.gaitTable(ROLES, 'f', have).map((x) => x.clip.name), ['m_walk_slow', 'f_walk', 'm_run']);
});

test('a speed between two gaits blends them and the stride follows', () => {
  const g = A.gaitTable(ROLES, 'm', have);
  const at = (v, k = 1) => A.pickGait(g, v, k, {});
  const walk = g[1], run = g[2];
  let p = at(walk.speed);
  assert.equal(p.b.clip.name, 'm_walk'); assert.ok(Math.abs(p.w - 1) < 1e-9); assert.ok(Math.abs(p.stride - 1.5) < 1e-9);
  p = at((walk.speed + run.speed) / 2);
  assert.equal(p.a.clip.name, 'm_walk'); assert.equal(p.b.clip.name, 'm_run');
  assert.ok(Math.abs(p.w - 0.5) < 1e-9); assert.ok(Math.abs(p.stride - (1.5 + 2.8) / 2) < 1e-9);
  // at a recorded gait's own speed the cycle covers exactly its recorded ground: no sliding
  p = at(g[0].speed); assert.ok(Math.abs(p.stride - 1.2) < 1e-9);
  // slower than the slowest: still that gait, shorter steps, never zero
  p = at(0.2); assert.equal(p.a.clip.name, 'm_walk_slow'); assert.ok(p.stride < 1.2 && p.stride >= 0.6);
  // faster than the fastest: the stride grows
  p = at(8); assert.equal(p.a.clip.name, 'm_run'); assert.ok(p.stride > 2.8);
  // a body with shorter legs covers less ground with the same pose
  p = at(walk.speed * 0.9, 0.9); assert.ok(Math.abs(p.stride - 1.5 * 0.9) < 1e-9);
  // no gaits at all is not a crash
  p = A.pickGait([], 1.3, 1, {}); assert.equal(p.a, null); assert.ok(p.stride > 0);
});

test('standing still: the same person, the same calm loop, an occasional fidget', () => {
  const idles = [clip('i1', 4, 0), clip('i2', 5, 0)], fid = [clip('look', 3, 0), clip('scratch', 2.5, 0)];
  const a = A.idleAt(1234, 3, idles, fid, {}, {}), b = A.idleAt(1234, 3, idles, fid, {}, {});
  assert.deepEqual(a, b);
  let fidgets = 0, calm = 0, names = new Set(), own = new Set();
  for (let seed = 1; seed < 40; seed++) {
    for (let t = 0; t < 280; t += 0.5) {
      const r = A.idleAt(seed, t, idles, fid, {}, {});
      if (r.fidget) { fidgets++; names.add(r.clip.name); assert.ok(r.t >= 0 && r.t < r.clip.dur); } else { calm++; own.add(seed + r.clip.name); }
    }
  }
  assert.ok(fidgets > 0 && fidgets < calm * 0.25, `fidgets ${fidgets} of ${calm}`);
  assert.equal(names.size, 2);
  assert.equal(own.size, 39, 'one calm loop per person');
  // nothing to fidget with is plain standing
  assert.equal(A.idleAt(7, 20, idles, [], {}, {}).fidget, false);
  assert.equal(A.idleAt(7, 20, [], fid, {}, {}).clip, null);
});

test('fades and the shared starting foot', () => {
  assert.equal(A.fadeInOut(0, 2), 0); assert.equal(A.fadeInOut(1, 2), 1); assert.equal(A.fadeInOut(2, 2), 0);
  assert.ok(Math.abs(A.fadeInOut(0.15, 2) - 0.5) < 1e-9);
  // the left foot is furthest ahead (most negative) at frame 7 of this cycle
  assert.equal(A.strikeFrame(20, (f) => Math.cos(((f - 7) / 20) * Math.PI * 2) * -0.3), 7);
});
