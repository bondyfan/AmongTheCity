// ---- js/characters/cast.js and appearance.js: who is who, as pure data --------
import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../js/characters/cast.js');
const A = await import('../js/characters/appearance.js');

const CAT = [];
const add = (id, sex, kind, age, tone, style, more = {}) => CAT.push({ id, sex, kind, age, tone, style, ...more });
for (let i = 1; i <= 8; i++) add('m' + String(i).padStart(2, '0'), 'm', 'adult', i > 6 ? 'old' : 'adult', i % 3, i % 2 ? 'casual' : 'smart');
for (let i = 1; i <= 8; i++) add('f' + String(i).padStart(2, '0'), 'f', 'adult', i > 6 ? 'old' : i === 1 ? 'young' : 'adult', i % 3, i % 2 ? 'casual' : 'sport');
add('pm1', 'm', 'police', 'adult', 0, 'work'); add('pm2', 'm', 'police', 'adult', 1, 'work'); add('pf1', 'f', 'police', 'adult', 0, 'work');
add('md1', 'f', 'medic', 'adult', 0, 'work');
add('c1', 'f', 'child', 'young', 0, 'casual');
C.setCatalog(CAT, { 'kolin-dcera': 'c1', vasek: 'm03', ghost: 'nobody' });

test('a pedestrian is a pure function of its seed and archetype', () => {
  for (const arch of ['m30', 'f30', 'm60', 'f60', 'm90']) {
    for (let seed = 1; seed < 400; seed += 7) {
      const a = C.avatarForSeed(seed, arch), b = C.avatarForSeed(seed, arch);
      assert.equal(a, b);
      const e = C.entry(a);
      assert.equal(e.kind, 'adult', 'never a uniform, never a child');
      assert.equal(e.sex, arch[0], `${arch} is played by its own sex`);
      if (arch !== 'm30' && arch !== 'f30') assert.equal(e.age, 'old', `${arch} is played by somebody old`);
      else assert.notEqual(e.age, 'old');
    }
  }
});

test('every body of a pool turns up, and none hogs the street', () => {
  const count = new Map();
  const N = 6000;
  for (let seed = 0; seed < N; seed++) { const id = C.avatarForSeed(Math.imul(seed, 2654435761) >>> 0, 'm30'); count.set(id, (count.get(id) ?? 0) + 1); }
  assert.equal(count.size, 6, 'the six working-age men');
  for (const [id, n] of count) assert.ok(n > N / 6 * 0.8 && n < N / 6 * 1.2, `${id}: ${n}`);
  // consecutive seeds do not walk through the pool in order
  const run = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => C.avatarForSeed(s, 'm30'));
  assert.ok(new Set(run).size >= 3);
});

test('uniforms, the story\'s cast and explicit avatars', () => {
  assert.ok(['pm1', 'pm2'].includes(C.castFor({ role: 'police', archetype: 'm30' }, 5).body));
  assert.equal(C.castFor({ role: 'police', archetype: 'f30' }, 5).body, 'pf1');
  // no male medic in this catalogue: the uniform matters more than the sex
  assert.equal(C.castFor({ role: 'medic', archetype: 'm30' }, 9).body, 'md1');
  assert.deepEqual(C.castFor({ uid: 'kolin-dcera', archetype: 'f30' }), { body: 'c1', head: null });
  assert.deepEqual(C.castFor({ uid: 'vasek' }), { body: 'm03', head: null });
  // a name that points at nobody falls back to the uid's own hash
  assert.equal(C.entry(C.castFor({ uid: 'ghost' }).body).kind, 'adult');
  assert.deepEqual(C.castFor({ avatar: 'f02' }), { body: 'f02', head: null });
  assert.equal(C.castFor({ avatar: 'missing', archetype: 'f30' }, 3).body[0], 'f');
  // a player with a code wears it; a head equal to the body is no second mesh
  assert.deepEqual(C.castFor({ uid: 'u1' }, 0, { body: 'm01', head: 'm04' }), { body: 'm01', head: 'm04' });
  assert.deepEqual(C.castFor({ uid: 'u1' }, 0, { body: 'm01', head: 'm01' }), { body: 'm01', head: null });
  // a stranger is the same adult on every screen
  assert.deepEqual(C.castFor({ uid: 'u9xk2' }), C.castFor({ uid: 'u9xk2' }));
  // an empty catalogue casts nobody (the game then keeps its own figures)
  C.setCatalog([]);
  assert.equal(C.castFor({ archetype: 'm30' }, 1), null);
  C.setCatalog(CAT, { 'kolin-dcera': 'c1', vasek: 'm03', ghost: 'nobody' });
});

