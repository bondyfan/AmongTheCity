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

const OFF_PX = 2048;     // offscreen city bitmap resolution
const VIEW_R = 110;      // meters of world from the center to the rim
const RECENTER_M = 1500; // player drift from render center that forces a redraw
const TAU = Math.PI * 2;
// Waypoint yellow. Not from COLORS on purpose: the palette describes the
// WORLD (asphalt, water, plaster), while this is HUD chrome that must never
// blend into it — the same flag color the world map paints, so a glance at
// either surface reads as the same flag.
const WP_COLOR = '#ffd21a';

// 0xrrggbb → '#rrggbb' with an optional brightness factor. The 3D palette is
// tuned for sunlit asphalt; on a tiny map dark-on-dark vanishes, so drivable
// road classes get lifted to read as the familiar light web of streets.
function css(c, k = 1) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
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
      g.strokeStyle = css(COLORS.road[f.t] ?? COLORS.road.footway, 0.95);
      g.lineWidth = 0.9;
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
  update(px, pz, heading, cars) {
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
    // AI cars: 3 px white dots. Cheap radial gate instead of the (now popped)
    // clip — also keeps rim-grazing dots from poking past the circle.
    g.fillStyle = '#f2f2ee';
    const gate = VIEW_R * 0.97;
    for (const c of cars) {
      const dx = c.x - px, dz = c.z - pz;
      if (dx * dx + dz * dz > gate * gate) continue;
      g.fillRect(cx + dx * k - 1.5, cy + dz * k - 1.5, 3, 3);
    }
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
}
