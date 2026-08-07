// ==========================================================================
// Chatter — who speaks, when, and about what
//
// THE PROBLEM THIS SOLVES. The city already had forty people walking down the
// street and not one of them had ever noticed you existed. You could clip a man
// with a wing mirror at fifty and he would get up and carry on walking. The
// crowd was scenery. What turns scenery into a place is not more people, it is
// people who REACT — and, just as much, people who are busy with something that
// has nothing to do with you, because a city where every line is aimed at the
// player is a theme park.
//
// So this module does two different jobs and keeps them honestly separate:
//
//   REACTIONS are things you caused. You nearly ran somebody over, you honked,
//   you shoved past, a car went into a wall. They fire from events, they are
//   local to this machine (the event was), and they are allowed to interrupt.
//
//   AMBIENT is the city talking to itself. Mutters, telephone calls, two
//   neighbours arguing about a parking space. It fires on a slow clock, it is
//   nobody's business but theirs, and — see DETERMINISM — two players standing
//   on the same corner hear the same conversation.
//
// WHAT IT IS NOT ALLOWED TO BE IS A RADIO. Every knob in here is a rate limit,
// and they are the whole design. The failure mode of this feature is not
// silence, it is a market square: eight bubbles, three overlapping voices,
// nothing legible, and a player who tunes the entire system out inside a
// minute and never tunes back in. js/traffic.js already argued this out for
// the car horn — "a horn is an EVENT, not a soundtrack" — and every budget
// below is that sentence applied to speech:
//
//   · one ambient line at a time near you, every ~5 s, and never the same
//     sentence twice within LINE_CD
//   · at most CONV_MAX conversations running, each one stream of turns
//   · a per-person cooldown, so nobody becomes a chatterbox
//   · a global reaction cooldown, so a crash is a gasp and not a chorus
//   · and under all of it, audio.js caps the mix at three voices at once
//
// DETERMINISM, and its limits. The crowd in this game is a pure function of
// (world seed, cell, slot, generation) — see the header of js/pedestrians.js —
// and speech does not get to break that. So WHICH line a given citizen says in
// a given eight-second slot is `hash32(their seed, slot)`: no Math.random
// anywhere on that path, and two clients watching the same man hear the same
// sentence. What stays local is WHETHER you were there to hear it — the
// budgets above are per-machine, because they are about your ears, not about
// the world. Reactions are local outright, exactly as the traffic horn is
// (traffic.js:2291) and for the identical reason: the event that caused them
// happened on one machine.
//
// Speech never moves anybody. It cannot desync a position, cannot change a
// route, cannot kill. That is what makes local divergence survivable here in a
// way it would not be for the walk itself.
//
// DEPENDENCIES ARE DELIBERATELY THIN. This file imports the corpus, the world
// clock and the audio layer — all three headless-safe — and nothing else. It
// does NOT import three.js and it does NOT import the renderer: the bubble
// drawer is handed in through the constructor and may be null. That is why the
// interesting half of this feature (who talks, cooldowns, gender, gating,
// conversation pairing) is testable under `node --test` with no canvas, no
// WebGL and no DOM anywhere in the process.
// ==========================================================================

import { LINES, CONVS, CAST, BY_CAT, castFor, clipId } from './chatterlines.js';
import { archetypeAt, ARCH_SALT } from './people.js';
import { worldT, tod } from './worldclock.js';
import { speakAt, preloadVoices, speakingNow } from './audio.js';

