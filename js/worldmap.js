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

// ZOOM_MAX was 12 when the world was the 30×38 km agglomeration, where 12×
// meant a 2.5 km view — street scale. v8 stretched the world to 144 km across,
// which quietly turned the SAME number into a 12 km view: a 100 m street is
// 2 px long there, so no street name could ever fit its street and the labels
// below would have been a feature you cannot see. The range now reaches the
// scale it always described.
const ZOOM_MIN = 1, ZOOM_MAX = 40;
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
const POLY_S = 0.05;         // …and below which live green/paved are too (20 m/px)

// Per-rank presentation, indexed by the `r` field of places.json (0 city …
// 5 isolated dwelling). The zoom gates are the contract's: 0-1 always, 2 from
// 2×, 3-4 from 4×, 5 from 8× — which is what keeps 212 villages from turning
// the region overview into a wall of text.
const RANK_ZOOM = [0, 0, 2, 4, 4, 8];
const RANK_FONT = [16, 13.5, 12, 11, 11, 10];   // CSS px, scaled by DPR
const RANK_DOT = [4.4, 3.4, 2.6, 2.2, 2.0, 1.7]; // CSS px radius, ditto
const RANK_BOLD = [1, 1, 0, 0, 0, 0];

// ---- street labels ------------------------------------------------------
// The same idea the minimap runs at HUD scale: a road's name is written ALONG
// the road, on the longest straight run of it that is actually in view, and
// only when the name is narrower than that run is wide on screen. A name that
// does not fit its own street is pointing at the wrong street, so it is not
// drawn at all — which is also what keeps a city centre from turning into a
// wall of text as you zoom in.
//
// Rank orders the candidates (motorway first) and gates the quiet classes.
// Anything not in this table — service aisles, footways, links — never gets a
// name: at map scale they are the noise you zoom past, not the road you drive.
const ST_RANK = {
  motorway: 0, trunk: 0, primary: 1, secondary: 1, tertiary: 2,
  unclassified: 3, residential: 3, living_street: 4, pedestrian: 4,
};
const STREET_ZOOM = 3;     // contract: names on the asphalt from 3× in
const STREET_MAX = 60;     // names placed per frame…
const STREET_CAND = 320;   // …chosen from this many candidates per render
const STREET_TURN = 0.28;  // rad a run may bend and still be laid out as a chord
const STREET_PAD = 6;      // CSS px of road demanded past each end of the name
const STREET_REPEAT = 260; // CSS px — a long avenue may say its name again here
const STREET_FONT = 11.5;  // CSS px
const ST_RANK_M = 0.18;    // score bonus per rank, as a FRACTION of the view
                           // width — one number that means the same thing at
                           // every zoom, unlike a fixed number of metres

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
  // aeroways: real width, and bright — a 3 km runway is the single most
  // recognisable shape on a region map
  runway: { w: 45, min: 2.6, k: 1.5 }, taxiway: { w: 23, min: 1.2, k: 1.35 },
  taxilane: { w: 15, min: 0.9, k: 1.3 }, airstrip: { w: 20, min: 1.0, k: 1.2 },
};
// DRAW order — quiet ways first so a motorway always crosses on top, mirroring
// the 3D layering. Anything the data throws at us that is not in this list is
// bucketed as `residential` (the same fallback minimap.js uses).
const ROAD_ORDER = ['steps', 'path', 'footway', 'cycleway', 'track', 'pedestrian',
  'service', 'living_street', 'residential', 'unclassified', 'tertiary',
  'secondary', 'primary', 'trunk', 'motorway',
  'taxilane', 'taxiway', 'airstrip', 'runway'];

// A co-op player with no colour of their own. Peers are normally painted in
// their JACKET colour — the very number identity.js hands their avatar — so
// the dot here, the dot on the minimap, the name over their head and the
// figure you can see through the windscreen are one colour by construction.
const PEER_FALLBACK = '#7fd8ff';
// CSS px kept clear of the canvas edge, where an off-view peer's chevron is
// pinned. Shared by the drawing and the hit test — see _peerScreen.
const PEER_INSET = 14;
// A colour off the wire goes straight into a canvas fillStyle, and an
// unparsable one does NOT throw — it silently keeps whatever fill was set
// last, which would paint a peer in the waypoint's yellow. So validate.
const SAFE_CSS_COLOR = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i;

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

function peerCss(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return css(c >>> 0);
  if (typeof c === 'string' && SAFE_CSS_COLOR.test(c.trim())) return c.trim();
  return PEER_FALLBACK;
}