test('an appearance code round-trips and is only as good as the catalogue', () => {
  const code = A.encodeLook({ head: 'm04', body: 'm01' });
  assert.equal(code, '1-m04-m01');
  assert.deepEqual(A.decodeLook(code), { head: 'm04', body: 'm01' });
  assert.equal(A.encodeLook({ body: 'f02' }), '1-f02-f02');
  for (const bad of ['', null, 42, '2-m01-m01', '1-m01', '1-<b>-m01', '1-m01-m01-x', '1-' + 'a'.repeat(13) + '-m01'])
    assert.equal(A.sanitizeLook(bad), '', String(bad));
  assert.equal(A.encodeLook({ head: 'x y', body: 'm01' }), '');
  // m04 and m01 share sex and tone (4 % 3 === 1 % 3): the head is kept
  assert.equal(A.validLook('1-m04-m01'), '1-m04-m01');
  // another tone, another sex, a child, a uniform, an unknown id: the body's own head
  assert.equal(A.validLook('1-m02-m01'), '1-m01-m01');
  assert.equal(A.validLook('1-f04-m01'), '1-m01-m01');
  assert.equal(A.validLook('1-zz9-m01'), '1-m01-m01');
  assert.equal(A.validLook('1-m01-pm1'), null, 'a uniform is not a wardrobe choice');
  assert.equal(A.validLook('1-c1-c1'), null);
  assert.equal(A.validLook('1-m01-zz9'), null);
  const d = A.defaultLook('u9xk2');
  assert.equal(d, A.defaultLook('u9xk2'));
  assert.equal(A.validLook(d), d);
});

test('the creator\'s lists come from the catalogue', () => {
  const o = A.creatorOptions();
  assert.deepEqual(o.sexes, ['m', 'f']);
  assert.deepEqual(o.tones('m'), [0, 1, 2]);
  assert.deepEqual(o.heads('m', 1).map((a) => a.id), ['m01', 'm04', 'm07']);
  assert.deepEqual(o.styles('f', 1), ['casual', 'sport']);
  assert.deepEqual(o.bodies('f', 1, 'sport').map((a) => a.id), ['f04']);
  assert.ok(o.all.every((a) => a.kind === 'adult'));
  assert.equal(A.styleName('smart'), 'Elegantní');
  const at = A.describeLook('1-m04-m01');
  assert.equal(at.sex, 'm'); assert.equal(at.tone, 1); assert.equal(at.style, 'casual'); assert.equal(at.head.id, 'm04');
  assert.equal(A.describeLook('nonsense'), null);
});

test('looks by uid: the choice, the default for strangers, and a notice on change', () => {
  const seen = [];
  const off = A.onLookChange((uid, code) => seen.push(uid + '=' + code));
  assert.equal(A.lookCodeFor('ua'), '');
  assert.deepEqual(A.lookOf('ua'), A.decodeLook(A.defaultLook('ua')));
  assert.equal(A.setLookFor('ua', '1-m04-m01'), true);
  assert.equal(A.setLookFor('ua', '1-m04-m01'), false, 'no change, no notice');
  assert.deepEqual(A.lookOf('ua'), { head: 'm04', body: 'm01' });
  // rubbish off the wire clears nothing it should not and never throws
  assert.equal(A.setLookFor('ub', '<script>'), false);
  assert.equal(A.setLookFor('', '1-m04-m01'), false);
  // a code for a body this build lacks shows the default instead
  A.setLookFor('uc', '1-zz1-zz2');
  assert.deepEqual(A.lookOf('uc'), A.decodeLook(A.defaultLook('uc')));
  off();
  A.setLookFor('ua', '');
  assert.deepEqual(seen, ['ua=1-m04-m01', 'uc=1-zz1-zz2']);
});

// ---- the wiring, read from the sources (these modules import three or the DOM) ----
import { readFileSync } from 'node:fs';
const src = (f) => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');

test('the co-op layer sends the look and trusts nothing it receives', () => {
  const net = src('netcity.js');
  // out: only a sanitised code ever becomes _myLook, and it rides in the state blob
  assert.match(net, /export function setPlayerLook\(code\) \{ return \(_myLook = sanitizeLook\(code\)\); \}/);
  assert.match(net, /\.\.\.\(_myLook \? \{ ap: _myLook \} : \{\}\)/);
  // in: a string of sane length goes through setLookFor (which sanitises), keyed by the PERSON
  assert.match(net, /typeof s\.ap === 'string' && s\.ap\.length < 40 && setLookFor\(baseUid\(uid\), s\.ap\)/);
  // and a body already built in the old look is retired
  assert.match(net, /setLookFor\(baseUid\(uid\), s\.ap\) && r\.cit\) \{\s*r\.cit\.dispose\(\);\s*r\.cit = null;/);
});

test('the player and every peer are cast by uid; a pedestrian by its shared seed', () => {
  assert.match(src('player.js'), /makeCitizen\(\{ \.\.\.this\.look, uid: this\.baseUid \}, \{ faceDetail: true \}\)/);
  assert.match(src('netcity.js'), /makeCitizen\(\{ \.\.\.lookForUid\(baseUid\(uid\)\), uid: baseUid\(uid\) \}\)/);
  assert.match(src('pedestrians.js'), /makeCitizen\(\{ archetype: arch, prop: prop\.key, propTint: prop\.tint, seed: s\.seed \}\)/);
});

test('a new campaign opens the creator once; a new game forgets the look', () => {
  const main = src('main.js'), menu = src('menu.js');
  assert.match(main, /if \(opening && !validLook\(loadMyLook\(\)\)\) await showCreator\(\);/);
  assert.match(main, /wearLook\(myLook\(\)\);/);
  assert.match(menu, /store\.clear\(\);\s*saveMyLook\(''\);/);
});
