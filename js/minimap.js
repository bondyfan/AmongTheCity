// ---- Minimap: circular HUD map of the whole city, pre-rendered once ----
// The full Pardubice vector set (water, parks, buildings, every road) is
// rasterized ONE time into a 2048² offscreen canvas at map scale — a few ms at
// boot. Per frame the HUD only blits a translated, scaled window of that
// bitmap through a circular clip: one drawImage plus a handful of dots, no
// polygon is ever re-drawn while playing. North stays up (the map never
// rotates); the player arrow does the turning, AI cars ride on top as dots.
// World→canvas is trivial here because z is SOUTH: world +z maps straight to
// canvas +y and north lands at the top for free.

import { COLORS } from './config.js';

const OFF_PX = 2048;   // offscreen city bitmap resolution
const VIEW_R = 110;    // meters of world from the center to the rim
const TAU = Math.PI * 2;

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
    this.off = document.createElement('canvas');
    this.off.width = this.off.height = OFF_PX;
    // the void past the city edge is painted in the map's own base color so
    // the bitmap boundary is invisible when the player nears the extract rim
    this._bg = css(COLORS.groundBase, 0.92);
    this._R = -1;                    // cached HUD radius → font/arrow sizes
    this._bounds(city);
    this._prerender(city);
  }

  // Square world window covering every feature (roads reach the furthest), so
  // the scale adapts if the extract ever grows. Falls back to ±2400 m around
  // the origin — the intended extract size, which lands at ~0.43 px/m.
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
    this.minX = (minX + maxX - span) / 2;
    this.minZ = (minZ + maxZ - span) / 2;
    this.s = OFF_PX / span;          // offscreen px per meter
  }

  _prerender(city) {
    const g = this.off.getContext('2d'), s = this.s, mx = this.minX, mz = this.minZ;
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
    for (const f of city.green ?? []) poly(f, css(COLORS.green[f.t] ?? COLORS.green.grass, 0.9));
    for (const f of city.paved ?? []) poly(f, css(COLORS.paved[f.t] ?? COLORS.paved.parking));
    for (const f of city.water ?? []) poly(f, css(COLORS.water, 0.85));
    // waterway polylines (the Chrudimka arms, mill races) at their real width
    g.strokeStyle = css(COLORS.water, 0.85);
    for (const f of city.waterways ?? []) {
      g.lineWidth = Math.max((f.w ?? 4) * s, 1.2);
      line(f.p);
    }
    // buildings: outer ring only — at 0.4 px/m courtyard holes are sub-pixel
    g.fillStyle = '#c6c2b8';
    for (const f of city.buildings ?? []) { g.beginPath(); ring(f.o); g.fill(); }
    // rails: a thin dark thread so the station corridor reads on the map
    g.strokeStyle = css(COLORS.rail, 1.6);
    g.lineWidth = 1.1;
    for (const f of city.rails ?? []) line(f.p);
    // roads in two passes: faint footpaths under, lifted drivable web on top
    for (const f of city.roads ?? []) {
      if (f.d) continue;
      g.strokeStyle = css(COLORS.road[f.t] ?? COLORS.road.footway, 0.95);
      g.lineWidth = 0.9;
      line(f.p);
    }
    for (const f of city.roads ?? []) {
      if (!f.d) continue;
      g.strokeStyle = css(COLORS.road[f.t] ?? COLORS.road.residential, 1.55);
      g.lineWidth = Math.max((f.w ?? 6) * s, 2.2);
      line(f.p);
    }
  }

  // Blit the pre-rendered city so (px,pz) sits dead center, then decorate.
  // cars is any iterable of {x,z} (the Traffic set passes straight through).
  update(px, pz, heading, cars) {
    const cv = this.canvas, g = this.g;
    const w = cv.width, h = cv.height, cx = w / 2, cy = h / 2;
    const R = Math.min(cx, cy) - 2;          // rim radius, 2 px border padding
    if (R < 8) return;                       // hidden/collapsed canvas — skip
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
