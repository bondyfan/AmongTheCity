// ---- street light and headlight lie on the road that is DRAWN ------------------
// "To světlo jak kdyby sedí někde, kde tam není vůbec surface. A taky když tam
// jezdí auta: jsou jak kdyby ve vzduchu." (Frank, 20 Nov 2026, on the ramp down
// to the railway underpass in Jana Palacha.) The pool of a lamp there hung
// 1.1 to 1.3 m over the carriageway, because it lay at the higher of the road
// and the 20 m height grid, and in a cutting the grid arches over the road.
// The fans of the cars coming over the top of the ramp stood up to a metre
// over the tarmac at their far ends, because a fan was one plane. Both rules
// live in js/poolspot.js and are pinned here.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { poolSpot, poolLevel, beamLie, beamSlope, fanHeight, LIFT, BEAM_LEN, BEAM_NOSE, BEAM_T1, BEAM_T2 } = await import('../js/poolspot.js');
const { LightPools } = await import('../js/lightpools.js');
const { LampMap, BEND_GLSL } = await import('../js/lampmap.js');

// one mast on the +z kerb of a road along x, facing it (rot 0: its local -z is the world's)
const mast = (x, y, z, kind = 'street') => ({ x, y, z, i: 0, kind, posts: { userData: { spots: [x, z, 0] } } });

// A road along x at z = 0, 9 m wide, whose surface is `road(x)`. `grid(x, z)` is
// the height grid, `drawn(x, z)` the ground the mesher draws (the grid clamped
// under the road's corridor). surfaceY and heightAt answer as city.js does.
function world({ road, grid, drawn = grid, half = 4.5, feet = true }) {
  const surf = { y: 0, road: false };
  const w = {
    terrain: { heightAt: grid },
    surfaceY(x, z) {
      surf.road = Math.abs(z) <= half + 0.35;
      surf.y = surf.road ? road(x) : grid(x, z) + 0.05;
      return surf;
    },
  };
  if (feet) w.heightAt = (x, z) => (Math.abs(z) <= half + 0.35 ? road(x) : drawn(x, z));
  return w;
}

test('a pool in a cutting lies on the carriageway, not on the grid arching over it', () => {
  // the ramp in Jana Palacha at z = 99.9: the road at 219.53, the grid at 220.45
  const w = world({ road: (x) => 219.53 + 0.069 * x, grid: () => 220.45, drawn: () => 219.48 });
  const s = poolSpot(mast(0, 219.65, 5.4), w);
  assert.ok(Math.abs(s.y - (219.53 + LIFT)) < 1e-9, `the pool lies at ${s.y.toFixed(2)}, the road is at 219.53`);
  assert.ok(Math.abs(s.slope - 0.069) < 1e-9, 'and along its grade');
  // what the old rule gave: the grid, the layer ladder and the lift over it
  const old = Math.max(219.53 + LIFT, 220.45 + 0.20 + LIFT);
  assert.ok(old - s.y > 1, 'the fixture has no cutting');
});

test('…and so does a lantern beside it: the ground that is drawn, not the grid', () => {
  const w = world({ road: () => 217.14, grid: () => 219.15, drawn: () => 217.09 });
  // a park lantern throws its pool at its own foot, here 7 m off the road in the cutting
  const s = poolSpot(mast(0, 217.09, 12, 'park'), w);
  assert.ok(Math.abs(s.y - (217.09 + LIFT)) < 1e-9, `at ${s.y.toFixed(2)} over ground drawn at 217.09`);
});

