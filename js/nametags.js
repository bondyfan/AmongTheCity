// ---- NameTags: a nickname floating over every remote player ----
// Deliberately NOT a DOM overlay. In a city full of buildings, buses and
// bridges a projected <div> floats through walls: you would read the name of a
// player two blocks away, standing behind a panelák. A sprite in the scene
// gets occlusion for free from the depth buffer, so a name only shows when its
// owner is actually visible — which is the whole point of a name tag.
//
// Sprite (not a manually billboarded quad) because three.js already keeps a
// sprite square to the camera every frame, including the roll the chase camera
// applies in a hard corner. The label is a CanvasTexture: a dark pill with
// white type and a black outline, so it survives both a blown-out midday sky
// and wet asphalt without a per-frame contrast test.
//
// Scale is screen-referred, not world-referred: the world height grows with
// distance so the tag holds roughly the same pixel size from 5 m to ~60 m,
// then stops growing (past that it visibly shrinks, which reads as "far") and
// fades out entirely by MAX_DIST. A fixed world height would either be a
// billboard in your face up close or an unreadable speck down the street.
//
// RANGE. 120 m was a walking-simulator number. This is a 134×43 km world with
// cars that do 180: at 120 m a friend's name survives about five seconds of
// following them down a straight, and the whole point of a name tag is
// knowing which of the dots ahead is a person. The default is now 400 m, the
// player can raise it to 2 km in the settings panel, and — the part that makes
// a long range worth anything — the screen-referred growth gets a SECOND,
// gentler slope past the knee. With one slope and a hard ceiling a 400 m tag
// is ~4 px tall, i.e. hidden with extra steps; the far slope keeps it around
// 12 px at 400 m and still legible as a marker at 2 km, while a nearby tag is
// untouched. Occlusion still does the real filtering: the sprite depth-tests,
// so a name 400 m away only shows when there is genuinely a line of sight.
//
// Import-time safety: nothing here touches the DOM until update() is first
// called with a real peer, so `node --check` and headless tests are free.

import * as THREE from 'three';

const DEF = {
  maxDist: 400,     // m — past this the tag is hidden outright
  fadeDist: 320,    // m — fade begins here and reaches zero at maxDist
  pxScale: 0.030,   // world metres of tag height per metre of camera distance
  minHeight: 0.10,  // m — floor, so a tag pressed against the lens stays sane
  maxHeight: 1.90,  // m — the knee: constant apparent size ends here (~63 m)
  farScale: 0.0105, // m of extra height per metre past the knee (see RANGE)
  headroom: 1.85,   // m above peer.y when the peer gives no explicit tagY
};

// The visible range the settings panel offers, in metres. Exported so
// settings.js and this module can never disagree about what "Daleko" means.
export const NAME_RANGES = [120, 400, 900, 2000];

// Never trust a name that came off the wire — netcity sanitizes on receive,
// but this module is the one that rasterises it, so it re-checks rather than
// assuming its only caller did. Same rule as AmongTheWoods. The class covers
// markup breakers AND everything that renders as nothing (U+200B, U+3164,
// U+2800 …) or reverses what follows (U+202E) — String.trim() knows none of
// those, so without it a peer can wear a blank or a text-reversing nameplate.
const STRIP = /[<>&"'`\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFC\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}]/gu;
// …and the backstop for every blank NOBODY has enumerated yet. Naming the
// characters one at a time is whack-a-mole: the first version of this list
// caught U+200B and U+3164 and still waved through U+034F (combining grapheme
// joiner), U+17B5 (Khmer inherent vowel), U+FE0F (variation selector) and the
// whole U+E00xx tag block — every one of them a perfectly empty nameplate,
// verified against the shipped function. So the rule is also stated
// positively: a nickname must contain at least one character that puts INK on
// the canvas — not whitespace, not a combining mark, not a format control, not
// a surrogate, not private-use, not unassigned. U+200D (ZWJ) and the variation
// selectors deliberately survive the strip above, so a family emoji stays one
// glyph and a thumbs-up keeps its colour; both are format/mark characters, so
// a name made of nothing but them is still refused right here.
const INK = /[^\s\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cs}\p{Cn}\p{Co}]/u;
function clean(s) {
  const n = String(s ?? '').replace(STRIP, '').trim().slice(0, 14).trim();
  return INK.test(n) ? n : '';
}
// Same function, exported, so every OTHER surface that renders a nickname —
// the co-op toasts, the map labels — filters it identically instead of growing
// a fourth copy of this regex that drifts from the other three.
export { clean as cleanName };

