// The paint of a car: colour, finish, dirt and the leaf are a pure function of
// a seed (js/carlook.js), so two players see the same car, and the fleet as a
// whole has the mix Frank asked for (20 Nov 2026): about three cars in ten
// fully polished, most of them ordinary used cars, some matte, some dirty, a
// leaf now and then; mostly silver, grey, white and black, pink and gold rare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickColor, colorFamily, lookFromSeed, paintFromSeed, unpackLook, packLook, lookParams,
  FINISH, LOOK_FLEET, leafSpot, seedAt, mix32, fadeRgb } from '../js/carlook.js';

const N = 40000;
const seeds = Array.from({ length: N }, (_, i) => mix32(i * 2654435761 + 12345));

test('the same seed paints the same car, on every call', () => {
  for (const kind of ['octavia', 'fabia', 'bmw', 'tesla', 'van', 'bus', 'roadster']) {
    for (let i = 0; i < 200; i++) {
      const a = paintFromSeed(kind, seeds[i]), b = paintFromSeed(kind, seeds[i]);
      assert.deepEqual(a, b);
      assert.ok(a.look >= 0 && a.look <= 255 && Number.isInteger(a.look));
      assert.ok(a.color >= 0 && a.color <= 0xffffff);
    }
  }
  assert.equal(seedAt(1030.26, -572.1), seedAt(1030.3, -572.12), 'a parking space hashes the same within a few cm');
  assert.notEqual(seedAt(1030.26, -572.1), seedAt(1032.8, -572.1));
});

test('the look byte round-trips and 0 is the polished clean car', () => {
  for (let l = 0; l < 256; l++) {
    const u = unpackLook(l);
    assert.equal(packLook(u.finish, u.dirt, u.variant, u.leaf), l);
  }
  const p = lookParams(0);
  assert.equal(p.gloss, 1); assert.equal(p.dirt, 0); assert.equal(p.leaf, false); assert.equal(p.rough, 0);
  assert.equal(unpackLook(LOOK_FLEET).dirt, 0);
});

test('ordinary cars: about 30 % full gloss, most used, some matte, some dirty', () => {
  const fin = [0, 0, 0, 0], dirt = [0, 0, 0, 0];
  let leaf = 0;
  for (const s of seeds) {
    const u = unpackLook(lookFromSeed('octavia', s));
    fin[u.finish]++; dirt[u.dirt]++; if (u.leaf) leaf++;
  }
  const f = fin.map((n) => n / N), d = dirt.map((n) => n / N);
  assert.ok(f[FINISH.GLOSS] > 0.27 && f[FINISH.GLOSS] < 0.33, 'gloss ' + f[FINISH.GLOSS]);
  assert.ok(f[FINISH.USED] > 0.45 && f[FINISH.USED] > f[FINISH.GLOSS], 'used is the largest group');
  assert.ok(f[FINISH.WORN] > 0.08 && f[FINISH.WORN] < 0.2);
  assert.ok(f[FINISH.MATTE] > 0.03 && f[FINISH.MATTE] < 0.1, 'matte ' + f[FINISH.MATTE]);
  assert.ok(d[0] > 0.35 && d[0] < 0.6, 'clean ' + d[0]);
  assert.ok(d[1] + d[2] + d[3] > 0.4, 'a good share carries some dirt');
  assert.ok(d[3] > 0.02 && d[3] < 0.12, 'caked is uncommon: ' + d[3]);
  assert.ok(leaf / N > 0.03 && leaf / N < 0.09, 'a leaf now and then: ' + leaf / N);
});

test('a polished car is never caked, and each finish gets less glossy in turn', () => {
  for (const s of seeds.slice(0, 5000)) {
    const u = unpackLook(lookFromSeed('fabia', s));
    if (u.finish === FINISH.GLOSS || u.finish === FINISH.MATTE) assert.ok(u.dirt <= 2);
  }
  const g = [0, 1, 2, 3].map((fi) => lookParams(packLook(fi, 0, 0, false)));
  assert.ok(g[0].gloss > g[1].gloss && g[1].gloss > g[2].gloss && g[2].gloss > g[3].gloss);
  assert.ok(g[0].ccRough < g[1].ccRough && g[1].ccRough < g[2].ccRough && g[2].ccRough < g[3].ccRough);
  assert.ok(g[3].rough > g[1].rough);
  assert.equal(g[3].gloss, 0, 'matte has no lacquer at all');
});

