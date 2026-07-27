// ---- WorldMap: the whole region on one screen (M) ----
// The HUD minimap answers "what is around the next corner"; this answers
// "where in the region am I, and where am I heading". It is a REGION map: the
// world is ~45 km across and STREAMS IN as tiles, so nothing here may assume a
// fixed extent — the bounds are recomputed from the LIVE city arrays on every
// offscreen render, exactly the way Minimap._bounds does it, and the very same
// per-feature bbox cache (`_mmbb`) is shared with the minimap, so whichever
// module scans a feature first is the only one that pays for it.
//
// The one decision that makes a 45 km map affordable: geometry is NEVER drawn
// per frame. An offscreen bitmap holds the rasterized region around the current
// view; a frame is ONE drawImage of a window of that bitmap plus the labels and
// markers — those are drawn per frame in screen space precisely so they stay
// crisp at any zoom, while the vector work never repeats. The bitmap is
// re-rendered only when something invalidates it (the map opening, a tile
// landing, the view leaving the padded window, a zoom step that needs more
// resolution than the bitmap holds) and always debounced, never from _draw().
//
// Frame convention (ARCHITECTURE.md): x east, z SOUTH, y up. Because +z is
// south, world z maps STRAIGHT onto canvas y and north is up for free — the
// same freebie minimap.js enjoys. heading 0 = −z = north = screen up, so the
// player arrow rotates by −heading (check: heading +π/2 → dir (−sin, −cos) =
// (−1, 0) = west → canvas rotate(−π/2) swings the arrow screen-left ✓).
//
// All DOM and CSS are injected from here: index.html and css/style.css stay
// untouched, the same rule settings.js follows. The overlay carries the class
// `panel` on purpose — input.js ignores wheel/mousedown whose target sits
// inside a `.panel`, so panning and zooming the map never also spins the game
// camera underneath.

import { COLORS } from './config.js';

const PLACES_URL = 'data/places.json';
const OVERVIEW_URL = 'data/overview.json';
const TAU = Math.PI * 2;

const ZOOM_MIN = 1, ZOOM_MAX = 12;
// Bitmap budget. 4096 px is the safe texture-ish ceiling for a 2D canvas on
// weak GPUs; the pixel cap is the memory one (9 Mpx ≈ 36 MB of backing store).
const OFF_MAX_SIDE = 4096;
const OFF_MAX_PX = 9.0e6;
const OFF_PAD = 1.5;         // bitmap covers this much more world than the view
const OFF_MARGIN = 300;      // m of blank kept past the region edge in the bitmap
const RENDER_MS = 150;       // debounce after the last pan/zoom before redrawing
const TILE_MS = 1000;        // debounce for a burst of streamed tiles (contract)
const MIN_SPAN = 3000;       // m — a world this small still gets a sane zoom-1
const ASPECT_MIN = 0.5, ASPECT_MAX = 2.0; // the canvas never gets sillier than this
const MAX_LABELS = 400;      // collision boxes kept per frame (preallocated)
const FOOT_S = 0.22;         // px/m below which footpaths are noise, not map

// Per-rank presentation, indexed by the `r` field of places.json (0 city …
// 5 isolated dwelling). The zoom gates are the contract's: 0-1 always, 2 from
// 2×, 3-4 from 4×, 5 from 8× — which is what keeps 212 villages from turning
// the region overview into a wall of text.
const RANK_ZOOM = [0, 0, 2, 4, 4, 8];
const RANK_FONT = [16, 13.5, 12, 11, 11, 10];   // CSS px, scaled by DPR
const RANK_DOT = [4.4, 3.4, 2.6, 2.2, 2.0, 1.7]; // CSS px radius, ditto
const RANK_BOLD = [1, 1, 0, 0, 0, 0];

// Road classes: nominal width in metres (the data's own `w` varies per way and
// is invisible at map scale, so one number per class lets every road of a class
// share a single stroke), a floor in bitmap px so a motorway never vanishes,
// and the minimap's brightness lift — dark asphalt on a dark map reads as
// nothing, so drivable classes get pushed up the same way there. `foot: true`
// means "only once we are zoomed in enough for pavements to mean something".
const ROAD_STYLE = {
  motorway: { w: 22, min: 2.4, k: 1.55 }, trunk: { w: 18, min: 2.2, k: 1.55 },
  primary: { w: 14, min: 2.0, k: 1.55 }, secondary: { w: 11, min: 1.7, k: 1.55 },
  tertiary: { w: 9, min: 1.4, k: 1.55 }, unclassified: { w: 7, min: 1.1, k: 1.5 },
  residential: { w: 7, min: 1.1, k: 1.5 }, living_street: { w: 6, min: 0.9, k: 1.4 },
  service: { w: 4.5, min: 0.7, k: 1.3 },
  pedestrian: { w: 4, min: 0.6, k: 1.0, foot: true },
  track: { w: 3, min: 0.5, k: 0.95, foot: true },
  cycleway: { w: 2.5, min: 0.5, k: 0.95, foot: true },
  footway: { w: 2, min: 0.45, k: 0.95, foot: true },
  path: { w: 2, min: 0.45, k: 0.95, foot: true },
  steps: { w: 2, min: 0.45, k: 0.95, foot: true },
};
// DRAW order — quiet ways first so a motorway always crosses on top, mirroring
// the 3D layering. Anything the data throws at us that is not in this list is
// bucketed as `residential` (the same fallback minimap.js uses).
const ROAD_ORDER = ['steps', 'path', 'footway', 'cycleway', 'track', 'pedestrian',
  'service', 'living_street', 'residential', 'unclassified', 'tertiary',
  'secondary', 'primary', 'trunk', 'motorway'];

const DASH = [7, 7];         // the waypoint thread — allocated once, never per frame
// The flag yellow, shared verbatim with minimap.js: the HUD map and this one
// paint the SAME waypoint, so a glance at either surface must read as one flag.
// Deliberately not from COLORS — that palette describes the world (asphalt,
// water, plaster) and chrome must never blend into it.
const WP_COLOR = '#ffd21a';
// Batched paths are the whole trick behind a fast region render, but ONE path
// holding 163 000 building footprints is a rasterizer's worst case, so every
// batch is flushed after this many shapes. Still ~10 draw calls instead of
// ~200 000, and no single path the GPU has to think twice about.
const FLUSH_N = 12000;

