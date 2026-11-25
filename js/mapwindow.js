// ---- mapwindow: the HUD map as one picture the compositor moves -----------------
// Drawing a dozen tiles into the disc every frame, turned by the camera, cost
// about 1.5 ms of frame time (measured in the game, A/B within one drive): a
// rotated, filtered blit over the whole disc is raster work, and it happened
// sixty times a second for a picture that only moves. The old north-up blur
// cost nothing because it was one unrotated copy into a 220 px canvas.
//
// So the map is no longer drawn per frame at all. The tiles of an N×N block
// around the player (js/maptiles.js) are copied 1:1 onto whole pixels of ONE
// canvas, north up, and the page moves that canvas with a CSS transform:
// translate to the player, rotate by the camera, scale by the zoom. Turning,
// zooming and driving are then compositor work (GPU, off the main thread);
// the canvas itself changes only when the player crosses into another cell
// (the block is re-laid, every ~120 m) or a tile is painted (one copy).
//
// The per-frame cost is a style write. Everything that does change per frame
// (the route ahead, traffic, the arrow, street names) is drawn on the small
// transparent canvas above it (js/minimap.js).

import { TILE_M, bleedPx, tilePx } from './maptiles.js';

export const WINDOW_N = 5;       // tiles per side: ±240 m at least around the player

export class MapWindow {
  /**
   * @param tiles  a MapTiles
   * @param canvas the window canvas (any 2D-capable canvas; DOM or not)
   */
  constructor(tiles, canvas, n = WINDOW_N) {
    this.tiles = tiles;
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.n = n;
    this.tx0 = 1e9; this.tz0 = 1e9;   // tile index of the window's top-left cell
    this.ppm = 0;
    this._slotT = new Array(n * n).fill(null);   // the tile object copied into each slot…
    this._slotV = new Int32Array(n * n);         // …and its paint version then
    this.relaid = 0;                             // diagnostics: full re-lays
    this.copies = 0;                             // …and single tile copies
  }

  /** World x, z of the window canvas's pixel (0, 0). */
  get x0() { return this.tx0 * TILE_M; }
  get z0() { return this.tz0 * TILE_M; }

  /**
   * Keep the window centred on the cell holding (px, pz) and up to date with
   * the tile cache. Returns true when the canvas content changed.
   */
  update(px, pz) {
    if (!this.g) return false;                  // no canvas to lay into (headless)
    const n = this.n, half = (n - 1) >> 1;
    const ppm = this.tiles.ppm;
    const tx0 = Math.floor(px / TILE_M) - half, tz0 = Math.floor(pz / TILE_M) - half;
    let changed = false;
    if (tx0 !== this.tx0 || tz0 !== this.tz0 || ppm !== this.ppm) {
      const side = Math.round(n * TILE_M * ppm);
      if (this.cv.width !== side) { this.cv.width = side; this.cv.height = side; }
      else this.g.clearRect(0, 0, side, side);
      this.tx0 = tx0; this.tz0 = tz0; this.ppm = ppm;
      this._slotT.fill(null);
      this._slotV.fill(0);
      this.relaid++;
      changed = true;
    }
    // copy every tile that is new or repainted since its slot was filled
    const step = Math.round(TILE_M * ppm), b = bleedPx(ppm), size = tilePx(ppm);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const t = this.tiles.get(tx0 + i, tz0 + j);
      const s = j * n + i;
      if (!t || (this._slotT[s] === t && this._slotV[s] === t.ver)) continue;
      // whole pixels, 1:1: no resampling, so the map stays as sharp as painted
      this.g.drawImage(t.cv, i * step - b, j * step - b, size, size);
      this._slotT[s] = t; this._slotV[s] = t.ver;
      this.copies++;
      changed = true;
    }
    return changed;
  }

  /**
   * The CSS transform that puts world (px, pz) at the disc centre (cssC, cssC)
   * turned by `rot` and scaled so the map shows `k` device px per metre.
   * Composed right to left on the canvas's own CSS pixels (origin 0 0).
   */
  cssTransform(px, pz, rot, k, dpr, cssC) {
    const ppm = this.ppm || 1;
    const ux = (px - this.x0) * ppm / dpr, uz = (pz - this.z0) * ppm / dpr;
    return 'translate(' + cssC.toFixed(2) + 'px,' + cssC.toFixed(2) + 'px) rotate(' + rot.toFixed(5)
      + 'rad) scale(' + (k / ppm).toFixed(5) + ') translate(' + (-ux).toFixed(2) + 'px,' + (-uz).toFixed(2) + 'px)';
  }

  /** Draw the window into a 2D context exactly as the CSS transform shows it
   *  (screenshots and tests: a hidden page has no compositor to look at). */
  drawInto(g, px, pz, rot, k, cx, cy) {
    const ppm = this.ppm || 1;
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    g.scale(k / ppm, k / ppm);
    g.drawImage(this.cv, -(px - this.x0) * ppm, -(pz - this.z0) * ppm);
    g.restore();
  }
}