test('on level ground a pool is where it was: on the road, and clear of every thin layer off it', () => {
  const flat = world({ road: () => 220.2, grid: () => 220 });
  assert.ok(Math.abs(poolSpot(mast(0, 220.32, 5.2), flat).y - (220.2 + LIFT)) < 1e-9);
  // off the road, on grass: the ground, and every thin layer on it is under the lift
  const y = poolSpot(mast(0, 220, 30, 'park'), flat).y;
  assert.ok(Math.abs(y - (220 + LIFT)) < 1e-9, `a lantern's pool at ${y.toFixed(2)} over ground at 220`);
  // a car park is surfaceY's own (a layer over the grid, flagged as road): the pool clears it
  assert.ok(Math.abs(poolLevel({ heightAt: () => 220 }, 0, 0, 220, 220.1, 220, true) - (220.1 + LIFT)) < 1e-9);
  // …but half a metre of "grass" over ground that is drawn lower is the grid's arch, not a layer
  assert.ok(Math.abs(poolLevel({ heightAt: () => 219.6 }, 0, 0, 219.6, 220.05, 220, false) - (219.6 + LIFT)) < 1e-9);
  // a path's slab is higher than surfaceY knows: the pool clears what feet stand on
  const slab = world({ road: () => 220.2, grid: () => 220, drawn: () => 220.16 });
  assert.ok(Math.abs(poolSpot(mast(0, 220.16, 30, 'park'), slab).y - (220.16 + LIFT)) < 1e-9);
});

test('a deck is still the deck: the road surface over what the feet are told', () => {
  // on a bridge heightAt answers the deck and surfaceY its asphalt, 20 cm over it
  assert.ok(Math.abs(poolLevel({ heightAt: () => 229.0 }, 0, 0, 229.2, 229.2, 211) - (229.2 + LIFT)) < 1e-9);
  // a world that cannot say what is drawn keeps the rule it had
  assert.strictEqual(poolLevel({}, 0, 0, 220, 220.2, 220), 220.2 + LIFT);
  assert.strictEqual(poolLevel({}, 0, 0, 220, 220.05, 220), 220 + 0.20 + LIFT);
  // the level asked is the mast's foot: a deck overhead is not what the pool lies on
  let asked = NaN;
  poolLevel({ heightAt: (x, z, near) => { asked = near; return 220.2; } }, 0, 0, 220.3, 220.2, 220);
  assert.strictEqual(asked, 220.3);
});

test('a pool moved over on a deck lies on the deck it moved onto', () => {
  // two decks side by side over a valley: the carriageway's at 195.4 (z from -4.5 to 0.5),
  // a lower one beside it at 194.0 (z from 0.5 to 4.5). The mast stands on the lower one,
  // and its pool hangs out 3.4 m to z = 0.85: still over the lower one.
  const surf = { y: 0, road: false };
  const top = (z) => (z < -4.5 || z > 4.5 ? null : z < 0.5 ? 195.4 : 194.0);
  const w = {
    terrain: { heightAt: () => 182 },
    surfaceY(x, z) { const t = top(z); surf.road = t !== null; surf.y = t ?? 182.05; return surf; },
    heightAt(x, z) { const t = top(z); return t === null ? 182 : t - 0.2; },     // feet: the deck, under its asphalt
  };
  const s = poolSpot(mast(0, 194.0, 4.25), w);
  assert.ok(s.z < 0.5, `the pool moved in from the edge, to z = ${s.z.toFixed(2)}`);
  assert.ok(Math.abs(s.y - (195.4 + LIFT)) < 1e-9, `and lies at ${s.y.toFixed(2)} on the deck that is there (195.4), not at the height of the one it left`);
});

// ---- the fan -----------------------------------------------------------------------

// how far the fan lies off the road, at worst, along its length
const worst = (lie, road, carY) => {
  let w = 0;
  for (let d = BEAM_NOSE; d <= BEAM_NOSE + BEAM_LEN + 1e-9; d += 2) w = Math.max(w, Math.abs(carY + fanHeight(lie, d) - road(d)));
  return w;
};
// the plane the fan used to be: one slope, read 13 m ahead
const plane = (lie) => ({ y0: lie.ahead * BEAM_NOSE, slope: lie.ahead, b1: 0, b2: 0 });

