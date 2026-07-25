// ---- Clouds: a sky you can fly INTO, made of flat sprites ----
// A helicopter changes what the sky has to be. Painted clouds on the dome
// (sky.js's FBM layer) are fine while the camera lives at street level, but
// the moment you climb to 300 m you need cloud you can approach, pass beside
// and punch through — and a real raymarch would cost more than the whole city
// does. So: ~14 CLUSTERS of 6–8 camera-facing puffs each. One puff is a soft
// radial-gradient sprite; a cluster's puffs are scattered in all three axes
// with a flat base and a cauliflower top, so from any angle — beside it,
// under it, above it, inside it — the silhouette has depth instead of being
// one card that flips to a line when you circle it.
//
// WHY individual THREE.Sprites and not one InstancedMesh: these are soft,
// NORMAL-blended, depth-write-free quads that constantly overlap each other,
// and overlapping alpha is order-dependent. The renderer sorts transparent
// objects back-to-front every frame, which is exactly the sort we need and
// costs us nothing; an InstancedMesh would freeze the blend order into the
// instance buffer, and flying around a cluster would smear its grey underside
// over its sunlit top. ~100 extra draw calls is noise next to the ~450 the
// traffic already issues.
//
// WHY the field is infinite: the clusters live on a 3600 m torus. Every frame
// each cluster's offset from the camera is wrapped into ±1800 m, i.e. we draw
// the NEAREST copy of an infinitely tiled pattern. Wrapping is a symmetry of
// that pattern, so it can never produce a seam — and the wrap can never pop
// either, because a puff is already at exactly zero opacity long before it
// reaches the wrap boundary (see the proof above FADE_CAP).
//
//   const clouds = new Clouds(scene);
//   clouds.update(dt, camera, sunDir, nightK);   // sunDir + nightK from sky.js

import * as THREE from 'three';

// ---- field shape ----
const CLUSTERS = 14;             // drifting cloud bodies alive at once
const PUFFS = [6, 8];            // sprites per cluster (inclusive range)
const FIELD = 1800;              // half-width of the field: spread is ±1800 m
const PERIOD = FIELD * 2;        // the torus the clusters tile the sky with
const ALT = [260, 420];          // cluster altitude band, meters (contracted)
const SPREAD_H = 115;            // puff scatter around the cluster axis, meters
const SPREAD_V = 34;             // …and vertically: flat base, towering top
const PUFF_D = [155, 255];       // puff sprite diameter, meters
const WIND = { x: 2.7, z: 0.95 };// prevailing westerly, drifting east-southeast

// ---- look ----
// Linear working-space colours (Color(r,g,b) is linear here). The sprites are
// toneMapped like every other object in the scene, so >1 values are legal and
// merely land high on the ACES curve — but they stay under the postfx bloom
// threshold (1.0 AFTER tone mapping), because a blooming sky would wash the
// whole frame the way the overbright lamps are meant to.
const LIT = new THREE.Color(1.12, 1.10, 1.05);   // sun-facing cauliflower tops
const SHADE = new THREE.Color(0.42, 0.48, 0.60); // grey-blue undersides
const LIT_W = new THREE.Color(1.20, 0.78, 0.46); // golden hour: lit sides go amber
const SHADE_W = new THREE.Color(0.50, 0.42, 0.50);
const LIT_N = new THREE.Color(0.13, 0.16, 0.24); // night: barely-there moonlit grey
const SHADE_N = new THREE.Color(0.06, 0.07, 0.12);
const OPACITY = 0.58;            // master alpha; puffs jitter ±18 % around it

// ---- fades (the two reasons nothing ever pops) ----
// FAR: derived from camera.far so the field can never straddle the far plane.
// A sprite's four corners share their centre's view-space depth (three builds
// the quad in view space), so a sprite does not clip gradually — it would
// vanish WHOLE the instant its centre crossed camera.far. Hence the far fade
// must reach zero strictly inside it: 0.89·far, capped at FADE_CAP.
// FADE_CAP exists to keep the wrap invisible. At the wrap boundary a cluster
// centre sits |offset| = 1800 m away, and no puff is further than
// hypot(SPREAD_H, SPREAD_V) ≈ 120 m from its centre, so EVERY puff that wraps
// is at least 1680 m out — 180 m beyond the widest fade we will ever use.
// Its opacity is therefore exactly 0 on both sides of the jump: the recentre
// moves geometry that is not on screen, whatever the camera is doing.
const FADE_FAR_K = 0.89, FADE_CAP = 1500, FADE_IN_K = 0.62;
// NEAR: a puff you fly into would otherwise fill the screen with one flat
// smear and then blink out the instant the camera crossed its centre (a
// point sprite behind the eye is simply gone). Fading it over its own radius
// turns that blink into a whiteout that thins as you pass through the cloud.
// This IS camera-distance-driven, but it is a smoothstep of distance with no
// thresholds anywhere, so it cannot pop — the failure mode the contract bans
// is a discontinuity, not a dependence on distance.
const FADE_NEAR_K = 1.55;        // full opacity once d > 1.55 × puff radius

