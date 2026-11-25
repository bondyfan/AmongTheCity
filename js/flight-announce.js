// ---- flight-announce.js: the airport's and the cabin's voices on the flight ----
// Plays the lines of js/flight-announce-lines.js. Each line is one mp3 under
// assets/flight/, fetched on first use and decoded once. Everything goes through the
// game's master bus (audioGraph() in js/audio.js), so the game's volume, and its
// silence at volume 0, apply as they do to every other sound.
//
// Lines are queued and never overlap. A line already waiting or on air is not queued
// again. Before the audio context is unlocked a request is dropped rather than held,
// so a PA does not come out late after the first click. A missing file or a locked
// context fails silently.

import { audioGraph } from './audio.js';
import { BY_ID, SOUND_IDS } from './flight-announce-lines.js';

// How far a terminal announcement carries, in metres. Beyond this it is inaudible.
export const REACH = 250;

// How each kind of speaker sounds: band limits, and how much of the hall's echo.
// A hall PA is reverberant, outdoor speakers are dull and short, the aircraft cabin
// is a small band-limited speaker and dry.
const CHAIN = {
  terminal: { hp: 180, lp: 6500, wet: 0.5 },
  apron: { hp: 120, lp: 3600, wet: 0.1 },
  cabin: { hp: 380, lp: 3300, wet: 0 },
};

// The gain of one announcement right now. Pure, so the rules can be checked in node.
//   where:  'terminal' (a hall PA), 'apron' (outdoor speakers) or 'cabin' (the aircraft PA)
//   inside: the player is in the terminal
//   aboard: the player is in the aircraft
//   near:   metres from the terminal
export function announceGain(where, { inside = false, aboard = false, near = 0 } = {}) {
  if (where === 'cabin') return aboard ? 1 : 0;
  if (aboard) return 0;
  const reach = Math.max(0, Math.min(1, 1 - near / REACH));
  const falloff = reach * reach; // drops away quickly after the first few metres
  if (where === 'terminal') return falloff * (inside ? 1 : 0.5);
  return falloff * (inside ? 0.12 : 0.35); // apron: outdoors, a little more distant
}

// The queue on its own: what is waiting and what is on the air. Pure, no audio.
export function announceQueue() {
  const waiting = [];
  let on = null;
  const known = (id) => on?.id === id || waiting.some((item) => item.id === id);
  return {
    // Queue a line. False if it is already waiting or on the air: a repeat is not doubled.
    add(id, where) {
      if (known(id)) return false;
      waiting.push({ id, where });
      return true;
    },
    // Put the next waiting line on the air, but only when nothing is on the air.
    take() {
      if (on || waiting.length === 0) return null;
      on = waiting.shift();
      return on;
    },
    // The line on the air has ended.
    done() {
      on = null;
    },
    clear() {
      waiting.length = 0;
      on = null;
    },
    get current() {
      return on;
    },
    get pending() {
      return waiting.length;
    },
  };
}

// One mp3 per name for the whole session. A missing file resolves to null and stays
// null, so a checkout without the recordings costs one 404 per line, not one per call.
const buffers = new Map(); // id -> Promise<AudioBuffer | null>
function fetchBuffer(ctx, id) {
  let p = buffers.get(id);
  if (!p) {
    p = fetch('assets/flight/' + id + '.mp3')
      .then((r) => { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .catch(() => null);
    buffers.set(id, p);
  }
  return p;
}

// The room's echo: one short decaying noise impulse, made once per context.
let impulse = null; // { ctx, buffer }
function impulseFor(ctx) {
  if (impulse?.ctx === ctx) return impulse.buffer;
  const rate = ctx.sampleRate, n = Math.floor(rate * 1.4);
  const buffer = ctx.createBuffer(2, n, rate);
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.4);
  }
  impulse = { ctx, buffer };
  return buffer;
}

export function flightAnnouncer() {
  const queue = announceQueue();
  let state = { inside: false, aboard: false, near: 0 };
  let run = null; // the line on the air: { where, out, nodes, sources }
  let token = 0; // bumped by stop(), so a line that is still loading does nothing
  let disposed = false;

  // The running context and the master bus, or null while the audio is locked.
  const ready = () => (disposed ? null : audioGraph());

  function stopRun() {
    if (!run) return;
    for (const s of run.sources) { try { s.stop(); } catch { /* already ended */ } }
    for (const n of run.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    run = null;
  }

  function finish(my) {
    if (my !== token) return;
    stopRun();
    queue.done();
    pump();
  }

  function play(item) {
    const g = ready();
    const gain = announceGain(item.where, state);
    if (!g || gain <= 0) { queue.done(); pump(); return; } // locked, or out of earshot: skip it
    const { ctx, master } = g;
    const my = ++token;
    const chain = CHAIN[item.where];

    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(master);
    const input = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = chain.hp;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = chain.lp;
    input.connect(hp);
    hp.connect(lp);
    lp.connect(out); // the dry sound
    const nodes = [input, hp, lp, out];
    if (chain.wet > 0) {
      const send = ctx.createGain();
      send.gain.value = chain.wet;
      const room = ctx.createConvolver();
      room.buffer = impulseFor(ctx);
      lp.connect(send);
      send.connect(room);
      room.connect(out);
      nodes.push(send, room);
    }
    run = { where: item.where, out, nodes, sources: [] };

    const chimeId = item.where === 'cabin' ? 'cabin-chime' : 'chime';
    Promise.all([fetchBuffer(ctx, chimeId), fetchBuffer(ctx, item.id)]).then(([chime, line]) => {
      if (my !== token) return; // stopped while loading
      if (!line) { finish(my); return; } // no recording on disk: silent, the next line goes
      const start = (buffer, when) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(input);
        src.start(when);
        run?.sources.push(src);
        return src;
      };
      let when = ctx.currentTime + 0.05;
      if (chime) {
        start(chime, when);
        when += chime.duration + 0.25; // the chime, then a breath, then the voice
      }
      start(line, when).onended = () => finish(my);
    });
  }

  // Start the next waiting line, if the audio is unlocked and nothing is on the air.
  function pump() {
    if (queue.current) return;
    if (!ready()) { if (queue.pending) queue.clear(); return; }
    const item = queue.take();
    if (item) play(item);
  }

  const api = {
    // Queue a line. where: 'terminal' (default), 'apron' or 'cabin'. False if refused:
    // unknown id, a chime, a repeat of a queued or spoken line, or audio still locked.
    say(id, { where = 'terminal' } = {}) {
      if (disposed || !BY_ID[id] || SOUND_IDS.includes(id) || !ready()) return false;
      if (!CHAIN[where]) where = 'terminal';
      if (!queue.add(id, where)) return false;
      pump();
      return true;
    },
    // Each frame. dt is unused: the gain glides on the audio clock.
    update(dt, next = {}) {
      state = { inside: !!next.inside, aboard: !!next.aboard, near: Number(next.near) || 0 };
      const g = ready();
      if (g && run) run.out.gain.setTargetAtTime(announceGain(run.where, state), g.ctx.currentTime, 0.12);
      pump();
    },
    get playing() {
      return queue.current?.id ?? null;
    },
    subtitle(id) {
      return BY_ID[id]?.subtitle ?? '';
    },
    stop() {
      token++;
      stopRun();
      queue.clear();
    },
    dispose() {
      api.stop();
      disposed = true;
    },
  };
  return api;
}
