// ---- Main menu backdrop: Pardubice at dusk, drawn in code ----
// The menu is the first thing a player sees, before a single tile has loaded,
// so it cannot borrow the three.js world: there is no renderer yet and the city
// streams only after the pick. Instead this paints the town the game is about
// on a plain 2D canvas: a dusk sky with the first stars, Kunětická hora on the
// horizon, the panel estates in the haze, the old town with Zelená brána, the
// town hall, St Bartholomew and the chateau, and in front a street under the
// trolley wire where a lit trolleybus and the evening traffic go by.
//
// Cost is kept flat: every layer that does not move is painted ONCE per resize
// into its own offscreen canvas, and a frame is a handful of drawImage calls
// plus the few things that do move (stars, clouds, the trolleybus, cars). The
// layers slide against each other with the pointer for a little depth.
// Nothing here is shared state, so Math.random would be harmless, but a seeded
// generator keeps the skyline the same from one visit to the next.

const rng = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WARM = ['#ffd38a', '#ffc46b', '#ffe2a8', '#ffb35c', '#fff0c8'];
const MARGIN = 48;                 // px of overdraw each side, room for parallax

function layer(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.ceil((w + MARGIN * 2) * dpr); c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, MARGIN * dpr, 0);    // x = 0 is the screen's left edge
  return { c, g };
}

// a lit window grid on a block face; `p` is the share of lit windows
function windows(g, r, x, y, w, h, cw, ch, gx, gy, p, dim) {
  if (cw + gx < 1 || ch + gy < 1) return;
  for (let yy = y + gy; yy + ch < y + h - 2; yy += ch + gy) {
    for (let xx = x + gx; xx + cw < x + w - 1; xx += cw + gx) {
      if (r() > p) continue;
      g.globalAlpha = dim * (0.55 + r() * 0.45);
      g.fillStyle = WARM[(r() * WARM.length) | 0];
      g.fillRect(xx, yy, cw, ch);
    }
  }
  g.globalAlpha = 1;
}

// ---- the static layers ------------------------------------------------------
function paintSky(w, h, dpr) {
  const L = layer(w, h, dpr), g = L.g;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#070b1c');
  sky.addColorStop(0.38, '#1a1f45');
  sky.addColorStop(0.62, '#4b3266');
  sky.addColorStop(0.74, '#b5536a');
  sky.addColorStop(0.82, '#f39a5c');
  sky.addColorStop(1, '#ffc98a');
  g.fillStyle = sky; g.fillRect(-MARGIN, 0, w + MARGIN * 2, h);
  // the sun has just gone: a warm bloom low in the west
  const sun = g.createRadialGradient(w * 0.22, h * 0.8, 0, w * 0.22, h * 0.8, w * 0.55);
  sun.addColorStop(0, 'rgba(255,190,120,0.55)');
  sun.addColorStop(0.4, 'rgba(255,140,110,0.18)');
  sun.addColorStop(1, 'rgba(255,140,110,0)');
  g.fillStyle = sun; g.fillRect(-MARGIN, 0, w + MARGIN * 2, h);
  // a thin moon high in the east. The crescent is cut on its own little
  // canvas: cutting it straight out of the sky would punch a hole through the
  // sky gradient as well and leave a black disc
  const mx = w * 0.8, my = h * 0.16, mr = Math.max(9, h * 0.022);
  const halo = g.createRadialGradient(mx, my, 0, mx, my, mr * 6);
  halo.addColorStop(0, 'rgba(220,230,255,0.25)'); halo.addColorStop(1, 'rgba(220,230,255,0)');
  g.fillStyle = halo; g.fillRect(mx - mr * 6, my - mr * 6, mr * 12, mr * 12);
  const mc = document.createElement('canvas'), ms = Math.ceil(mr * 2 + 4);
  mc.width = mc.height = ms;
  const m = mc.getContext('2d');
  m.fillStyle = '#f4f1e6';
  m.beginPath(); m.arc(ms / 2, ms / 2, mr, 0, Math.PI * 2); m.fill();
  m.globalCompositeOperation = 'destination-out';
  m.beginPath(); m.arc(ms / 2 + mr * 0.45, ms / 2 - mr * 0.2, mr * 0.92, 0, Math.PI * 2); m.fill();
  g.drawImage(mc, mx - ms / 2, my - ms / 2);
  return L;
}