// 0xrrggbb → '#rrggbb' with a brightness factor. Copied from minimap.js rather
// than exported from it so the two files stay independent, but the numbers are
// identical on purpose: the HUD map and the world map must read as ONE map.
function css(c, k = 1) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const MAP_BG = css(COLORS.groundBase, 0.92);   // the minimap's own base colour
const VOID_BG = css(COLORS.groundBase, 0.38);  // past the loaded region: dead ground
const BLD_FILL = '#c6c2b8';                    // minimap's building grey
const BLD_WASH = 'rgba(198,194,184,0.72)';     // …as a tint when a house is 1 px

// data/overview.json is the whole world at map fidelity: motorway→secondary
// roads, main railway lines, big water, big forests, and built-up area as runs
// of 200 m cells (scripts/build-region.mjs writes it). It exists because the map
// draws the LIVE city arrays, and over a 110 km world that means Prague is not
// on the map until you have personally driven there — open it in Pardubice and
// two thirds of the country is blank olive. Three megabytes buys a permanent
// base layer that live detail then paints over. Same graceful-failure contract
// as places: no file, no base layer, map still works.
let _ovP = null;
function loadOverview() {
  if (!_ovP) {
    _ovP = fetch(OVERVIEW_URL)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(d => ({
        roads: d?.roads ?? [], rails: d?.rails ?? [],
        water: d?.water ?? [], green: d?.green ?? [], urban: d?.urban ?? [],
      }))
      .catch(err => {
        console.warn('[worldmap] overview.json unavailable, map shows only streamed data:', err.message);
        return null;
      });
  }
  return _ovP;
}

// places.json is fetched ONCE per page load and shared by every WorldMap ever
// built. A failure is not fatal: the promise resolves to an empty list and the
// map simply has no labels (contract: degrade gracefully).
let _placesP = null;
function loadPlaces() {
  if (!_placesP) {
    _placesP = fetch(PLACES_URL)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(d => {
        const list = (d?.places ?? []).filter(p => p && Array.isArray(p.p));
        // the file ships sorted by rank; sorting again is one cheap pass that
        // makes the draw loop's "big names first" guarantee independent of it
        list.sort((a, b) => (a.r | 0) - (b.r | 0));
        return list;
      })
      .catch(err => {
        console.warn('[worldmap] places.json unavailable, map runs without labels:', err.message);
        return [];
      });
  }
  return _placesP;
}

const CSS_TEXT = `
#atc-map {
  position: fixed; inset: 0; z-index: 36; display: none;
  align-items: center; justify-content: center;
  background: rgba(7,10,16,0.78); color: #e8ecf4;
  font-family: 'Trebuchet MS','Segoe UI',sans-serif; user-select: none;
}
#atc-map.atc-open { display: flex; }
.atc-map-frame {
  display: flex; flex-direction: column; max-width: 97vw; max-height: 97vh;
  background: linear-gradient(#1b2230, #131926);
  border: 2px solid #3d4f74; border-radius: 16px; overflow: hidden;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6);
}
.atc-map-head {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.12);
}
.atc-map-head h2 { margin: 0; font-size: 17px; letter-spacing: 2px; }
.atc-map-stat { margin-left: auto; font-size: 13px; opacity: 0.72; white-space: nowrap; }
.atc-map-close {
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 15px;
  background: none; border: 1px solid rgba(255,255,255,0.3); color: inherit;
}
.atc-map-close:hover { background: rgba(255,255,255,0.1); }
.atc-map-body { padding: 12px 12px 4px; display: flex; justify-content: center; }
#atc-map canvas {
  display: block; border-radius: 10px; touch-action: none; cursor: grab;
  border: 1px solid rgba(255,255,255,0.15); background: ${VOID_BG};
}
#atc-map canvas.atc-drag { cursor: grabbing; }
.atc-map-foot {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  padding: 9px 16px 12px; font-size: 12.5px;
}
.atc-map-key { display: flex; align-items: center; gap: 6px; opacity: 0.85; }
.atc-map-sw { width: 15px; height: 9px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.45); }
.atc-map-hint { margin-left: auto; opacity: 0.62; }
.atc-map-hint b { color: #cfe0ff; font-weight: bold; }
@media (max-width: 720px) { .atc-map-hint { margin-left: 0; } }
`;

export class WorldMap {
  // `city` is the live object from geo.loadCity — its arrays GROW as tiles
  // stream, and we hold the reference forever, re-reading it at every render.
  // `minimap` is optional and only used to hand the waypoint over to the HUD
  // map, so both maps show the same flag without main.js having to plumb it.
  constructor(city, minimap = null) {
    this.city = city;
    this.minimap = minimap;
    this.waypoint = null;         // {x,z} | null — main.js drives the HUD arrow
    this.places = [];             // filled asynchronously; [] = no labels, fine
    this.ov = null;               // …and the world base layer; null = streamed only

    // ---- view state (world metres) ----
    this.zoom = 1;
    this.cx = 0; this.cz = 0;     // view centre
    this.k0 = 1;                  // canvas px per metre at zoom 1 (whole region)
    this.rx0 = -2400; this.rz0 = -2400; this.rx1 = 2400; this.rz1 = 2400;

    // ---- offscreen bitmap state ----
    this.off = document.createElement('canvas');
    this.offg = this.off.getContext('2d', { alpha: false });
    this.bs = 0;                  // bitmap px per metre (0 = nothing rendered yet)
    this.bx = 0; this.bz = 0;     // world position of the bitmap's top-left px

    this._open = false;
    this._justOpened = false;
    this._rt = 0;                 // pending debounced render timer
    this._dpr = 1;
    this._fonts = RANK_FONT.map(() => '');
    // Collision boxes for the current frame, flat and preallocated: labels are
    // the one per-frame loop that could allocate, and a Float64Array of
    // [x0,y0,x1,y1]×N costs nothing after construction.
    this._boxes = new Float64Array(MAX_LABELS * 4);
    this._buckets = new Map();    // reused across renders: key → feature array
    this._zr = -1; this._dr = -1; // last status numbers (strings only on change)

    this._buildDom();
    loadPlaces().then(list => { this.places = list; });
    // 3 MB lands well after the first frames; if the map is already open when
    // it does, redraw so the world appears instead of waiting for a pan
    loadOverview().then(ov => { this.ov = ov; if (this._open) this._schedule(TILE_MS); });

    // A tile landing invalidates the bitmap: while the map is open we redraw
    // debounced 1 s, so a burst of neighbouring tiles costs ONE render. While
    // it is closed there is nothing to do — every open renders from scratch.
    city.onTileLoaded?.(() => { if (this._open) this._schedule(TILE_MS); });
    // …and a tile going slim (its buildings evicted 9 km back) leaves the
    // bitmap showing footprints the arrays no longer hold. Same debounce.
    city.onTileUnloaded?.(() => { if (this._open) this._schedule(TILE_MS); });
  }

