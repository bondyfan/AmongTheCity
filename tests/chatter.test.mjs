// ---- The city has a mouth: the corpus, the casting, and the rate limits ----
//
// Everything here runs with no canvas, no WebGL and no AudioContext, which is
// the whole reason js/chatter.js was split from js/chatbubbles.js: the half
// that decides WHO SPEAKS is plain arithmetic over plain data and deserves to
// be checked like it. The renderer is passed in, so these tests hand it a stub
// that records what it was asked to draw.
//
// The three things that can actually break this feature in a way nobody
// notices until a player complains:
//
//   1. A line whose mp3 was never rendered — the bubble appears, the street
//      stays silent, and the only symptom is a 404 audio.js swallows by
//      design. castFor() must agree with the generator about every clip.
//   2. A man saying a woman's line, because the corpus filter and the voice
//      seed disagree.
//   3. The rate limits quietly not working, which does not fail — it just
//      turns the city into a market and the player turns the feature off.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LINES, CONVS, CATS, CAST, BY_CAT, BY_ID, castFor, clipId, allClips }
  from '../js/chatterlines.js';
import { Chatter, voiceOf, todTag } from '../js/chatter.js';
import { ARCHETYPES, archetypeAt } from '../js/people.js';

const MOODS = new Set(['angry', 'annoyed', 'scared', 'friendly', 'neutral',
  'sad', 'amused', 'drunk', 'tired', 'shocked']);
const WHENS = new Set(['', 'morning', 'noon', 'evening', 'night',
  'rain', 'cold', 'hot', 'fog']);

// ---------------------------------------------------------------- corpus ----

test('every line is well formed', () => {
  assert.ok(LINES.length > 200, `only ${LINES.length} lines`);
  for (const l of LINES) {
    assert.match(l.id, /^[a-z0-9_]+$/, `bad id: ${l.id}`);
    assert.ok(CATS.includes(l.cat), `${l.id}: unknown category ${l.cat}`);
    assert.ok(['m', 'f', 'a'].includes(l.g), `${l.id}: bad gender ${l.g}`);
    assert.ok(MOODS.has(l.mood), `${l.id}: unknown mood ${l.mood}`);
    assert.ok(WHENS.has(l.when), `${l.id}: unknown when "${l.when}"`);
    assert.ok(l.text.trim().length > 0, `${l.id}: empty text`);
    assert.ok(l.tts.trim().length > 0, `${l.id}: no delivery direction`);
  }
});

test('ids are unique — an id IS a filename, so a collision silently overwrites', () => {
  const seen = new Set();
  for (const l of LINES) {
    assert.ok(!seen.has(l.id), `duplicate line id ${l.id}`);
    seen.add(l.id);
  }
  for (const c of CONVS) {
    assert.ok(!seen.has(c.id), `conversation id ${c.id} collides with a line`);
    seen.add(c.id);
  }
  assert.equal(BY_ID.size, LINES.length);
});

// The bubble wraps to three lines of ~22 characters. A longer line is not a
// crash — chatbubbles.js truncates with an ellipsis — it is a line the player
// never gets to read, which is worse, because it was still spoken in full.
test('no line is longer than a bubble can show', () => {
  for (const l of LINES) {
    assert.ok(l.text.length <= 70, `${l.id}: ${l.text.length} chars — "${l.text}"`);
  }
  for (const c of CONVS) {
    for (const t of c.turns) {
      assert.ok(t.text.length <= 70, `${c.id}: ${t.text.length} chars — "${t.text}"`);
    }
  }
});

// How often you can hear a category is what sets how deep it has to be. The
// ambient pools fire every few seconds and need the most; a reaction pool fires
// when you cause something and can be shallower. 'victim' is the deliberate
// outlier and is small for a reason worth stating: it is the line the person
// you knocked down says once they are back on their feet, so hearing it twice
// in a session already means you have run two people over.
const MIN_LINES = { victim: 4 };
const MIN_DEFAULT = 12;