function paintFar(w, h, dpr, ground) {
  const L = layer(w, h, dpr), g = L.g, r = rng(7);
  const s = h / 900;
  // Kunětická hora: the lone hill with its castle north east of the town
  const hx = w * 0.86, hy = ground - 26 * s;
  g.fillStyle = '#3a3358';
  g.beginPath(); g.moveTo(hx - 260 * s, ground);
  g.bezierCurveTo(hx - 120 * s, hy - 10 * s, hx - 70 * s, hy - 62 * s, hx, hy - 66 * s);
  g.bezierCurveTo(hx + 70 * s, hy - 62 * s, hx + 120 * s, hy - 10 * s, hx + 260 * s, ground);
  g.fill();
  g.fillRect(hx - 22 * s, hy - 86 * s, 44 * s, 22 * s);
  g.fillRect(hx - 6 * s, hy - 104 * s, 12 * s, 20 * s);
  // the panel estates, Polabiny and Dubina, as tall pale slabs in the haze
  for (let x = -MARGIN; x < w + MARGIN;) {
    const bw = (46 + r() * 70) * s, bh = (70 + r() * 120) * s;
    if (r() < 0.78) {
      g.fillStyle = r() < 0.5 ? '#2e2c52' : '#34305a';
      g.fillRect(x, ground - bh, bw, bh);
      windows(g, r, x, ground - bh, bw, bh, 2.2 * s + 1, 3 * s + 1, 3.2 * s + 1, 4.2 * s + 1, 0.16, 0.55);
    }
    x += Math.max(4, bw + (4 + r() * 30) * s);
  }
  // haze over the far town
  const haze = g.createLinearGradient(0, ground - 200 * s, 0, ground);
  haze.addColorStop(0, 'rgba(240,140,110,0)'); haze.addColorStop(1, 'rgba(240,140,110,0.28)');
  g.fillStyle = haze; g.fillRect(-MARGIN, ground - 200 * s, w + MARGIN * 2, 200 * s);
  return L;
}

// a gabled house front, the unit of the old town's roofline
function house(g, r, x, ground, bw, bh, s) {
  const roof = (16 + r() * 22) * s;
  g.fillStyle = '#1b1a35';
  g.beginPath();
  g.moveTo(x, ground); g.lineTo(x, ground - bh); g.lineTo(x + bw / 2, ground - bh - roof);
  g.lineTo(x + bw, ground - bh); g.lineTo(x + bw, ground); g.fill();
  if (r() < 0.5) g.fillRect(x + bw * (0.2 + r() * 0.5), ground - bh - roof * 0.75, 3 * s, roof * 0.7);  // chimney
  windows(g, r, x, ground - bh, bw, bh, 4 * s, 6 * s, 5 * s, 7 * s, 0.38, 0.95);
}

function spire(g, cx, base, w, h) {
  g.beginPath(); g.moveTo(cx - w / 2, base); g.lineTo(cx, base - h); g.lineTo(cx + w / 2, base); g.fill();
}