test('the Czech fleet palette: mostly achromatic, many shades, pink and gold rare', () => {
  const fam = new Map(), shades = new Set();
  for (const s of seeds) {
    const c = pickColor('octavia', (s >>> 8) / 16777216);
    shades.add(c);
    fam.set(colorFamily(c), (fam.get(colorFamily(c)) ?? 0) + 1);
  }
  const share = (...k) => k.reduce((a, n) => a + (fam.get(n) ?? 0), 0) / N;
  assert.ok(shades.size >= 45, 'many more shades than the old ten: ' + shades.size);
  assert.ok(share('silver', 'grey', 'white', 'black') > 0.55, 'achromatic ' + share('silver', 'grey', 'white', 'black'));
  assert.ok(share('silver', 'grey') > share('white') && share('white') > share('red'));
  assert.ok(share('blue') > 0.1 && share('blue') < 0.22);
  assert.ok(share('red') > 0.05 && share('red') < 0.13);
  assert.ok(share('brown', 'beige') > 0.03 && share('green') > 0.02);
  assert.ok(share('bright') > 0.01 && share('bright') < 0.05, 'a few bright ones');
  assert.ok(share('pink', 'gold') < 0.012 && share('pink', 'gold') > 0, 'pink and gold: ' + share('pink', 'gold'));
  assert.equal(fam.get('other'), undefined);
});

test('kinds keep their own bias', () => {
  const count = (kind, f) => seeds.slice(0, 8000).filter((s) => f(pickColor(kind, (s >>> 8) / 16777216))).length / 8000;
  assert.ok(count('van', (c) => colorFamily(c) === 'white') > 0.4, 'vans are mostly white');
  assert.ok(count('bus', (c) => colorFamily(c) === 'red') > 0.7, 'the bus keeps its livery');
  assert.ok(count('bmw', (c) => ['black', 'grey', 'silver', 'white', 'blue'].includes(colorFamily(c))) > 0.9);
  assert.ok(count('roadster', (c) => colorFamily(c) === 'white') > 0.5);
  // edges of the draw
  for (const k of ['octavia', 'van', 'bus']) { assert.ok(pickColor(k, 0) >= 0); assert.ok(pickColor(k, 1) >= 0); assert.ok(pickColor(k, -3) >= 0); }
});

test('the leaf lies on the bonnet, the screen foot or the roof, inside the body', () => {
  const K = { wid: 1.81, hull: { sts: [[-2.35, 0.3, 0.52, 0.66], [2.35, 0.26, 0.82, 0.78]] },
    green: { sts: [[-0.72, 0.87, 0.90], [-0.02, 0.88, 1.44], [0.30, 0.885, 1.44], [0.44, 0.885, 1.435], [1.30, 0.90, 1.40], [2.06, 0.90, 0.94]] } };
  assert.equal(leafSpot(K, packLook(1, 0, 3, false)), null);
  assert.equal(leafSpot({ wid: 2.5, hull: K.hull }, packLook(1, 0, 3, true)), null, 'a bus has no bonnet');
  for (let v = 0; v < 8; v++) for (const hex of [0x15171a, 0xe8e8e3, 0xa61c26]) {
    const l = leafSpot(K, packLook(1, 1, v, true), hex);
    assert.ok(l && Math.abs(l[0]) < K.wid / 2 * 0.6, 'x ' + l[0]);
    assert.ok(l[1] > -2.0 && l[1] < 1.3, 'z ' + l[1]);
    assert.ok(l[3] > 0.03 && l[3] < 0.07, 'a leaf is a few cm');
    assert.deepEqual(l, leafSpot(K, packLook(1, 1, v, true), hex));
  }
});

test('fading chalks a colour toward pale without leaving 0..1', () => {
  assert.deepEqual(fadeRgb(0.5, 0.1, 0.1, 0), [0.5, 0.1, 0.1]);
  const [r, g, b] = fadeRgb(0.5, 0.02, 0.02, 0.14);
  assert.ok(g > 0.02 && b > 0.02 && r <= 0.56 && r >= 0 && g <= 1);
});