// Byte-identical to the hash in js/pedestrians.js and js/traffic.js, and
// duplicated for the same reason they duplicate it from each other: those two
// files state in their headers that the crowd and the traffic must be pure
// functions of the same integers, and a shared import that somebody later
// "optimises" would silently re-roll every citizen in the world. Only imul,
// xor and shift — nothing two engines can disagree about.
function hash32(a, b = 0, c = 0, d = 0, e = 0, f = 0) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < 6; i++) {
    let k = (i === 0 ? a : i === 1 ? b : i === 2 ? c : i === 3 ? d : i === 4 ? e : f) | 0;
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
const rnd01 = (h) => (h >>> 8) / 16777216;

// Salts. pedestrians.js already burns 0xc17 for the wardrobe and traffic.js
// uses 9 for the horn cooldown; the 0x76xx block is unused by either, so a
// voice can never accidentally be a jacket colour.
// 0x76f1 and 0x76f2 were the old free-standing gender and cast draws. They are
// retired rather than reused: the voice now follows the body (see voiceOf), and
// a salt that once meant something else is how two builds end up disagreeing
// about who somebody is.
const S_PITCH = 0x76f3;
const S_SLOT = 0x76f4;
const S_LINE = 0x76f5;
const S_PAIR = 0x76f6;
const S_CONV = 0x76f7;

// ---- budgets, and every one of them is a design decision -----------------
const SPEAK_R = 44;        // m — nobody outside this is worth a bubble at all
const CONV_R = 34;         // m — a conversation must be nearer to be started
const PAIR_R = 4.6;        // m — how close two walkers must be to talk
const PAIR_R2 = PAIR_R * PAIR_R;

const AMB_GAP = [3.6, 3.4];   // s until the next ambient solo: base + spread
const REACT_CD = 0.85;        // s — global floor between two reactions
// …and a much longer one for DRIVERS, because they are the one reaction the
// player can cause continuously. Stand in the road and traffic.js piles up a
// queue: every car in it passes the heldT test, and at the 0.85 s general
// floor four of them shouted inside four seconds. Screenshotted, that is a mob
// with two of the four bubbles overlapping illegibly. A jam should produce one
// irritated voice every few seconds — the queue is the joke, not the volume.
const DRIVER_CD = 4.5;
const PED_CD = [16, 12];      // s — one person's own cooldown: base + spread
const LINE_CD = 45;           // s — the same sentence may not be heard again
const CONV_MAX = 2;           // running conversations
const CONV_GAP = 0.55;        // s of silence between two turns
const CONV_CHANCE = 0.30;     // a qualifying pair actually talks this often
const IDLE_SLOT = 8;          // s — the grid ambient line choice is quantised to
const IDLE_CHANCE = 0.55;     // …and how often a citizen has something to say
const PRELOAD_N = 12;         // clips warmed at boot — see preload()

// Bubble timing. The hold is read-speed, not audio length: we do not know how
// long a clip is until it has been decoded, and a bubble that waited for the
// network would blink. 52 ms per character lands within a few tenths of the
// generated speech for every line in the corpus, and the fade-out covers the
// rest — a voice trailing half a second past its bubble reads as natural.
const FADE_IN = 0.14, FADE_OUT = 0.40;
const HOLD_BASE = 1.15, HOLD_CHAR = 0.052, HOLD_MAX = 4.6;

// Where the tail of the bubble points, in metres above the speaker's feet.
// js/netcity.js puts a peer's name tag at 1.75 * PLAYER_SCALE + 0.22; this sits
// deliberately a little higher so a bubble and a nametag over the same head
// stack instead of fighting. PLAYER_SCALE is not imported — config.js is a big
// module and this is one number that has not moved in the life of the project.
const HEAD_Y = 1.75 * 0.9 + 0.34;    // = 1.915 m
const CAR_Y = 1.28;                  // driver's window, over the left flank
const HEADROOM = 0.34;               // clear air between hair and bubble tail

// Where THIS person's bubble hangs. The constant above was written when every
// citizen was 1.75 m; js/people.js now spans 1.63 to 1.78, and a fixed height
// parks a grandmother's words fifteen centimetres over her hair while a young
// man's sit on his. pedestrians.js stamps `headTop` on the body at birth, so
// this costs one property read; the constant is the fallback for a body that
// predates the stamp and for the peers, who are all still the reference adult.
function headY(p) {
  return p.headTop ? p.headTop * 0.9 + HEADROOM : HEAD_Y;
}

// ---- who a citizen sounds like -------------------------------------------
// A pure function of the seed that already picks their jacket, so it is the
// same on every machine and — the part that matters to the ear — the same for
// every sentence they will ever say. Nothing about the box people is gendered
// (js/citizen.js builds the same eleven boxes for everyone), so this is a
// property of the VOICE and not a claim about the character.
// The voice comes off the BODY, not off a coin of its own. It used to flip
// `hash32(pid, S_GENDER) & 1` and pick a cast member at random inside that
// half — which was fine while every citizen was the same 1.75 m box, and became
// wrong the moment js/people.js gave the crowd five ages and two sexes: a
// stooped ninety-year-old with a stick would open his mouth and a young woman
// would come out. So archetype first, voice second, both from the same seed
// through the same salt, and neither module needs to ask the other.
//
// The mapping uses the cast that already exists — m1 is the middle-aged bloke,
// m2 the older and gruffer one, f1 middle-aged, f2 younger — so all 904 clips
// on disk stay valid and nothing had to be re-rendered.
const CAST_FOR = { m30: 'm1', m60: 'm2', m90: 'm2', f30: 'f2', f60: 'f1' };
export function voiceOf(pid) {
  const a = archetypeAt(rnd01(hash32(pid, ARCH_SALT)));
  const key = CAST_FOR[a.key] ?? 'm1';
  const c = CAST.find((x) => x.key === key) ?? CAST[0];
  // ±7 % of playback rate, per PERSON — four recordings times a continuous
  // offset is what stops a street of forty people sounding like four. Per
  // UTTERANCE would have made one man's own voice wobble between sentences,
  // which is worse than four. The ninety-year-old is dragged down a further
  // 6 %: m2 is already the oldest voice in the cast and he is thirty years
  // past it, and pitch is the only knob left that costs nothing.
  const age = a.key === 'm90' ? -0.06 : 0;
  return {
    male: a.sex === 'm',
    arch: a.key,
    cast: c.key,
    pitch: 0.93 + rnd01(hash32(pid, S_PITCH)) * 0.14 + age,
  };
}

// ---- the world clock, as the corpus talks about it -----------------------
// worldclock.tod() is 0..1 with 0 = midnight. The boundaries are the ones a
// Czech would recognise, not equal quarters: "ráno" is not six hours long.
export function todTag(t01) {
  const t = t01 - Math.floor(t01);
  if (t < 0.25 || t >= 0.875) return 'night';    // 21:00 – 06:00
  if (t < 0.46) return 'morning';                // 06:00 – 11:00
  if (t < 0.60) return 'noon';                   // 11:00 – 14:24
  return 'evening';                              // 14:24 – 21:00
}

export class Chatter {
  /**
   * bubbles: a ChatBubbles instance, or null — with null the whole feature
   *   still runs and is still audible, it just has nothing to draw. That is
   *   not a courtesy to tests, it is the settings panel: "bubliny vypnuto"
   *   must not also turn the city mute.
   * opts: { peds, traffic } may be handed in now or assigned later; nothing
   *   here holds a reference it will not re-read.
   */
  constructor(bubbles = null, opts = {}) {
    this.bubbles = bubbles;
    this.peds = opts.peds ?? null;
    this.enabled = true;
    this.voiceOn = true;         // settings: voices without bubbles, or neither
    this.volume = 1;

    this._live = [];             // utterances being said right now
    this._convs = [];            // running two-handers
    this._seq = 0;               // makes an utterance key unique
    this._ambCd = 2.0;           // grace period after boot before anyone speaks
    this._reactCd = 0;
    this._pairT = 0;             // the 4 Hz pair scan, piggybacked on nothing
    this._lineAt = new Map();    // line id → worldT it was last heard
    this._t = worldT();          // cached clock, refreshed once per update()
    this._lis = { x: 0, z: 0 };  // where the player's ears are
    this._victim = null;         // the last person run over, waiting to get up
    this._driverAt = 0;          // no shouting out of windows before this time

    // Scratch, reused: this module runs inside stepGame and stepGame can run
    // several times per rendered frame (main.js clamps dt to 50 ms and loops),
    // so an allocation here is an allocation three times a frame.
    this._cand = [];
    this._cdist = [];
  }

  /**
   * Warm a HANDFUL of clips so the first reaction of the session is not late.
   *
   * The size of that handful is the whole point. The first version warmed
   * every clip of four whole categories — 254 files, ~5 MB over the wire and
   * something like 90 MB of decoded PCM resident in audio.js's buffer Map,
   * which has no eviction — on the first click, and again on every click after
   * that. For a latency problem that is measured in a tenth of a second.
   *
   * PRELOAD_N is a spread, not a prefix: every fourth line of the two
   * categories the player is most likely to trigger in their first minute
   * (driving too close, walking into somebody), one clip per line rather than
   * all four cast voices, so a cold miss costs the usual ~100 ms and nothing
   * else. Everything past that loads the way it always did — once, on demand,
   * cached for the session.
   */
  preload() {
    if (this._preloaded) return;             // once per session, not per click
    this._preloaded = true;
    const hot = [];
    for (const cat of ['nearmiss', 'bump']) {
      const pool = BY_CAT.get(cat) ?? [];
      for (let i = 0; i < pool.length && hot.length < PRELOAD_N; i += 4) {
        const cast = castFor(pool[i].g);
        hot.push('v/' + clipId(pool[i].id, cast[i % cast.length].key));
      }
    }
    preloadVoices(hot);
  }

  // ---------------------------------------------------------------- frame ----

  /**
   * ctx: {
   *   camera      the render camera — bubbles need it, nothing else does
   *   ears        { x, z } the listener, i.e. main.js's `ears`
   *   player      { pos:{x,z}, speed }  — may be null
   *   playerCar   the car the player is DRIVING, or null
   *   onFoot      true when the player is walking
   *   cars        iterable of AI cars (for the drivers who shout)
   * }
   */
  update(dt, ctx = {}) {
    // ONE clock read a step, cached for everything below. The cooldowns are
    // absolute deadlines now (see _cool), and the pair scan alone would ask
    // for the time a few thousand times a second if each comparison called
    // worldT() itself.
    this._t = worldT();
    const ears = ctx.ears ?? ctx.player?.pos;
    if (ears) { this._lis.x = ears.x; this._lis.z = ears.z; }

    if (this.enabled) {
      this._reactCd -= dt;
      this._ambient(dt, ctx);
      this._pairs(dt);
      this._runConvs(dt);
      this._drivers(dt, ctx);
      this._proximity(dt, ctx);
      this._victimUp();
    }
    this._step(dt);
    this.bubbles?.update(this._live, ctx.camera);
  }

  // Advance every live utterance: follow its speaker, run the fade envelope,
  // and retire it. An utterance whose speaker was reaped mid-sentence dies with
  // them — citizen.dispose() detaches the group from the scene, so a null
  // parent is a free and exact liveness test.
  _step(dt) {
    for (let i = this._live.length - 1; i >= 0; i--) {
      const u = this._live[i];
      u.t += dt;

      const m = u.ped ? u.ped.mesh : u.car?.mesh;
      const gone = !m || !m.parent
        || (u.ped && (u.ped.state === 'rag' || u.ped.state === 'dead'));
      if (gone) { this._live.splice(i, 1); this.bubbles?.remove(u.key); continue; }

      if (u.ped) {
        u.x = u.ped.x; u.z = u.ped.z;
        u.y = m.position.y + headY(u.ped);
      } else {
        // over the driver's window rather than the roof centre: a shout that
        // comes out of the middle of the car reads as the car talking
        const c = u.car;
        const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
        const ax = -0.34 * (c.wid ?? 1.8);
        u.x = c.x + ax * ch; u.z = c.z - ax * sh;
        u.y = m.position.y + CAR_Y;
      }

      u.a = u.t < FADE_IN ? u.t / FADE_IN
        : u.t < FADE_IN + u.hold ? 1
        : 1 - (u.t - FADE_IN - u.hold) / FADE_OUT;
      if (u.a <= 0) { this._live.splice(i, 1); this.bubbles?.remove(u.key); }
    }
  }

  // ------------------------------------------------------------- ambient ----

  // One person, somewhere near you, saying something to nobody. This is the
  // layer that does the actual work of making the street feel inhabited, and
  // it is also the one that would ruin it if it ran twice as often.
  _ambient(dt, ctx) {
    this._ambCd -= dt;
    if (this._ambCd > 0 || !this.peds) return;
    this._ambCd = AMB_GAP[0] + Math.random() * AMB_GAP[1];
    if (speakingNow() >= 2) return;         // let the mix breathe

    const p = this._pickNearby(24, true);
    if (!p) return;

    // WHAT they say is deterministic (see DETERMINISM in the header): the
    // eight-second slot plus their seed. WHEN we happened to look is not.
    const pid = this._pid(p);
    const slot = Math.floor(this._t / IDLE_SLOT);
    if (rnd01(hash32(pid, slot, S_SLOT)) > IDLE_CHANCE) return;

    // Which pot: mostly the plain mutters, a good slice of Pardubice, and a
    // telephone call now and then. The local-colour lines are the ones players
    // quote back at you, so they are worth more than their share.
    const r = rnd01(hash32(pid, slot, S_CONV));
    const cat = r < 0.16 ? 'phone' : r < 0.44 ? 'local'
      : r < 0.60 ? 'tod' : 'idle';

    this._say(p, cat, hash32(pid, slot, S_LINE));
  }

  // ---------------------------------------------------------- two-handers ----

  // Find pairs of people standing close enough to be talking. Brute force over
  // this.peds at 4 Hz: the fleet is capped at ~94 bodies even on "Rušno", so
  // this is under 4 400 squared-distance tests four times a second — an order
  // of magnitude under the per-FRAME cars × peds test the hit pass already
  // runs. A spatial index for this would be more code and less speed.
  _pairs(dt) {
    this._pairT -= dt;
    if (this._pairT > 0 || !this.peds) return;
    this._pairT = 0.25;
    if (this._convs.length >= CONV_MAX) return;

    const peds = this.peds.peds;
    const lx = this._lis.x, lz = this._lis.z;
    for (let i = 0; i < peds.length; i++) {
      const a = peds[i];
      if (a.state !== 'walk' || a.free || this._busy(a)) continue;
      const adx = a.x - lx, adz = a.z - lz;
      if (adx * adx + adz * adz > CONV_R * CONV_R) continue;
      for (let j = i + 1; j < peds.length; j++) {
        const b = peds[j];
        if (b.state !== 'walk' || b.free || this._busy(b)) continue;
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > PAIR_R2) continue;
        if (this._startConv(a, b)) return;      // one new conversation per scan
      }
    }
  }

  // The pair is fixed by seed order, never by array order, so both clients
  // agree on who is speaker 0 — the array is a different shuffle on every
  // machine and would otherwise have swapped the two halves of the dialogue.
  _startConv(a, b) {
    const pa = this._pid(a), pb = this._pid(b);
    const lo = pa <= pb ? a : b, hi = pa <= pb ? b : a;
    const key = hash32(Math.min(pa, pb), Math.max(pa, pb), S_PAIR);
    const bucket = Math.floor(this._t / 30);
    if (rnd01(hash32(key, bucket, S_CONV)) > CONV_CHANCE) return false;

    const va = voiceOf(this._pid(lo)), vb = voiceOf(this._pid(hi));
    const ga = va.male ? 'm' : 'f', gb = vb.male ? 'm' : 'f';

    // Rejection sample a compatible dialogue rather than building a filtered
    // array: this runs four times a second and the whole file is under the
    // "nothing that runs every second may allocate" rule the engine pass set.
    let cv = null;
    for (let n = 0; n < 10; n++) {
      const c = CONVS[(rnd01(hash32(key, bucket, n)) * CONVS.length) | 0];
      if (!c) continue;
      const g0 = c.g?.[0] ?? 'a', g1 = c.g?.[1] ?? 'a';
      if ((g0 === 'a' || g0 === ga) && (g1 === 'a' || g1 === gb)
        && !this._tooSoon(c.id)) { cv = c; break; }
    }
    if (!cv) return false;

    this._lineAt.set(cv.id, this._t);
    this._convs.push({ cv, a: lo, b: hi, va, vb, turn: -1, wait: 0.25 });
    // Both of them are busy for the length of the dialogue plus their cooldown,
    // so a man cannot mutter to himself in the middle of his own argument.
    this._cool(lo); this._cool(hi);
    return true;
  }

  _runConvs(dt) {
    for (let i = this._convs.length - 1; i >= 0; i--) {
      const c = this._convs[i];
      // Either party being run over or reaped ends it mid-sentence, which is
      // exactly what happens on a real pavement.

      if (!this._talkable(c.a) || !this._talkable(c.b)) { this._convs.splice(i, 1); continue; }

      c.wait -= dt;
      if (c.wait > 0) continue;
      c.turn++;
      const t = c.cv.turns[c.turn];
      if (!t) { this._convs.splice(i, 1); continue; }

      const who = t.s === 0 ? c.a : c.b;
      const v = t.s === 0 ? c.va : c.vb;
      const hold = this._hold(t.text);
      this._utter(who, null, c.cv.id + '_' + c.turn, t.text, t.mood, v, hold);
      c.wait = hold + FADE_IN + CONV_GAP;
    }
  }

  // ------------------------------------------------------------- drivers ----

  // A driver leans out and shouts. traffic.js already computes the only thing
  // worth reacting to — `ai.heldT`, the seconds this car has been pinned below
  // its desired speed by whatever is in front of it — and it already knows the
  // difference between "held up" and "waiting at a red" (`ai.sigQ`). We read
  // both and add nothing: a shout is a rarer, closer, angrier horn, and it
  // must be suppressed at a red light for the same reason the horn is.
  _drivers(dt, ctx) {
    if (!ctx.cars || this._reactCd > 0 || this._driverAt > this._t) return;
    const lx = this._lis.x, lz = this._lis.z;
    // A DEADLINE, like every other cooldown here — see _cool(). An earlier
    // version counted `car._shoutCd` down inside this loop AND again in a
    // second sweep, so any car near enough to be a candidate cooled at double
    // rate; making it a timestamp deletes the whole question.
    for (const car of ctx.cars) {
      if ((car._shoutAt ?? 0) > this._t) continue;
      const ai = car.ai;
      // heldT is traffic.js's own "this driver is fed up" meter, and sigQ is
      // its own "…but he is only waiting at a red". Both are already computed
      // for the horn; reading them adds nothing and cannot disagree with it.
      if (!ai || ai.sigQ || (ai.heldT ?? 0) < 9) continue;
      const dx = car.x - lx, dz = car.z - lz;
      if (dx * dx + dz * dz > 34 * 34) continue;
      car._shoutAt = this._t + 14 + Math.random() * 12;
      this._driverAt = this._t + DRIVER_CD;
      this._sayCar(car, 'driver');
      return;                                  // one shout per frame, city-wide
    }
  }

  // ----------------------------------------------------------- proximity ----

  // The three things the player does with their body rather than with an
  // event: driving past somebody far too close, walking into them, and
  // standing in their way. All three are one scan, at 10 Hz.
  _proximity(dt, ctx) {
    if (!this.peds) return;
    this._proxT = (this._proxT ?? 0) - dt;
    const due = this._proxT <= 0;
    if (due) this._proxT = 0.1;

    const car = ctx.playerCar;
    const fast = car && Math.abs(car.speed) > 7;
    const foot = ctx.onFoot && ctx.player;
    if (!due || (!fast && !foot)) return;

    let fx = 0, fz = 0, rx = 0, rz = 0, px = 0, pz = 0;
    if (fast) {
      const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
      fx = -sh; fz = -ch;                     // citizen.js convention: faces −z
      rx = -fz; rz = fx;                      // the driver's right
      px = car.x; pz = car.z;
    } else {
      px = ctx.player.pos.x; pz = ctx.player.pos.z;
    }

    for (const p of this.peds.peds) {
      if (p.state !== 'walk') continue;
      const dx = p.x - px, dz = p.z - pz;
      const d2 = dx * dx + dz * dz;

      if (fast) {
        if (d2 > 49) continue;
        const lon = dx * fx + dz * fz, lat = dx * rx + dz * rz;
        // ALONGSIDE or JUST PASSED, and outside the width that would have been
        // an actual hit — pedestrians.js owns the hit, and a man who has been
        // launched over the bonnet is not going to shout "gratuluju k
        // řidičáku". The lower bound on |lat| is what keeps the two apart.
        const la = lat < 0 ? -lat : lat;
        if (la < 0.85 || la > 3.0 || lon > 1.8 || lon < -4.0) continue;
        // `continue`, not `return`, when nobody spoke: _say() refuses for a
        // personal cooldown or an exhausted line pool, and bailing out of the
        // whole scan on a refusal meant one recently-startled pedestrian could
        // shield everybody behind them for the next 16 seconds.
        if (this._say(p, 'nearmiss')) return;
        continue;
      }

      if (d2 < 1.7 && (ctx.player.speed ?? 0) > 1.4) {
        if (this._say(p, 'bump')) return;     // walked straight into them
        continue;
      }
      if (d2 < 10) {
        // loitering in somebody's face: a second and a bit of it earns a line
        p._chatNear = (p._chatNear ?? 0) + 0.1;
        if (p._chatNear > 1.3) { p._chatNear = 0; if (this._say(p, 'player')) return; }
      } else if (p._chatNear) p._chatNear = 0;
    }
  }

  // ----------------------------------------------------------- reactions ----

  /** Somebody just got hit by a car. The victim is airborne and says nothing
   *  YET — the scream is audio.js's job — but the street saw it, and if they
   *  survive they will have something to say about it in a few seconds. */
  pedHit(victim, impact) {
    if (impact < 3) return;
    this._witness(victim.x, victim.z, 22, 'hit', impact > 6 ? 2 : 1);
    // pedestrians.js puts a survivor through rag → down (2–4 s on the tarmac)
    // → walk, and getting up is the moment the line belongs to: "Bolí mě
    // hlavně hrdost" from a man still in the air is a joke told too early.
    // We cannot hook _getUp from out here, so we watch for the state to come
    // back round. One slot only — the newest victim wins, because a second
    // person going under the wheels is the more interesting one.
    if (!victim.dead) this._victim = victim;
  }

  // Did the person we last ran over get back on their feet? Cheap: one object
  // compare a frame, and it self-clears the moment they speak, die or vanish.
  _victimUp() {
    const v = this._victim;
    if (!v) return;
    if (!this._talkable(v)) {
      // 'rag' and 'down' are them still on the way up — keep waiting. Anything
      // else (dead, reaped, ghosted) means there is nobody left to speak.
      if (v.state !== 'rag' && v.state !== 'down') this._victim = null;
      return;
    }
    this._victim = null;
    // They have just stood up, so their own cooldown is irrelevant — this is
    // the one line they are entitled to.
    v._chatAt = 0;
    this._say(v, 'victim');
  }

  /** A horn, from anywhere: an AI car leaning on it, or the player's own. */
  honk(x, z) { this._witness(x, z, 17, 'horn', 1); }

  /** Something loud and bad happened here — an explosion, a car into a wall,
   *  a rocket. Wired to peds.panic() in main.js, so every existing and future
   *  source of panic feeds this without knowing the module exists. */
  bang(x, z, r = 25) { this._witness(x, z, Math.max(r, 18), 'bang', 2); }

  // Pick the one or two nearest people who can see it and let them speak. Not
  // everyone: a chorus of twelve is a football crowd, and the point of a
  // reaction is that you can tell what was said.
  _witness(x, z, radius, cat, howMany) {
    if (!this.peds || !this.enabled || this._reactCd > 0) return;
    const r2 = radius * radius;
    const lx = this._lis.x, lz = this._lis.z;
    let said = 0;
    // nearest-to-the-EVENT first, so the person who actually saw it speaks
    // TWO arrays, not one array of alternating objects and numbers: a mixed
    // array forces V8 out of its packed-double representation and boxes every
    // distance, which is exactly the per-frame allocation the engine pass
    // banned. Both are reused across calls and never shrink.
    const cand = this._cand, dist = this._cdist;
    let n = 0;
    for (const p of this.peds.peds) {
      if (p.state !== 'walk' || this._busy(p)) continue;
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const ex = p.x - lx, ez = p.z - lz;
      if (ex * ex + ez * ez > SPEAK_R * SPEAK_R) continue;   // you'd not hear it
      cand[n] = p; dist[n] = d2; n++;
    }
    if (!n) return;
    // partial selection sort, `howMany` passes — no sort callback, no
    // comparator closure, and howMany is 1 or 2
    for (let k = 0; k < howMany && said < howMany; k++) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) if (dist[i] < bd) { bd = dist[i]; best = i; }
      if (best < 0) break;
      dist[best] = Infinity;
      if (this._say(cand[best], cat)) said++;
    }
    for (let i = 0; i < n; i++) cand[i] = null;   // don't pin dead bodies
  }

  // --------------------------------------------------------------- saying ----

  // Choose a line of `cat` this person is allowed to say, and say it. `h` makes
  // the choice deterministic (ambient); leaving it out picks at random, which
  // is right for reactions since the event itself was local anyway.
  _say(ped, cat, h = null) {
    if (!this.enabled || ped.state !== 'walk' || this._busy(ped)) return false;
    const pid = this._pid(ped);
    const v = voiceOf(pid);
    const line = this._pick(cat, v.male, h);
    if (!line) return false;
    this._cool(ped);
    // Only a REACTION arms the reaction floor. It used to be armed by every
    // line, ambient included — so a man muttering about the price of butter
    // ate the 0.85 s window that the shout after a near miss needed, and
    // roughly one player-caused reaction in six was silently dropped. An
    // idle mutter is not an event and must not spend an event's budget.
    if (h === null) this._reactCd = REACT_CD;
    this._lineAt.set(line.id, this._t);
    this._utter(ped, null, line.id, line.text, line.mood, v, this._hold(line.text));
    return true;
  }

  _sayCar(car, cat) {
    const pid = car.ai?.seed ?? 0;
    const v = voiceOf(pid);
    const line = this._pick(cat, v.male, null);
    if (!line) return false;
    this._reactCd = REACT_CD;
    this._lineAt.set(line.id, this._t);
    this._utter(null, car, line.id, line.text, line.mood, v, this._hold(line.text));
    return true;
  }

  // Rejection sampling, not filter(): this is called several times a second and
  // a fresh array per call is the exact allocation the engine pass banned.
  //
  // Ten darts is NOT enough on its own, and the failure is silent, which is
  // what makes it worth the extra loop. A pool where half the lines suit the
  // speaker's voice misses ten times in a row about once in a thousand tries —
  // rare enough to look like nothing and common enough that, over an hour in
  // the city, a handful of near misses simply produce no shout at all. It
  // showed up first as a test that passed alone and failed in a suite, which
  // is exactly how a probabilistic gap announces itself.
  //
  // So: darts for speed, then ONE linear sweep from a random offset that
  // cannot miss. The sweep is O(pool) — thirty comparisons on a pool that only
  // reaches it a fraction of the time — and it turns "usually finds a line"
  // into "finds one if one exists". Returning null now genuinely means the
  // pool is exhausted (every line on cooldown, or gated to another hour),
  // which IS the correct time to say nothing.
  _pick(cat, male, h) {
    const pool = BY_CAT.get(cat);
    if (!pool || !pool.length) return null;
    const g = male ? 'm' : 'f';
    const when = todTag(tod());
    const n = pool.length;
    for (let i = 0; i < 10; i++) {
      const r = h === null ? Math.random() : rnd01(hash32(h, i));
      const l = pool[(r * n) | 0];
      if (l && this._eligible(l, g, when)) return l;
    }
    const start = ((h === null ? Math.random() : rnd01(hash32(h, 99))) * n) | 0;
    for (let i = 0; i < n; i++) {
      const l = pool[(start + i) % n];
      if (l && this._eligible(l, g, when)) return l;
    }
    return null;
  }

  // A weather tag this build cannot satisfy is never eligible — see the note in
  // chatterlines.js. '' is always; a clock tag must match the hour.
  _eligible(l, g, when) {
    if (l.g !== 'a' && l.g !== g) return false;
    if (l.when && l.when !== when) return false;
    return !this._tooSoon(l.id);
  }

  _tooSoon(id) {
    const at = this._lineAt.get(id);
    return at !== undefined && this._t - at < LINE_CD;
  }

  _hold(text) {
    return Math.min(HOLD_MAX, HOLD_BASE + text.length * HOLD_CHAR);
  }

  // A DEADLINE, not a countdown — and that distinction is the whole reason
  // this comment exists. The first version stamped `ped._chatCd = 16 + rnd*12`
  // and every read tested `> 0`, exactly like pedestrians.js's own `hitCd`…
  // except pedestrians.js decrements hitCd in its walk loop and NOTHING here
  // ever decremented ours. So a citizen who said one word was mute for the
  // rest of their 420-second life, the busiest street in the game went quiet
  // after a minute, and every test still passed, because "he does not speak
  // twice" is what a working cooldown looks like from the outside too.
  //
  // An absolute time cannot rot: there is no per-frame pass to forget, no
  // ownership question about who ticks whose field, and a body that sits
  // frozen in a paused tab comes back with its cooldown correctly expired.
  // `car._shoutAt` below is the same shape for the same reason.
  _cool(ped) { ped._chatAt = this._t + PED_CD[0] + Math.random() * PED_CD[1]; }

  // "Has this person spoken too recently to speak again?" — one place, so the
  // five call sites cannot drift apart on the comparison.
  _busy(p) { return (p._chatAt ?? 0) > this._t; }

  // The person, not the slot. p.sch is nulled the moment a body is cut loose
  // from its schedule (run over, or its generation rolled while you watched),
  // so the seed is copied onto the body at birth — see pedestrians.js _attach.
  // The fallback keeps a body that predates that stamp from being voiceless.
  _pid(p) {
    return p.pid ?? p.sch?.seed ?? (p.pid = hash32(Math.round(p.x * 4), Math.round(p.z * 4), 0x7a1));
  }

  // Put one line in the world: a bubble anybody in line of sight can read, and
  // a voice anybody within earshot can hear. Deliberately independent — the
  // bubble does not wait for the audio, and a refused voice (too far, three
  // people already talking, no generated assets on disk at all) still leaves
  // the line visible. A game checked out without assets/voices is a silent
  // film, not a broken one.
  _utter(ped, car, audioId, text, mood, v, hold) {
    const x = ped ? ped.x : car.x, z = ped ? ped.z : car.z;
    const y = (ped?.mesh ?? car?.mesh)?.position.y ?? 0;
    const u = {
      key: 'u' + (++this._seq),
      // The corpus id this came out of. Nothing in the render path reads it —
      // it is here so a test can assert WHICH line was chosen rather than
      // string-matching the text back against the corpus (two situations can
      // legitimately share a sentence, and that search finds the wrong one),
      // and so a bug report can name the line that misfired.
      id: audioId,
      ped, car, text, mood,
      x, z, y: y + (ped ? headY(ped) : CAR_Y),
      // Anti-collision stagger, in line heights — chatbubbles.js applies it.
      // The counter is what makes it work: two people who speak at the same
      // moment get consecutive sequence numbers and therefore different lifts,
      // which is exactly the case (a two-hander, two witnesses to one crash)
      // where two bubbles land in the same patch of sky.
      lift: (this._seq % 3) * 1.15,
      t: 0, a: 0, hold,
    };
    this._live.push(u);
    if (this.voiceOn) {
      speakAt('v/' + clipId(audioId, v.cast), x, z,
        { vol: this.volume, rate: v.pitch });
    }
    return u;
  }

  // -------------------------------------------------------------- helpers ----

  // Is this body in a state to say anything at all? The flying, the lying and
  // the dead are not, and a body whose citizen group has been detached from
  // the scene has already been reaped — citizen.dispose() nulls the parent, so
  // this is an exact liveness test that costs one property read.
  _talkable(p) {
    return !!p && p.state === 'walk' && !!p.mesh?.parent;
  }

  // Somebody near you who could say something, picked at random from everyone
  // eligible — the radius does the "near" part, and choosing uniformly inside
  // it is what stops the same person becoming the voice of the street.
  //
  // This used to throw six darts at the ped array instead of scanning it, on
  // the reasoning that the answer only has to be plausible. Measured on the
  // real spawn at 06:00: 63 bodies loaded, exactly ONE of them walking within
  // 24 m — so a dart found the only candidate 9 % of the time and the ambient
  // layer, which believes it speaks every five seconds, actually managed a
  // line about once a minute. In a busy square darts are fine; in the quiet
  // streets that are most of Pardubice they made the feature look broken.
  //
  // A full scan of ≤94 bodies once every ~5 s is nothing — the conversation
  // pair scan next door does 4 400 distance tests four times a second — and it
  // turns "usually finds somebody" into "finds somebody if anybody is there".
  // `owned` skips the ghosts and the run-over: a body cut loose from its
  // schedule is on its way out and should not start a sentence.
  _pickNearby(radius, owned) {
    const peds = this.peds?.peds;
    if (!peds || !peds.length) return null;
    const r2 = radius * radius;
    const lx = this._lis.x, lz = this._lis.z;
    const cand = this._cand;
    let n = 0;
    for (const p of peds) {
      if (!this._talkable(p) || this._busy(p)) continue;
      if (owned && p.free) continue;
      const dx = p.x - lx, dz = p.z - lz;
      if (dx * dx + dz * dz > r2) continue;
      cand[n++] = p;
    }
    if (!n) return null;
    const pick = cand[(Math.random() * n) | 0];
    for (let i = 0; i < n; i++) cand[i] = null;   // don't pin dead bodies
    return pick;
  }

  /** Everyone shuts up: opening the menu, teleporting, a cutscene. */
  silence() {
    this._live.length = 0;
    this._convs.length = 0;
    this.bubbles?.clear();
  }

  dispose() {
    this.silence();
    this._lineAt.clear();
    this.peds = null;
    this.bubbles = null;
  }
}

export default Chatter;