const FONT_PX = 72;
const PAD_X = 30, PAD_Y = 16;

function pill(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// One canvas per distinct nickname. Returns { tex, aspect } or null when there
// is no DOM to draw on (headless import, server-side test run).
function makeTagTexture(name) {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  const font = `bold ${FONT_PX}px Arial, Helvetica, sans-serif`;
  probe.font = font;
  const tw = Math.ceil(probe.measureText(name).width);

  const cv = document.createElement('canvas');
  cv.width = Math.max(64, tw + PAD_X * 2);
  cv.height = FONT_PX + PAD_Y * 2;
  const g = cv.getContext('2d');
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  // pill inset by 2 px so the 3 px stroke below is not clipped by the edge
  pill(g, 2, 2, cv.width - 4, cv.height - 4, (cv.height - 4) / 2);
  g.fillStyle = 'rgba(12,14,18,0.62)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.stroke();

  // outline first, then fill: the black rim is what keeps white type legible
  // where the pill happens to sit over a bright headlight or a white van
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(name, cv.width / 2, cv.height / 2 + 2);
  g.fillStyle = '#ffffff';
  g.fillText(name, cv.width / 2, cv.height / 2 + 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: cv.width / cv.height, refs: 0 };
}

export class NameTags {
  // scene: the THREE.Scene sprites are added to. opts overrides any DEF key.
  constructor(scene, opts = {}) {
    this.scene = scene || null;
    this.opt = { ...DEF, ...opts };
    this.enabled = true;
    this._tags = new Map();   // uid -> { sprite, mat, name, gen }
    this._tex = new Map();    // name -> { tex, aspect, refs }  (refcounted)
    this._gen = 0;
    this._camPos = new THREE.Vector3();
  }

  // Visible range in metres, straight from the settings panel. The fade band
  // is derived rather than configured — a caller that sets a range and forgets
  // the fade would otherwise get tags that pop out of existence, and the two
  // numbers only ever make sense together. Non-finite or tiny input is
  // ignored, so a corrupt localStorage value cannot blank every tag.
  setRange(maxDist) {
    const d = Number(maxDist);
    if (!Number.isFinite(d) || d < 20) return this.opt.maxDist;
    this.opt.maxDist = d;
    this.opt.fadeDist = d * 0.8;
    return d;
  }

  // peers: any iterable of peer records — a Map (values are used), Set or
  // Array. Each record is read for:
  //   uid   string, required — the tag identity
  //   name  string, falsy → the peer gets no tag (and loses one it had)
  //   x, z  world position of the tag column
  //   tagY  world Y of the tag centre; when absent, y + opt.headroom is used
  // camera: the render camera. Missing scene or camera makes this a no-op, so
  // the caller never needs a guard of its own.
  update(peers, camera) {
    if (!this.scene || !camera || !peers) return;
    const it = peers instanceof Map ? peers.values() : peers;
    if (!it || typeof it[Symbol.iterator] !== 'function') return;

    const o = this.opt;
    const gen = ++this._gen;
    camera.getWorldPosition(this._camPos);
    const cx = this._camPos.x, cy = this._camPos.y, cz = this._camPos.z;

    for (const p of it) {
      if (!p || !p.uid) continue;
      const name = this.enabled ? clean(p.name) : '';
      if (!name) { this.remove(p.uid); continue; }

      let t = this._tags.get(p.uid);
      if (!t || t.name !== name) {
        t = this._retag(p.uid, name);
        if (!t) continue;                     // no DOM — nothing to draw
      }
      t.gen = gen;

      const x = p.x ?? 0, z = p.z ?? 0;
      const y = Number.isFinite(p.tagY) ? p.tagY : (p.y ?? 0) + o.headroom;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist > o.maxDist) { t.sprite.visible = false; continue; }
      t.sprite.visible = true;
      t.sprite.position.set(x, y, z);

      // screen-referred height (see the RANGE note): constant apparent size up
      // to the knee, then a shallow slope so a far tag shrinks on screen
      // without vanishing. farScale = pxScale would be no shrink at all;
      // farScale = 0 is the old hard ceiling.
      let h = dist * o.pxScale;
      if (h < o.minHeight) h = o.minHeight;
      else if (h > o.maxHeight) {
        const knee = o.maxHeight / o.pxScale;              // m at which growth bends
        h = o.maxHeight + (dist - knee) * (o.farScale ?? 0);
      }
      t.sprite.scale.set(h * t.aspect, h, 1);

      t.mat.opacity = dist <= o.fadeDist
        ? 1 : 1 - (dist - o.fadeDist) / (o.maxDist - o.fadeDist);
    }

    // anyone absent from this call left the world — drop their tag. The owner
    // usually calls remove() on leave, but a reap/stream-out path that forgets
    // to would otherwise leak a sprite for the rest of the session.
    for (const [uid, t] of this._tags) if (t.gen !== gen) this.remove(uid);
  }

  // swap a uid onto a different nickname (or create its tag), releasing the
  // texture the old name held
  _retag(uid, name) {
    const e = this._acquire(name);
    if (!e) return null;
    let t = this._tags.get(uid);
    if (t) {
      this._release(t.name);
      t.mat.map = e.tex;
      t.mat.needsUpdate = true;
      t.name = name;
      t.aspect = e.aspect;
      return t;
    }
    const mat = new THREE.SpriteMaterial({
      map: e.tex,
      transparent: true,
      // depthTest ON is the reason this is a sprite and not a DOM overlay:
      // a wall between us and the player hides their name too. depthWrite OFF
      // so two overlapping tags blend instead of punching holes in each other.
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      // SpriteMaterial fogs by DEFAULT, and this tag must not. sky.js pulls the
      // haze in with the streamed radius: on the "Krátká dohlednost" preset at
      // night fog.near lands at ~42 m and fog.far at ~183 m, so a tag at 90 m —
      // where THIS module has only just started its own fade — was already 34 %
      // blended into the fog colour, and 55 % of it by maxDist. A distance
      // policy the module states in its own header was being overruled by the
      // weather; opacity above is the only fade a name gets.
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 12;   // late among transparents, over glass and FX
    sprite.frustumCulled = true;
    t = { sprite, mat, name, aspect: e.aspect, gen: this._gen };
    this._tags.set(uid, t);
    this.scene.add(sprite);
    return t;
  }

  _acquire(name) {
    let e = this._tex.get(name);
    if (!e) {
      e = makeTagTexture(name);
      if (!e) return null;
      this._tex.set(name, e);
    }
    e.refs++;
    return e;
  }

  _release(name) {
    const e = this._tex.get(name);
    if (!e) return;
    if (--e.refs <= 0) { e.tex.dispose(); this._tex.delete(name); }
  }

  // the peer went away: sprite out of the scene, material gone, and the
  // texture freed once the last player wearing that nickname is gone
  remove(uid) {
    const t = this._tags.get(uid);
    if (!t) return;
    this.scene?.remove(t.sprite);
    t.mat.dispose();
    this._tags.delete(uid);
    this._release(t.name);
  }

  dispose() {
    for (const uid of [...this._tags.keys()]) this.remove(uid);
    // belt and braces: any texture still held after every tag is gone was a
    // refcount that drifted, and it would outlive the session otherwise
    for (const e of this._tex.values()) e.tex.dispose();
    this._tex.clear();
    this._tags.clear();
    this.scene = null;
  }
}

export default NameTags;
