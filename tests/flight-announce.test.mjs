// The flight's announcements: every line the flight can say exists, is in both
// languages, has its recording on disk, and the player's queue and gain rules hold
// in node, where there is no audio context. The em dash is written as an escape so
// that this file passes its own check.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, statSync } from 'node:fs';

const { LINES, BY_ID, SOUND_IDS, ROLES } = await import('../js/flight-announce-lines.js');
const { REACH, announceGain, announceQueue, flightAnnouncer } = await import('../js/flight-announce.js');

const EM_DASH = '\u2014';
const root = new URL('../', import.meta.url);
const audioDir = new URL('public/assets/flight/', root);

const GATE_FLIGHTS = ['740', '750', '741', '751'];
const KINDS_GATE = ['board', 'last', 'close'];
const DESTS = ['sez', 'ped', 'prg'];
const KINDS_CABIN = ['welcome', 'takeoff', 'descent', 'arrived'];

test('every gate announcement exists for all four flights', () => {
  for (const no of GATE_FLIGHTS) {
    for (const kind of KINDS_GATE) {
      const line = BY_ID[`${kind}-${no}`];
      assert.ok(line, `missing ${kind}-${no}`);
      assert.equal(line.role, 'pa', `${kind}-${no} is an airport announcement`);
    }
  }
});

test('every cabin announcement exists for all three destinations, and the generic doors line', () => {
  for (const dest of DESTS) {
    for (const kind of KINDS_CABIN) {
      assert.ok(BY_ID[`${kind}-${dest}`], `missing ${kind}-${dest}`);
    }
  }
  assert.ok(BY_ID.doors, 'missing doors');
  assert.equal(LINES.length, GATE_FLIGHTS.length * KINDS_GATE.length + DESTS.length * KINDS_CABIN.length + 1);
});

test('ids are unique and every role is one of the three', () => {
  assert.equal(new Set(LINES.map((l) => l.id)).size, LINES.length);
  for (const line of LINES) assert.ok(ROLES.includes(line.role), `${line.id} has role ${line.role}`);
  assert.deepEqual(ROLES, ['pa', 'crew', 'captain']);
});

test('the roles are the right ones: crew and captain in the cabin, the PA at the gate', () => {
  for (const dest of DESTS) {
    assert.equal(BY_ID[`welcome-${dest}`].role, 'crew');
    assert.equal(BY_ID[`arrived-${dest}`].role, 'crew');
    assert.equal(BY_ID[`takeoff-${dest}`].role, 'captain');
    assert.equal(BY_ID[`descent-${dest}`].role, 'captain');
  }
  assert.equal(BY_ID.doors.role, 'crew');
});

test('every line has a Czech and an English part with text, and a Czech subtitle', () => {
  for (const line of LINES) {
    const langs = line.parts.map((p) => p.lang).sort();
    assert.deepEqual(langs, ['cs', 'en'], `${line.id} has both languages`);
    for (const part of line.parts) {
      assert.ok(part.text.trim().length > 20, `${line.id} ${part.lang} has text`);
    }
    assert.ok(line.subtitle && line.subtitle.length > 10, `${line.id} has a subtitle`);
  }
});

test('airport lines: Czech first at Pardubice and Praha, English first at Seychelles', () => {
  const first = (id) => BY_ID[id].parts[0].lang;
  for (const kind of KINDS_GATE) {
    assert.equal(first(`${kind}-740`), 'cs', `${kind}-740 starts in Czech`);
    assert.equal(first(`${kind}-750`), 'cs', `${kind}-750 starts in Czech`);
    assert.equal(first(`${kind}-741`), 'en', `${kind}-741 starts in English`);
    assert.equal(first(`${kind}-751`), 'en', `${kind}-751 starts in English`);
  }
});

test('no line names a clock time or a temperature, and the carrier is ATC', () => {
  for (const line of LINES) {
    for (const text of [...line.parts.map((p) => p.text), line.subtitle]) {
      assert.ok(!/\d\s?:\s?\d/.test(text), `${line.id} has a clock time: ${text}`);
      assert.ok(!text.includes('°'), `${line.id} has a temperature: ${text}`);
    }
  }
  assert.ok(LINES.some((l) => l.parts.some((p) => p.text.includes('ATC'))), 'the carrier is named ATC');
});

