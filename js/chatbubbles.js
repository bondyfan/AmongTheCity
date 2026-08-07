// ---- ChatBubbles: what the city is saying, drawn over the speaker's head ----
//
// The same argument js/nametags.js makes, for the same reason: this is a SPRITE
// in the scene and not a projected <div>. A speech bubble that floats through a
// panelák is worse than a name tag that does, because a name is a label and a
// line of dialogue is an EVENT — you turn your head toward it. Reading "Ty vole,
// dávej bacha!" through a wall, from a person you cannot see, on a street you
// are not on, teaches the player that the bubbles are decoration. Depth-testing
// the sprite means a line only reaches you when its speaker does, and that one
// property is what makes the crowd feel like it is in the world rather than on
// the glass.
//
// WHAT THIS MODULE IS NOT. It has no timers, no cooldowns, no opinion about who
// speaks. It is handed a list of live utterances once a frame and it draws them
// — position, alpha and text all decided by js/chatter.js. That split is on
// purpose: the interesting logic (who talks, when, about what) is testable
// headless with no canvas anywhere near it, and this file stays a renderer that
// a test can skip entirely. It is the nametags contract verbatim — pass the
// whole collection every frame, gen-stamp what you saw, reap what you didn't —
// because that pattern already survived two years of actors appearing and
// vanishing mid-frame in this codebase, and a second lifecycle idiom for the
// same problem would be the drift, not the improvement.
//
// TEXTURE ECONOMY. A bubble's canvas is keyed by its TEXT, refcounted, and held
// in an LRU of CACHE_MAX entries. Keyed by text and not by speaker, because
// forty people saying "Dobrý den" should share one texture — a cache keyed by
// speaker would have rasterised it forty times. The LRU is the correction to
// the first version, which kept every canvas forever on the argument that "the
// corpus is finite so the cache is bounded": true, and still ~330 canvases plus
// their GPU textures by the end of a long session. Disposing at refs === 0 is
// the opposite mistake — "Dobrý den" is said every few seconds and would be
// re-rasterised every time, on the frame path. Keep the recent, drop the cold.
//
// SIZE. Screen-referred, like the name tags: a bubble holds roughly the same
// apparent size from arm's length to the knee at ~40 m, then shrinks slowly
// instead of vanishing. Unlike a name tag it is also CAPPED IN RANGE hard —
// MAX_DIST is 60 m, because past that the type is a smudge and the honest cue
// for a conversation across the square is the one the mix already provides:
// hearing it, faintly, and not being able to make it out.
//
// Import-time safety: nothing here touches the DOM until update() is first
// called with a real utterance, so `node --check` and headless tests are free.

import * as THREE from 'three';

const DEF = {
  maxDist: 60,      // m — past this a bubble is not drawn at all
  fadeDist: 45,     // m — distance fade begins here, zero at maxDist
  pxScale: 0.030,   // world metres of ONE TEXT LINE per metre of camera distance
  minHeight: 0.12,  // m — floor, so a bubble pressed against the lens stays sane
  maxHeight: 1.20,  // m — the knee: constant apparent size ends here (~40 m)
  farScale: 0.006,  // m of extra line height per metre past the knee
  maxLive: 10,      // hard cap on bubbles drawn at once — see CROWD below
};

// CROWD. Ten is not a performance number (ten sprites is nothing); it is a
// legibility number. A pavement where eight bubbles overlap is a wall of text
// and the player reads none of it. chatter.js keeps its own, much tighter rate
// limit; this is the backstop for the case it cannot foresee — a bus stop, a
// crash, and a panic all landing in the same second.

// Same sanitiser doctrine as nametags.js, but a narrower job: our text never
// comes off the wire, it comes from the shipped corpus, so the concern is not
// a hostile nickname — it is a stray control character in an authored string
// silently rendering as a blank pill. Strip the invisibles, keep everything a
// Czech sentence legitimately needs (diacritics are combining marks in NFD, so
// they are deliberately NOT stripped here — the canvas draws them fine).
const CTRL = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

// The texture cache key is (text, mood), joined by the one character an
// authored Czech sentence provably cannot contain — CTRL above strips NUL out
// of the text before it ever gets here, so no pair of distinct inputs can
// collide on a shared key. It is written as an ESCAPE and not as a literal:
// the first version put a raw 0x00 byte in this file, and a source file with a
// NUL in it is a binary file as far as grep is concerned — every `grep -rn` in
// the repo silently skipped chatbubbles.js.
const SEP = String.fromCharCode(0);