  get open() { return this._open; }

  // Open/close. `force` lets main.js close it from elsewhere without guessing
  // the current state. Returns the NEW state so a caller can drive a HUD flag.
  toggle(force) {
    const want = force === undefined ? !this._open : !!force;
    if (want === this._open) return this._open;
    this._open = want;
    if (want) {
      this.root.classList.add('atc-open');
      // The map needs a real cursor. With mouseLook on, main.js keeps the
      // pointer locked and the cursor invisible, so release it — and raise the
      // cross-module "a modal owns the mouse" flag settings.js established so
      // main does not immediately grab it back on the next click.
      document.exitPointerLock?.();
      document.body.dataset.panelOpen = '1';
      this._justOpened = true;
      this._computeBounds();
      this._layout();
      // Render AFTER the browser has painted the panel: the first region
      // render is the expensive one (every road in the loaded world), and
      // doing it inside the keydown handler would look like a freeze. One
      // frame of delay is enough for the empty panel to appear first.
      this._schedule(16);
    } else {
      this.root.classList.remove('atc-open');
      delete document.body.dataset.panelOpen;
      clearTimeout(this._rt); this._rt = 0;
    }
    return this._open;
  }

  // Per-frame while open. Player.pos mirrors whatever the player is riding in
  // (player.js copies the car's / helicopter's x, z and heading while inCar),
  // so the arrow only ever needs the player — `car` is taken as an override
  // because main updates it after the player in the same frame, and `heli` is
  // here for the machine's own icon whether it is parked or being flown.
  update(player, car, heli) {
    if (!this._open) return;
    if (car) { this._px = car.x; this._pz = car.z; this._ph = car.heading; }
    else if (player) {
      this._px = player.pos.x; this._pz = player.pos.z; this._ph = player.heading;
    }
    this._hx = heli ? heli.x : null;
    this._hz = heli ? heli.z : null;
    this._heliMine = !!(heli && player && player.inCar === heli);
    if (this._justOpened) {
      this._justOpened = false;
      // Opening keeps the view you left behind — unless you have driven off
      // it, in which case dropping you somewhere else on the region would be
      // baffling. Then (and on the very first open) centre on the player.
      if (this._px !== undefined && !this._inView(this._px, this._pz)) this._centerOnPlayer();
    }
    this._draw();
  }

  // ---------------------------------------------------------------- DOM ----

