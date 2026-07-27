// ---- Minimap: circular HUD map, pre-rendered to a sliding window ----
// The city vector set (water, parks, buildings, every road) is rasterized
// into a 2048² offscreen canvas at map scale — a few ms per render. Per frame
// the HUD only blits a translated, scaled window of that bitmap through a
// circular clip: one drawImage plus a handful of dots, no polygon is ever
// re-drawn while playing. North stays up (the map never rotates); the player
// arrow does the turning, AI cars ride on top as dots. World→canvas is
// trivial here because z is SOUTH: world +z maps straight to canvas +y and
// north lands at the top for free.
//
// Region mode: the world now streams in as tiles and outgrows any single
// bitmap (30×38 km at 2048 px would be ~0.05 px/m — mush), so the offscreen
// canvas became a fixed-scale WINDOW: it re-renders (debounced) whenever a
// tile lands, and RECENTERS on the player once they stray >1500 m from the
// last render center. The px/m scale never changes after boot, so the blit
// math in update() is untouched — only minX/minZ slide.

import { COLORS } from './config.js';
import { forEachChunkInRadius } from './geo.js';

// Aeroway lines live in the road layer (see build-region.mjs) but are drawn at
// their real width — a runway is the clearest landmark an air map has.
const AERO_CLASS = /^(runway|taxiway|taxilane|airstrip)$/;

const OFF_PX = 2048;     // offscreen city bitmap resolution
const VIEW_R = 110;      // meters of world from the center to the rim
const RECENTER_M = 1500; // player drift from render center that forces a redraw
const TAU = Math.PI * 2;
// Waypoint yellow. Not from COLORS on purpose: the palette describes the
// WORLD (asphalt, water, plaster), while this is HUD chrome that must never
// blend into it — the same flag color the world map paints, so a glance at
// either surface reads as the same flag.
const WP_COLOR = '#ffd21a';
// A co-op player with no colour of their own. Peers are normally painted in
// their JACKET colour — the same number identity.js gives their avatar — so
// the dot on the map, the name over their head and the person you can see
// across the square are one colour by construction.
const PEER_FALLBACK = '#7fd8ff';

// ---- street labels ------------------------------------------------------
// Roads carry `n` on every named street (~23 % of the ways; the rest are
// service aisles and footpaths). A name is only worth ink if it fits ALONG
// the road it names, so the whole feature is one question asked per road:
// what is the longest straight, VISIBLE run of this polyline, and is the name
// narrower than that run is wide on screen? If it is not, the road stays
// anonymous — a name spilling past its own street points at the wrong street.
//
// The class list stops at `residential` (contract): a 110 m circle has room
// for about four names, and one spent on a parking aisle is one not spent on
// the street you are actually driving down. The rank doubles as the draw
// priority, so a trunk road outbids a cul-de-sac for the same pixels.
const ST_RANK = {
  motorway: 0, trunk: 0, primary: 1, secondary: 1,
  tertiary: 2, unclassified: 3, residential: 3,
};
const ST_MAX = 4;        // names drawn per frame — the whole map is 220 px wide
const ST_CAND = 16;      // candidates the scan keeps, best first
const ST_SCAN_M = 10;    // player travel (m) that re-runs the scan
const ST_CHUNK_R = 2;    // chunk rings scanned: ≥ 240 m each way vs a 110 m view
const ST_TURN = 0.28;    // rad a run may bend and still be laid out as one chord
const ST_PAD = 5;        // px of road demanded past each end of the name
const ST_RANK_M = 120;   // metres of "importance" one class rank is worth
const ST_VIEW_K = 0.94;  // names keep this far off the rim (chrome lives there)

// Segment A→B clipped to the view circle, as the parameter range that survives.
// Written into a module-level scratch because this runs inside the scan loop
// and a returned {t0,t1} would be an allocation per road per rescan.
const _clip = { t0: 0, t1: 0 };
function clipCircle(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax, dz = bz - az;
  const A = dx * dx + dz * dz;
  if (A < 1e-9) return false;
  const fx = ax - cx, fz = az - cz;
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return false;                 // the chord misses the circle
  const sd = Math.sqrt(disc), inv = 0.5 / A;
  let t0 = (-B - sd) * inv, t1 = (-B + sd) * inv;
  if (t0 < 0) t0 = 0;
  if (t1 > 1) t1 = 1;
  if (t1 <= t0) return false;                  // …or only misses it off the ends
  _clip.t0 = t0; _clip.t1 = t1;
  return true;
}