const FONT_PX = 44;          // cap height of one line, in canvas pixels
const LINE_H = 56;           // baseline-to-baseline
const PAD_X = 30, PAD_Y = 22;
const RADIUS = 22;
const TAIL_W = 34, TAIL_H = 28;   // the pointer down toward the speaker's head
// NARROW ON PURPOSE — ≈ 15 Czech characters a line, four lines deep.
//
// The first build wrapped at 470 px (≈ 22 chars) and two lines, which is the
// shape a chat client wants and the wrong shape for a world. Screenshotted in
// the street outside the Obchod, a two-line bubble over a man at 29 m was wide
// enough to reach into the building beside him — and because these sprites
// depth-test (see the header, and it is the right call), the last third of
// "Málem jsi mě přejel" was simply cut off by a wall. Half a sentence reads as
// a rendering bug, not as depth.
//
// A TALL NARROW bubble lives in the vertical column directly over its
// speaker's head, and that column is the one piece of screen you already know
// is clear: you can see the speaker, so you can see the air above them. The
// same words, stacked instead of spread, stopped colliding with the city.
const WRAP_PX = 330;
const MAX_LINES = 4;         // a fifth line means the corpus has a line too long

// How many rasterised sentences stay resident. 64 is comfortably more than the
// city says in any five-minute stretch (the rate limits see to that), so in
// practice nothing is ever re-rasterised — and it caps the feature's texture
// memory at a few megabytes instead of letting it walk up to the whole corpus.
const CACHE_MAX = 64;

// Mood only ever moves the RIM, never the fill. A bubble whose body changes
// colour reads as a different UI element — a quest marker, a warning — and the
// player stops treating them all as "somebody said something". A warm rim on a
// shout and a cold one on a fright is enough to feel without being decoded.
const RIM = {
  angry:   'rgba(255,138,110,0.85)',
  annoyed: 'rgba(255,196,120,0.72)',
  scared:  'rgba(190,214,255,0.80)',
  shocked: 'rgba(190,214,255,0.80)',
  sad:     'rgba(160,178,200,0.62)',
  drunk:   'rgba(214,180,255,0.66)',
  amused:  'rgba(196,238,170,0.70)',
  friendly:'rgba(210,232,255,0.62)',
  tired:   'rgba(180,190,200,0.55)',
  neutral: 'rgba(255,255,255,0.34)',
};

// Greedy wrap on spaces, with a hard mid-word break for the pathological case
// (a 30-character compound with no space in it would otherwise run off the
// canvas and be silently clipped, which is a bug you only find by screenshot).
function wrap(g, text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const probe = cur ? cur + ' ' + w : w;
    if (g.measureText(probe).width <= WRAP_PX) { cur = probe; continue; }
    if (cur) { lines.push(cur); cur = ''; }
    if (g.measureText(w).width <= WRAP_PX) { cur = w; continue; }
    // one word wider than the whole bubble: chop it
    let chunk = '';
    for (const ch of w) {
      if (g.measureText(chunk + ch).width > WRAP_PX && chunk) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    cur = chunk;
  }
  if (cur) lines.push(cur);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = lines[MAX_LINES - 1].replace(/[\s.,!?…]*$/, '') + '…';
  }
  return lines.length ? lines : [' '];
}

// One canvas per distinct (text, mood). Returns { tex, aspect, refs } or null
// when there is no DOM to draw on (headless import, server-side test run).
function makeBubbleTexture(text, mood) {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  const font = `600 ${FONT_PX}px "Segoe UI", Roboto, Arial, Helvetica, sans-serif`;
  probe.font = font;

  const lines = wrap(probe, text);
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, Math.ceil(probe.measureText(l).width));

  const bw = Math.max(120, tw + PAD_X * 2);
  const bh = lines.length * LINE_H + PAD_Y * 2;

  const cv = document.createElement('canvas');
  cv.width = bw + 8;                 // 4 px breathing room each side for the rim
  cv.height = bh + TAIL_H + 8;
  const g = cv.getContext('2d');
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const bx = 4, by = 4;

  // Body + tail are ONE path so the rim strokes around the outside of both and
  // there is no seam where the tail meets the body. Drawing them as two shapes
  // put a stroke across the join, which at 30 m reads as a crack in the bubble.
  g.beginPath();
  g.moveTo(bx + RADIUS, by);
  g.arcTo(bx + bw, by, bx + bw, by + bh, RADIUS);
  g.arcTo(bx + bw, by + bh, bx, by + bh, RADIUS);
  // …along the bottom edge, detouring down into the tail at the centre
  const cx = bx + bw / 2;
  g.lineTo(cx + TAIL_W / 2, by + bh);
  g.lineTo(cx - TAIL_W * 0.10, by + bh + TAIL_H);   // off-centre tip: a bubble
  g.lineTo(cx - TAIL_W / 2, by + bh);                // whose tail leans reads as
  g.lineTo(bx + RADIUS, by + bh);                    // drawn, not generated
  g.arcTo(bx, by + bh, bx, by, RADIUS);
  g.arcTo(bx, by, bx + bw, by, RADIUS);
  g.closePath();

  g.fillStyle = 'rgba(14,16,20,0.78)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = RIM[mood] || RIM.neutral;
  g.stroke();

  // outline first, then fill — the black rim is what keeps white type legible
  // where the bubble happens to sit over a white van or a blown-out sky
  const y0 = by + PAD_Y + LINE_H / 2;
  g.lineWidth = 6;
  g.lineJoin = 'round';
  for (let i = 0; i < lines.length; i++) {
    const y = y0 + i * LINE_H;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(lines[i], cx, y);
    g.fillStyle = '#ffffff';
    g.fillText(lines[i], cx, y);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // lineUnits: how many TEXT LINES tall this canvas is, tail and padding
  // included. The screen-referred scale below sizes ONE line and multiplies,
  // so a three-line bubble is three times as tall on screen — and not three
  // times as tall as a one-liner ought to be, which is what a single "fit the
  // whole canvas to h" would have given.
  return { tex, aspect: cv.width / cv.height, lineUnits: cv.height / LINE_H, refs: 0 };
}

