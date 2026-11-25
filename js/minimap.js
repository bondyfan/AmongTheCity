// ---- Minimap: the HUD disc, crisp, turning with the camera ----------------------
// What it shows: the streets around you painted like a modern satnav (dark
// ground, the network graded by class, water, parks, buildings up close), the
// route still ahead of you in blue with an arrow at the next turn, traffic,
// gameplay marks, friends, the flag, and you.
//
// Why it is crisp now (it was a blur): the map is painted per 120 m chunk cell
// at the disc's own device resolution (js/maptiles.js) and laid 1:1 into one
// picture (js/mapwindow.js), instead of the old 0.42 px/m bitmap stretched
// five times; the canvas over it follows its CSS size times the pixel ratio.
//
// Two layers. The map picture sits in a div (#minimap-map) under the canvas
// and is moved, turned and zoomed by a CSS transform, so the compositor does
// that per frame, not the main thread. The canvas (#minimap) is transparent
// and carries only what changes every frame: the route ahead, traffic, marks,
// friends, names, the arrow and the rim.
//
// How it turns: the disc is heading-up. The camera's yaw is up, the map rotates
// under a fixed arrow, the way every car satnav and open-world radar works, so
// "left on the disc" is "left out of the windscreen". The arrow itself shows
// where the BODY points relative to the camera (a car skidding, a walker
// looking around).
//
// How it zooms: the view radius follows speed (mapstyle.viewRadiusFor), eased,
// so at a crawl you see the doors and at 130 km/h the next junction.
//
// Cost per frame: one style write, one route path stroked four times, a
// handful of dots and up to four names. Painting tiles happens inside a time
// budget (a fraction of a millisecond driving, more only when the disc would
// otherwise show a hole).

import { tilePpm, viewRadiusFor, VIEW_NEAR } from './mapstyle.js';
import { MapTiles, TILE_M } from './maptiles.js';
import { MapWindow, WINDOW_N } from './mapwindow.js';
import { StreetLabels } from './minimaplabels.js';
import { sliceAhead, blendStart, visibleCount } from './routeahead.js';
import { strokeRoute, drawTurnArrow } from './maproute.js';
import {
  drawCars, drawMarks, drawPeers, drawWaypoint, drawPlayerArrow, drawRim,
} from './minimapchrome.js';

const TAU = Math.PI * 2;
const ZOOM_RATE = 1.4;     // 1/s: how fast the view radius chases its target
const PAINT_IDLE = 0.9;    // ms of tile painting per frame when nothing is missing
const PAINT_HOLE = 6;      // …and when the disc would show a hole
const SL_MAX = 512;        // route points per frame, at most
const TA_MAX = 64;
const BLEND_M = 28;        // m over which the line bends from the arrow onto the route
const DPR_MAX = 2;