test('over the top of a ramp the fan follows the road down', () => {
  // level, then falling away: the crest at the head of the Jana Palacha ramp
  const road = (x) => 221.3 - 0.0011 * x * x;
  const w = world({ road, grid: () => 221.2 });
  const lie = beamLie(w, 0, 0, 1, 0, road(0));
  assert.ok(lie.b1 > 0.2 && lie.b2 > 0.2, `the road stands ${lie.b1.toFixed(2)} and ${lie.b2.toFixed(2)} m over the chord`);
  assert.ok(worst(lie, road, road(0)) < 0.06, `the fan is ${worst(lie, road, road(0)).toFixed(3)} m off the road at worst`);
  assert.ok(worst(plane(lie), road, road(0)) > 0.9, 'the fixture has no crest');
  assert.strictEqual(beamSlope(w, 0, 0, 1, 0, road(0)), lie.ahead);
});

test('…and through the dip under a bridge it follows the road up', () => {
  const road = (x) => 214.3 + 0.0009 * (x - 10) * (x - 10);
  const w = world({ road, grid: () => 217 });
  const lie = beamLie(w, 0, 0, 1, 0, road(0));
  assert.ok(lie.b1 < -0.1 && lie.b2 < -0.1, 'the road hangs under the chord');
  assert.ok(worst(lie, road, road(0)) < 0.06);
  assert.ok(worst(plane(lie), road, road(0)) > 0.5);
});

test('a hump too sharp for any one curve is still followed from look to look', () => {
  // an embanked street over its crest (Pardubice 2186, 914): up a hand, then down 2.5 m
  const road = (x) => 223.17 + (x < 10 ? 0.013 * x : 0.13 - 0.0945 * (x - 10));
  const w = world({ road, grid: () => 223 });
  const lie = beamLie(w, 0, 0, 1, 0, road(0));
  assert.ok(worst(plane(lie), road, road(0)) > 2, 'the plane hangs over two metres in the air');
  assert.ok(worst(lie, road, road(0)) < 0.35, `the fan is ${worst(lie, road, road(0)).toFixed(2)} m off the road at worst`);
});

test('on a ramp of one grade the fan is the plane it was', () => {
  const road = (x) => 220.2 + 0.05 * x;
  const lie = beamLie(world({ road, grid: () => 211 }), 0, 0, 1, 0, 220.2);
  assert.ok(Math.abs(lie.slope - 0.05) < 1e-9 && Math.abs(lie.b1) < 1e-9 && Math.abs(lie.b2) < 1e-9 && Math.abs(lie.ahead - 0.05) < 1e-9);
  assert.ok(Math.abs(lie.y0 - 0.05 * BEAM_NOSE) < 1e-9, 'the chord starts at the bumper, on the road');
});

