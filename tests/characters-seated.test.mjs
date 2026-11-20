// ---- the people behind car glass: rows, views and crews ---------------------------
// js/characters/seatrows.js is pure bookkeeping (whose picture is in which row
// of the seated atlas), js/carcrew.js says who a car shows. The pictures
// themselves need a renderer and are checked in the game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const S = await import('../js/characters/seatrows.js');

const vec = () => new THREE.Vector4(-1, -1, 0, 0);

test('the picture shown is the one taken from nearest the eye', () => {
  assert.equal(S.viewIndex(0, 1), 0, 'from straight behind (the chase camera)');
  assert.equal(S.viewIndex(0, -1), S.VIEWS / 2, 'through the windscreen');
  assert.equal(S.viewIndex(1, 0), S.VIEWS / 4, 'from the right flank');
  assert.equal(S.viewIndex(-1, 0), (3 * S.VIEWS) / 4, 'from the left flank');
  for (let i = 0; i < S.VIEWS; i++) {
    const a = S.viewAzimuth(i);
    assert.equal(S.viewIndex(Math.sin(a), Math.cos(a)), i);
    // and anywhere within half a step of it
    assert.equal(S.viewIndex(Math.sin(a + 0.18), Math.cos(a + 0.18)), i);
    assert.equal(S.viewIndex(Math.sin(a - 0.18), Math.cos(a - 0.18)), i);
  }
  assert.deepEqual(S.tileRect(3, 5), [5 * S.TILE_W, 3 * S.TILE_H, S.TILE_W, S.TILE_H]);
  // a picture is as tall as it is wide in the cabin's own metres, pixel for pixel
  assert.ok(Math.abs(S.FRAME_W / S.FRAME_H - S.TILE_W / S.TILE_H) < 1e-9);
});

test('nobody has a picture until somebody can draw; then everyone bound gets a row', () => {
  S.resetSeats();
  const a = vec(), b = vec();
  assert.equal(S.bindSeat(a, 0, '@civ0'), -1);
  assert.equal(S.bindSeat(b, 1, 'm01+m01:p'), -1);
  assert.equal(S.bindSeat(b, 0, null), -1, 'no key, no picture');
  const drawn = [];
  S.setBaker((row, key) => { drawn.push(key + '@' + row); });
  assert.deepEqual(drawn, ['@civ0@0', 'm01+m01:p@1']);
  assert.equal(a.x, 0); assert.equal(b.y, 1); assert.equal(b.x, -1);
  // the same person asked for again is the same row and is not drawn twice
  const c = vec();
  assert.equal(S.bindSeat(c, 0, '@civ0'), 0);
  assert.equal(drawn.length, 2);
  // somebody nobody can draw (an unknown name) has no row and holds none
  S.setBaker((row, key) => key !== 'ghost+ghost:d');
  const g = vec();
  assert.equal(S.bindSeat(g, 0, 'ghost+ghost:d'), -1);
  assert.equal(S.seatStats().drawn, 2);
});

test('a full atlas gives up the picture asked for longest ago, never a stock driver', () => {
  S.resetSeats();
  const redrawn = [];
  S.setBaker((row, key, again) => { if (again) redrawn.push(key); });
  const stock = [];
  for (let i = 0; i < S.CIVS; i++) { const v = vec(); S.bindSeat(v, 0, '@civ' + i); stock.push(v); }
  const named = [];
  for (let i = 0; i < S.ROWS - S.CIVS; i++) { const v = vec(); S.bindSeat(v, 0, 'p' + i + '+p' + i + ':d'); named.push(v); }
  assert.equal(S.seatStats().drawn, S.ROWS);
  S.touchSeat('p0+p0:d');                       // the oldest is looked at again: now p1 is the oldest
  const late = vec();
  const r = S.bindSeat(late, 0, 'late+late:d');
  assert.ok(r >= 0);
  assert.equal(named[1].x, -1, 'the one given up is told so');
  assert.equal(named[0].x >= 0, true);
  assert.ok(stock.every((v, i) => v.x === i), 'the stock drivers kept their rows');
  assert.equal(S.rowOf('late+late:d'), r);
  // shown again, the one given up is drawn afresh (and somebody else makes way)
  const back = S.touchSeat('p1+p1:d');
  assert.ok(back >= 0);
  assert.equal(named[1].x, back);
  // a sharp texture came in: the same row, taken again
  assert.equal(S.redrawSeat('late+late:d'), r);
  assert.deepEqual(redrawn, ['late+late:d']);
  // the pictures are forgotten with whoever drew them
  S.setBaker(null);
  assert.ok(stock.every((v) => v.x === -1) && late.x === -1);
});

test('a picture is keyed by body, head and what the hands do', () => {
  const body = { id: 'm08' }, head = { id: 'm07' };
  assert.equal(S.seatKey({ human: true, avatar: body, headAvatar: head }, 'd'), 'm08+m07:d');
  assert.equal(S.seatKey({ human: true, avatar: body }, 'p'), 'm08+m08:p');
  assert.equal(S.seatKey({ avatar: body }), null, 'a plain lofted figure has no picture');
  assert.equal(S.seatKey(null), null);
  assert.ok(S.isStock('@civ2') && !S.isStock('m08+m07:d'));
});