function paintTown(w, h, dpr, ground) {
  const L = layer(w, h, dpr), g = L.g, r = rng(19);
  const s = h / 900;
  // the roofline of the old town, end to end
  for (let x = -MARGIN; x < w + MARGIN;) {
    const bw = (30 + r() * 34) * s, bh = (46 + r() * 46) * s;
    house(g, r, x, ground, bw, bh, s);
    x += Math.max(4, bw - 1);
  }
  // the chateau on its ramparts, west of the old town
  const zx = w * 0.12, zs = s;
  g.fillStyle = '#211f3d';
  g.beginPath(); g.moveTo(zx - 150 * zs, ground); g.quadraticCurveTo(zx, ground - 50 * zs, zx + 150 * zs, ground); g.fill();
  g.fillStyle = '#1d1b38';
  g.fillRect(zx - 95 * zs, ground - 110 * zs, 190 * zs, 80 * zs);
  g.beginPath(); g.moveTo(zx - 100 * zs, ground - 108 * zs); g.lineTo(zx - 70 * zs, ground - 140 * zs);
  g.lineTo(zx + 70 * zs, ground - 140 * zs); g.lineTo(zx + 100 * zs, ground - 108 * zs); g.fill();
  g.fillRect(zx + 20 * zs, ground - 175 * zs, 26 * zs, 50 * zs);
  g.fillStyle = '#2e5a52'; spire(g, zx + 33 * zs, ground - 175 * zs, 30 * zs, 34 * zs);
  windows(g, r, zx - 95 * zs, ground - 110 * zs, 190 * zs, 80 * zs, 5 * zs, 8 * zs, 9 * zs, 9 * zs, 0.3, 0.7);

  // town hall tower
  const rx = w * 0.28;
  g.fillStyle = '#1c1b37';
  g.fillRect(rx - 13 * s, ground - 190 * s, 26 * s, 190 * s);
  g.fillStyle = '#2f5d55'; spire(g, rx, ground - 190 * s, 34 * s, 62 * s);
  g.fillStyle = '#ffe7b0'; g.beginPath(); g.arc(rx, ground - 165 * s, 6 * s, 0, Math.PI * 2); g.fill();

  // St Bartholomew: nave and its tower
  const bx = w * 0.69;
  g.fillStyle = '#1a1934';
  g.beginPath(); g.moveTo(bx - 70 * s, ground); g.lineTo(bx - 70 * s, ground - 80 * s);
  g.lineTo(bx - 10 * s, ground - 125 * s); g.lineTo(bx + 50 * s, ground - 80 * s); g.lineTo(bx + 50 * s, ground); g.fill();
  g.fillRect(bx + 40 * s, ground - 200 * s, 30 * s, 200 * s);
  g.fillStyle = '#2f5d55';
  g.beginPath(); g.ellipse(bx + 55 * s, ground - 208 * s, 19 * s, 14 * s, 0, 0, Math.PI * 2); g.fill();
  spire(g, bx + 55 * s, ground - 214 * s, 10 * s, 42 * s);
  g.fillStyle = 'rgba(255,214,150,0.85)';
  for (let i = 0; i < 3; i++) g.fillRect(bx - 50 * s + i * 30 * s, ground - 70 * s, 8 * s, 24 * s);

  // Zelená brána: the 59 m gate tower, its gallery, the four corner turrets
  // and the spire, floodlit as it is every night
  // (right of the centre, where the menu card does not cover it)
  const gx = w * 0.83, tw = 40 * s, th = 250 * s, top = ground - th;
  const flood = g.createRadialGradient(gx, ground - th * 0.35, 0, gx, ground - th * 0.35, th * 0.9);
  flood.addColorStop(0, 'rgba(255,200,130,0.35)'); flood.addColorStop(1, 'rgba(255,200,130,0)');
  g.fillStyle = flood; g.fillRect(gx - th, ground - th * 1.4, th * 2, th * 1.4);
  const shaft = g.createLinearGradient(gx - tw / 2, 0, gx + tw / 2, 0);
  shaft.addColorStop(0, '#5a3f3f'); shaft.addColorStop(0.5, '#8a6150'); shaft.addColorStop(1, '#4a3440');
  g.fillStyle = shaft; g.fillRect(gx - tw / 2, top, tw, th);
  g.fillStyle = '#140f22';                                    // the gate passage
  g.beginPath(); g.moveTo(gx - 10 * s, ground); g.lineTo(gx - 10 * s, ground - 26 * s);
  g.arc(gx, ground - 26 * s, 10 * s, Math.PI, 0); g.lineTo(gx + 10 * s, ground); g.fill();
  g.fillStyle = '#ffe9b8';                                    // clock face
  g.beginPath(); g.arc(gx, top + 60 * s, 8 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3a2a33';                                    // gallery
  g.fillRect(gx - tw / 2 - 7 * s, top - 6 * s, tw + 14 * s, 12 * s);
  g.fillStyle = 'rgba(255,214,150,0.9)';
  for (let i = 0; i < 5; i++) g.fillRect(gx - tw / 2 - 3 * s + i * 11 * s, top - 3 * s, 5 * s, 6 * s);
  g.fillStyle = '#3f8070';                                    // copper
  spire(g, gx, top - 6 * s, tw * 0.95, 120 * s);
  for (const dx of [-1, 1]) spire(g, gx + dx * (tw / 2 + 2 * s), top - 6 * s, 10 * s, 46 * s);
  spire(g, gx, top - 40 * s, 14 * s, 0.1);
  g.fillStyle = '#d8c070'; g.fillRect(gx - 1 * s, top - 136 * s, 2 * s, 12 * s);   // the finial
  return L;
}

function paintStreet(w, h, dpr, ground, street) {
  const L = layer(w, h, dpr), g = L.g, r = rng(31);
  const s = h / 900;
  // the pavement and the road
  g.fillStyle = '#121022'; g.fillRect(-MARGIN, ground, w + MARGIN * 2, h - ground);
  g.fillStyle = '#1a1730'; g.fillRect(-MARGIN, street - 8 * s, w + MARGIN * 2, h - street + 8 * s);
  g.fillStyle = 'rgba(255,230,190,0.18)';
  for (let x = -MARGIN; x < w + MARGIN; x += 70 * s) g.fillRect(x, street + 34 * s, 34 * s, 3 * s);
  // masts carrying the trolley wire, with a lamp on every second one
  const step = 210 * s;
  const masts = [];
  for (let x = -MARGIN + 40 * s; x < w + MARGIN + step; x += step) masts.push(x);
  for (const [i, mx] of masts.entries()) {
    g.fillStyle = '#0a0916'; g.fillRect(mx - 2.5 * s, street - 170 * s, 5 * s, 170 * s);
    g.fillRect(mx, street - 166 * s, 70 * s, 3 * s);
    if (i % 2 === 0) {
      const ly = street - 150 * s, lx = mx - 30 * s;
      g.fillRect(lx, ly, 30 * s, 2.5 * s);
      const pool = g.createRadialGradient(lx, ly + 4 * s, 0, lx, ly + 4 * s, 120 * s);
      pool.addColorStop(0, 'rgba(255,205,140,0.55)'); pool.addColorStop(1, 'rgba(255,205,140,0)');
      g.fillStyle = pool; g.fillRect(lx - 120 * s, ly - 116 * s, 240 * s, 240 * s);
      const floor = g.createRadialGradient(lx, street + 20 * s, 0, lx, street + 20 * s, 110 * s);
      floor.addColorStop(0, 'rgba(255,200,130,0.22)'); floor.addColorStop(1, 'rgba(255,200,130,0)');
      g.fillStyle = floor; g.fillRect(lx - 110 * s, street - 20 * s, 220 * s, 90 * s);
      g.fillStyle = '#fff2d0'; g.fillRect(lx - 4 * s, ly + 2 * s, 8 * s, 3 * s);
    }
  }
  // the two wires, sagging between the masts
  g.strokeStyle = 'rgba(70,64,98,0.95)'; g.lineWidth = Math.max(1, 1.2 * s);
  for (const off of [0, 9 * s]) {
    g.beginPath();
    for (let i = 0; i < masts.length - 1; i++) {
      const a = masts[i] + 60 * s, b = masts[i + 1] + 60 * s, y = street - 160 * s + off;
      g.moveTo(a, y); g.quadraticCurveTo((a + b) / 2, y + 7 * s, b, y);
    }
    g.stroke();
  }
  // a few walkers on the pavement
  for (let i = 0; i < 9; i++) {
    const x = r() * w, ph = (22 + r() * 6) * s;
    g.fillStyle = '#07060f';
    g.fillRect(x - 2.5 * s, street - 8 * s - ph, 5 * s, ph);
    g.beginPath(); g.arc(x, street - 11 * s - ph, 3.5 * s, 0, Math.PI * 2); g.fill();
  }
  return { ...L, wireY: street - 160 * s };
}

function paintShade(w, h, dpr) {
  const L = layer(w, h, dpr), g = L.g;
  const v = g.createRadialGradient(w / 2, h * 0.45, h * 0.25, w / 2, h * 0.5, h * 0.95);
  v.addColorStop(0, 'rgba(4,5,14,0)'); v.addColorStop(1, 'rgba(4,5,14,0.72)');
  g.fillStyle = v; g.fillRect(-MARGIN, 0, w + MARGIN * 2, h);
  return L;
}

// ---- the moving things --------------------------------------------------------
function drawTrolleybus(g, x, street, wireY, s, t) {
  const L = 150 * s, H = 38 * s, y = street - 4 * s - H;
  // the body: DPMP red with the white band
  g.fillStyle = '#b3212d'; roundRect(g, x, y, L, H, 6 * s); g.fill();
  g.fillStyle = '#f2ece2'; g.fillRect(x + 2 * s, y + H * 0.62, L - 4 * s, 4 * s);
  g.fillStyle = '#d9d4cb'; g.fillRect(x + 20 * s, y - 6 * s, L * 0.55, 6 * s);           // roof gear
  // lit windows with passengers in them
  for (let i = 0; i < 7; i++) {
    const wx = x + 10 * s + i * 19 * s;
    g.fillStyle = '#ffe2a6'; g.fillRect(wx, y + 6 * s, 15 * s, 13 * s);
    if ((i * 7 + 3) % 4 === 0) { g.fillStyle = 'rgba(40,20,30,0.7)'; g.fillRect(wx + 5 * s, y + 10 * s, 5 * s, 9 * s); }
  }
  // the destination display, amber, as on the real cars
  g.fillStyle = '#120b08'; g.fillRect(x + L - 44 * s, y + 2 * s, 40 * s, 7 * s);
  g.fillStyle = '#ffb43a'; g.font = `${Math.round(6 * s)}px system-ui, sans-serif`;
  g.textBaseline = 'middle'; g.fillText('3 Lázně Bohdaneč', x + L - 43 * s, y + 5.6 * s, 38 * s);
  // headlight and the light it throws ahead
  const hb = g.createRadialGradient(x + L + 4 * s, street - 10 * s, 0, x + L + 4 * s, street - 10 * s, 90 * s);
  hb.addColorStop(0, 'rgba(255,245,220,0.55)'); hb.addColorStop(1, 'rgba(255,245,220,0)');
  g.fillStyle = hb; g.fillRect(x + L + 4 * s - 90 * s, street - 100 * s, 180 * s, 180 * s);
  g.fillStyle = '#ff3b3b'; g.fillRect(x - 1 * s, y + H - 12 * s, 3 * s, 5 * s);
  // wheels
  g.fillStyle = '#05040a';
  for (const wx of [x + 26 * s, x + L - 30 * s]) { g.beginPath(); g.arc(wx, street - 4 * s, 7 * s, 0, Math.PI * 2); g.fill(); }
  // two poles up to the wire, and now and then a spark where they touch
  // a shade lighter than the night behind them, or the poles vanish
  g.strokeStyle = '#6b6488'; g.lineWidth = Math.max(1, 1.6 * s);
  const px0 = x + 30 * s, py0 = y - 6 * s;
  for (const [k, off] of [[0, 0], [1, 9 * s]]) {
    g.beginPath(); g.moveTo(px0 + k * 6 * s, py0); g.lineTo(px0 + 62 * s + k * 4 * s, wireY + off); g.stroke();
  }
  if (Math.sin(t * 9.1) > 0.985) {
    const sx = px0 + 64 * s, sy = wireY + 4 * s;
    const sp = g.createRadialGradient(sx, sy, 0, sx, sy, 16 * s);
    sp.addColorStop(0, 'rgba(190,220,255,0.95)'); sp.addColorStop(1, 'rgba(120,170,255,0)');
    g.fillStyle = sp; g.fillRect(sx - 16 * s, sy - 16 * s, 32 * s, 32 * s);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawCar(g, x, y, s, hue, dir) {
  const L = 44 * s, H = 13 * s;
  g.fillStyle = hue; roundRect(g, x, y - H, L, H, 4 * s); g.fill();
  g.fillRect(x + 10 * s, y - H - 7 * s, L - 20 * s, 8 * s);
  g.fillStyle = 'rgba(255,226,170,0.35)'; g.fillRect(x + 12 * s, y - H - 5 * s, L - 24 * s, 5 * s);
  const fx = dir < 0 ? x : x + L;
  const hb = g.createRadialGradient(fx, y - 6 * s, 0, fx, y - 6 * s, 70 * s);
  hb.addColorStop(0, 'rgba(255,248,225,0.7)'); hb.addColorStop(1, 'rgba(255,248,225,0)');
  g.fillStyle = hb; g.fillRect(fx - 70 * s, y - 76 * s, 140 * s, 140 * s);
  g.fillStyle = '#ff2f3a'; g.fillRect(dir < 0 ? x + L - 3 * s : x, y - 10 * s, 3 * s, 4 * s);
}

/**
 * startMenuScene(canvas) → stop(). Paints and animates the backdrop until
 * stop() is called; stop() also removes every listener it added.
 */
export function startMenuScene(canvas) {
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, raf = 0, alive = true, L = null, stars = [], clouds = [];
  let px = 0, py = 0, tx = 0, ty = 0;
  const t0 = performance.now();

  const build = () => {
    // a hidden or still collapsed page can report 0 x 0; every loop below
    // steps by a size scaled from H, so a zero would never end. Floor it.
    W = Math.max(320, canvas.clientWidth || innerWidth || 0);
    H = Math.max(240, canvas.clientHeight || innerHeight || 0);
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ground = H * 0.74, street = H * 0.86;
    L = { sky: paintSky(W, H, dpr), far: paintFar(W, H, dpr, ground * 0.985), town: paintTown(W, H, dpr, ground),
      road: paintStreet(W, H, dpr, ground, street), shade: paintShade(W, H, dpr), ground, street };
    const r = rng(5);
    stars = Array.from({ length: Math.round(W * H / 9000) }, () => ({
      x: r() * W, y: r() * H * 0.5, s: 0.4 + r() * 1.3, p: r() * 6.28, f: 0.6 + r() * 2.2 }));
    clouds = Array.from({ length: 5 }, (_, i) => ({ x: r() * W, y: H * (0.18 + r() * 0.32), w: W * (0.2 + r() * 0.25), v: 4 + r() * 6, a: 0.05 + i * 0.012 }));
  };

  const frame = (now) => {
    if (!alive) return;
    const t = (now - t0) / 1000;
    px += (tx - px) * 0.04; py += (ty - py) * 0.04;
    const s = H / 900;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const put = (lay, depth) => {
      const ox = -MARGIN * dpr - px * depth * MARGIN * dpr, oy = -py * depth * 10 * dpr;
      ctx.drawImage(lay.c, ox, oy);
    };
    put(L.sky, 0.1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const st of stars) {                                    // the first stars
      const a = Math.min(1, t / 3) * (0.45 + 0.55 * Math.sin(st.p + t * st.f)) * (1 - st.y / (H * 0.55));
      if (a <= 0.02) continue;
      ctx.globalAlpha = a; ctx.fillStyle = '#fff6e0';
      ctx.fillRect(st.x - px * 4, st.y - py * 2, st.s, st.s);
    }
    ctx.globalAlpha = 1;
    for (const c of clouds) {                                    // slow cloud bands
      const x = ((c.x + t * c.v) % (W + c.w * 2)) - c.w - px * 8;
      const gr = ctx.createRadialGradient(x, c.y, 0, x, c.y, c.w);
      gr.addColorStop(0, `rgba(255,170,150,${c.a})`); gr.addColorStop(1, 'rgba(255,170,150,0)');
      ctx.fillStyle = gr; ctx.save(); ctx.translate(x, c.y); ctx.scale(1, 0.18); ctx.translate(-x, -c.y);
      ctx.fillRect(x - c.w, c.y - c.w, c.w * 2, c.w * 2); ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    put(L.far, 0.25);
    // the town lights up window by window as the menu opens
    ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, t / 2.2);
    put(L.town, 0.5);
    ctx.globalAlpha = 1;
    put(L.road, 0.9);
    // the moving street, under the same parallax as its layer
    ctx.setTransform(dpr, 0, 0, dpr, -px * 0.9 * MARGIN * dpr, -py * 0.9 * 10 * dpr);
    const span = W + 600 * s;
    const busX = ((t * 46 * s + W * 0.15) % span) - 300 * s;
    drawTrolleybus(ctx, busX, L.street, L.road.wireY, s, t);
    for (let i = 0; i < 3; i++) {
      const v = (70 + i * 23) * s, cx = W + 200 * s - ((t * v + i * W * 0.4) % (W + 400 * s));
      drawCar(ctx, cx, L.street + 26 * s, s, ['#d9dde4', '#3d5a8a', '#222'][i], -1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(L.shade.c, -MARGIN * dpr, 0);
    if (!still) raf = requestAnimationFrame(frame);
  };

  const onMove = (e) => { tx = (e.clientX / innerWidth - 0.5) * 2; ty = (e.clientY / innerHeight - 0.5) * 2; };
  const onResize = () => { build(); if (still) frame(performance.now() + 5000); };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('resize', onResize);
  build();
  raf = requestAnimationFrame(still ? (n) => frame(n + 5000) : frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', onMove);
    removeEventListener('resize', onResize);
  };
}