test('no em dash in the line data, the generator, the player or this test', () => {
  const files = [
    '../js/flight-announce-lines.js',
    '../js/flight-announce.js',
    '../scripts/gen-flight-audio.mjs',
    '../tests/flight-announce.test.mjs',
  ];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!text.includes(EM_DASH), `${f} contains an em dash`);
  }
  for (const line of LINES) {
    for (const text of [...line.parts.map((p) => p.text), line.subtitle]) {
      assert.ok(!text.includes(EM_DASH), `${line.id} contains an em dash`);
    }
  }
});

test('every line and both chimes have a recording on disk', () => {
  for (const id of [...LINES.map((l) => l.id), ...SOUND_IDS]) {
    const file = new URL(id + '.mp3', audioDir);
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    assert.ok(size > 4000, `${id}.mp3 is missing or empty (${size} bytes)`);
  }
});

test('the queue never doubles a line, and never lets two lines on the air', () => {
  const q = announceQueue();
  assert.equal(q.add('board-740', 'terminal'), true);
  assert.equal(q.add('board-740', 'terminal'), false, 'a waiting line is not queued again');
  assert.equal(q.add('board-740', 'apron'), false, 'the same line from another place is not doubled');
  assert.equal(q.pending, 1);

  const on = q.take();
  assert.equal(on.id, 'board-740');
  assert.equal(q.current.id, 'board-740');
  assert.equal(q.add('board-740', 'terminal'), false, 'a line on the air is not queued again');

  assert.equal(q.add('last-740', 'terminal'), true);
  assert.equal(q.take(), null, 'nothing starts while a line is on the air');
  q.done();
  assert.equal(q.take().id, 'last-740', 'the next line starts when the first has ended');
  q.done();
  assert.equal(q.add('board-740', 'terminal'), true, 'a finished line may be said again later');
  q.clear();
  assert.equal(q.pending, 0);
  assert.equal(q.current, null);
});

test('gain: terminal lines carry about 250 m and are silent aboard, the cabin only aboard', () => {
  assert.equal(REACH, 250);
  assert.equal(announceGain('terminal', { near: REACH }), 0);
  assert.equal(announceGain('terminal', { near: 400 }), 0);
  assert.equal(announceGain('terminal', { inside: true, near: 0 }), 1);
  assert.equal(announceGain('terminal', { aboard: true, inside: true }), 0);
  assert.equal(announceGain('apron', { aboard: true, near: 0 }), 0);
  assert.equal(announceGain('cabin', { near: 0 }), 0, 'cabin lines are not heard from the terminal');
  assert.equal(announceGain('cabin', { aboard: true, near: 999 }), 1);
});

test('gain: the terminal falls away with distance, and outdoors is quieter than the hall', () => {
  let last = Infinity;
  for (let d = 0; d < REACH; d += 10) {
    const g = announceGain('terminal', { near: d });
    assert.ok(g <= last + 1e-9, `gain falls with distance at ${d} m`);
    last = g;
  }
  assert.ok(announceGain('apron', { near: 40 }) < announceGain('terminal', { inside: true, near: 40 }));
  assert.ok(announceGain('terminal', { inside: false, near: 40 }) < announceGain('terminal', { inside: true, near: 40 }));
});

test('without an unlocked audio context the player refuses quietly', () => {
  const player = flightAnnouncer();
  assert.equal(player.say('board-740', { where: 'terminal' }), false, 'no audio in node');
  assert.equal(player.playing, null);
  assert.equal(player.say('chime'), false, 'a chime is not a line');
  assert.equal(player.say('no-such-line'), false);
  assert.match(player.subtitle('board-740'), /Nástup do letu 740/);
  assert.equal(player.subtitle('no-such-line'), '');
  player.update(0.016, { inside: true, aboard: false, near: 0 });
  player.stop();
  player.dispose();
  assert.equal(player.say('board-740'), false, 'a disposed player says nothing');
});