test('every category the code can ask for is deep enough for how often it fires', () => {
  for (const cat of CATS) {
    const pool = BY_CAT.get(cat);
    const min = MIN_LINES[cat] ?? MIN_DEFAULT;
    assert.ok(pool && pool.length >= min,
      `category ${cat} has ${pool?.length ?? 0} lines, wanted ${min}`);
  }
});

// Rejection sampling in _pick() takes ten darts. If a category's lines were
// all one gender, half the city could never say anything from it — and the
// symptom is silence, which reads as "the feature is broken".
test('every category can be spoken by both halves of the cast', () => {
  for (const cat of CATS) {
    const min = Math.min(8, MIN_LINES[cat] ?? MIN_DEFAULT);
    for (const g of ['m', 'f']) {
      const n = BY_CAT.get(cat).filter((l) => l.g === 'a' || l.g === g).length;
      assert.ok(n >= min, `category ${cat} offers only ${n} lines to a ${g} voice`);
    }
  }
});

// The lines that were mis-filed: 'horn' and 'hit' are pools chatter.js only
// ever hands to a PEDESTRIAN, so a line written from inside a car ("Zhaslo mi
// to, no!", "Já ho neviděl, vběhl mi pod kola!") came out of a passer-by's
// mouth. They live under 'driver' now. This guards the property rather than
// the individual lines: nothing in a pedestrian pool may talk about driving
// the car, and nothing may be in the victim's own voice.
test('no pedestrian pool contains a line written from behind a wheel', () => {
  const DRIVING = /\b(zhaslo mi|vběhl mi pod kola|mám jako jet|mám jako přeskočit|kolona je kolona|vystoupím)\b/i;
  for (const cat of ['horn', 'hit', 'bang', 'nearmiss', 'bump', 'player']) {
    for (const l of BY_CAT.get(cat)) {
      assert.ok(!DRIVING.test(l.text), `${l.id} [${cat}] is a driver's line: "${l.text}"`);
    }
  }
});

test('the victim lines exist and are only reachable as the victim', () => {
  const pool = BY_CAT.get('victim');
  assert.ok(pool.length >= 4);
  // and none of them leaked into the bystander pool they came from
  for (const l of BY_CAT.get('hit')) {
    assert.ok(!/^hit_victim_/.test(l.id), `${l.id} is still in the bystander pool`);
  }
});

// A `when` this build cannot produce means the line never plays. That is a
// deliberate decision (see chatterlines.js), but it must not be how a whole
// CATEGORY behaves, or that category is dead weight in the asset bundle.
// 'tod' is exempt by definition — it IS the clock-gated category, and a line
// in it with no gate would be an idle mutter filed in the wrong drawer.
test('the clock-gated lines are a garnish, not the meal', () => {
  for (const cat of CATS) {
    if (cat === 'tod') continue;
    const pool = BY_CAT.get(cat);
    const free = pool.filter((l) => !l.when).length;
    assert.ok(free >= pool.length / 2,
      `category ${cat}: only ${free}/${pool.length} lines are always available`);
  }
});

// The weather tags are written against a sky this build does not have yet, so
// every one of them is a line that ships, is billed to ElevenLabs and can
// never be heard. A handful is a deliberate down-payment; a third of the
// corpus would be waste, and this is where that turns into a failing test.
test('the unreachable weather lines stay a down-payment', () => {
  const dead = LINES.filter((l) => ['rain', 'cold', 'hot', 'fog'].includes(l.when));
  assert.ok(dead.length < LINES.length * 0.12,
    `${dead.length}/${LINES.length} lines wait on weather that does not exist`);
});

// Every 'tod' line must be reachable at SOME hour, or it is an asset nobody
// will ever hear — the same waste as above, arrived at by a typo instead.
test('every clock-gated line has an hour it can actually be said in', () => {
  const hours = ['morning', 'noon', 'evening', 'night'];
  for (const l of BY_CAT.get('tod')) {
    assert.ok(hours.includes(l.when) || ['rain', 'cold', 'hot', 'fog'].includes(l.when),
      `${l.id}: when="${l.when}" is not an hour this game can reach`);
  }
  for (const h of hours) {
    const n = BY_CAT.get('tod').filter((l) => l.when === h).length;
    assert.ok(n >= 2, `only ${n} lines for ${h}`);
  }
});