const dprNow = () => Math.min(DPR_MAX, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Minimap {
  constructor(canvas, city) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.city = city;
    this.waypoint = null;            // {x,z} mirrored from the world map, or null
    // Gameplay marks (job offers, your car, pumps): owned and rewritten in
    // place by js/career.js, read here by reference every frame.
    this.markers = null;
    this.nav = null;                 // js/navigation.js, for the route (setRoute)
    // the CSS size: from a ResizeObserver, else the size the page gave the
    // canvas at boot (a hidden page measures 0 and keeps this)
    this._css = canvas.clientWidth || canvas.width || 220;
    this._ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver((es) => {
        const w = es[0]?.contentRect?.width;
        if (w > 0) this._css = w;
      });
      this._ro.observe(canvas);
    }
    this._W = -1; this._dpr = 0; this._R = 0;
    this._viewR = VIEW_NEAR;
    this._t = 0;
    this.tiles = new MapTiles(city);
    this.labels = new StreetLabels(city);
    // the map layer: one picture under the canvas, moved by CSS (mapwindow.js)
    const doc = typeof document !== 'undefined' ? document : null;
    const winCv = doc ? doc.createElement('canvas') : { width: 0, height: 0, getContext: () => null };
    this.win = new MapWindow(this.tiles, winCv);
    this._layer = null;
    this._tr = '';
    this._winW = -1;
    if (doc && canvas.parentNode) {
      const layer = doc.createElement('div');
      layer.id = 'minimap-map';
      layer.appendChild(winCv);
      canvas.parentNode.insertBefore(layer, canvas);
      this._layer = layer;
    }
    this._last = { px: 0, pz: 0, rot: 0, k: 1 };    // for snapshot()
    this._taN = 0; this._taW = 0;                   // the turn arrow's slice, this frame
    // one transform record, rewritten each frame (see minimapchrome.js)
    this._T = { cx: 0, cy: 0, k: 1, c: 1, s: 0, ox: 0, oz: 0, rot: 0 };
    this._sl = { x: new Float64Array(SL_MAX), z: new Float64Array(SL_MAX), s: new Float64Array(SL_MAX) };
    this._ta = { x: new Float64Array(TA_MAX), z: new Float64Array(TA_MAX), s: new Float64Array(TA_MAX) };
    // new data in some chunk cells: only the tiles over them go stale, and the
    // street names are picked again from what is there now
    city.onTileLoaded?.((ev) => { this.tiles.invalidateCells(ev?.cells ?? null); this.labels.reset(); });
    city.onTileUnloaded?.((ev) => { this.tiles.invalidateCells(ev?.cells ?? null); });
    city.onTileReleased?.((ev) => { this.tiles.invalidateCells(ev?.cells ?? null); this.labels.reset(); });
  }

  // ---- waypoint: the world map's flag, mirrored onto the HUD ----
  // Stored BY REFERENCE: the world map owns the object and replaces it when it
  // moves. Anything that isn't a finite point means "no flag".
  setWaypoint(wp) {
    this.waypoint = wp && Number.isFinite(wp.x) && Number.isFinite(wp.z) ? wp : null;
  }

  /** Metres from (px, pz) to the flag, or null. */
  distanceTo(px, pz) {
    return this.waypoint ? Math.hypot(this.waypoint.x - px, this.waypoint.z - pz) : null;
  }

  /** The route source: js/navigation.js (route, routeCum, routeS, nextTurn). */
  setRoute(nav) { this.nav = nav || null; }

  // Backing store = CSS size × device pixel ratio, and everything derived
  // from the radius (fonts, glyph sizes, the cached gradients) with it.
  _size() {
    const dpr = dprNow();
    const W = Math.max(16, Math.round(this._css * dpr));
    if (W === this._W && dpr === this._dpr) return;
    this._W = W; this._dpr = dpr;
    const cv = this.canvas;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== W) cv.height = W;
    const R = this._R = W / 2 - Math.max(2, 1.5 * dpr);
    this.tiles.setPpm(tilePpm(R));
    this._sfs = Math.max(8 * dpr, Math.round(R * 0.085));
    this._sfont = '600 ' + this._sfs + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    this._pfont = '600 ' + Math.max(8 * dpr, Math.round(R * 0.095)) + 'px system-ui, sans-serif';
    this._badge = Math.max(6 * dpr, R * 0.085);
    this._nfont = '800 ' + Math.round(this._badge * 1.15) + 'px system-ui, sans-serif';
    this._arrow = Math.max(6 * dpr, R * 0.105);
    const g = this.g, c = W / 2;
    this._tr = '';                                  // the layer transform depends on the size
    const cg = g.createRadialGradient(c, c, 0, c, c, this._arrow * 5.5);
    cg.addColorStop(0, 'rgba(160, 205, 255, 0.20)');
    cg.addColorStop(1, 'rgba(160, 205, 255, 0)');
    this._cone = cg;
  }

  /**
   * Draw the disc centred on (px, pz). `heading` is the CAMERA yaw (it is what
   * main.js has always passed): the map turns so it points up. cars: any
   * iterable of {x, z}; peers: the co-op roster or null. opts (optional, may
   * be one reused object): { body: the player's or car's heading, speed: m/s }.
   */
  update(px, pz, heading, cars, peers = null, opts = null) {
    this._size();
    const W = this._W, R = this._R, dpr = this._dpr, g = this.g;
    if (R < 8) return;
    const t = nowMs();
    const dt = this._t ? Math.min(0.25, Math.max(0, (t - this._t) / 1000)) : 0;
    this._t = t;
    // ---- zoom with speed, eased ----
    const target = viewRadiusFor(opts?.speed ?? 0);
    this._viewR += (target - this._viewR) * (1 - Math.exp(-dt * ZOOM_RATE));
    const viewR = this._viewR, k = R / viewR;
    // ---- the transform every layer shares ----
    const rot = Number.isFinite(heading) ? heading : 0;
    const T = this._T;
    T.cx = W / 2; T.cy = W / 2; T.k = k; T.c = Math.cos(rot); T.s = Math.sin(rot);
    T.ox = px; T.oz = pz; T.rot = rot;
    // ---- tiles: the window's block nearest first, then the ring around it ----
    const tiles = this.tiles, win = this.win;
    const half = (WINDOW_N + 1) >> 1;               // the window's half, plus one ring
    const ptx = Math.floor(px / TILE_M), ptz = Math.floor(pz / TILE_M);
    const rVis = viewR * 1.02;
    let hole = false;
    for (let tx = ptx - half; tx <= ptx + half; tx++) for (let tz = ptz - half; tz <= ptz + half; tz++) {
      const d = rectDist(px, pz, tx * TILE_M, tz * TILE_M);
      const ring = Math.max(Math.abs(tx - ptx), Math.abs(tz - ptz)) === half;
      if (d <= rVis && !tiles.get(tx, tz)) hole = true;
      tiles.want(tx, tz, (ring ? 1e5 : 0) + d);
    }
    tiles.pump(hole ? PAINT_HOLE : PAINT_IDLE);
    // ---- the map layer: re-laid only on a new cell or a new tile, moved by CSS ----
    win.update(px, pz);
    if (this._layer) {
      const wcv = win.cv;
      if (wcv.width !== this._winW) {
        this._winW = wcv.width;
        wcv.style.width = wcv.style.height = (wcv.width / dpr) + 'px';
      }
      const tr = win.cssTransform(px, pz, rot, k, dpr, this._css / 2);
      if (tr !== this._tr) { wcv.style.transform = tr; this._tr = tr; }
    }
    const L = this._last;
    L.px = px; L.pz = pz; L.rot = rot; L.k = k;
    // ---- the canvas: transparent, only what moves ----
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath();
    g.arc(T.cx, T.cy, R, 0, TAU);
    g.clip();
    // ---- the route ahead, under everything that is navigation chrome ----
    this._drawRoute(g, T, R, px, pz, viewR, dpr);
    // ---- street names, traffic; then marks, friends, the flag, you ----
    this.labels.scan(px, pz, viewR);
    this.labels.draw(g, T, R, this._sfont, this._sfs, this._arrow * 1.3, true);
    // the manoeuvre arrow over the names: an instruction is never under text
    if (this._taN >= 2) drawTurnArrow(g, this._ta, this._taN, T, this._taW);
    drawCars(g, T, R, cars, px, pz, Math.max(3, 2.3 * dpr));
    g.restore();
    const ms = Math.max(3.5, R * 0.055);
    drawMarks(g, T, R, this.markers, px, pz, ms, this._arrow);
    if (peers) drawPeers(g, T, R, peers, px, pz, this._arrow, this._pfont);
    if (this.waypoint) drawWaypoint(g, T, R, this.waypoint, px, pz, this._arrow);
    const body = opts && Number.isFinite(opts.body) ? opts.body : rot;
    drawPlayerArrow(g, T, this._arrow, rot - body, this._cone);
    drawRim(g, T, R, this._nfont, this._badge);
  }

  /**
   * The disc as the player sees it, map layer and canvas composed into one
   * canvas (`out`, or a new one). For screenshots and tests: a hidden page has
   * no compositor to look at, and the canvas alone is transparent.
   */
  snapshot(out = null) {
    const W = this._W, L = this._last;
    const doc = typeof document !== 'undefined' ? document : null;
    const c = out ?? doc?.createElement('canvas');
    if (!c || W <= 0) return null;
    c.width = c.height = W;
    const g = c.getContext('2d');
    g.fillStyle = '#151a22';
    g.beginPath();
    g.arc(W / 2, W / 2, W / 2, 0, TAU);
    g.fill();
    g.save();
    g.clip();
    this.win.drawInto(g, L.px, L.pz, L.rot, L.k, W / 2, W / 2);
    g.restore();
    g.drawImage(this.canvas, 0, 0);
    return c;
  }

  // The road still ahead, from where navigation has you along it: nothing
  // behind the car, bent out of the arrow over the first metres, cut where it
  // has left the disc for good, and the next manoeuvre as a white arrow.
  _drawRoute(g, T, R, px, pz, viewR, dpr) {
    this._taN = 0;
    const nav = this.nav;
    const route = nav?.route, cum = nav?.routeCum;
    if (!route || !cum || cum.length !== route.length) return;
    const s0 = nav.routeS ?? 0;
    const sl = this._sl;
    let n = sliceAhead(route, cum, s0, viewR * 6, sl, SL_MAX, 0, nav.routeI ?? 0);
    if (n < 2) return;
    blendStart(sl, n, px - sl.x[0], pz - sl.z[0], BLEND_M);
    n = visibleCount(sl, n, px, pz, viewR * 1.15, viewR);
    // (drawn inside the disc clip update() holds)
    const w = Math.max(3 * dpr, R * 0.05);
    strokeRoute(g, sl, n, T, w);
    const turn = nav.nextTurn;
    if (turn && turn.dist > 3 && turn.dist < viewR * 1.2 && (turn.dir === 'left' || turn.dir === 'right')) {
      const back = 30 * dpr / T.k, fwd = 26 * dpr / T.k;
      const sT = s0 + turn.dist;
      const m = sliceAhead(route, cum, Math.max(s0, sT - back), back + fwd, this._ta, TA_MAX, 0, nav.routeI ?? 0);
      // drawn by update() after the street names
      if (m >= 2) { this._taN = m; this._taW = Math.max(2.2 * dpr, w * 0.62); }
    }
  }
}

// distance from (x, z) to the tile square at (x0, z0)
function rectDist(x, z, x0, z0) {
  const dx = x < x0 ? x0 - x : x > x0 + TILE_M ? x - x0 - TILE_M : 0;
  const dz = z < z0 ? z0 - z : z > z0 + TILE_M ? z - z0 - TILE_M : 0;
  return Math.sqrt(dx * dx + dz * dz);
}