// 0xrrggbb → '#rrggbb' with an optional brightness factor. The 3D palette is
// tuned for sunlit asphalt; on a tiny map dark-on-dark vanishes, so drivable
// road classes get lifted to read as the familiar light web of streets.
function css(c, k = 1) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// A peer's colour may arrive as 0xrrggbb (the jacket palette) or as a css
// string. Anything else — including a string that is not obviously a colour —
// falls back, because this value goes straight into a canvas fillStyle and an
// unparsable one silently keeps the PREVIOUS fill, painting a peer in whatever
// colour happened to be set last.
const SAFE_CSS_COLOR = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i;
function peerCss(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return css(c >>> 0);
  if (typeof c === 'string' && SAFE_CSS_COLOR.test(c.trim())) return c.trim();
  return PEER_FALLBACK;
}

export class Minimap {
  constructor(canvas, city) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.city = city;              // re-renders read the LIVE arrays — they grow
    this.off = document.createElement('canvas');
    this.off.width = this.off.height = OFF_PX;
    // the void past the city edge is painted in the map's own base color so
    // the bitmap boundary is invisible when the player nears the extract rim
    this._bg = css(COLORS.groundBase, 0.92);
    this._R = -1;                    // cached HUD radius → font/arrow sizes
    this._renderT = 0;               // pending debounced-render timer (0 = none)
    this.waypoint = null;            // {x,z} mirrored from the world map, or null
    // ---- street-label state (see _scanStreets / _drawStreets) ----
    // Every array here is allocated ONCE and rewritten in place: labels are
    // the only per-frame loop in this file that could otherwise allocate.
    this._stN = 0;                              // live candidates
    this._stRoad = new Array(ST_CAND).fill(null);
    this._st = new Float64Array(ST_CAND * 4);   // mx, mz, angle, visible metres
    this._stScore = new Float64Array(ST_CAND);
    this._stStamp = 0;                          // dedupe id of the current scan
    this._stX = 1e9; this._stZ = 1e9;           // where the last scan ran…
    this._stK = 0;                              // …and at what px/m
    this._stBox = new Float64Array(ST_MAX * 4); // AABBs of the names drawn now
    this._stDrawn = new Array(ST_MAX).fill('');
    this._sfont = ''; this._sfs = 10;
    // bound once so the chunk walk costs no closure per scan
    this._stCell = (key) => this._scanCell(key);
    this._bounds(city);
    this._prerender(city);
    // region tiles stream in while driving — redraw the bitmap when new data
    // lands, debounced 2 s so a burst of neighbouring tiles costs ONE render.
    // (Legacy single-file mode registers too and simply never fires.)
    city.onTileLoaded?.(() => {
      clearTimeout(this._renderT);
      this._renderT = setTimeout(() => { this._renderT = 0; this._prerender(this.city); }, 2000);
    });
  }

  // Square world window covering every feature loaded SO FAR (roads reach the
  // furthest). Falls back to ±2400 m around the origin — the size of the old
  // single-city extract AND of the empty-at-boot manifest world (spawn sits
  // near the origin), which lands at ~0.42 px/m. This initial span fixes the
  // px/m scale for good; later renders only slide the window, never rezoom.
  _bounds(city) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const scan = (pts) => {
      for (const [x, z] of pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    };
    for (const f of city.roads ?? []) scan(f.p);
    for (const f of city.water ?? []) scan(f.o);
    for (const f of city.green ?? []) scan(f.o);
    if (maxX < minX) { minX = minZ = -2400; maxX = maxZ = 2400; }
    const span = Math.max(maxX - minX, maxZ - minZ) + 120; // 60 m breathing room
    this.span = span;
    this.minX = (minX + maxX - span) / 2;
    this.minZ = (minZ + maxZ - span) / 2;
    this._cx = this.minX + span / 2; // world point the bitmap was rendered around
    this._cz = this.minZ + span / 2;
    this.s = OFF_PX / span;          // offscreen px per meter
  }

  // Slide the fixed-scale window so the player sits at its center, then
  // redraw right away — update() blits from this bitmap on the very next
  // frame, so a debounce here would show the void past the old window edge.
  _recenter(px, pz) {
    this._cx = px; this._cz = pz;
    this.minX = px - this.span / 2;
    this.minZ = pz - this.span / 2;
    clearTimeout(this._renderT);     // this render is fresher than any pending one
    this._renderT = 0;
    this._prerender(this.city);
  }

  _prerender(city) {
    // A bitmap refresh means the world changed under us (a tile landed, or we
    // recentered), so the street-label candidates are stale too — force the
    // next frame to rescan instead of naming roads picked from the old data.
    this._stX = 1e9;
    const g = this.off.getContext('2d'), s = this.s, mx = this.minX, mz = this.minZ;
    // With the whole region loaded the arrays hold far more than one window
    // shows — cache each feature's bbox on first sight (one tiny array per
    // feature, once ever) and O(1)-reject anything that can't touch the
    // window. 100 m pad covers stroke widths at this scale many times over.
    const x1 = mx - 100, z1 = mz - 100, x2 = mx + this.span + 100, z2 = mz + this.span + 100;
    const vis = (f, pts) => {
      let bb = f._mmbb;
      if (!bb) {
        let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
        for (const [x, z] of pts) { if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z; }
        bb = f._mmbb = [a, b, c, d];
      }
      return bb[2] >= x1 && bb[0] <= x2 && bb[3] >= z1 && bb[1] <= z2;
    };
    const ring = (r) => {
      for (let i = 0; i < r.length; i++) {
        const px = (r[i][0] - mx) * s, py = (r[i][1] - mz) * s;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath();
    };
    const poly = (f, color) => {     // holes via even-odd: outer + inner rings
      g.beginPath();
      ring(f.o);
      for (const h of f.i ?? []) ring(h);
      g.fillStyle = color;
      g.fill('evenodd');
    };
    const line = (p) => {
      g.beginPath();
      for (let i = 0; i < p.length; i++) {
        const px = (p[i][0] - mx) * s, py = (p[i][1] - mz) * s;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke();
    };
    g.fillStyle = this._bg;
    g.fillRect(0, 0, OFF_PX, OFF_PX);
    g.lineJoin = g.lineCap = 'round';
    for (const f of city.green ?? []) if (vis(f, f.o)) poly(f, css(COLORS.green[f.t] ?? COLORS.green.grass, 0.9));
    for (const f of city.paved ?? []) if (vis(f, f.o)) poly(f, css(COLORS.paved[f.t] ?? COLORS.paved.parking));
    for (const f of city.water ?? []) if (vis(f, f.o)) poly(f, css(COLORS.water, 0.85));
    // waterway polylines (the Chrudimka arms, mill races) at their real width
    g.strokeStyle = css(COLORS.water, 0.85);
    for (const f of city.waterways ?? []) {
      if (!vis(f, f.p)) continue;
      g.lineWidth = Math.max((f.w ?? 4) * s, 1.2);
      line(f.p);
    }
    // buildings: outer ring only — at 0.4 px/m courtyard holes are sub-pixel
    g.fillStyle = '#c6c2b8';
    for (const f of city.buildings ?? []) { if (!vis(f, f.o)) continue; g.beginPath(); ring(f.o); g.fill(); }
    // rails: a thin dark thread so the station corridor reads on the map
    g.strokeStyle = css(COLORS.rail, 1.6);
    g.lineWidth = 1.1;
    for (const f of city.rails ?? []) if (vis(f, f.p)) line(f.p);
    // roads in two passes: faint footpaths under, lifted drivable web on top
    for (const f of city.roads ?? []) {
      if (f.d || !vis(f, f.p)) continue;
      // A runway rides the road layer with d:0 so no car ever queues for
      // take-off — but it is 45 m of concrete, not a footpath, and drawing it
      // as a 0.9 px hairline would hide the most legible landmark on the map.
      const aero = AERO_CLASS.test(f.t);
      g.strokeStyle = css(COLORS.road[f.t] ?? COLORS.road.footway, aero ? 1.4 : 0.95);
      g.lineWidth = aero ? Math.max((f.w ?? 20) * s, 1.6) : 0.9;
      line(f.p);
    }
    for (const f of city.roads ?? []) {
      if (!f.d || !vis(f, f.p)) continue;
      g.strokeStyle = css(COLORS.road[f.t] ?? COLORS.road.residential, 1.55);
      g.lineWidth = Math.max((f.w ?? 6) * s, 2.2);
      line(f.p);
    }
  }

  // ---- waypoint: the world map's flag, mirrored onto the HUD ----
  // The point is stored BY REFERENCE, not copied: the world map owns the
  // object, main.js is free to push it every frame, and one small allocation
  // per frame is exactly what this file refuses to do. Anything that isn't a
  // finite point (null, a cleared waypoint, a bad click) means "no flag", so
  // the draw path below never has to defend itself.
  setWaypoint(wp) {
    this.waypoint = wp && Number.isFinite(wp.x) && Number.isFinite(wp.z) ? wp : null;
  }

  // Meters from (px,pz) to the flag, or null when there is none. The HUD
  // prints this readout, so the distance math lives in exactly ONE place and
  // can never disagree with the arrow drawn from the same waypoint.
  distanceTo(px, pz) {
    return this.waypoint ? Math.hypot(this.waypoint.x - px, this.waypoint.z - pz) : null;
  }

  // Blit the pre-rendered city so (px,pz) sits dead center, then decorate.
  // cars is any iterable of {x,z} (the Traffic set passes straight through).
  // peers is the co-op roster — an array of {uid, name, x, z, color} — drawn
  // as coloured dots inside the window and as rim chevrons outside it. Omit it
  // (single player) and nothing about this method changes.
  update(px, pz, heading, cars, peers = null) {
    const cv = this.canvas, g = this.g;
    const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
    const R = Math.min(cx, cy) - 2;          // rim radius, 2 px border padding
    if (R < 8) return;                       // hidden/collapsed canvas — skip
    // the bitmap is a fixed-scale window: once the player walks far enough
    // from where it was rendered, recenter + redraw. span/2 ≈ 2460 m, so the
    // circle rim always has ≥ ~850 m of drawn map beyond it after a recenter.
    const ox = px - this._cx, oz = pz - this._cz;
    if (ox * ox + oz * oz > RECENTER_M * RECENTER_M) this._recenter(px, pz);
    if (R !== this._R) {                     // cache size-derived strings once,
      this._R = R;                           // not every frame
      this._font = 'bold ' + Math.max(9, Math.round(R * 0.16)) + 'px system-ui, sans-serif';
      this._pfont = 'bold ' + Math.max(8, Math.round(R * 0.105)) + 'px system-ui, sans-serif';
      // Street names are the quietest text on the map — they label the ground
      // rather than announce anything — so they run a notch under the peer
      // tags and at 600 rather than bold, which keeps a 12-letter Czech name
      // inside the 60-odd metres of straight street a HUD circle ever shows.
      this._sfs = Math.max(8, Math.round(R * 0.092));
      this._sfont = '600 ' + this._sfs + 'px system-ui, sans-serif';
      this._arrow = Math.max(6, R * 0.10);
    }
    const k = R / VIEW_R;                    // screen px per meter
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();
    g.fillStyle = this._bg;
    g.fillRect(0, 0, w, h);
    // one drawImage does the whole city: scale offscreen px → screen px, then
    // slide the player's map position into the circle center
    g.translate(cx, cy);
    g.scale(k / this.s, k / this.s);
    g.drawImage(this.off, -(px - this.minX) * this.s, -(pz - this.minZ) * this.s);
    g.restore();
    // Street names go on straight after the city and BEFORE every marker: the
    // dots, the arrow and the flag are navigation, and navigation is never
    // allowed to end up underneath a piece of text. Re-picking which streets
    // are worth naming is gated on real movement — a set that reshuffled every
    // frame would flicker, and a name that flickers is unreadable.
    const sdx = px - this._stX, sdz = pz - this._stZ;
    if (k !== this._stK || sdx * sdx + sdz * sdz > ST_SCAN_M * ST_SCAN_M)
      this._scanStreets(px, pz, k);
    this._drawStreets(g, cx, cy, R, k, px, pz);
    // AI cars: 3 px white dots. Cheap radial gate instead of the (now popped)
    // clip — also keeps rim-grazing dots from poking past the circle.
    g.fillStyle = '#f2f2ee';
    const gate = VIEW_R * 0.97;
    for (const c of cars) {
      const dx = c.x - px, dz = c.z - pz;
      if (dx * dx + dz * dz > gate * gate) continue;
      g.fillRect(cx + dx * k - 1.5, cy + dz * k - 1.5, 3, 3);
    }
    // co-op players, under the player's own arrow but over the traffic dots —
    // a friend must never be hidden by an AI car sharing the same pixel
    if (peers) this._drawPeers(g, cx, cy, R, k, px, pz, peers);
    // player arrow: the map stays north-up, so the arrow does the turning.
    // heading 0 faces −z = north = screen up; canvas y is world +z, which
    // makes the canvas rotation −heading (check: heading π/2 → dir (−1,0) =
    // west → arrow points screen-left ✓).
    const a = this._arrow;
    g.save();
    g.translate(cx, cy);
    g.rotate(-heading);
    g.beginPath();
    g.moveTo(0, -a);
    g.lineTo(a * 0.7, a * 0.8);
    g.lineTo(0, a * 0.42);                   // notched tail reads as direction
    g.lineTo(-a * 0.7, a * 0.8);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(20,24,28,0.85)';
    g.stroke();
    g.restore();
    // waypoint: a yellow diamond sitting on its map position while the flag is
    // inside the 110 m window, and — because at region scale it is off the
    // window nearly always — a chevron clamped to the rim on the same bearing
    // otherwise, so the direction to it is readable even from 20 km away.
    // North-up map ⇒ no rotation by heading here, only the bearing itself.
    // The blit's clip was popped above (cars use a radial gate instead), so
    // re-arm one: the rim chevron straddles the ring and its stroke would
    // spill outside the circle into the 3D view without it.
    if (this.waypoint) {
      const wx = (this.waypoint.x - px) * k, wz = (this.waypoint.z - pz) * k;
      const d = Math.hypot(wx, wz);
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, TAU);
      g.clip();
      g.translate(cx, cy);
      g.fillStyle = WP_COLOR;
      g.strokeStyle = 'rgba(38,30,4,0.9)';
      g.lineWidth = 1.2;
      if (d < R - a * 0.9) {                 // whole diamond fits inside the rim
        const s = a * 0.72;
        g.beginPath();
        g.moveTo(wx, wz - s);
        g.lineTo(wx + s * 0.72, wz);
        g.lineTo(wx, wz + s);
        g.lineTo(wx - s * 0.72, wz);
        g.closePath();
        g.fill();
        g.stroke();
        g.beginPath();                       // dark eye — reads as a marker, not a dot
        g.arc(wx, wz, Math.max(1, s * 0.26), 0, TAU);
        g.fillStyle = 'rgba(38,30,4,0.9)';
        g.fill();
      } else {
        // slide onto the rim along the same bearing, far enough in that the
        // chevron's own tip (+0.8a) and stroke stay inside the ring uncut
        const len = d || 1, rr = R - a * 0.95;
        g.translate(wx / len * rr, wz / len * rr);
        g.rotate(Math.atan2(wz, wx));        // local +x now points at the flag
        const s = a * 0.8;
        g.beginPath();
        g.moveTo(s, 0);                      // tip outward, notched tail like the player arrow
        g.lineTo(-s * 0.55, s * 0.72);
        g.lineTo(-s * 0.18, 0);
        g.lineTo(-s * 0.55, -s * 0.72);
        g.closePath();
        g.fill();
        g.stroke();
      }
      g.restore();
    }
    // rim ring + north tick at the top of the circle
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(16,20,26,0.75)';
    g.stroke();
    g.fillStyle = '#e9e7df';
    g.font = this._font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', cx, cy - R + Math.max(7, R * 0.12));
  }

  // ---- co-op peers ----
  // Inside the 110 m window a peer is a dot in their jacket colour with their
  // name under it. Outside it — which, in a world 134 km across, is nearly
  // always — they become a chevron pinned to the rim on the same bearing, the
  // waypoint's own trick: the HUD map is the only navigation the game has, and
  // "your friend is that way" is the single most useful thing it can say.
  //
  // The clip is re-armed here because the blit's was popped after the city
  // drawImage (traffic dots use a radial gate instead); without it a rim
  // chevron's stroke and a long nickname would spill out of the circle and
  // into the 3D view.
  _drawPeers(g, cx, cy, R, k, px, pz, peers) {
    const a = this._arrow;
    const rim = R - a * 0.95;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();
    g.lineJoin = 'round';
    for (const p of peers) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const dx = (p.x - px) * k, dz = (p.z - pz) * k;
      const d = Math.hypot(dx, dz);
      const col = peerCss(p.color);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(10,14,20,0.9)';
      g.lineWidth = 1.4;
      if (d < rim) {
        const r = Math.max(2.6, a * 0.42);
        g.beginPath();
        g.arc(cx + dx, cy + dz, r, 0, TAU);
        g.fill();
        g.stroke();
        // the nickname, outlined the way the name tags are: a light label on a
        // light map needs the dark rim, not a panel behind it
        const name = typeof p.name === 'string' ? p.name.slice(0, 14) : '';
        if (name) {
          g.font = this._pfont;
          g.textAlign = 'center';
          g.textBaseline = 'top';
          g.lineWidth = 3;
          g.strokeStyle = 'rgba(8,11,16,0.9)';
          g.strokeText(name, cx + dx, cy + dz + r + 1.5);
          g.fillStyle = '#f2f5fb';
          g.fillText(name, cx + dx, cy + dz + r + 1.5);
        }
      } else {
        const len = d || 1, s = a * 0.72;
        g.save();
        g.translate(cx + dx / len * rim, cy + dz / len * rim);
        g.rotate(Math.atan2(dz, dx));      // local +x now points at the peer
        g.beginPath();
        g.moveTo(s, 0);
        g.lineTo(-s * 0.6, s * 0.72);
        g.lineTo(-s * 0.2, 0);             // notched tail, same shape as the flag chevron
        g.lineTo(-s * 0.6, -s * 0.72);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
      }
    }
    g.restore();
  }

  // ---- street labels ----------------------------------------------------

  // Re-pick the streets worth naming around (px, pz). The region holds a
  // quarter of a million ways and this runs while the player drives, so the
  // scan goes through the CHUNK INDEX — ST_CHUNK_R rings of 120 m cells, a few
  // hundred road references — and never through city.roads. Candidates are
  // kept best-first by a bounded insertion, so the frame loop can stop at the
  // first ST_MAX that fit and know it stopped on the most important ones.
  _scanStreets(px, pz, k) {
    this._stN = 0;
    this._stX = px; this._stZ = pz; this._stK = k;
    if (!this.city?.chunkIndex) return;
    this._stStamp++;
    forEachChunkInRadius(px, pz, ST_CHUNK_R, this._stCell);
  }

  // One chunk cell of the scan. A feature is bucketed into EVERY cell its
  // bbox touches (geo.bucketize), so a long avenue turns up four or five times
  // — the stamp is the dedupe, and it is a plain number on the feature so no
  // Set is allocated per scan.
  _scanCell(key) {
    const cell = this.city.chunkIndex.get(key);
    if (!cell) return;
    const stamp = this._stStamp;
    for (const f of cell.roads) {
      if (!f.n || f._mmSt === stamp) continue;
      f._mmSt = stamp;
      const rank = ST_RANK[f.t];
      if (rank === undefined) continue;        // below residential — not on a HUD
      this._consider(f, rank);
    }
  }

  // The best placement for ONE road: the longest straight run of its polyline,
  // clipped to the view circle. Consecutive segments whose bearing stays
  // within ST_TURN of the run's first are ONE run — OSM chops a street at
  // every driveway, so laying a name on a single segment would fit almost
  // nothing (measured over the real tiles: the longest single segment of a
  // named way is 45–69 m at the median, the longest run 58–114 m). At 0.28 rad
  // the arc's own bulge away from its chord is under 4 % of the chord, which
  // is well inside the stroke of the road it is written on.
  _consider(f, rank) {
    const p = f.p, n = p.length;
    if (n < 2) return;
    const px = this._stX, pz = this._stZ, r = VIEW_R * ST_VIEW_K;
    let bestL = 0, bmx = 0, bmz = 0, bang = 0;
    for (let i = 0; i < n - 1;) {
      const ax = p[i][0], az = p[i][1];
      const a0 = Math.atan2(p[i + 1][1] - az, p[i + 1][0] - ax);
      let j = i + 1;
      while (j < n - 1) {
        let d = Math.atan2(p[j + 1][1] - p[j][1], p[j + 1][0] - p[j][0]) - a0;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        if (d > ST_TURN || d < -ST_TURN) break;
        j++;
      }
      const bx = p[j][0], bz = p[j][1];
      if (clipCircle(ax, az, bx, bz, px, pz, r)) {
        const dx = bx - ax, dz = bz - az;
        const chord = Math.sqrt(dx * dx + dz * dz);
        const L = chord * (_clip.t1 - _clip.t0);
        if (L > bestL) {
          bestL = L;
          const t = (_clip.t0 + _clip.t1) / 2;  // centre of the VISIBLE part
          bmx = ax + dx * t; bmz = az + dz * t;
          // Never upside down: mirroring the direction turns the same line
          // through 180°, which leaves the text on the road but the right way
          // up. atan2 of a non-negative x is always within ±90°.
          bang = dx < 0 ? Math.atan2(-dz, -dx) : Math.atan2(dz, dx);
        }
      }
      i = j > i + 1 ? j : i + 1;               // runs share their joint
    }
    if (bestL <= 0) return;
    // Class beats length, but only by ST_RANK_M worth of it — a residential
    // street you can see all of still outranks a trunk road showing 20 m.
    const score = bestL + (3 - rank) * ST_RANK_M;
    const cand = this._st, sc = this._stScore;
    let at = this._stN;
    if (at >= ST_CAND) { if (score <= sc[ST_CAND - 1]) return; at = ST_CAND - 1; }
    else this._stN++;
    while (at > 0 && sc[at - 1] < score) {     // shift the weaker ones down
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

  // Lay the surviving names along their streets. Three rejections, in the
  // order that costs least: the name must FIT the drawn run (measureText, the
  // one call here that would allocate, so the width is memoised per road per
  // font), its box must sit wholly inside the ring, and it must not touch a
  // box already placed this frame.
  _drawStreets(g, cx, cy, R, k, px, pz) {
    if (!this._stN) return;
    const st = this._st, boxes = this._stBox, drawn = this._stDrawn;
    const font = this._sfont, hh = this._sfs * 0.62, rim = R - 3;
    let n = 0;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (let i = 0; i < this._stN && n < ST_MAX; i++) {
      const f = this._stRoad[i], b = i * 4;
      // memo keys are minimap-private: the world map measures the SAME roads
      // at its own font, and one shared cache would make the two thrash
      if (f._mmLF !== font) { f._mmLW = g.measureText(f.n).width; f._mmLF = font; }
      const w = f._mmLW;
      if (w + ST_PAD * 2 > st[b + 3] * k) continue;   // longer than its street
      // one name per street: OSM splits a single street into a dozen ways, and
      // a 220 px circle reading "Sladkovského" three times is not a map
      let dup = false;
      for (let q = 0; q < n; q++) if (drawn[q] === f.n) { dup = true; break; }
      if (dup) continue;
      const sx = cx + (st[b] - px) * k, sy = cy + (st[b + 1] - pz) * k;
      const ang = st[b + 2], ca = Math.cos(ang), sa = Math.sin(ang);
      // AABB of the ROTATED box — conservative on both tests below, which is
      // the right way round: it never lets a name overlap or overhang.
      const ex = Math.abs(ca) * w / 2 + Math.abs(sa) * hh;
      const ey = Math.abs(sa) * w / 2 + Math.abs(ca) * hh;
      const ox = sx - cx, oy = sy - cy;
      const fx = Math.abs(ox) + ex, fy = Math.abs(oy) + ey;   // furthest corner
      if (fx * fx + fy * fy > rim * rim) continue;   // a name the rim cuts in half
      let hit = false;
      for (let q = 0, e = n * 4; q < e; q += 4)
        if (sx - ex < boxes[q + 2] && sx + ex > boxes[q]
          && sy - ey < boxes[q + 3] && sy + ey > boxes[q + 1]) { hit = true; break; }
      if (hit) continue;
      boxes[n * 4] = sx - ex; boxes[n * 4 + 1] = sy - ey;
      boxes[n * 4 + 2] = sx + ex; boxes[n * 4 + 3] = sy + ey;
      drawn[n] = f.n;
      n++;
      g.save();
      g.translate(sx, sy);
      g.rotate(ang);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(12,16,22,0.85)';   // the dark case, as the peer tags
      g.strokeText(f.n, 0, 0);
      g.fillStyle = '#eef1f6';
      g.fillText(f.n, 0, 0);
      g.restore();
    }
    g.restore();
  }
}