test('where the nose leaves the road the fan lies on what is drawn there, or stays a plane', () => {
  const road = (x) => 220.2 - 0.0011 * x * x;
  // a bend: from 20 m on the nose is over the verge, a hand under the asphalt
  const bendy = world({ road, grid: () => 220 });
  const on = bendy.surfaceY.bind(bendy);
  bendy.surfaceY = (x, z, n) => { const s = on(x, z, n); if (x > 20) { s.road = false; s.y = 220.05; } return s; };
  bendy.heightAt = (x) => (x > 20 ? road(x) - 0.15 : road(x));
  let lie = beamLie(bendy, 0, 0, 1, 0, 220.2);
  assert.ok(Math.abs(220.2 + fanHeight(lie, 25.45) - (road(25.45) - 0.15)) < 1e-9, 'the middle of the fan is on the verge');
  assert.ok(Math.abs(220.2 + fanHeight(lie, 37.9) - (road(37.9) - 0.15)) < 1e-9, 'and so is its far end');
  // the end of a deck: from 20 m on there is only the valley, 15 m down
  const end = world({ road, grid: () => 205 });
  const onE = end.surfaceY.bind(end);
  end.surfaceY = (x, z, n) => { const s = onE(x, z, n); if (x > 20) { s.road = false; s.y = 205.05; } return s; };
  end.heightAt = (x) => (x > 20 ? 205 : road(x));
  lie = beamLie(end, 0, 0, 1, 0, 220.2);
  assert.ok(lie.b1 === 0 && lie.b2 === 0 && lie.slope === lie.ahead, 'a plane, at the pitch of the first look');
  // …from 30 m on: the middle look alone is not borne out, and the plane stays
  end.surfaceY = (x, z, n) => { const s = onE(x, z, n); if (x > 30) { s.road = false; s.y = 205.05; } return s; };
  end.heightAt = (x) => (x > 30 ? 205 : road(x));
  lie = beamLie(end, 0, 0, 1, 0, 220.2);
  assert.ok(lie.b1 === 0 && lie.b2 === 0 && lie.slope === lie.ahead);
  // a terrace beside the road, 1.3 m up where the middle look lands: not the road steepening
  const terrace = world({ road: (x) => (x > 20 && x < 32 ? 221.5 : 220.2), grid: () => 220 });
  lie = beamLie(terrace, 0, 0, 1, 0, 220.2);
  assert.ok(lie.b1 === 0 && lie.b2 === 0 && lie.slope === 0);
  // a deck overhead where the road has turned away is not the road climbing: surfaceY
  // offers it only because nothing is at the car's level (Okružní, 2 m over the street)
  const over = world({ road: (x) => (x > 20 && x < 32 ? 222.3 : 220.2), grid: () => 220 });
  lie = beamLie(over, 0, 0, 1, 0, 220.2);
  assert.ok(lie.b1 === 0 && lie.b2 === 0 && lie.slope === 0, 'level, as the first look left it');
  // a street climbing one in six is still its own road at the first look, as it always was
  const steep = world({ road: (x) => 220.2 + 0.16 * x, grid: (x) => 220 + 0.16 * x });
  lie = beamLie(steep, 0, 0, 1, 0, 220.2);
  assert.ok(Math.abs(lie.ahead - 0.16) < 1e-9 && Math.abs(lie.slope - 0.16) < 1e-9 && Math.abs(lie.b1) < 1e-9 && Math.abs(lie.b2) < 1e-9);
  // a drop: the road falls away faster than a road does
  const sharp = world({ road: (x) => 220.2 - 0.02 * x * x, grid: () => 220 });
  lie = beamLie(sharp, 0, 0, 1, 0, 220.2);
  assert.ok(lie.b1 === 0 && lie.b2 === 0);
});

test('a street steeper than one in five is still a street; a step that high is not', () => {
  // K Bateriím: one in four, all the way
  const hill = world({ road: (x) => 300 + 0.25 * x, grid: (x) => 299.8 + 0.25 * x });
  let lie = beamLie(hill, 0, 0, 1, 0, 300);
  assert.ok(Math.abs(lie.ahead - 0.25) < 1e-9 && Math.abs(lie.slope - 0.25) < 1e-9, `the fan climbs ${lie.slope.toFixed(3)} with a street of 0.25`);
  assert.ok(Math.abs(300 + fanHeight(lie, 37.9) - (300 + 0.25 * 37.9)) < 1e-9);
  // level, then a deck or a terrace 3.4 m up where the first look lands: the point half way is not on that line
  const step = world({ road: (x) => (x > 10 ? 303.4 : 300), grid: () => 299.8 });
  lie = beamLie(step, 0, 0, 1, 0, 300);
  assert.strictEqual(lie.slope, 0);
  // nothing is a street at one in two
  const cliff = world({ road: (x) => 300 + 0.5 * x, grid: (x) => 299.8 + 0.5 * x });
  assert.strictEqual(beamLie(cliff, 0, 0, 1, 0, 300).slope, 0);
});