test('conversations alternate, start with speaker 0, and name two genders', () => {
  for (const c of CONVS) {
    assert.ok(c.turns.length >= 2, `${c.id}: a two-hander needs two turns`);
    assert.equal(c.turns[0].s, 0, `${c.id}: does not start with speaker 0`);
    assert.match(c.g, /^[mfa]{2}$/, `${c.id}: bad gender pair "${c.g}"`);
    for (let i = 1; i < c.turns.length; i++) {
      assert.notEqual(c.turns[i].s, c.turns[i - 1].s,
        `${c.id}: speaker ${c.turns[i].s} takes two turns in a row`);
    }
    for (const t of c.turns) assert.ok(MOODS.has(t.mood), `${c.id}: mood ${t.mood}`);
  }
});

// --------------------------------------------------------------- casting ----

test('the cast is two men and two women, and the keys are unique', () => {
  assert.equal(CAST.filter((c) => c.g === 'm').length, 2);
  assert.equal(CAST.filter((c) => c.g === 'f').length, 2);
  assert.equal(new Set(CAST.map((c) => c.key)).size, CAST.length);
});

// THE 404 TEST. For every citizen the world can mint and every line they are
// allowed to say, the file the game will ask audio.js for must be one the
// generator was told to produce. Nothing else in the build connects those two
// halves, and a mismatch is inaudible rather than loud.
test('every line a citizen can say has a clip rendered in their own voice', () => {
  const have = new Set(allClips().map((c) => c.file));
  for (let seed = -5000; seed < 5000; seed += 37) {
    const v = voiceOf(seed);
    const g = v.male ? 'm' : 'f';
    for (const l of LINES) {
      if (l.g !== 'a' && l.g !== g) continue;
      assert.ok(have.has(clipId(l.id, v.cast)),
        `no clip ${clipId(l.id, v.cast)} for seed ${seed}`);
    }
  }
});

test('every conversation turn has a clip for every voice that could say it', () => {
  const have = new Set(allClips().map((c) => c.file));
  for (const c of CONVS) {
    c.turns.forEach((t, i) => {
      for (const cast of castFor(c.g[t.s])) {
        assert.ok(have.has(clipId(c.id + '_' + i, cast.key)),
          `missing ${clipId(c.id + '_' + i, cast.key)}`);
      }
    });
  }
});

test('allClips has no duplicate filenames', () => {
  const files = allClips().map((c) => c.file);
  assert.equal(new Set(files).size, files.length);
});

// --------------------------------------------------------------- voicing ----

// A citizen's voice is a pure function of the seed that already picked their
// jacket. If this drifts, two co-op clients hear the same man as two people.
test('a voice is stable and shared: same seed, same voice, forever', () => {
  for (const seed of [0, 1, -1, 12345, -998877, 2 ** 30]) {
    const a = voiceOf(seed), b = voiceOf(seed);
    assert.deepEqual(a, b);
    assert.ok(CAST.some((c) => c.key === a.cast), `seed ${seed} → unknown cast ${a.cast}`);
    assert.equal(a.male, a.cast.startsWith('m'));
    assert.ok(a.pitch > 0.9 && a.pitch < 1.08, `seed ${seed} pitch ${a.pitch}`);
  }
});

test('the city is not all men, and all four voices get used', () => {
  const seen = new Map();
  let male = 0;
  for (let s = 0; s < 4000; s++) {
    const v = voiceOf(s * 2654435761 | 0);
    seen.set(v.cast, (seen.get(v.cast) ?? 0) + 1);
    if (v.male) male++;
  }
  assert.equal(seen.size, CAST.length, `only ${seen.size} of ${CAST.length} voices ever cast`);
  assert.ok(male > 1400 && male < 2600, `${male}/4000 male — the coin is bent`);
  for (const [key, n] of seen) assert.ok(n > 600, `voice ${key} used only ${n}/4000 times`);
});