// Czech head count for the status line — "2 hráči", "5 hráčů".
function czPlayers(n) {
  return n === 1 ? '1 hráč' : n < 5 ? n + ' hráči' : n + ' hráčů';
}

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
    this._peers = null;           // co-op roster for THIS frame, by reference
    // Click a friend and the waypoint FOLLOWS them: uid of the peer being
    // chased, or null. A static flag on the spot where somebody stood two
    // minutes ago is not navigation in a world this size — by the time you
    // arrive they are a kilometre further on.
    this.followUid = null;
    this.followName = '';
    // Reused by _peerScreen — the peer loop runs every frame the map is open
    // and must not allocate a point object per peer per frame.
    this._ps = { sx: 0, sy: 0, off: false };
    this.places = [];             // filled asynchronously; [] = no labels, fine
    this.ov = null;               // …and the world base layer; null = streamed only
    this._ovBmp = null;           // …rasterised once (see _overviewBitmap)

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
    // 0, not 1: _layout() only rebuilds the font strings when the DPR CHANGES,
    // so seeding this with a plausible DPR meant that on any ordinary 1× display
    // the comparison matched on the very first layout and the fonts stayed empty
    // strings — `g.font = ''` is ignored by the canvas, and every settlement
    // label silently fell back to the browser default 10px. No real device ever
    // reports 0, so this always fires once.
    this._dpr = 0;
    this._fonts = RANK_FONT.map(() => '');
    this._pfont = 'bold 12.5px system-ui, sans-serif';   // peer labels, rebuilt per DPR
    // Collision boxes for the current frame, flat and preallocated: labels are
    // the one per-frame loop that could allocate, and a Float64Array of
    // [x0,y0,x1,y1]×N costs nothing after construction.
    // Settlements fill it first and street names continue in the SAME array,
    // which is the whole reason places win every contested pixel: a street can
    // only take a box no town wanted. Hence the extra room at the end rather
    // than a second array — one array, one rule, no way for the two passes to
    // disagree about what is already occupied.
    this._boxes = new Float64Array((MAX_LABELS + STREET_MAX) * 4);
    // ---- street-label state (see _collectStreets / _drawStreets) ----
    this._stN = 0;                                  // live candidates
    this._stRoad = new Array(STREET_CAND).fill(null);
    this._st = new Float64Array(STREET_CAND * 4);   // mx, mz, angle, visible m
    this._stScore = new Float64Array(STREET_CAND);
    this._slName = new Array(STREET_MAX).fill('');  // names drawn THIS frame…
    this._slPos = new Float64Array(STREET_MAX * 2); // …and where, for the repeat rule
    this._sfont = '';
    this._buckets = new Map();    // reused across renders: key → feature array
    // last status values — the head line is rebuilt only when one of them
    // changes. _fk starts null rather than '' so the very first _status()
    // cannot compare equal to "not following anybody" and skip its paint.
    this._zr = -1; this._dr = -1; this._pr = -1; this._fk = null;
    this._followBefore = null;    // the chase a double-click has to put back

    this._buildDom();
    loadPlaces().then(list => { this.places = list; });
    // 3 MB lands well after the first frames; if the map is already open when
    // it does, redraw so the world appears instead of waiting for a pan
    loadOverview().then(ov => {
      this.ov = ov;
      if (this._open) this._schedule(TILE_MS);
      // Rasterising the base layer is a ~500 ms job. Doing it on the first map
      // open put that half-second squarely on the keypress; doing it here, in
      // an idle slot minutes earlier, means the first open is as quick as
      // every one after it.
      const build = () => { try { this._computeBounds(); this._overviewBitmap(); } catch {} };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 8000 });
      else setTimeout(build, 3000);
    });

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
  //
  // `peers` is the co-op roster: an array of { uid, name, x, z, color }. It is
  // held BY REFERENCE and read inside the very same call (update → _draw is
  // synchronous), so the caller is free to hand over one array it rewrites
  // every frame — this module allocates nothing for it. Omit it and the map
  // behaves exactly as it did in single player.
  update(player, car, heli, peers = null) {
    const roster = Array.isArray(peers) && peers.length ? peers : null;
    // Chasing a friend has to keep working with the map CLOSED — that is the
    // whole point of it, since the map is shut while you actually drive there.
    // So the follow step runs BEFORE the open check.
    //
    // `peers === null` means the caller reported nothing this frame; an ARRAY
    // means it reported, and a peer missing from that array has genuinely
    // gone. Only the second cancels the chase. Collapsing the two would mean a
    // caller that passes the roster only while the map is open silently drops
    // your destination the moment you close the map to drive to it.
    if (this.followUid && Array.isArray(peers)) this._followPeer(roster);
    if (!this._open) { this._peers = null; return; }
    this._peers = roster;
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
          ${this._key(PEER_FALLBACK, 'Hráči')}
          <!-- "dvojklik na hráče" used to mean YOURSELF, which stopped being an
               unambiguous phrase the moment other players appeared on the map. -->
          <span class="atc-map-hint"><b>táhni</b> posun · <b>kolečko</b> přiblížení ·
            <b>klik</b> cíl cesty · <b>klik na kamaráda</b> sledovat ·
            <b>pravý klik</b> zrušit · <b>dvojklik</b> na sebe ·
            <b>M</b>/<b>Esc</b> zavřít</span>
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
      this._pfont = 'bold ' + (12.5 * dpr).toFixed(1) + 'px system-ui, sans-serif';
      // Street names sit a weight under the settlements on purpose: a town is
      // an answer to "where am I", a street is only an answer to "which one is
      // this", and the hierarchy has to be legible before the words are.
      this._sfont = '600 ' + (STREET_FONT * dpr).toFixed(1) + 'px system-ui, sans-serif';
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
    // bounds moved → the pre-rendered base layer is registered to the old ones
    if (this._ovBmp && (this._ovBmp.x0 !== minX || this._ovBmp.z0 !== minZ
      || Math.abs((this._ovBmp.w / this._ovBmp.s) - (maxX - minX)) > 1)) this._ovBmp = null;
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
    // right = zrušit cíl. Stop the chase FIRST: clearing only the flag would
    // let _followPeer put it straight back on the next frame.
    if (e.button === 2) { this.stopFollow(); this._setWaypoint(null); return; }
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
    if (now - (this._lastClickT ?? -1e9) > 400) {
      this._wpBefore = this.waypoint;
      this._followBefore = this.followUid;
    }
    this._lastClickT = now;
    // A click that landed on a friend means "take me to THEM", and them is a
    // moving target — anywhere else is an ordinary flag on the ground.
    const hit = this._peerHit(this._evX(e), this._evY(e));
    this.stopFollow();
    if (hit) {
      this.followUid = hit.uid;
      this.followName = typeof hit.name === 'string' ? hit.name : '';
      this._setWaypoint(hit.x, hit.z);
    } else {
      this._setWaypoint(wx, wz);
    }
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
    this.stopFollow();
    this._setWaypoint(before ? before.x : null, before ? before.z : 0);
    // …and restore the chase the first click cancelled, so a double-click on
    // empty map does not quietly stop you following a friend.
    if (this._followBefore) {
      this.followUid = this._followBefore;
      this.followName = '';        // refreshed by the next _followPeer
    }
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

  // ---- following a friend ----------------------------------------------
  // Re-point the waypoint at the peer we are chasing. Called every frame,
  // open or closed, so the HUD compass in main.js tracks a moving target.
  _followPeer(roster) {
    let p = null;
    if (roster) for (const q of roster) if (q && q.uid === this.followUid) { p = q; break; }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      // They are not in a roster the caller DID report, i.e. they left. Stop
      // chasing — but LEAVE the flag where they were last seen. Deleting the
      // player's destination out from under them is worse than a stale one,
      // and "last seen here" is still the only lead there is.
      this.stopFollow();
      return;
    }
    if (typeof p.name === 'string') this.followName = p.name;
    const wp = this.waypoint;
    // Only when they have actually moved: _setWaypoint REPLACES the object
    // (the minimap holds it by reference and a mutation would be invisible to
    // it), so an ungated follow allocates a waypoint every frame for a peer
    // who is standing still.
    if (wp && Math.abs(wp.x - p.x) < 1.5 && Math.abs(wp.z - p.z) < 1.5) return;
    this._setWaypoint(p.x, p.z);
  }

  // Stop chasing, keep the flag. Public because the moment main.js grows a
  // "cancel destination" key it needs to clear the chase too, or the waypoint
  // would reappear on the very next frame.
  // No repaint is scheduled here on purpose: the chase ring lives in the
  // per-frame OVERLAY (_draw), not in the cached bitmap (_render), so it comes
  // off by itself on the next frame. Scheduling would rasterize the whole
  // region window again for a 2 px circle.
  stopFollow() {
    if (!this.followUid) return;
    this.followUid = null;
    this.followName = '';
  }

  // Where a peer's ICON sits on the canvas — the dot when they are inside the
  // view, the clamped rim chevron when they are not. One function so the hit
  // test can never disagree with what was drawn: a chevron you can see and
  // cannot click is worse than no chevron. Writes into a reused point.
  _peerScreen(p, W, H, k, inset) {
    const o = this._ps;
    let sx = W / 2 + (p.x - this.cx) * k, sy = H / 2 + (p.z - this.cz) * k;
    o.off = sx < inset || sx > W - inset || sy < inset || sy > H - inset;
    if (o.off) {
      // Slide along the ray from the view centre until it meets the inset
      // rectangle: t is the smaller of the two axis-wise hits, which is the
      // edge the ray actually crosses first.
      const vx = sx - W / 2, vy = sy - H / 2;
      const tx = vx ? (W / 2 - inset) / Math.abs(vx) : Infinity;
      const ty = vy ? (H / 2 - inset) / Math.abs(vy) : Infinity;
      const t = Math.min(tx, ty);
      if (!Number.isFinite(t)) return null;   // dead centre AND off-view: impossible
      sx = W / 2 + vx * t; sy = H / 2 + vy * t;
    }
    o.sx = sx; o.sy = sy;
    return o;
  }

  // The peer whose icon is under (sx, sy), or null. The grab radius is a
  // finger, not a pixel — this canvas takes touch input too.
  _peerHit(sx, sy) {
    const peers = this._peers;
    if (!peers) return null;
    const k = this.k0 * this.zoom;
    if (!k) return null;
    const W = this.cv.width, H = this.cv.height;
    const inset = PEER_INSET * this._dpr, grab = 18 * this._dpr;
    let best = null, bestD2 = grab * grab;
    for (const p of peers) {
      if (!p || !p.uid || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const s = this._peerScreen(p, W, H, k, inset);
      if (!s) continue;
      const d2 = (s.sx - sx) * (s.sx - sx) + (s.sy - sy) * (s.sy - sy);
      if (d2 <= bestD2) { bestD2 = d2; best = p; }
    }
    return best;
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
    this._blitOverview(g, x0, z0, s, ow, oh);

    // Same layer order as the minimap so the two read as one map: greens and
    // paved surfaces, then water, then the built fabric, then rails, then the
    // road web on top.
    // Live green and paved cost 73 ms of a region render for features that are
    // a pixel across at that zoom — and the base layer already carries every
    // forest big enough to navigate by. Below POLY_S they are noise you pay
    // for, so they wait until you are zoomed in enough to read them.
    if (s >= POLY_S) {
      this._polys(city.green, f => css(COLORS.green[f.t] ?? COLORS.green.grass, 0.9));
      this._polys(city.paved, f => css(COLORS.paved[f.t] ?? COLORS.paved.parking, 1));
    }
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
    // Street-label candidates are picked HERE, with the geometry, and not per
    // frame: the region holds hundreds of thousands of ways and the frame loop
    // may only ever touch the few hundred that survive this pass. They are
    // clipped to the BITMAP window rather than the view, so the small pans and
    // the one zoom step the bitmap already absorbs keep their names too.
    this._collectStreets(city, x0, z0, x1, z1, k);
    this._zr = -1;               // force the status line to repaint the zoom
  }

  // The overview is IMMUTABLE — it is a file, it never streams, it never grows.
  // Drawing it per render cost 421 ms of the map's 508 (measured at spawn), all
  // of it rasterising one path holding 14 421 built-up rectangles, and that is
  // the whole of "the game freezes when I open the map". So it is rasterised
  // ONCE into its own canvas covering the region, and every render after that
  // is a single drawImage.
  //
  // Resolution is capped on the long side; at 110 km that is ~27 m per pixel,
  // which is far finer than the base layer is ever asked to be — by the time
  // you are zoomed in enough to see it soften, the live streamed detail is
  // drawn on top of it anyway.
  _overviewBitmap() {
    if (this._ovBmp || !this.ov) return this._ovBmp;
    const OV_PX = 4096;
    const w = Math.max(1, this.rx1 - this.rx0), h = Math.max(1, this.rz1 - this.rz0);
    const sc = OV_PX / Math.max(w, h);
    const cw = Math.max(2, Math.round(w * sc)), ch = Math.max(2, Math.round(h * sc));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d', { alpha: true });
    g.lineJoin = g.lineCap = 'round';
    // The draw helpers all read this.offg / this.bx / this.bz / this.bs and the
    // visibility window, so point that state at the new canvas for the duration
    // rather than duplicating every batching routine.
    const save = [this.offg, this.bx, this.bz, this.bs,
      this._wx0, this._wz0, this._wx1, this._wz1];
    this.offg = g; this.bx = this.rx0; this.bz = this.rz0; this.bs = sc;
    this._wx0 = this.rx0 - 500; this._wz0 = this.rz0 - 500;
    this._wx1 = this.rx1 + 500; this._wz1 = this.rz1 + 500;
    try {
      this._overview(g, this.rx0, this.rz0, sc);
    } finally {
      [this.offg, this.bx, this.bz, this.bs,
        this._wx0, this._wz0, this._wx1, this._wz1] = save;
    }
    this._ovBmp = { cv, x0: this.rx0, z0: this.rz0, s: sc, w: cw, h: ch };
    return this._ovBmp;
  }

  // Blit the window of the pre-rendered base layer that this bitmap covers.
  // Source and destination are clamped TOGETHER: a source rect running off the
  // edge of the overview canvas would otherwise be stretched to fill the whole
  // destination, sliding the base layer out of register with the live data.
  _blitOverview(g, x0, z0, s, ow, oh) {
    const b = this._overviewBitmap();
    if (!b) return;
    const wx1 = x0 + ow / s, wz1 = z0 + oh / s;
    const cx0 = Math.max(x0, b.x0), cz0 = Math.max(z0, b.z0);
    const cx1 = Math.min(wx1, b.x0 + b.w / b.s), cz1 = Math.min(wz1, b.z0 + b.h / b.s);
    if (cx1 <= cx0 || cz1 <= cz0) return;
    g.drawImage(b.cv,
      (cx0 - b.x0) * b.s, (cz0 - b.z0) * b.s, (cx1 - cx0) * b.s, (cz1 - cz0) * b.s,
      (cx0 - x0) * s, (cz0 - z0) * s, (cx1 - cx0) * s, (cz1 - cz0) * s);
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

    // Settlements first, streets into the boxes they left over, markers on top
    // of both — the priority the map is read in.
    this._drawStreets(g, W, H, k, this._drawLabels(g, W, H, k));
    this._drawMarkers(g, W, H, k);
    this._status();
  }

  // Settlement labels, biggest rank first with a screen-space collision
  // reject: a candidate whose box overlaps one already placed is skipped, so
  // the region overview shows the towns and the villages appear as you zoom
  // into the space that frees up. Text widths are memoised per place (the font
  // only changes with the DPR), which keeps measureText out of the steady
  // state — it is the one call in this loop that would allocate every frame.
  //
  // Returns how many boxes were reserved: the street pass continues in the
  // same array from there, which is what makes a town name beat a street name
  // for the same pixels without either pass knowing about the other.
  _drawLabels(g, W, H, k) {
    const places = this.places;
    if (!places.length) return 0;
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
    return n;
  }

  // ---- street labels ----------------------------------------------------

  // Pick the named roads worth a label for the frames until the next render.
  // For each one: the longest straight RUN of its polyline, clipped to the
  // bitmap window, kept best-first by a bounded insertion so the frame loop
  // can stop at the first STREET_MAX that fit and know it stopped on the most
  // important ones. Nothing here allocates — the candidate arrays were built
  // once and are rewritten in place.
  _collectStreets(city, x0, z0, x1, z1, k) {
    this._stN = 0;
    if (this.zoom < STREET_ZOOM) return;         // contract: from 3× in
    const list = city.roads;
    if (!list || !list.length) return;
    // Cheap pre-filter before the run scan: a name is roughly half its font
    // size per character wide, so a road with no straight run near that length
    // cannot possibly be labelled and does not deserve the polyline walk.
    const emK = STREET_FONT * this._dpr * 0.45 / k;   // metres per character
    const bonus = ((x1 - x0) / OFF_PAD) * ST_RANK_M;  // one rank, in metres
    for (const f of list) {
      if (!f.n) continue;                        // 77 % of ways leave here
      const rank = ST_RANK[f.t];
      if (rank === undefined) continue;
      const bb = this._bb(f, f.p);
      if (!bb || !this._visBB(bb)) continue;
      const needM = f.n.length * emK;
      // No chord of a polyline is longer than its bounding box's diagonal, so
      // this rejects a road that could not hold its own name before we walk a
      // single segment of it. It is the whole reason a wide zoom is cheap: at
      // 6× a ten-letter name wants 700 m of straight road and this throws away
      // 13 000 of Prague's 13 200 named ways on four subtractions each.
      const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
      if (bw * bw + bh * bh < needM * needM) continue;
      this._considerStreet(f, rank, x0, z0, x1, z1, needM, bonus);
    }
  }

  // The best placement for ONE road. Consecutive segments whose bearing stays
  // within STREET_TURN of the run's first are ONE run — OSM chops a street at
  // every driveway, so a single segment would fit almost no names (measured
  // over the real tiles: the longest single segment of a named way is 45–69 m
  // at the median, the longest straight run 58–114 m). At 0.28 rad the arc's
  // bulge away from its own chord is under 4 % of the chord, which is inside
  // the stroke of the road the name is written on.
  _considerStreet(f, rank, x0, z0, x1, z1, needM, bonus) {
    const p = f.p, n = p.length;
    if (n < 2) return;
    let bestL = 0, bmx = 0, bmz = 0, bang = 0;
    for (let i = 0; i < n - 1;) {
      const ax = p[i][0], az = p[i][1];
      const a0 = Math.atan2(p[i + 1][1] - az, p[i + 1][0] - ax);
      let j = i + 1;
      while (j < n - 1) {
        let d = Math.atan2(p[j + 1][1] - p[j][1], p[j + 1][0] - p[j][0]) - a0;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        if (d > STREET_TURN || d < -STREET_TURN) break;
        j++;
      }
      const bx = p[j][0], bz = p[j][1];
      if (clipRect(ax, az, bx, bz, x0, z0, x1, z1)) {
        const dx = bx - ax, dz = bz - az;
        const L = Math.sqrt(dx * dx + dz * dz) * (_clip.t1 - _clip.t0);
        if (L > bestL) {
          bestL = L;
          const t = (_clip.t0 + _clip.t1) / 2;   // centre of the VISIBLE part
          bmx = ax + dx * t; bmz = az + dz * t;
          // Never upside down: mirroring the direction turns the same line
          // through 180°, which leaves the text lying on the road but the
          // right way up. atan2 of a non-negative x is always within ±90°.
          bang = dx < 0 ? Math.atan2(-dz, -dx) : Math.atan2(dz, dx);
        }
      }
      i = j > i + 1 ? j : i + 1;                 // runs share their joint
    }
    if (bestL < needM) return;                   // hopeless before we measure
    // Class beats length, but only by one view-width fraction of it: a
    // residential street you can see all of still outranks a motorway
    // showing 40 m in the corner.
    const score = bestL + (4 - rank) * bonus;
    const cand = this._st, sc = this._stScore;
    let at = this._stN;
    if (at >= STREET_CAND) {
      if (score <= sc[STREET_CAND - 1]) return;
      at = STREET_CAND - 1;
    } else this._stN++;
    while (at > 0 && sc[at - 1] < score) {       // shift the weaker ones down
      sc[at] = sc[at - 1];
      this._stRoad[at] = this._stRoad[at - 1];
      cand[at * 4] = cand[at * 4 - 4]; cand[at * 4 + 1] = cand[at * 4 - 3];
      cand[at * 4 + 2] = cand[at * 4 - 2]; cand[at * 4 + 3] = cand[at * 4 - 1];
      at--;
    }
    sc[at] = score;
    this._stRoad[at] = f;
    cand[at * 4] = bmx; cand[at * 4 + 1] = bmz;
    cand[at * 4 + 2] = bang; cand[at * 4 + 3] = bestL;
  }

  // Lay the surviving names along their streets, continuing the settlement
  // pass's collision boxes at index `n0`. Four rejections in cheapest-first
  // order: the name must FIT the drawn run (measureText — memoised per road
  // per font, the one call here that would otherwise allocate every frame),
  // it must not repeat a name already written nearby, its box must be wholly
  // on the canvas, and it must not touch a box already placed — including
  // every town's, which is how places win.
  _drawStreets(g, W, H, k, n0) {
    if (this.zoom < STREET_ZOOM || !this._stN) return;
    const st = this._st, boxes = this._boxes, dpr = this._dpr;
    const font = this._sfont, hh = STREET_FONT * dpr * 0.62;
    const pad = STREET_PAD * dpr, rep = STREET_REPEAT * dpr;
    const names = this._slName, pos = this._slPos;
    let n = n0, drawn = 0;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (let i = 0; i < this._stN && drawn < STREET_MAX && n < MAX_LABELS + STREET_MAX; i++) {
      const f = this._stRoad[i], b = i * 4;
      // memo keys are world-map-private: the minimap measures the SAME roads
      // at its own font, and one shared cache would make the two thrash
      if (f._wmLF !== font) { f._wmLW = g.measureText(f.n).width; f._wmLF = font; }
      const w = f._wmLW;
      if (w + pad * 2 > st[b + 3] * k) continue;      // longer than its street
      const sx = W / 2 + (st[b] - this.cx) * k, sy = H / 2 + (st[b + 1] - this.cz) * k;
      // One street is a dozen OSM ways, so the same name would otherwise land
      // five times in a row down one avenue. It may say itself again, but only
      // once you have travelled far enough along that the first is no help.
      let dup = false;
      for (let q = 0; q < drawn; q++) {
        if (names[q] !== f.n) continue;
        const ddx = pos[q * 2] - sx, ddy = pos[q * 2 + 1] - sy;
        if (ddx * ddx + ddy * ddy < rep * rep) { dup = true; break; }
      }
      if (dup) continue;
      const ang = st[b + 2], ca = Math.cos(ang), sa = Math.sin(ang);
      // AABB of the ROTATED box — conservative on both tests below, which is
      // the right way round: it never lets a name overlap or overhang.
      const ex = Math.abs(ca) * w / 2 + Math.abs(sa) * hh;
      const ey = Math.abs(sa) * w / 2 + Math.abs(ca) * hh;
      const bx0 = sx - ex, bx1 = sx + ex, by0 = sy - ey, by1 = sy + ey;
      if (bx0 < 2 || bx1 > W - 2 || by0 < 2 || by1 > H - 2) continue;
      let hit = false;
      for (let q = 0, e = n * 4; q < e; q += 4)
        if (bx0 < boxes[q + 2] && bx1 > boxes[q] && by0 < boxes[q + 3] && by1 > boxes[q + 1]) {
          hit = true; break;
        }
      if (hit) continue;
      boxes[n * 4] = bx0; boxes[n * 4 + 1] = by0;
      boxes[n * 4 + 2] = bx1; boxes[n * 4 + 3] = by1;
      n++;
      names[drawn] = f.n; pos[drawn * 2] = sx; pos[drawn * 2 + 1] = sy;
      drawn++;
      g.save();
      g.translate(sx, sy);
      g.rotate(ang);
      g.lineWidth = 3 * dpr;
      g.strokeStyle = 'rgba(8,11,16,0.82)';      // the dark case, as the towns
      g.strokeText(f.n, 0, 0);
      g.fillStyle = '#dde4ef';
      g.fillText(f.n, 0, 0);
      g.restore();
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

    // co-op players, under our own arrow (ours is the one that must never be
    // covered) but over everything else on the map
    if (this._peers) this._drawPeers(g, W, H, k);

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

  // Co-op players, drawn the way the helicopter is (dark outline pass, icon
  // over it) so they read as chrome and not as map data. Two states, and the
  // second one is the one that matters in a 134 km world: a peer who is not on
  // the visible rectangle becomes a chevron clamped to the canvas edge on the
  // bearing to them, with the distance beside it — otherwise a friend two
  // villages away is simply absent from the only navigation the game has, and
  // zooming out to find them means losing the detail you zoomed in for.
  _drawPeers(g, W, H, k) {
    const dpr = this._dpr;
    const inset = PEER_INSET * dpr;
    const px = this._px, pz = this._pz, hasP = px !== undefined;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.font = this._pfont;
    for (const p of this._peers) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const s = this._peerScreen(p, W, H, k, inset);
      if (!s) continue;
      const sx = s.sx, sy = s.sy;
      const col = peerCss(p.color);
      const chased = !!p.uid && p.uid === this.followUid;
      const name = typeof p.name === 'string' ? p.name.slice(0, 14) : '';
      if (s.off) {
        const a = 7 * dpr;
        g.save();
        g.translate(sx, sy);
        // local +x points at the peer: the chevron is aimed along the bearing
        g.rotate(Math.atan2(sy - H / 2, sx - W / 2));
        g.beginPath();
        g.moveTo(a, 0);
        g.lineTo(-a * 0.6, a * 0.72);
        g.lineTo(-a * 0.2, 0);
        g.lineTo(-a * 0.6, -a * 0.72);
        g.closePath();
        g.lineWidth = 3.4 * dpr;
        g.strokeStyle = chased ? WP_COLOR : 'rgba(8,11,16,0.85)';
        g.stroke();
        g.fillStyle = col;
        g.fill();
        g.restore();
        continue;
      }
      const r = 5 * dpr;
      g.beginPath();
      g.arc(sx, sy, r * 1.9, 0, TAU);
      g.fillStyle = 'rgba(10,14,20,0.35)';       // halo, so a dot over a white
      g.fill();                                  // building still reads as a marker
      // the chase ring, in the waypoint's own yellow: the flag on the ground
      // and the person it is stuck to are the same destination, and they have
      // to look like it
      if (chased) {
        g.beginPath();
        g.arc(sx, sy, r * 2.5, 0, TAU);
        g.lineWidth = 2.2 * dpr;
        g.strokeStyle = WP_COLOR;
        g.stroke();
      }
      g.beginPath();
      g.arc(sx, sy, r, 0, TAU);
      g.fillStyle = col;
      g.fill();
      g.lineWidth = 1.8 * dpr;
      g.strokeStyle = 'rgba(8,11,16,0.9)';
      g.stroke();
      if (!name) continue;
      // The nickname arrives already filtered — netcity.sanitizeName runs on
      // receive, and it is the same body as nametags.clean. This module does
      // NOT re-run it: importing nametags.cleanName would drag three.js into a
      // canvas-only module that is otherwise headless-testable, and a fourth
      // hand-copied regex is exactly the drift nametags warns about. It goes
      // to strokeText, never to innerHTML.
      //
      // name above the dot, plus how far away they are — the number is what
      // turns "there they are" into "I can get there"
      let label = name;
      if (hasP) {
        const d = Math.hypot(p.x - px, p.z - pz);
        label += d >= 1000 ? '  ' + (d / 1000).toFixed(1) + ' km' : '  ' + Math.round(d) + ' m';
      }
      const ty2 = sy - r - 4 * dpr;
      g.lineWidth = 3.2 * dpr;
      g.strokeStyle = 'rgba(8,11,16,0.88)';
      g.strokeText(label, sx, ty2);
      g.fillStyle = '#f2f5fb';
      g.fillText(label, sx, ty2);
    }
  }

  // Head line: zoom and the distance to the waypoint. Both are rebuilt ONLY
  // when their rounded value changes — string building is an allocation, and
  // this runs every frame the map is open.
  _status() {
    const zr = Math.round(this.zoom * 10);
    let dr = -1;
    if (this.waypoint && this._px !== undefined)
      dr = Math.round(Math.hypot(this.waypoint.x - this._px, this.waypoint.z - this._pz) / 10);
    const pn = this._peers ? this._peers.length : 0;
    // The chase is part of the memo key, or picking a friend to follow would
    // leave the head line advertising the previous destination until the
    // distance happened to tick over.
    const fk = this.followUid ? this.followUid + '|' + this.followName : '';
    if (zr === this._zr && dr === this._dr && pn === this._pr && fk === this._fk) return;
    this._zr = zr; this._dr = dr; this._pr = pn; this._fk = fk;
    let txt = this.bs > 0 ? 'přiblížení ' + (zr / 10).toFixed(1) + '×' : 'vykresluji mapu…';
    if (dr >= 0) {
      const m = dr * 10;
      // While chasing, the destination has a name — "cíl 2.4 km" says nothing
      // about the fact that the 2.4 km is walking away from you.
      txt += ' · ' + (this.followUid ? 'sleduješ ' + (this.followName || 'hráče') + ' ' : 'cíl ')
        + (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m');
    }
    // the head count belongs on the map itself: this is where a player looks
    // to find out where everyone is, so it is also where "everyone" is counted
    if (pn > 0) txt += ' · ' + czPlayers(pn) + ' na mapě';
    this.stat.textContent = txt;
  }
}

const EMPTY_DASH = [];   // setLineDash([]) every frame would allocate; this does not

// Segment A→B clipped to a world rectangle (Liang–Barsky), as the parameter
// range that survives. The answer goes into a module-level scratch because
// this runs once per straight run of every named road in the window and a
// returned {t0,t1} would be an allocation per call.
const _clip = { t0: 0, t1: 0 };
function clipRect(ax, az, bx, bz, x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (let e = 0; e < 4; e++) {
    // p = the outward rate along this edge's normal, q = how far inside we start
    const p = e === 0 ? -dx : e === 1 ? dx : e === 2 ? -dz : dz;
    const q = e === 0 ? ax - x0 : e === 1 ? x1 - ax : e === 2 ? az - z0 : z1 - az;
    if (p === 0) { if (q < 0) return false; continue; }   // parallel and outside
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  if (t1 <= t0) return false;
  _clip.t0 = t0; _clip.t1 = t1;
  return true;
}

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