// deterministic sky: the same 14 clouds every session, so a screenshot taken
// today can be compared with one taken last week
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth01 = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

// ---- the one texture every sprite shares ----
// A plain airbrushed disc reads as a bubble, so the alpha is built from ~34
// overlapping soft blobs ADDED together (a lumpy interior) and then multiplied
// by a radial mask, which guarantees the puff always ends in air no matter how
// the lumps fell. RGB stays pure white: all colour comes from per-puff
// material.color, which is what lets one texture light 100 sprites differently.
function makePuffTexture() {
  // headless (node --test with a three shim) has no DOM: fall back to the same
  // profile evaluated into a small DataTexture so the module stays importable
  if (typeof document === 'undefined') return makePuffTextureHeadless();
  const S = 256, R = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(0x5EED17);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 34; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.40;
    const px = R + Math.cos(a) * rr, py = R + Math.sin(a) * rr;
    const br = R * (0.16 + rnd() * 0.24);
    const g = ctx.createRadialGradient(px, py, 0, px, py, br);
    g.addColorStop(0, 'rgba(255,255,255,0.24)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - br, py - br, br * 2, br * 2);
  }
  ctx.globalCompositeOperation = 'destination-in';
  const m = ctx.createRadialGradient(R, R, 0, R, R, R);
  m.addColorStop(0.00, 'rgba(255,255,255,1)');
  m.addColorStop(0.34, 'rgba(255,255,255,0.98)');
  m.addColorStop(0.62, 'rgba(255,255,255,0.62)');
  m.addColorStop(0.85, 'rgba(255,255,255,0.16)');
  m.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter; // puffs shrink to specks at 1.2 km
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makePuffTextureHeadless() {
  const S = 32, R = S / 2, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
    const a = u >= 1 ? 0 : Math.pow(1 - u, 1.6);
    const i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(a * 255);
  }
  const tex = new THREE.DataTexture(data, S, S);
  tex.needsUpdate = true;
  return tex;
}

// scratch — the update loop must not allocate, it runs on every sub-step
const _lit = new THREE.Color(), _shade = new THREE.Color();