test('the world clock maps onto the tags the corpus uses', () => {
  assert.equal(todTag(0.00), 'night');     // midnight
  assert.equal(todTag(0.24), 'night');     // 05:45
  assert.equal(todTag(0.30), 'morning');   // 07:12
  assert.equal(todTag(0.50), 'noon');      // 12:00
  assert.equal(todTag(0.70), 'evening');   // 16:48
  assert.equal(todTag(0.95), 'night');     // 22:48
  assert.equal(todTag(1.30), 'morning');   // wraps, like tod() does
  assert.equal(todTag(-0.30), 'evening');  // …in both directions
});

// --------------------------------------------------------------- chatter ----

// The smallest thing that looks like a pedestrian to chatter.js: a position,
// a state, a mesh whose parent is what proves it is still in the world.
function fakePed(pid, x = 0, z = 0) {
  return { pid, x, z, state: 'walk', free: 0, mesh: { parent: {}, position: { y: 0 } } };
}
function fakePeds(list) { return { peds: list }; }

// Records what it was told to draw, so a test can read the bubbles back.
function stubBubbles() {
  return {
    seen: [],
    removed: [],
    update(items) { this.seen.push([...items].map((u) => ({ ...u }))); },
    remove(k) { this.removed.push(k); },
    clear() {},
  };
}

function run(ch, seconds, ctx, step = 0.05) {
  for (let t = 0; t < seconds; t += step) ch.update(step, ctx);
}

test('a reaction shows a bubble, and the same person does not say two', () => {
  const b = stubBubbles();
  const p = fakePed(4242, 3, 0);
  const ch = new Chatter(b, { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });

  ch.honk(3, 0);
  assert.equal(ch._live.length, 1, 'the honk went unanswered');
  const said = ch._live[0].text;
  assert.ok(said.length > 0);

  // …and the cooldown is real: a second honk a moment later finds him busy
  ch._reactCd = 0;
  ch.honk(3, 0);
  assert.equal(ch._live.length, 1, 'he answered twice in one second');
  assert.ok(ch._busy(p), 'no personal cooldown was set');
});

// THE REGRESSION THAT MATTERS. The first version of the personal cooldown was
// a countdown (`p._chatCd = 16 + rnd*12`, tested `> 0`) copied from
// pedestrians.js's `hitCd` — but pedestrians.js decrements hitCd in its walk
// loop and nothing ever decremented ours. Every assertion above still passed:
// "he does not answer twice" is exactly what a permanently muted man looks
// like. So the property to nail down is not that the cooldown BLOCKS, it is
// that the cooldown ENDS.
test('a personal cooldown expires — a citizen is not muted for life', () => {
  const p = fakePed(777, 2, 0);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });

  ch.honk(2, 0);
  assert.equal(ch._live.length, 1, 'never spoke at all');
  assert.ok(ch._busy(p), 'spoke and was not put on cooldown');

  // …wind the shared clock past the longest cooldown the constants can draw
  ch._t += 40;
  assert.ok(!ch._busy(p), 'still on cooldown 40 s later — it never expires');

  ch._live.length = 0;
  ch._reactCd = 0;
  ch.honk(2, 0);
  assert.equal(ch._live.length, 1, 'silent forever after one line');
});

test('a driver shout is on a deadline too, and it also expires', () => {
  const car = { x: 3, z: 0, heading: 0, wid: 1.8, mesh: { parent: {}, position: { y: 0 } },
    ai: { seed: 4242, heldT: 12, sigQ: false } };
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([]) });
  const ctx = { ears: { x: 0, z: 0 }, cars: [car] };

  ch.update(0.05, ctx);
  assert.equal(ch._live.length, 1, 'a driver pinned for 12 s said nothing');
  assert.ok(car._shoutAt > ch._t, 'shouted without arming a cooldown');

  ch._live.length = 0; ch._reactCd = 0;
  ch.update(0.05, ctx);
  assert.equal(ch._live.length, 0, 'shouted again immediately');

  ch._t += 40; ch._reactCd = 0;
  ch._drivers(0.05, ctx);
  assert.equal(ch._live.length, 1, 'the driver never got to shout again');
});