export class ChatBubbles {
  // scene: the THREE.Scene sprites are added to. opts overrides any DEF key.
  constructor(scene, opts = {}) {
    this.scene = scene || null;
    this.opt = { ...DEF, ...opts };
    this.enabled = true;
    this._live = new Map();   // key -> { sprite, mat, text, mood, aspect, lineUnits, gen }
    this._tex = new Map();    // text \0 mood -> { tex, aspect, lineUnits, refs }
    this._gen = 0;
    this._camPos = new THREE.Vector3();
  }

  setRange(maxDist) {
    const d = Number(maxDist);
    if (!Number.isFinite(d) || d < 8) return this.opt.maxDist;
    this.opt.maxDist = d;
    this.opt.fadeDist = d * 0.75;
    return d;
  }

  // items: any iterable of live utterances. Each is read for
  //   key   string, required — stable for the life of one utterance
  //   text  string, falsy → no bubble
  //   mood  string, keys RIM; anything unknown falls back to neutral
  //   x,y,z world position of the TAIL TIP (i.e. just over the speaker's head)
  //   a     0..1 alpha the caller is driving (fade in, hold, fade out)
  // Missing scene or camera makes this a no-op, so callers need no guard.
  update(items, camera) {
    if (!this.scene || !camera || !items) return;
    const it = items instanceof Map ? items.values() : items;
    if (!it || typeof it[Symbol.iterator] !== 'function') return;

    const o = this.opt;
    const gen = ++this._gen;
    camera.getWorldPosition(this._camPos);
    const cx = this._camPos.x, cy = this._camPos.y, cz = this._camPos.z;
    let drawn = 0;

    for (const u of it) {
      if (!u || !u.key) continue;
      const text = this.enabled ? String(u.text ?? '').replace(CTRL, '').trim() : '';
      const a = u.a ?? 1;
      if (!text || a <= 0.002 || drawn >= o.maxLive) { this.remove(u.key); continue; }

      const mood = RIM[u.mood] ? u.mood : 'neutral';
      let b = this._live.get(u.key);
      if (!b || b.text !== text || b.mood !== mood) {
        b = this._retext(u.key, text, mood);
        if (!b) continue;                       // no DOM — nothing to draw
      }
      b.gen = gen;

      const x = u.x ?? 0, y = u.y ?? 0, z = u.z ?? 0;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > o.maxDist) { b.sprite.visible = false; continue; }

      // ONE text line's world height, screen-referred (see SIZE in the header)
      let lh = dist * o.pxScale;
      if (lh < o.minHeight) lh = o.minHeight;
      else if (lh > o.maxHeight) {
        const knee = o.maxHeight / o.pxScale;
        lh = o.maxHeight + (dist - knee) * (o.farScale ?? 0);
      }
      const h = lh * b.lineUnits;

      b.sprite.visible = true;
      drawn++;
      // u.y is where the TAIL points; the sprite's origin is its centre, so the
      // bubble is lifted by half its own height. Without this a bubble grew
      // downward through the speaker's face as it got wordier.
      //
      // `lift` is the anti-collision nudge, in LINE HEIGHTS so it scales with
      // the screen-referred size rather than being a fixed world metre that
      // vanishes at distance. Two people standing together and talking at the
      // same time — a conversation, or two witnesses to the same crash — put
      // two bubbles in the same patch of sky, and the pair rendered as one
      // unreadable pile. chatter.js hands out a rotating lift, so consecutive
      // utterances stack instead of overlapping.
      b.sprite.position.set(x, y + h / 2 + (u.lift ?? 0) * lh, z);
      b.sprite.scale.set(h * b.aspect, h, 1);

      const far = dist <= o.fadeDist
        ? 1 : 1 - (dist - o.fadeDist) / (o.maxDist - o.fadeDist);
      b.mat.opacity = a * far;
    }