export class Clouds {
  constructor(scene) {
    this.scene = scene;
    this.tex = makePuffTexture();
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false; // stays at the origin; sprites carry world pos
    this.clusters = [];
    this.puffCount = 0;
    const rnd = mulberry32(0xC10D5);

    // Stratified placement: 16 cells of a 4×4 grid over the torus, shuffled,
    // 14 taken. Pure random over 3.6 km would regularly leave a whole quadrant
    // of sky empty and pile four clusters into one corner — with only 14 bodies
    // covering the horizon, that reads as a bug rather than as weather.
    const cells = [];
    for (let i = 0; i < 16; i++) cells.push(i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const cell = PERIOD / 4;
    for (let c = 0; c < CLUSTERS; c++) {
      const gx = cells[c] % 4, gz = (cells[c] / 4) | 0;
      const cl = {
        // absolute world position; wind moves it, the wrap only affects drawing
        x: -FIELD + (gx + 0.5) * cell + (rnd() - 0.5) * cell * 0.84,
        z: -FIELD + (gz + 0.5) * cell + (rnd() - 0.5) * cell * 0.84,
        y: ALT[0] + rnd() * (ALT[1] - ALT[0]),
        puffs: [],
      };
      const n = PUFFS[0] + ((rnd() * (PUFFS[1] - PUFFS[0] + 1)) | 0);
      const base = Math.ceil(n * 0.55); // majority sit on the flat cumulus base
      for (let p = 0; p < n; p++) {
        const onBase = p < base;
        const a = rnd() * Math.PI * 2;
        // base puffs spread wide and hang a little below the axis; the tower
        // puffs stack above and pull in — a cauliflower over a flat bottom
        const rr = Math.sqrt(rnd()) * SPREAD_H * (onBase ? 1 : 0.6);
        const oy = onBase ? SPREAD_V * (-0.30 + rnd() * 0.35)
          : SPREAD_V * (0.15 + rnd() * 0.85);
        const ox = Math.cos(a) * rr, oz = Math.sin(a) * rr;
        // higher puffs are smaller: the towers are the youngest parcels
        const d = (PUFF_D[0] + rnd() * (PUFF_D[1] - PUFF_D[0]))
          * (1 - 0.22 * (oy / SPREAD_V));
        // Shading normal ≠ position offset. A cumulus is far wider than it is
        // tall, so the true offsets are nearly horizontal and dot(sun, offset)
        // would grade almost nothing top-to-bottom. Stretching the normal's y
        // by 3.2 restores the reading everyone expects — bright crown, grey
        // belly — without deforming the actual volume.
        const ny = oy * 3.2;
        const nl = Math.sqrt(ox * ox + ny * ny + oz * oz) || 1;
        const mat = new THREE.SpriteMaterial({
          map: this.tex,
          transparent: true,
          depthWrite: false,   // puffs must not carve each other out of the depth buffer
          depthTest: true,     // …but the CITY still occludes them, as it must
          fog: false,          // they live above the fog wall; fogging them greys the sky out
          sizeAttenuation: true,
          rotation: rnd() * Math.PI * 2, // one texture, 100 different-looking blobs
          opacity: 0,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(d, d, 1);
        sprite.renderOrder = -900;  // behind every other transparent thing (glass, rotor disc)
        sprite.visible = false;
        this.group.add(sprite);
        cl.puffs.push({
          sprite, mat, ox, oy, oz, r: d * 0.5,
          nx: ox / nl, ny: ny / nl, nz: oz / nl,   // unit shading normal
          a: 0.82 + rnd() * 0.18,                  // per-puff opacity jitter
        });
        this.puffCount++;
      }
      this.clusters.push(cl);
    }
    scene.add(this.group);
  }

  // dt seconds; camera drives the recentre; sunDir/nightK come straight from
  // sky.js (sky.sunDir, sky.nightK) so the clouds are lit by the same sun that
  // lights the streets. Safe to call several times per rendered frame — the
  // integrator sub-steps the sim — since everything but the drift is recomputed
  // from scratch rather than accumulated.
  update(dt, camera, sunDir, nightK = 0) {
    if (!camera) return;
    const nk = clamp01(nightK);

    // ---- wind: absolute drift, so the wrap stays pure modular arithmetic ----
    for (const cl of this.clusters) { cl.x += WIND.x * dt; cl.z += WIND.z * dt; }

    // ---- this frame's two palette ends, computed ONCE for the whole field ----
    const sx = sunDir?.x ?? 0.40, sy = sunDir?.y ?? 0.85, sz = sunDir?.z ?? 0.35;
    // Key direction = the sun nudged upward. With the sun on the horizon a
    // pure sun vector would light the sides and leave tops and bottoms
    // identical; real clouds keep a bright crown from the whole sky bowl. The
    // vertical term is floored at 0 for the same reason: once the sun is UNDER
    // the horizon its raw −y would light the bellies and shade the crowns, an
    // inversion nothing in the sky ever does (what light is left after dark
    // still arrives from above).
    let kx = sx, ky = Math.max(sy, 0) + 0.40, kz = sz;
    const kl = Math.sqrt(kx * kx + ky * ky + kz * kz) || 1;
    kx /= kl; ky /= kl; kz /= kl;
    // golden hour: sun low but not yet under (sy = sin of elevation)
    const warm = clamp01((0.30 - sy) / 0.30) * clamp01((sy + 0.10) / 0.14);
    _lit.copy(LIT).lerp(LIT_W, warm).lerp(LIT_N, nk);
    _shade.copy(SHADE).lerp(SHADE_W, warm).lerp(SHADE_N, nk);
    const lr = _lit.r, lg = _lit.g, lb = _lit.b;
    const sr = _shade.r, sg = _shade.g, sb = _shade.b;
    const master = OPACITY * (1 - 0.18 * nk); // night thins them so the moon reads

    // ---- fade band, re-derived each frame in case camera.far ever changes ----
    const farOut = Math.min((camera.far || 1400) * FADE_FAR_K, FADE_CAP);
    const farIn = farOut * FADE_IN_K;
    const invFar = 1 / Math.max(1, farOut - farIn);

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const cl of this.clusters) {
      // THE RECENTRE. Stateless modular wrap into [−FIELD, +FIELD]: the cluster
      // is drawn at whichever of its infinitely many tiled copies is nearest.
      // Doing it as arithmetic rather than as an incremental "if it fell behind,
      // add a field width" means it is also correct after a teleport (respawn,
      // a save load, the helicopter crossing a tile boundary at 62 m/s) — there
      // is no accumulated state to get out of step with the camera.
      let dx = cl.x - cx, dz = cl.z - cz;
      dx -= PERIOD * Math.round(dx / PERIOD);
      dz -= PERIOD * Math.round(dz / PERIOD);
      const dy = cl.y - cy;   // altitude never wraps: you can climb above the deck
      for (const p of cl.puffs) {
        const px = dx + p.ox, py = dy + p.oy, pz = dz + p.oz;
        const d = Math.sqrt(px * px + py * py + pz * pz);
        // far fade → 0 well inside camera.far and far inside the wrap boundary
        const fFar = 1 - smooth01((d - farIn) * invFar);
        // near fade → 0 at the puff's own centre, so flying through whitens
        // the view and thins out instead of blinking
        const fNear = smooth01(d / (p.r * FADE_NEAR_K));
        const alpha = master * p.a * fFar * fNear;
        // Below 1/255 the framebuffer cannot represent the sprite at all, so
        // dropping it there saves the draw call without being a visible cut —
        // this is the ONE hard threshold in the module, and it sits under the
        // hardware's own quantisation floor.
        if (alpha <= 0.004) { p.sprite.visible = false; continue; }
        p.sprite.visible = true;
        p.mat.opacity = alpha;
        p.sprite.position.set(cx + px, cy + py, cz + pz);
        // sun-facing side bright, underside grey-blue — one dot product
        const k = smooth01(0.5 + 0.62 * (kx * p.nx + ky * p.ny + kz * p.nz));
        p.mat.color.setRGB(sr + (lr - sr) * k, sg + (lg - sg) * k, sb + (lb - sb) * k);
      }
    }
  }
}