test('a driver waiting at a red light keeps his opinions to himself', () => {
  const car = { x: 3, z: 0, heading: 0, wid: 1.8, mesh: { parent: {}, position: { y: 0 } },
    ai: { seed: 99, heldT: 30, sigQ: true } };   // sigQ = legitimately stopped
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([]) });
  ch.update(0.05, { ears: { x: 0, z: 0 }, cars: [car] });
  assert.equal(ch._live.length, 0, 'shouted at a red light — traffic.js suppresses the horn there for the same reason');
});

// An idle mutter is not an event and must not spend an event's budget. This
// was costing roughly one player-caused reaction in six.
test('an ambient mutter does not eat the reaction budget', () => {
  const p = fakePed(31415, 2, 0);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch._say(p, 'idle', 12345);              // h !== null → the ambient path
  // <= 0 rather than === 0: update() decrements the floor every step, so it
  // sits slightly negative when nothing has armed it.
  assert.ok(ch._reactCd <= 0, 'a mutter armed the reaction floor');

  const q = fakePed(27182, 2, 0);
  ch.peds.peds.push(q);
  ch._say(q, 'horn');                     // h === null → a reaction
  assert.ok(ch._reactCd > 0, 'a reaction did not arm the reaction floor');
});

// _say() refuses for a personal cooldown or an exhausted pool. Abandoning the
// whole scan on a refusal let one recently-startled pedestrian shield everyone
// standing behind them for the length of their cooldown.
test('one pedestrian on cooldown does not shield the whole pavement', () => {
  const mute = fakePed(1, 0.6, 0);
  const fresh = fakePed(2, 1.0, 0);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([mute, fresh]) });
  // NOT update(): two people 40 cm apart are also a conversation candidate, and
  // _pairs() cools BOTH of them when it starts one — correct behaviour that
  // would flake this assertion 30 % of the time. Seed the clock by hand.
  ch._t = 1000;
  ch._cool(mute);                          // he has just spoken

  const ctx = {
    ears: { x: 0, z: 0 }, onFoot: true,
    player: { pos: { x: 0, z: 0 }, speed: 3 },
  };
  // _proximity directly, not through update(): two people standing 40 cm apart
  // are also a conversation candidate, and _pairs() cools BOTH of them when it
  // starts one — which is correct behaviour that would flake this assertion
  // 30 % of the time. The property under test is the scan, so test the scan.
  ch._proxT = 0;
  ch._proximity(0.05, ctx);
  assert.equal(ch._live.length, 1, 'the scan gave up on the first refusal');
  assert.equal(ch._live[0].ped, fresh);
});

test('a man never says a woman\'s line, and vice versa', () => {
  const ch = new Chatter(null, { peds: fakePeds([]) });
  for (let seed = 0; seed < 400; seed++) {
    const v = voiceOf(seed);
    for (const cat of CATS) {
      const l = ch._pick(cat, v.male, null);
      if (!l) continue;
      assert.ok(l.g === 'a' || l.g === (v.male ? 'm' : 'f'),
        `seed ${seed} (${v.male ? 'm' : 'f'}) got ${l.id} [${l.g}]`);
    }
  }
});

test('the same sentence is not heard twice in a row', () => {
  const ch = new Chatter(null, { peds: fakePeds([]) });
  const first = ch._pick('idle', true, null);
  assert.ok(first);
  ch._lineAt.set(first.id, Number.MAX_SAFE_INTEGER);   // "just said"
  for (let n = 0; n < 40; n++) {
    const l = ch._pick('idle', true, null);
    if (l) assert.notEqual(l.id, first.id, 'repeated a line inside the cooldown');
  }
});

test('an ambient line is deterministic — two clients hear the same sentence', () => {
  const a = new Chatter(null, { peds: fakePeds([]) });
  const b = new Chatter(null, { peds: fakePeds([]) });
  for (const h of [1, 77, -12345, 909090]) {
    // same seed+slot hash on both machines must land on the same line
    assert.equal(a._pick('idle', true, h)?.id, b._pick('idle', true, h)?.id);
    assert.equal(a._pick('local', false, h)?.id, b._pick('local', false, h)?.id);
  }
});