    // anything absent from this call stopped being said — drop it. chatter.js
    // normally fades to a === 0 first (handled above); this catches the
    // utterance whose speaker was reaped mid-sentence.
    for (const [key, b] of this._live) if (b.gen !== gen) this.remove(key);
  }

  _retext(key, text, mood) {
    const e = this._acquire(text, mood);
    if (!e) return null;
    let b = this._live.get(key);
    if (b) {
      this._release(b.text, b.mood);
      b.mat.map = e.tex;
      b.mat.needsUpdate = true;
      b.text = text; b.mood = mood;
      b.aspect = e.aspect; b.lineUnits = e.lineUnits;
      return b;
    }
    const mat = new THREE.SpriteMaterial({
      map: e.tex,
      transparent: true,
      // depthTest ON is the whole argument in the header: a wall between us and
      // the speaker hides what they said. depthWrite OFF so two bubbles blend
      // instead of punching holes in each other.
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      // SpriteMaterial fogs by default and this must not — sky.js pulls the
      // haze in with the streamed radius, and on the short-visibility preset a
      // bubble at 40 m would be half fog colour while this module still
      // considers it fully readable. Opacity above is the only fade it gets.
      // (Same fix, same reason, as nametags.js.)
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 13;      // over name tags, which are 12
    sprite.frustumCulled = true;
    b = { sprite, mat, text, mood, aspect: e.aspect, lineUnits: e.lineUnits, gen: this._gen };
    this._live.set(key, b);
    this.scene.add(sprite);
    return b;
  }

  // "Bounded by the corpus" is true and was not good enough. Every line in the
  // game can be said, so a long session converges on ~330 rasterised canvases;
  // at roughly 420×260 RGBA that is a canvas backing store AND a GPU texture
  // each, on the order of a hundred megabytes of the player's memory spent
  // remembering sentences nobody has uttered for twenty minutes.
  //
  // But disposing the moment refs hit zero is the other wrong answer: "Dobrý
  // den" is said every few seconds, and re-rasterising it each time puts a
  // canvas allocation and a texture upload on a path that runs while you are
  // driving. So: keep them, in use order, and drop the coldest once there are
  // more than CACHE_MAX. Insertion order in a Map IS the LRU as long as a hit
  // re-inserts, which is the one line at the top of _acquire.
  _acquire(text, mood) {
    const k = text + SEP + mood;
    let e = this._tex.get(k);
    if (e) { this._tex.delete(k); this._tex.set(k, e); }   // touch → most recent
    else {
      e = makeBubbleTexture(text, mood);
      if (!e) return null;
      this._tex.set(k, e);
      this._evict();
    }
    e.refs++;
    return e;
  }

  // Oldest first, and never one that is on screen right now — a bubble whose
  // texture was disposed mid-sentence renders as a white rectangle.
  _evict() {
    if (this._tex.size <= CACHE_MAX) return;
    for (const [k, e] of this._tex) {
      if (this._tex.size <= CACHE_MAX) return;
      if (e.refs > 0) continue;
      e.tex.dispose();
      this._tex.delete(k);
    }
  }

  _release(text, mood) {
    const k = text + SEP + mood;
    const e = this._tex.get(k);
    if (!e) return;
    // refs hitting zero does NOT dispose — it only makes this entry eligible
    // for _evict() to take once the cache is over its cap. Everything said in
    // the last CACHE_MAX distinct sentences stays hot.
    if (e.refs > 0) e.refs--;
  }

  remove(key) {
    const b = this._live.get(key);
    if (!b) return;
    this.scene?.remove(b.sprite);
    b.mat.dispose();
    this._live.delete(key);
    this._release(b.text, b.mood);
  }

  clear() {
    for (const key of [...this._live.keys()]) this.remove(key);
  }

  dispose() {
    this.clear();
    for (const e of this._tex.values()) e.tex.dispose();
    this._tex.clear();
    this.scene = null;
  }
}

export default ChatBubbles;