// ---- who a car shows -------------------------------------------------------------
const C = await import('../js/carcrew.js');
const G = await import('../js/carglass.js');

test('every car is born with a stock driver, and not all with the same one', () => {
  S.resetSeats();
  S.setBaker(() => true);
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const c = C.bornCrew();
    assert.match(c.dKey, /^@civ\d$/);
    assert.equal(c.D[3], 1);
    assert.ok(c.P.x >= 0, 'the driver has a picture');
    assert.equal(c.P.y, -1, 'and rides alone');
    seen.add(c.dKey);
  }
  assert.equal(seen.size, S.CIVS, 'all of the stock drivers are on the road');
  assert.equal(C.roleCrew('police').dKey, '@police');
  assert.equal(C.roleCrew('medic').dKey, '@medic');
  assert.ok(C.roleCrew('police') === C.roleCrew('police'), 'one record, so one material');
});

test('a car somebody sat in shows exactly them', () => {
  const born = C.roleCrew('medic');
  const me = { human: true, avatar: { id: 'm08' }, headAvatar: { id: 'm07' } };
  const vasek = { human: true, avatar: { id: 'm07' } };
  assert.ok(C.crewOf(born, undefined, null) === born, 'nobody named: the stock driver');
  const mine = C.crewOf(born, { jacket: 0x334455, cit: me }, null);
  assert.equal(mine.dKey, 'm08+m07:d');
  assert.equal(mine.D[3], 2, 'named: shown lamps or no lamps');
  assert.ok(mine.P.x >= 0 && mine.P.y === -1);
  assert.ok(mine === C.crewOf(born, { jacket: 0x334455, cit: me }, null), 'the same crew is the same record');
  const two = C.crewOf(born, { jacket: 0x334455, cit: me }, vasek);
  assert.equal(two.pKey, 'm07+m07:p');
  assert.ok(two.P.x >= 0 && two.P.y >= 0 && two.P.x !== two.P.y);
  // I have got out: the seat is empty whatever the lamps say, he still sits there
  const left = C.crewOf(born, null, vasek);
  assert.equal(left.D[3], 0);
  assert.ok(left.P.x === -1 && left.P.y >= 0);
  // he waits in a parked car whose own driver was never named
  const waits = C.crewOf(born, undefined, vasek);
  assert.equal(waits.dKey, '@medic');
  assert.ok(waits.P.y >= 0);
  // a plain lofted figure (no people bank): the jacket, and no picture
  const plain = C.crewOf(born, { jacket: 0x808080, cit: { look: {} } }, null);
  assert.equal(plain.P.x, -1);
  assert.ok(plain.D[0] > 0);
});

test('the glass reads the crew\'s own vector, and the shader knows the atlas it reads', () => {
  const crew = C.roleCrew('police');
  const u = G.glassUniforms('octavia|123', 0x123456, null, crew);
  assert.ok(u.uCabP.value === crew.P, 'not a copy: rows are drawn and given up after the material is made');
  assert.ok(u.uCabPeople === S.seatAtlas);
  const none = G.glassUniforms('octavia|123', 0x123456, null, null);
  assert.equal(none.uCabP.value.x, -1);
  const src = G.GLASS_FRAG_DECL;
  assert.match(src, /void cabPerson\(/);
  assert.ok(src.includes('/ vec2(' + S.VIEWS + '.0, ' + S.ROWS + '.0)'), 'the atlas is VIEWS by ROWS pictures');
  assert.ok(src.includes('/ ' + S.FRAME_W + ' + 0.5') && src.includes('/ ' + S.FRAME_H + ')'), 'a picture is FRAME_W by FRAME_H metres');
  assert.ok(!src.includes('undefined') && !src.includes('NaN'));
  // the plain figure stays for a driver with no picture
  assert.match(src, /driver > 0\.5 && uCabP\.x < -0\.5/);
  // a stock driver is there while the lamps burn, somebody named always
  assert.ok(G.glassFrag('uLit').includes('max(uLit, uCabD.w - 1.0) * uCabD.w'));
});

// ---- who a key is ---------------------------------------------------------------
const { installDummies } = await import('../js/characters/dummy.js');
const { whoIs } = await import('../js/characters/seated.js');

test('a key names somebody of the bank, or nobody', () => {
  const [man, woman] = installDummies();
  assert.equal(whoIs('@civ0').body, man.id, 'even numbers are men');
  assert.equal(whoIs('@civ1').body, woman.id, 'odd ones women');
  assert.equal(whoIs('@civ0').driver, true);
  const me = whoIs(man.id + '+' + woman.id + ':p');
  assert.deepEqual(me, { body: man.id, head: woman.id, driver: false });
  assert.equal(whoIs(man.id + '+' + man.id + ':d').head, null, 'their own head is no borrowed one');
  assert.equal(whoIs('nobody+nobody:d'), null);
  assert.equal(whoIs(null), null);
});