test('a whole street does not answer one horn', () => {
  const peds = [];
  for (let i = 0; i < 30; i++) peds.push(fakePed(1000 + i, i * 0.4, 0));
  const ch = new Chatter(stubBubbles(), { peds: fakePeds(peds) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch.bang(0, 0, 30);
  assert.ok(ch._live.length <= 2, `${ch._live.length} people reacted to one bang`);
});

test('nobody far away is given a bubble at all', () => {
  const far = fakePed(7, 300, 300);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([far]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch.bang(300, 300, 40);
  assert.equal(ch._live.length, 0, 'drew a bubble for somebody 400 m away');
});

test('the ragdolled and the dead do not talk', () => {
  for (const state of ['rag', 'down', 'dead']) {
    const p = fakePed(9, 2, 0);
    p.state = state;
    const ch = new Chatter(null, { peds: fakePeds([p]) });
    ch.update(0.016, { ears: { x: 0, z: 0 } });
    ch.bang(2, 0, 20);
    assert.equal(ch._live.length, 0, `a '${state}' pedestrian spoke`);
  }
});

test('a bubble fades in, holds, and lets go of its speaker', () => {
  const b = stubBubbles();
  const p = fakePed(555, 2, 0);
  const ch = new Chatter(b, { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch.honk(2, 0);
  const u = ch._live[0];
  assert.ok(u.a < 0.3, 'started at full opacity instead of fading in');

  run(ch, 0.5, { ears: { x: 0, z: 0 } });
  assert.equal(ch._live[0].a, 1, 'never reached full opacity');

  run(ch, 12, { ears: { x: 0, z: 0 } });
  assert.equal(ch._live.length, 0, 'the bubble never went away');
  assert.ok(b.removed.includes(u.key), 'the renderer was not told to drop it');
});

test('a bubble follows its speaker and dies with them', () => {
  const p = fakePed(31337, 5, 5);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch.honk(5, 5);
  assert.equal(ch._live.length, 1);

  p.x = 9; p.z = 4; p.mesh.position.y = 220;
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  assert.equal(ch._live[0].x, 9);
  assert.equal(ch._live[0].z, 4);
  assert.ok(ch._live[0].y > 221, 'the bubble sank into the terrain');

  // citizen.dispose() detaches the group — the exact liveness test chatter uses
  p.mesh.parent = null;
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  assert.equal(ch._live.length, 0, 'a reaped pedestrian left their words behind');
});

test('switching the feature off silences what is already in the air', () => {
  const p = fakePed(64, 2, 0);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  ch.honk(2, 0);
  assert.equal(ch._live.length, 1);
  ch.enabled = false;
  ch.silence();
  assert.equal(ch._live.length, 0);
  ch.honk(2, 0);
  assert.equal(ch._live.length, 0, 'spoke while disabled');
});

// …and the other end of the same knob. Measured at the real spawn, 63 bodies
// were loaded and exactly ONE was walking within 24 m; the sampler that threw
// six darts at the array found them 9 % of the time, so a layer that believes
// it speaks every five seconds managed a line about once a minute. Most of
// Pardubice is quiet streets, so the sparse case is the normal case.
test('one walker on a quiet street is still found, every time', () => {
  const peds = [];
  for (let i = 0; i < 62; i++) peds.push(fakePed(9000 + i, 400 + i, 400));  // far away
  const lonely = fakePed(4242, 8, 3);                                        // 8.5 m off
  peds.splice(31, 0, lonely);                                                // mid-array
  const ch = new Chatter(stubBubbles(), { peds: fakePeds(peds) });
  ch.update(0.016, { ears: { x: 0, z: 0 } });
  for (let n = 0; n < 20; n++) {
    assert.equal(ch._pickNearby(24, true), lonely, `missed the only candidate on try ${n}`);
  }
});

test('the city does not become a market: ambient lines are rationed', () => {
  const peds = [];
  for (let i = 0; i < 40; i++) peds.push(fakePed(50000 + i, (i % 8) * 2, (i / 8 | 0) * 2));
  const ch = new Chatter(stubBubbles(), { peds: fakePeds(peds) });
  let peak = 0;
  const ctx = { ears: { x: 0, z: 0 } };
  for (let t = 0; t < 60; t += 0.05) {
    ch.update(0.05, ctx);
    peak = Math.max(peak, ch._live.length);
  }
  assert.ok(peak <= 4, `${peak} people talking at once on an idle street`);
});

test('driving past somebody at speed gets you told off — once', () => {
  const p = fakePed(818, 0, -2);           // 2 m ahead of the car, 0 m to the side
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  // the car faces −z (citizen.js convention), doing 15 m/s
  const car = { x: 0, z: 0, heading: 0, speed: 15 };
  const ctx = { ears: { x: 0, z: 0 }, playerCar: car };

  ch.update(0.2, ctx);
  assert.equal(ch._live.length, 0, 'shouted at somebody directly in front — that is a hit');

  p.x = 1.6; p.z = 1.0;                    // alongside and just passed
  ch._proxT = 0;
  ch.update(0.2, ctx);
  assert.equal(ch._live.length, 1, 'a 54 km/h near miss went unremarked');
  assert.equal(ch._live[0].ped, p);
});

test('walking into somebody is a different situation from driving into them', () => {
  const p = fakePed(2024, 1, 0);
  const ch = new Chatter(stubBubbles(), { peds: fakePeds([p]) });
  const ctx = {
    ears: { x: 0, z: 0 }, onFoot: true,
    player: { pos: { x: 0, z: 0 }, speed: 3 },
  };
  ch.update(0.2, ctx);
  assert.equal(ch._live.length, 1);
  const line = BY_ID.get(ch._live[0].id);
  assert.ok(line, `spoke ${ch._live[0].id}, which is not in the corpus`);
  assert.equal(line.cat, 'bump', `walked into somebody and got a "${line.cat}" line`);
  assert.equal(line.text, ch._live[0].text, 'the bubble and the clip disagree');
});

test('two people standing together eventually hold a conversation', () => {
  // Seeded so the pair test passes deterministically rather than by luck: try
  // a spread of pids and assert that SOME pair talks, which is the property
  // that matters (a specific pair talking is a coin flip by design).
  let talked = 0;
  for (let s = 0; s < 40; s++) {
    const a = fakePed(1000 + s * 7919, 0, 0);
    const b = fakePed(2000 + s * 6151, 1.5, 0);
    const ch = new Chatter(stubBubbles(), { peds: fakePeds([a, b]) });
    run(ch, 3, { ears: { x: 0, z: 0 } });
    if (ch._convs.length || ch._live.some((u) => u.ped === a || u.ped === b)) talked++;
  }
  assert.ok(talked > 2, `only ${talked}/40 pairs ever said a word to each other`);
});

test('a conversation ends when one of them walks off or is run over', () => {
  let ch = null, a = null, b = null;
  for (let s = 0; s < 200 && !(ch && ch._convs.length); s++) {
    a = fakePed(3000 + s * 7919, 0, 0);
    b = fakePed(4000 + s * 6151, 1.5, 0);
    ch = new Chatter(stubBubbles(), { peds: fakePeds([a, b]) });
    run(ch, 2, { ears: { x: 0, z: 0 } });
  }
  assert.ok(ch._convs.length, 'could not get a conversation started at all');
  b.state = 'rag';                                   // a car happened
  ch.update(0.05, { ears: { x: 0, z: 0 } });
  assert.equal(ch._convs.length, 0, 'they kept chatting through the ragdoll');
});

// ---------------------------------------------------------------- bodies ----
// js/people.js is the third module that exists only so two others can agree:
// pedestrians.js builds the body and chatter.js picks the voice, and if they
// draw different archetypes from the same seed then a stooped ninety-year-old
// opens his mouth and a young woman comes out.

test('the five archetypes are well formed and sum to one', () => {
  assert.equal(ARCHETYPES.length, 5);
  const keys = new Set(ARCHETYPES.map((a) => a.key));
  assert.equal(keys.size, 5);
  for (const want of ['m30', 'f30', 'f60', 'm60', 'm90']) {
    assert.ok(keys.has(want), `missing archetype ${want}`);
  }
  let w = 0;
  for (const a of ARCHETYPES) {
    assert.ok(['m', 'f'].includes(a.sex), `${a.key}: bad sex`);
    assert.ok(a.age >= 18 && a.age <= 100, `${a.key}: age ${a.age}`);
    assert.ok(a.h > 1.4 && a.h < 2.0, `${a.key}: ${a.h} m is not a person`);
    assert.ok(a.w > 0, `${a.key}: zero weight means it never appears`);
    w += a.w;
  }
  assert.ok(Math.abs(w - 1) < 1e-9, `weights sum to ${w}`);
});

// Heights above ~1.79 would push a citizen's hair through the name-tag and
// speech-bubble constants that js/netcity.js and js/chatter.js pin at 1.75.
test('nobody is taller than the constants hung over their head', () => {
  for (const a of ARCHETYPES) assert.ok(a.h <= 1.79, `${a.key} is ${a.h} m`);
});

test('archetypeAt is total: every input in and out of range lands on a body', () => {
  for (const r of [0, 0.0001, 0.5, 0.999999, 1, 1.5, -1, NaN, undefined, null]) {
    const a = archetypeAt(r);
    assert.ok(ARCHETYPES.includes(a), `archetypeAt(${r}) returned something else`);
  }
});

test('the draw follows the weights, so a 90-year-old stays rare', () => {
  const n = new Map();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const k = archetypeAt(i / N).key;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  for (const a of ARCHETYPES) {
    const got = (n.get(a.key) ?? 0) / N;
    assert.ok(Math.abs(got - a.w) < 0.01, `${a.key}: ${got.toFixed(3)} vs weight ${a.w}`);
  }
  assert.ok((n.get('m90') / N) < 0.12, 'the man with the stick is not rare any more');
});

// THE ONE THAT MATTERS. Body and voice are drawn independently, by two modules
// that cannot import each other — this is the assertion that they agree.
test('a citizen sounds like the body they were given', () => {
  const CAST_SEX = Object.fromEntries(CAST.map((c) => [c.key, c.g]));
  for (let seed = -20000; seed < 20000; seed += 61) {
    const v = voiceOf(seed);
    assert.equal(v.male, v.arch[0] === 'm', `seed ${seed}: ${v.arch} got male=${v.male}`);
    assert.equal(CAST_SEX[v.cast], v.arch[0],
      `seed ${seed}: archetype ${v.arch} was given voice ${v.cast}`);
  }
});

test('the old are not voiced by the young', () => {
  // m90 and m60 must land on the older male voice, f60 on the older female one
  const seen = new Map();
  for (let seed = 0; seed < 30000; seed++) {
    const v = voiceOf(seed);
    if (!seen.has(v.arch)) seen.set(v.arch, new Set());
    seen.get(v.arch).add(v.cast);
  }
  assert.equal(seen.size, 5, `only ${seen.size} archetypes ever drawn`);
  assert.deepEqual([...seen.get('m90')], ['m2']);
  assert.deepEqual([...seen.get('m60')], ['m2']);
  assert.deepEqual([...seen.get('m30')], ['m1']);
  assert.deepEqual([...seen.get('f60')], ['f1']);
  assert.deepEqual([...seen.get('f30')], ['f2']);
});

test('the man with the stick is pitched below everyone else', () => {
  let old = 0, young = 0;
  for (let seed = 0; seed < 6000; seed++) {
    const v = voiceOf(seed);
    if (v.arch === 'm90') old = Math.max(old, v.pitch);
    if (v.arch === 'm30') young = Math.min(young || 9, v.pitch);
  }
  assert.ok(old < 1.02, `the 90-year-old tops out at ${old}`);
});

// Every clip still has to exist for whatever voice the body implies — this is
// the 404 test from above, re-run against the new archetype-driven casting.
test('re-casting by body did not orphan a single clip', () => {
  const have = new Set(allClips().map((c) => c.file));
  for (let seed = -4000; seed < 4000; seed += 29) {
    const v = voiceOf(seed);
    const g = v.male ? 'm' : 'f';
    for (const l of LINES) {
      if (l.g !== 'a' && l.g !== g) continue;
      assert.ok(have.has(clipId(l.id, v.cast)),
        `no clip ${clipId(l.id, v.cast)} for ${v.arch}`);
    }
  }
});
