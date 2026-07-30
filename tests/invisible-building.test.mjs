// ---- a building you cannot see but can crash into --------------------------
// Reported at Pardubice main station: "dokud nenabourám do té budovy, tak ji
// nevidím". The clue is in the sentence — the CRASH is what makes it appear.
//
// A building close enough to the player is promoted from the chunk mesh's
// painted quads to its own box model, and the chunk mesh is told to stop
// drawing it (`hidden`). Two separate ways that leaves nothing on screen:
//
//   1. the shell comes out EMPTY. addShell() sets `shelled` whether or not it
//      produced a piece, and shellPieces emits walls per storey — a canopy or a
//      degenerate plan gets none. The building was hidden behind a replacement
//      that does not exist.
//   2. the model was built on GROUND WE DID NOT HAVE, so it sits tens of metres
//      under the world. _model() has always re-checked that, but the check was
//      unreachable: the scan only calls _model when there is no model at all.
//
// Both leave the building SOLID, because collide() works from the footprint and
// never asks whether a building is hidden. And both are fixed by a crash, which
// runs activate() → _model(force) → the rebuild the scan never asked for.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Interiors } = await import('../js/interiorsim.js');

/** Flat ground at `h`, with `ready` under our control. */
const terrainAt = (h, ready = true) => ({
  ready: () => ready,
  heightAt: () => h,
});

const buildingAt = () => ({ o: [[0, 0], [10, 0], [10, 10], [0, 10]] });

test('a model built on ground that has since moved is stale', () => {
  const f = buildingAt();
  const sim = { world: { terrain: terrainAt(221.4) } };
  const model = { f, plan: { ground: 221.4 }, damaged: false };
  assert.equal(Interiors.prototype._stale.call(sim, model), false,
    'a model standing on the ground it was built for was called stale');

  // …the height map lands and says something else. Without this the building is
  // hidden by a model buried under the world, for the rest of the session.
  delete f._gy;                       // groundFor memoises per feature
  sim.world.terrain = terrainAt(0);   // the "we had nothing yet" answer
  assert.equal(Interiors.prototype._stale.call(sim, model), true,
    'a model built 221 m off the ground was not noticed');
});

test('a wreck is never stale — it is exactly where it fell', () => {
  const f = buildingAt();
  const sim = { world: { terrain: terrainAt(0) } };
  assert.equal(
    Interiors.prototype._stale.call(sim, { f, plan: { ground: 221.4 }, damaged: true }),
    false, 'a wrecked building was rebuilt out from under its own debris');
});

test('the staleness check survives having no terrain at all', () => {
  const f = buildingAt();
  const sim = { world: {} };
  // groundFor answers 0 with no terrain; a model planned at 0 agrees with it
  assert.equal(Interiors.prototype._stale.call(sim, { f, plan: { ground: 0 } }), false);
});