  _buildDom() {
    document.head.appendChild(document.createElement('style')).textContent = CSS_TEXT;
    const root = document.createElement('div');
    root.id = 'atc-map';
    // `panel` is not cosmetic: input.js skips wheel and mousedown events whose
    // target sits inside a .panel, which is what stops a map drag from also
    // steering the camera. Our own stopPropagation covers pointer events.
    root.className = 'panel';
    root.innerHTML = `
      <div class="atc-map-frame">
        <div class="atc-map-head">
          <h2>MAPA REGIONU</h2>
          <span class="atc-map-stat"></span>
          <button class="atc-map-close" title="Zavřít (Esc)">✕</button>
        </div>
        <div class="atc-map-body"><canvas></canvas></div>
        <div class="atc-map-foot">
          ${this._key(css(COLORS.water, 0.85), 'Voda')}
          ${this._key(css(COLORS.green.wood, 0.9), 'Les a zeleň')}
          ${this._key(css(COLORS.road.primary, 1.55), 'Silnice')}
          ${this._key(css(COLORS.rail, 1.6), 'Železnice')}
          ${this._key(BLD_FILL, 'Zástavba')}
          <span class="atc-map-hint"><b>táhni</b> posun · <b>kolečko</b> přiblížení ·
            <b>klik</b> cíl cesty · <b>pravý klik</b> zrušit ·
            <b>dvojklik</b> na hráče · <b>M</b>/<b>Esc</b> zavřít</span>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.frame = root.querySelector('.atc-map-frame');
    this.stat = root.querySelector('.atc-map-stat');
    this.cv = root.querySelector('canvas');
    this.g = this.cv.getContext('2d', { alpha: false });
    root.querySelector('.atc-map-close').addEventListener('click', () => this.toggle(false));

    const cv = this.cv;
    cv.addEventListener('pointerdown', e => this._onDown(e));
    cv.addEventListener('pointermove', e => this._onMove(e));
    cv.addEventListener('pointerup', e => this._onUp(e));
    cv.addEventListener('pointercancel', () => this._endDrag());
    cv.addEventListener('dblclick', e => this._onDbl(e));
    cv.addEventListener('contextmenu', e => e.preventDefault());
    // passive:false — we must preventDefault or the page (and the game camera)
    // scrolls with us; stopPropagation keeps input.js out of it entirely.
    cv.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    // Escape (and M, which main.js binds to toggle) are swallowed in the
    // CAPTURE phase exactly like settings.js does it: input.js listens on
    // window in the bubble phase, so stopping propagation here means the game
    // never sees the press that dismissed the map — and M cannot double-toggle.
    window.addEventListener('keydown', e => {
      if (!this._open) return;
      if (e.code !== 'Escape' && e.code !== 'KeyM') return;
      e.stopPropagation();
      this.toggle(false);
    }, true);
    window.addEventListener('resize', () => {
      if (!this._open) return;
      this._layout();
      this._schedule(RENDER_MS);
    });
  }

  _key(color, text) {
    return `<span class="atc-map-key"><i class="atc-map-sw" style="background:${color}"></i>`
      + `${text}</span>`;
  }

  // Canvas size: ~92 % of the viewport (minus the head/foot chrome) fitted to
  // the region's own aspect, so at zoom 1 the region fills the canvas instead
  // of floating in letterbox. The aspect is clamped because at boot only the
  // spawn tile exists — a 5 km × 900 m sliver of loaded world would otherwise
  // produce a letterbox-slot canvas that looks broken.
  _layout() {
    const rw = this.rx1 - this.rx0, rh = this.rz1 - this.rz0;
    const asp = clamp(rw / rh, ASPECT_MIN, ASPECT_MAX);
    const availW = Math.max(240, window.innerWidth * 0.92 - 28);
    const availH = Math.max(200, window.innerHeight * 0.92 - 148); // head + foot + padding
    const w = Math.min(availW, availH * asp), h = w / asp;
    // The frame would otherwise be as wide as its widest child — the legend
    // row — which leaves a tall narrow region floating in dead panel. Drive
    // the frame from the canvas instead, with a floor so the Czech hint line
    // still has somewhere to wrap to.
    this.frame.style.width = Math.round(Math.min(window.innerWidth * 0.96,
      Math.max(w + 24, 540))) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    const cv = this.cv;
    cv.style.width = Math.round(w) + 'px';
    cv.style.height = Math.round(h) + 'px';
    if (cv.width !== cw) cv.width = cw;      // assigning clears — only when needed
    if (cv.height !== ch) cv.height = ch;
    if (dpr !== this._dpr) {
      this._dpr = dpr;
      for (let r = 0; r < RANK_FONT.length; r++)
        this._fonts[r] = (RANK_BOLD[r] ? 'bold ' : '') +
          (RANK_FONT[r] * dpr).toFixed(1) + 'px system-ui, sans-serif';
      for (const p of this.places) p._wmF = '';  // measured widths are dpr-bound
    }
    // zoom 1 = the whole region inside the canvas
    this.k0 = Math.min(cv.width / rw, cv.height / rh);
    this._clampView();
  }

  // ------------------------------------------------------------- bounds ----

  // Square-free version of Minimap._bounds: scan every feature loaded SO FAR
  // (roads reach furthest, water and green fill in the countryside) and keep
  // the real rectangle, because a region 45 km wide is not a circle-shaped
  // island. The per-feature bbox is the SAME `_mmbb` cache the minimap fills,
  // so this is O(features) with four array reads each after the first pass.
  _computeBounds() {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const scan = (list, key) => {
      for (const f of list ?? []) {
        const bb = this._bb(f, f[key]);
        if (!bb) continue;
        if (bb[0] < minX) minX = bb[0];
        if (bb[1] < minZ) minZ = bb[1];
        if (bb[2] > maxX) maxX = bb[2];
        if (bb[3] > maxZ) maxZ = bb[3];
      }
    };
    scan(this.city.roads, 'p');
    scan(this.city.water, 'o');
    scan(this.city.green, 'o');
    // The loaded arrays only cover the tiles streamed so far, so fitting to
    // them alone showed Pardubice and hid the other 400 settlements — the map
    // is meant to answer "where is Sezemice from here", which it cannot do if
    // Sezemice is off the edge. The MANIFEST knows the whole region up front,
    // so take the bounds from there and let the geometry fill in as it loads.
    const mt = this.city.manifestTiles ?? this.city.tiles;
    const T = this.city.tile;
    if (T && Array.isArray(mt) && mt.length) {
      for (const t of mt) {
        if (t.tx * T < minX) minX = t.tx * T;
        if (t.tz * T < minZ) minZ = t.tz * T;
        if ((t.tx + 1) * T > maxX) maxX = (t.tx + 1) * T;
        if ((t.tz + 1) * T > maxZ) maxZ = (t.tz + 1) * T;
      }
    }
    // …and never crop out a named place either: a label the player can see
    // must be somewhere they can pan to.
    for (const p of this.places ?? []) {
      if (p.p[0] < minX) minX = p.p[0];
      if (p.p[1] < minZ) minZ = p.p[1];
      if (p.p[0] > maxX) maxX = p.p[0];
      if (p.p[1] > maxZ) maxZ = p.p[1];
    }
    if (maxX < minX) { minX = minZ = -2400; maxX = maxZ = 2400; } // nothing loaded yet
    // pad, then enforce a floor on both spans: with one tile loaded the world
    // is a few km across and an unpadded fit would zoom in absurdly far
    const pad = Math.max(300, (maxX - minX + maxZ - minZ) * 0.02);
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
    if (maxX - minX < MIN_SPAN) {
      const c = (minX + maxX) / 2; minX = c - MIN_SPAN / 2; maxX = c + MIN_SPAN / 2;
    }
    if (maxZ - minZ < MIN_SPAN) {
      const c = (minZ + maxZ) / 2; minZ = c - MIN_SPAN / 2; maxZ = c + MIN_SPAN / 2;
    }
    this.rx0 = minX; this.rz0 = minZ; this.rx1 = maxX; this.rz1 = maxZ;
  }

  // Feature bbox as [minX, minZ, maxX, maxZ], memoised on the feature under
  // the same key minimap.js uses. Shared deliberately: the two maps ask the
  // same question about the same objects, so only one of them should pay.
  _bb(f, pts) {
    let bb = f._mmbb;
    if (!bb) {
      if (!pts || !pts.length) return null;
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
      for (const [x, z] of pts) {
        if (x < a) a = x; if (x > c) c = x;
        if (z < b) b = z; if (z > d) d = z;
      }
      bb = f._mmbb = [a, b, c, d];
    }
    return bb;
  }

  // --------------------------------------------------------- view maths ----

  // Clamp the view centre so the map can never be dragged into empty space.
  // Per axis: if the view is WIDER than the region there is nothing to pan —
  // pin it to the region centre; otherwise keep the view rectangle inside.
  _clampView() {
    const cv = this.cv, k = this.k0 * this.zoom;
    if (!cv.width || !k) return;
    const vw = cv.width / k, vh = cv.height / k;
    const rw = this.rx1 - this.rx0, rh = this.rz1 - this.rz0;
    this.cx = vw >= rw ? (this.rx0 + this.rx1) / 2
      : clamp(this.cx, this.rx0 + vw / 2, this.rx1 - vw / 2);
    this.cz = vh >= rh ? (this.rz0 + this.rz1) / 2
      : clamp(this.cz, this.rz0 + vh / 2, this.rz1 - vh / 2);
  }

  _inView(x, z) {
    const cv = this.cv, k = this.k0 * this.zoom;
    if (!cv.width || !k) return false;
    const vw = cv.width / k / 2, vh = cv.height / k / 2;
    return Math.abs(x - this.cx) < vw && Math.abs(z - this.cz) < vh;
  }

  _centerOnPlayer() {
    if (this._px === undefined) return;
    this.cx = this._px; this.cz = this._pz;
    this._clampView();
    this._schedule(RENDER_MS);
  }

  // Canvas DEVICE pixels for a mouse event (the CSS box and the backing store
  // differ by the DPR, and by whatever the max-width rules did to the frame).
  _evX(e) {
    const r = this.cv.getBoundingClientRect();
    return (e.clientX - r.left) * (this.cv.width / Math.max(1, r.width));
  }
  _evY(e) {
    const r = this.cv.getBoundingClientRect();
    return (e.clientY - r.top) * (this.cv.height / Math.max(1, r.height));
  }

  // ------------------------------------------------------------- input ----

  _onDown(e) {
    e.stopPropagation();
    if (e.button === 2) { this._setWaypoint(null); return; }   // right = zrušit cíl
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.cv.getBoundingClientRect();
    this._pxPerCss = this.cv.width / Math.max(1, r.width);
    this._dragX = e.clientX; this._dragY = e.clientY;
    this._dragMoved = 0;
    this._dragging = true;
    this.cv.setPointerCapture?.(e.pointerId);
    this.cv.classList.add('atc-drag');
  }

  _onMove(e) {
    if (!this._dragging) return;
    const k = this.k0 * this.zoom;
    if (!k) return;
    const dx = (e.clientX - this._dragX) * this._pxPerCss;
    const dy = (e.clientY - this._dragY) * this._pxPerCss;
    this._dragX = e.clientX; this._dragY = e.clientY;
    this._dragMoved += Math.abs(dx) + Math.abs(dy);
    // grab-and-drag: the world under the cursor must follow it, so the centre
    // moves the OPPOSITE way, converted from canvas px back to metres.
    this.cx -= dx / k;
    this.cz -= dy / k;
    this._clampView();
    this._schedule(RENDER_MS);
  }

  _onUp(e) {
    if (!this._dragging) return;
    const moved = this._dragMoved;
    this._endDrag();
    e.stopPropagation();
    if (moved > 5 * this._dpr) return;         // that was a pan, not a click
    const k = this.k0 * this.zoom;
    if (!k) return;
    const wx = this.cx + (this._evX(e) - this.cv.width / 2) / k;
    const wz = this.cz + (this._evY(e) - this.cv.height / 2) / k;
    // Remember what the waypoint was BEFORE this click, but only when the
    // click starts a fresh gesture — a double-click sends two clicks and its
    // undo (see _onDbl) must restore the state from before the first of them.
    const now = performance.now();
    if (now - (this._lastClickT ?? -1e9) > 400) this._wpBefore = this.waypoint;
    this._lastClickT = now;
    this._setWaypoint(wx, wz);
  }

  _endDrag() {
    this._dragging = false;
    this.cv.classList.remove('atc-drag');
  }

  // Double-click recentres on the player. Its first click already dropped a
  // waypoint (clicks are answered instantly — a 250 ms wait to see whether a
  // second one arrives would make every single click feel broken), so undo it
  // here instead of delaying the common case.
  _onDbl(e) {
    e.stopPropagation();
    e.preventDefault();
    const before = this._wpBefore ?? null;
    this._setWaypoint(before ? before.x : null, before ? before.z : 0);
    this._centerOnPlayer();
  }

  // Wheel zoom ANCHORED ON THE CURSOR: the world point under the pointer must
  // not move. Solve it directly — wx = cx + (sx − W/2)/k holds before and
  // after, so the new centre is wx − (sx − W/2)/k'.
  _onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const cv = this.cv;
    const sx = this._evX(e), sy = this._evY(e);
    // deltaMode 1 = lines (Firefox); normalise to something pixel-ish first
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const kOld = this.k0 * this.zoom;
    if (!kOld) return;
    const wx = this.cx + (sx - cv.width / 2) / kOld;
    const wz = this.cz + (sy - cv.height / 2) / kOld;
    const zoom = clamp(this.zoom * Math.exp(-dy * 0.0016), ZOOM_MIN, ZOOM_MAX);
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    const kNew = this.k0 * this.zoom;
    this.cx = wx - (sx - cv.width / 2) / kNew;
    this.cz = wz - (sy - cv.height / 2) / kNew;
    this._clampView();
    this._schedule(RENDER_MS);
  }

  _setWaypoint(x, z) {
    this.waypoint = x === null || x === undefined ? null : { x, z };
    // Hand the same flag straight to the HUD minimap so the two never disagree
    // even for the frame before main.js pushes it. minimap.setWaypoint stores
    // the object BY REFERENCE — which is why this object is replaced, never
    // mutated: a mutation would silently move the HUD's flag too.
    if (this.minimap?.setWaypoint) this.minimap.setWaypoint(this.waypoint);
    else if (this.minimap) this.minimap.waypoint = this.waypoint;
  }

  // ------------------------------------------------------------ render ----

  // Debounced bitmap render. NEVER called from _draw(): a stale-bitmap test
  // that rescheduled every frame would push its own deadline forever, so only
  // discrete events (open, tile, pan, zoom, resize) may schedule one.
  _schedule(ms) {
    if (!this._open) return;     // a closed map renders on its next open, not now
    clearTimeout(this._rt);
    this._rt = setTimeout(() => { this._rt = 0; this._render(); }, ms);
  }

  // Rasterize the region around the current view into the offscreen canvas.
  // The bitmap is a WINDOW, not the whole world: at 12× a 45 km region would
  // need a 100k px bitmap, so we render the view padded by OFF_PAD (small pans
  // and a click of zoom then need no redraw) and clipped to the region itself
  // (at zoom 1 there is nothing outside to keep, which buys back resolution).
  _render() {
    clearTimeout(this._rt); this._rt = 0;
    this._computeBounds();       // the live arrays have grown since last time
    this._layout();              // …which can change the aspect and thus k0
    const cv = this.cv, W = cv.width, H = cv.height;
    const k = this.k0 * this.zoom;
    if (!W || !H || !k) return;
    const vw = W / k, vh = H / k;

    let x0 = this.cx - vw * OFF_PAD / 2, x1 = this.cx + vw * OFF_PAD / 2;
    let z0 = this.cz - vh * OFF_PAD / 2, z1 = this.cz + vh * OFF_PAD / 2;
    // Clip the padded window to the region: rendering blank kilometres past
    // the data would spend the pixel budget on nothing. Guarded so a degenerate
    // clip (region entirely off the view — impossible after _clampView, but
    // cheap to insure) falls back to the unclipped window.
    const cx0 = Math.max(x0, this.rx0 - OFF_MARGIN), cx1 = Math.min(x1, this.rx1 + OFF_MARGIN);
    const cz0 = Math.max(z0, this.rz0 - OFF_MARGIN), cz1 = Math.min(z1, this.rz1 + OFF_MARGIN);
    if (cx1 - cx0 > vw * 0.2 && cz1 - cz0 > vh * 0.2) { x0 = cx0; x1 = cx1; z0 = cz0; z1 = cz1; }

    // 1:1 with the screen is exactly crisp; the caps then decide how much of
    // that we can afford, and anything they take back shows as soft upscaling.
    let s = k;
    let pw = (x1 - x0) * s, ph = (z1 - z0) * s;
    const shrink = Math.min(1, OFF_MAX_SIDE / Math.max(pw, ph),
      Math.sqrt(OFF_MAX_PX / Math.max(1, pw * ph)));
    if (shrink < 1) { s *= shrink; pw *= shrink; ph *= shrink; }
    const ow = Math.max(2, Math.round(pw)), oh = Math.max(2, Math.round(ph));
    const off = this.off;
    if (off.width !== ow) off.width = ow;
    if (off.height !== oh) off.height = oh;
    this.bs = s; this.bx = x0; this.bz = z0;
    // O(1) reject window for the whole render — 200 m of slop covers the
    // fattest stroke many times over at any scale this map ever uses
    this._wx0 = x0 - 200; this._wz0 = z0 - 200;
    this._wx1 = x0 + ow / s + 200; this._wz1 = z0 + oh / s + 200;

    const g = this.offg, city = this.city;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = MAP_BG;
    g.fillRect(0, 0, ow, oh);
    g.lineJoin = g.lineCap = 'round';

    // The world base layer goes down FIRST, so streamed detail paints over it
    // wherever it exists and the rest of the country is still a country.
    this._overview(g, x0, z0, s);

    // Same layer order as the minimap so the two read as one map: greens and
    // paved surfaces, then water, then the built fabric, then rails, then the
    // road web on top.
    this._polys(city.green, f => css(COLORS.green[f.t] ?? COLORS.green.grass, 0.9));
    this._polys(city.paved, f => css(COLORS.paved[f.t] ?? COLORS.paved.parking, 1));
    this._polys(city.water, () => css(COLORS.water, 0.85));
    // waterways are polylines (the Chrudimka arms, mill races). One batched
    // stroke at a nominal 5 m: their real `w` varies by a metre or two, which
    // is invisible here and not worth a stroke call per stream.
    g.strokeStyle = css(COLORS.water, 0.85);
    g.beginPath();
    let any = false;
    for (const f of city.waterways ?? []) {
      const bb = this._bb(f, f.p);
      if (!bb || !this._visBB(bb)) continue;
      this._line(g, f.p, x0, z0, s);
      any = true;
    }
    if (any) { g.lineWidth = Math.max(1, 5 * s); g.stroke(); }

    this._buildings(g, city, x0, z0, s);

    // rails: one thin dark thread — the station corridors are a landmark
    g.strokeStyle = css(COLORS.rail, 1.6);
    g.lineWidth = Math.max(0.8, 2.2 * s);
    g.beginPath();
    any = false;
    for (const f of city.rails ?? []) {
      const bb = this._bb(f, f.p);
      if (!bb || !this._visBB(bb)) continue;
      this._line(g, f.p, x0, z0, s);
      any = true;
    }
    if (any) g.stroke();

    this._roads(g, city, x0, z0, s);
    this._zr = -1;               // force the status line to repaint the zoom
  }

  // The whole-world base layer. Everything here is the same feature shape the
  // live layers use — {o} rings and {p} polylines with a `t` class — so it goes
  // through the very same batching helpers, and the two layers cannot drift
  // apart in colour or line weight. Drawn a touch flatter than the live data so
  // that where both exist, the streamed detail is the one you read.
  _overview(g, x0, z0, s) {
    const ov = this.ov;
    if (!ov) return;
    this._polys(ov.green, () => css(COLORS.green.wood, 0.78));
    this._polys(ov.water, () => css(COLORS.water, 0.8));
    // built-up area: runs of 200 m cells that hold at least one building. At
    // region zoom this is what makes a town look like a town — the same wash
    // _buildings paints when a real footprint is under a pixel.
    this._polys(ov.urban, () => BLD_WASH);
    g.strokeStyle = css(COLORS.rail, 1.4);
    g.lineWidth = Math.max(0.7, 2 * s);
    g.beginPath();
    let any = false;
    for (const f of ov.rails) {
      const bb = this._bb(f, f.p);
      if (!bb || !this._visBB(bb)) continue;
      this._line(g, f.p, x0, z0, s);
      any = true;
    }
    if (any) g.stroke();
    this._roads(g, { roads: ov.roads }, x0, z0, s);
  }

  _visBB(bb) {
    return bb[2] >= this._wx0 && bb[0] <= this._wx1 && bb[3] >= this._wz0 && bb[1] <= this._wz1;
  }

  // One path per COLOUR instead of one per polygon: 21 k green polygons as
  // separate fills is most of a region render. The nonzero rule makes that
  // safe only if winding is consistent, which OSM does not promise — so every
  // outer ring is emitted with a positive signed area and every hole with a
  // negative one. Overlapping parks then merge instead of cancelling, and
  // courtyards still punch through.
  _polys(list, colorOf) {
    if (!list || !list.length) return;
    const g = this.offg, buckets = this._buckets;
    for (const arr of buckets.values()) arr.length = 0;
    for (const f of list) {
      const bb = this._bb(f, f.o);
      if (!bb || !this._visBB(bb)) continue;
      const c = colorOf(f);
      let arr = buckets.get(c);
      if (!arr) buckets.set(c, arr = []);
      arr.push(f);
    }
    const ox = this.bx, oz = this.bz, s = this.bs;
    for (const [color, arr] of buckets) {
      if (!arr.length) continue;
      g.fillStyle = color;
      g.beginPath();
      let n = 0;
      for (const f of arr) {
        // a feature and its holes MUST share one path or the hole has nothing
        // to punch through — so the flush only ever happens between features
        this._ring(g, f.o, this._signOf(f) < 0, ox, oz, s);
        for (const h of f.i ?? []) this._ring(g, h, ringArea(h) > 0, ox, oz, s);
        if (++n >= FLUSH_N) { g.fill(); g.beginPath(); n = 0; }
      }
      if (n) g.fill();
    }
  }

  // signed area of the outer ring, memoised — it costs the same as drawing the
  // ring, so paying it once per feature per session matters at 21 k polygons
  _signOf(f) {
    let s = f._wmSign;
    if (s === undefined) s = f._wmSign = ringArea(f.o);
    return s;
  }

  _ring(g, r, reverse, ox, oz, s) {
    if (!r || r.length < 3) return;
    if (reverse) {
      for (let i = r.length - 1; i >= 0; i--) {
        const p = r[i], px = (p[0] - ox) * s, py = (p[1] - oz) * s;
        i === r.length - 1 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
    } else {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], px = (p[0] - ox) * s, py = (p[1] - oz) * s;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
    }
    g.closePath();
  }

  _line(g, p, ox, oz, s) {
    for (let i = 0; i < p.length; i++) {
      const px = (p[i][0] - ox) * s, py = (p[i][1] - oz) * s;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
  }

  // Buildings as a light wash. Two regimes, because 163 k footprints over a
  // 45 km region are each a fraction of a pixel: zoomed out we stamp bbox
  // rectangles (dense town centres blend into a tint, a lone farm is one
  // pixel), zoomed in we fill the real outline like the minimap does. Both go
  // into ONE path with one fill — rects and outlines alike are convex-ish and
  // wound consistently by the API/data, so overlaps merge under nonzero.
  _buildings(g, city, ox, oz, s) {
    const list = city.buildings;
    if (!list || !list.length) return;
    const outline = s >= 0.06;            // a 20 m house is ≥ 1.2 px — worth drawing
    g.fillStyle = outline ? BLD_FILL : BLD_WASH;
    g.beginPath();
    let n = 0;
    for (const f of list) {
      const bb = this._bb(f, f.o);
      if (!bb || !this._visBB(bb)) continue;
      if (outline) {
        this._ring(g, f.o, this._signOf(f) < 0, ox, oz, s);
      } else {
        const x = (bb[0] - ox) * s, y = (bb[1] - oz) * s;
        g.rect(x, y, Math.max(1, (bb[2] - bb[0]) * s), Math.max(1, (bb[3] - bb[1]) * s));
      }
      if (++n >= FLUSH_N) { g.fill(); g.beginPath(); n = 0; }
    }
    if (n) g.fill();
  }

  // Roads bucketed by class and stroked ONCE per class (15 strokes instead of
  // 70 000). Per-way widths from the data are dropped on purpose: at map scale
  // the difference between a 5.5 m and a 6.5 m residential street is far under
  // a pixel, and one stroke per class is what makes a region render fast.
  _roads(g, city, ox, oz, s) {
    const list = city.roads;
    if (!list || !list.length) return;
    const buckets = this._buckets;
    for (const arr of buckets.values()) arr.length = 0;
    for (const f of list) {
      const st = ROAD_STYLE[f.t];
      if (st && st.foot && s < FOOT_S) continue;   // pavements: only when zoomed in
      const bb = this._bb(f, f.p);
      if (!bb || !this._visBB(bb)) continue;
      const key = st ? f.t : 'residential';        // unknown class → the minimap's fallback
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, arr = []);
      arr.push(f);
    }
    for (const cls of ROAD_ORDER) {
      const arr = buckets.get(cls);
      if (!arr || !arr.length) continue;
      const st = ROAD_STYLE[cls];
      g.strokeStyle = css(COLORS.road[cls] ?? COLORS.road.residential, st.k);
      g.lineWidth = Math.max(st.min, st.w * s);
      g.beginPath();
      let n = 0;
      for (const f of arr) {
        this._line(g, f.p, ox, oz, s);
        if (++n >= FLUSH_N) { g.stroke(); g.beginPath(); n = 0; }
      }
      if (n) g.stroke();
    }
  }

  // -------------------------------------------------------------- frame ----

  // One frame: blit a window of the bitmap, then draw everything that must
  // stay sharp (labels, markers) in screen space. No geometry, no allocation.
  _draw() {
    const cv = this.cv, g = this.g, W = cv.width, H = cv.height;
    if (!W || !H) return;
    const k = this.k0 * this.zoom;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = VOID_BG;
    g.fillRect(0, 0, W, H);

    if (this.bs > 0) {
      // source rect in bitmap px for the view rect, clamped to the bitmap so a
      // fast pan shows dead ground instead of a stretched edge; the dest rect
      // is clipped by the SAME amount, which keeps 1 source px = k/bs dest px.
      const bs = this.bs, f = k / bs;
      const sx = (this.cx - W / (2 * k) - this.bx) * bs;
      const sy = (this.cz - H / (2 * k) - this.bz) * bs;
      const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
      const x1 = Math.min(this.off.width, sx + W / f), y1 = Math.min(this.off.height, sy + H / f);
      if (x1 > x0 && y1 > y0)
        g.drawImage(this.off, x0, y0, x1 - x0, y1 - y0,
          (x0 - sx) * f, (y0 - sy) * f, (x1 - x0) * f, (y1 - y0) * f);
    }

    this._drawLabels(g, W, H, k);
    this._drawMarkers(g, W, H, k);
    this._status();
  }

  // Settlement labels, biggest rank first with a screen-space collision
  // reject: a candidate whose box overlaps one already placed is skipped, so
  // the region overview shows the towns and the villages appear as you zoom
  // into the space that frees up. Text widths are memoised per place (the font
  // only changes with the DPR), which keeps measureText out of the steady
  // state — it is the one call in this loop that would allocate every frame.
  _drawLabels(g, W, H, k) {
    const places = this.places;
    if (!places.length) return;
    const dpr = this._dpr, boxes = this._boxes;
    let n = 0;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    let font = '';
    for (let i = 0; i < places.length && n < MAX_LABELS; i++) {
      const p = places[i];
      const r = p.r | 0;
      if (this.zoom < RANK_ZOOM[r]) continue;
      const sx = W / 2 + (p.p[0] - this.cx) * k;
      const sy = H / 2 + (p.p[1] - this.cz) * k;
      if (sx < -80 || sx > W + 80 || sy < -40 || sy > H + 40) continue;
      const wantFont = this._fonts[r];
      if (wantFont !== font) { g.font = wantFont; font = wantFont; }
      if (p._wmF !== wantFont) { p._wmW = g.measureText(p.n).width; p._wmF = wantFont; }
      const fs = RANK_FONT[r] * dpr, dot = RANK_DOT[r] * dpr, pad = 3 * dpr;
      const bx0 = sx - p._wmW / 2 - pad, bx1 = sx + p._wmW / 2 + pad;
      const by1 = sy - dot - 2 * dpr, by0 = by1 - fs;   // the name sits above its dot
      // A name sliced in half by the canvas edge is worse than no name: reject
      // it and let the collision budget go to a place that fits. (The earlier
      // cull only skipped places far outside — this catches the ones straddling
      // the rim, which is where a long Czech name lands most often.)
      if (bx0 < 2 || bx1 > W - 2 || by0 < 2 || sy + dot > H - 2) continue;
      let hit = false;
      for (let b = 0, e = n * 4; b < e; b += 4)
        if (bx0 < boxes[b + 2] && bx1 > boxes[b] && by0 < boxes[b + 3] && by1 > boxes[b + 1]) {
          hit = true; break;
        }
      if (hit) continue;
      // the reserved box swallows the dot too, so two neighbouring villages
      // cannot stack a name straight onto someone else's marker
      boxes[n * 4] = bx0; boxes[n * 4 + 1] = by0;
      boxes[n * 4 + 2] = bx1; boxes[n * 4 + 3] = sy + dot + 2 * dpr;
      n++;
      g.beginPath();
      g.arc(sx, sy, dot, 0, TAU);
      g.fillStyle = r <= 1 ? '#ffe6b0' : '#ffffff';
      g.fill();
      g.lineWidth = 1.2 * dpr;
      g.strokeStyle = 'rgba(10,14,20,0.9)';
      g.stroke();
      g.lineWidth = 3 * dpr;
      g.strokeStyle = 'rgba(8,11,16,0.85)';
      g.strokeText(p.n, sx, by1);
      g.fillStyle = r <= 1 ? '#fff3d6' : '#f2f4f8';
      g.fillText(p.n, sx, by1);
    }
  }

  _drawMarkers(g, W, H, k) {
    const dpr = this._dpr;
    const px = this._px, pz = this._pz;
    const hasP = px !== undefined;
    const wp = this.waypoint;

    // the thread from the player to the flag: a dashed line reads as "route"
    // without pretending we did any routing
    if (wp && hasP) {
      g.setLineDash(DASH);
      g.lineWidth = 1.6 * dpr;
      g.strokeStyle = 'rgba(255,210,26,0.66)';
      g.beginPath();
      g.moveTo(W / 2 + (px - this.cx) * k, H / 2 + (pz - this.cz) * k);
      g.lineTo(W / 2 + (wp.x - this.cx) * k, H / 2 + (wp.z - this.cz) * k);
      g.stroke();
      g.setLineDash(EMPTY_DASH);
    }

    // the helicopter: a rotor cross, dimmed while you are the one flying it
    // (the player arrow is then sitting on the same spot and is the truth)
    if (this._hx !== null && this._hx !== undefined) {
      const sx = W / 2 + (this._hx - this.cx) * k, sy = H / 2 + (this._hz - this.cz) * k;
      if (sx > -20 && sx < W + 20 && sy > -20 && sy < H + 20) {
        const a = 7 * dpr;
        g.globalAlpha = this._heliMine ? 0.45 : 1;
        g.beginPath();
        g.moveTo(sx - a, sy - a); g.lineTo(sx + a, sy + a);
        g.moveTo(sx + a, sy - a); g.lineTo(sx - a, sy + a);
        g.lineWidth = 4 * dpr;
        g.strokeStyle = 'rgba(8,11,16,0.85)';   // dark outline pass…
        g.stroke();
        g.lineWidth = 1.8 * dpr;
        g.strokeStyle = '#8fd0ff';              // …then the icon over it
        g.stroke();
        g.beginPath();
        g.arc(sx, sy, 2.4 * dpr, 0, TAU);
        g.fillStyle = '#8fd0ff';
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // the waypoint flag
    if (wp) {
      const sx = W / 2 + (wp.x - this.cx) * k, sy = H / 2 + (wp.z - this.cz) * k;
      if (sx > -30 && sx < W + 30 && sy > -30 && sy < H + 30) {
        const a = 6 * dpr;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx - a, sy - a * 1.5);
        g.lineTo(sx, sy - a * 2.6);
        g.lineTo(sx + a, sy - a * 1.5);
        g.closePath();
        g.fillStyle = WP_COLOR;
        g.fill();
        g.lineWidth = 1.6 * dpr;
        g.strokeStyle = 'rgba(20,16,4,0.9)';
        g.stroke();
        g.beginPath();
        g.arc(sx, sy - a * 1.55, a * 0.32, 0, TAU);
        g.fillStyle = 'rgba(20,16,4,0.9)';
        g.fill();
      }
    }

    // the player: a heading arrow on a soft halo. North stays up, so the arrow
    // does the turning — rotate(−heading), the minimap's own convention.
    if (!hasP) return;
    const sx = W / 2 + (px - this.cx) * k, sy = H / 2 + (pz - this.cz) * k;
    if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) return;
    const a = 8 * dpr;
    g.beginPath();
    g.arc(sx, sy, a * 1.7, 0, TAU);
    g.fillStyle = 'rgba(120,180,255,0.28)';
    g.fill();
    g.save();
    g.translate(sx, sy);
    g.rotate(-(this._ph ?? 0));
    g.beginPath();
    g.moveTo(0, -a);
    g.lineTo(a * 0.72, a * 0.82);
    g.lineTo(0, a * 0.42);                   // notched tail reads as direction
    g.lineTo(-a * 0.72, a * 0.82);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 1.4 * dpr;
    g.strokeStyle = 'rgba(16,22,30,0.9)';
    g.stroke();
    g.restore();
  }

  // Head line: zoom and the distance to the waypoint. Both are rebuilt ONLY
  // when their rounded value changes — string building is an allocation, and
  // this runs every frame the map is open.
  _status() {
    const zr = Math.round(this.zoom * 10);
    let dr = -1;
    if (this.waypoint && this._px !== undefined)
      dr = Math.round(Math.hypot(this.waypoint.x - this._px, this.waypoint.z - this._pz) / 10);
    if (zr === this._zr && dr === this._dr) return;
    this._zr = zr; this._dr = dr;
    let txt = this.bs > 0 ? 'přiblížení ' + (zr / 10).toFixed(1) + '×' : 'vykresluji mapu…';
    if (dr >= 0) {
      const m = dr * 10;
      txt += ' · cíl ' + (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m');
    }
    this.stat.textContent = txt;
  }
}

const EMPTY_DASH = [];   // setLineDash([]) every frame would allocate; this does not

// Signed area of a ring (shoelace). Only its SIGN is used — to force a
// consistent winding before batched nonzero fills.
function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}