test('the fan that is drawn is the one that follows the road, on both paths', () => {
  const road = (x) => 221.3 - 0.0011 * x * x;
  const w = world({ road, grid: () => 221.2 });
  const lp = new LightPools({ add() {} });
  const car = { x: 0, z: 0, heading: Math.atan2(-1, 0), mesh: { position: { y: road(0) } } };   // nose to +x
  assert.strictEqual(lp._beam(0, car, 0, 0, w), 1);
  const g = lp.beams.geometry, bend = g.getAttribute('aBend');
  assert.ok(bend && bend.isInstancedBufferAttribute && bend.itemSize === 2, 'the fans carry two node heights each');
  assert.ok(bend.array[0] > 0.2 && bend.array[1] > 0.2, 'and this one\'s are written');
  // every vertex of the strip, moved as the shader moves it, lies on the road
  const bendAt = (lz) => {
    const t = 0.5 - 0.5 * lz;
    return t < BEAM_T1 ? bend.array[0] * t / BEAM_T1
      : t < BEAM_T2 ? bend.array[0] + (bend.array[1] - bend.array[0]) * (t - BEAM_T1) / (BEAM_T2 - BEAM_T1)
        : bend.array[1] * (1 - t) / (1 - BEAM_T2);
  };
  const m = new THREE.Matrix4(), v = new THREE.Vector3(), pos = g.getAttribute('position');
  lp.beams.getMatrixAt(0, m);
  const rows = new Set();
  let off = 0;
  for (let i = 0; i < pos.count; i++) {
    const lz = pos.getZ(i);
    rows.add(lz.toFixed(4));
    v.set(pos.getX(i), pos.getY(i), lz).applyMatrix4(m);
    v.y += bendAt(lz);
    off = Math.max(off, Math.abs(v.y - (road(v.x) + LIFT - 0.03)));
  }
  assert.ok(rows.size >= 9, `a strip of ${rows.size - 1} spans along its length`);
  assert.ok(off < 0.25, `the drawn fan is ${off.toFixed(2)} m off the road at worst`);
  // the light map draws the same strip with the same numbers and the same rule
  const map = new LampMap(lp.pools, lp.beams, 430, 190, 64);
  assert.strictEqual(map.beams.geometry, g);
  for (const sh of [map.beamMat.vertexShader, lp.beamMat.vertexShader]) {
    assert.ok(sh.includes(BEND_GLSL), 'one bend, shared');
    assert.match(sh, /world\.y \+= beamBend\(aBend, position\.z\)/);
  }
  assert.ok(map.beamMat.defines.ATC_BEAM !== undefined && lp.beamMat.defines.ATC_BEAM !== undefined);
  assert.strictEqual(lp.pools.geometry.getAttribute('aBend'), undefined, 'a pool is still a quad');
});

test('the fan eases onto a crest, it does not jump there', () => {
  const flat = world({ road: () => 221.3, grid: () => 221.2 });
  const crest = world({ road: (x) => 221.3 - 0.0011 * x * x, grid: () => 221.2 });
  const lp = new LightPools({ add() {} });
  const car = { x: 0, z: 0, heading: Math.atan2(-1, 0), mesh: { position: { y: 221.3 } } };
  lp._beam(0, car, 0, 0, flat);
  assert.strictEqual(lp.bend.array[0], 0);
  let prev = 0, step = 0;
  for (let i = 0; i < 60; i++) {
    lp._frame++;
    lp._beam(0, car, 0, 0, crest);
    step = Math.max(step, Math.abs(lp.bend.array[0] - prev));
    prev = lp.bend.array[0];
  }
  assert.ok(prev > 0.2, 'after a second the fan is on the crest');
  assert.ok(step < prev * 0.6, `and no frame took more than ${step.toFixed(2)} m of those ${prev.toFixed(2)}`);
});
