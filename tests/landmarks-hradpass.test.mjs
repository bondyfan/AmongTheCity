// The openings js/landmarks-hradpass.js cuts in Prague Castle's walls, on the
// real footprint (tile -21_-2). A cut ends on the passage's jambs, where the
// opening must reach the springing of its arch: a jamb sample read as outside
// the arch dropped to the floor and stood a sloped sliver of wall in the
// opening (the Matthias Gate, 0.2 m, and the east passage, 0.45 m).
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const { LANDMARKS, matches } = await import('../js/landmarks.js');
const { passages, cutsOf, cutWall } = await import('../js/landmarks-hradpass.js');

const T = JSON.parse(readFileSync(new URL('../public/data/tiles/-21_-2.json', import.meta.url), 'utf8'));
const l = LANDMARKS.find((e) => e.id === 'hrad');
const f = T.buildings.find((b) => matches(l, b));

test('no wall cut for a castle passage leaves a sloped sliver standing in the opening', () => {
  assert.ok(f, 'the castle footprint is not in the tile');
  const quads = [];
  // a flat kit: the cut only needs relative heights (floor 0, foundation -0.6)
  const kit = { rel: () => 0, ground: 0, quad: (a, b) => quads.push([a[1], b[1]]) };
  const ps = passages(kit, f), y0 = -0.6, E = 18;
  let cut = 0;
  for (const ring of [f.o, ...(f.i ?? [])]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const cuts = cutsOf(a, b, ps);
      if (!cuts.length) continue;
      cut++;
      quads.length = 0;
      cutWall(kit, a, b, y0, E, 0, 0, cuts, () => {});
      for (const [ya, yb] of quads) {
        const onFloor = (y) => Math.abs(y - y0) < 1e-6;
        assert.ok(onFloor(ya) === onFloor(yb) || Math.max(ya, yb) < 1, `edge ${i}: a wall piece rises from the floor to ${Math.max(ya, yb).toFixed(2)} m inside an opening`);
      }
    }
  }
  assert.ok(cut >= 8, `only ${cut} wall edges cut (four passages, two faces each)`);
});
