// ---- signatlas.js: painting the street atlas ---------------------------------
// The pictures js/signfaces.js maps: Czech road signs as they stand on a real
// street (vyhláška 294/2015: P 4 dej přednost, P 6 stůj, P 2 hlavní pozemní
// komunikace, B 2 zákaz vjezdu, IP 4a jednosměrný provoz, B 20a rychlost,
// IP 6 přechod pro chodce, C 1 kruhový objezd, IP 11a parkoviště, IJ 4b
// zastávka, IP 25a zóna, IP 10a slepá), their galvanised backs, posters for the
// lit panel of a bus shelter, a timetable and a pane of glass.
//
// Everything is drawn with canvas 2D calls: no image, no font file. MAIN THREAD
// ONLY (a worker has no canvas); the mesher only ever needs signfaces.js.
//
// The material is one Lambert for every textured thing on a street. Its alpha
// goes to MSAA coverage instead of a blend, so a round sign has a clean edge,
// a pane of glass is see-through, and none of it needs sorting.

import * as THREE from 'three';
import { ATLAS_PX, SIGN_PX, SIGNS, BACK_DY, PANELS, AD_COUNT } from './signfaces.js';
import { COVERAGE, COVERAGE_GLSL } from './coverage.js';

const RED = '#cf1f2b', BLUE = '#1558a6', YELLOW = '#f5c21b', WHITE = '#f3f3ee', BLACK = '#18181a';
const BACK = '#84888d';
const FONT = '"Arial Narrow", Arial, "Helvetica Neue", Helvetica, sans-serif';

// ---- plate outlines, in a 128 box, centred on (64, 64) ----
function outline(g, shape) {
  g.beginPath();
  if (shape === 'tri') { g.moveTo(11, 17); g.lineTo(117, 17); g.lineTo(64, 109); g.closePath(); }
  else if (shape === 'oct') {
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * Math.PI * 2;
      g[i ? 'lineTo' : 'moveTo'](64 + Math.cos(a) * 55, 64 + Math.sin(a) * 55);
    }
    g.closePath();
  } else if (shape === 'diamond') { g.moveTo(64, 9); g.lineTo(119, 64); g.lineTo(64, 119); g.lineTo(9, 64); g.closePath(); }
  else if (shape === 'disc') g.arc(64, 64, 54, 0, Math.PI * 2);
  else if (shape === 'tall') g.roundRect(20, 9, 88, 110, 7);
  else g.roundRect(11, 11, 106, 106, 8);
}
function plate(g, shape, fill) {
  // a rounded join is what makes a triangle's corners the radius a real plate has
  outline(g, shape);
  g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = fill; g.fillStyle = fill;
  if (shape === 'tri' || shape === 'diamond' || shape === 'oct') g.stroke();
  g.fill();
}
function text(g, s, x, y, px, col, weight = 'bold') {
  g.font = `${weight} ${px}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = col;
  g.fillText(s, x, y);
}
function speed(g, n) {
  plate(g, 'disc', RED);
  g.beginPath(); g.arc(64, 64, 42, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill();
  text(g, String(n), 64, 67, 50, BLACK);
}
function arrowUp(g, x, y0, y1, w) {
  g.fillStyle = WHITE;
  g.fillRect(x - w / 2, y0 - 2, w, y1 - y0);
  g.beginPath(); g.moveTo(x, y0 - 30); g.lineTo(x + w * 1.55, y0 + 2); g.lineTo(x - w * 1.55, y0 + 2); g.closePath(); g.fill();
}

const PAINT = {
  give_way(g) {
    plate(g, 'tri', RED);
    g.beginPath(); g.moveTo(33, 29); g.lineTo(95, 29); g.lineTo(64, 83); g.closePath();
    g.fillStyle = WHITE; g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = WHITE; g.stroke(); g.fill();
  },
  stop(g) {
    plate(g, 'oct', RED);
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * Math.PI * 2;
      g[i ? 'lineTo' : 'moveTo'](64 + Math.cos(a) * 51, 64 + Math.sin(a) * 51);
    }
    g.closePath(); g.lineWidth = 3.5; g.strokeStyle = WHITE; g.stroke();
    text(g, 'STOP', 64, 66, 39, WHITE);
  },
  main_road(g) {
    plate(g, 'diamond', WHITE);
    g.beginPath(); g.moveTo(64, 30); g.lineTo(98, 64); g.lineTo(64, 98); g.lineTo(30, 64); g.closePath();
    g.fillStyle = YELLOW; g.fill();
    outline(g, 'diamond'); g.lineWidth = 2; g.strokeStyle = BLACK; g.stroke();
  },
  main_end(g) {
    PAINT.main_road(g);
    g.save(); g.translate(64, 64); g.rotate(-Math.PI / 4);
    g.fillStyle = BLACK;
    for (const o of [-10, -3, 4, 11]) g.fillRect(-52, o - 1.6, 104, 3.2);
    g.restore();
  },
  no_entry(g) {
    plate(g, 'disc', RED);
    g.fillStyle = WHITE; g.fillRect(24, 54, 80, 20);
  },
  one_way(g) { plate(g, 'square', BLUE); arrowUp(g, 64, 52, 104, 20); },
  speed30(g) { speed(g, 30); }, speed50(g) { speed(g, 50); },
  speed70(g) { speed(g, 70); }, speed90(g) { speed(g, 90); },
  crossing(g) {
    plate(g, 'square', BLUE);
    g.beginPath(); g.moveTo(64, 20); g.lineTo(108, 102); g.lineTo(20, 102); g.closePath();
    g.fillStyle = WHITE; g.fill();
    // the walker: head, a leaning body, two legs in stride, on the bars of a zebra
    g.fillStyle = BLACK; g.strokeStyle = BLACK; g.lineCap = 'round';
    g.beginPath(); g.arc(66, 46, 5.2, 0, Math.PI * 2); g.fill();
    g.lineWidth = 6; g.beginPath(); g.moveTo(65, 55); g.lineTo(62, 72); g.stroke();
    g.lineWidth = 4.4;
    g.beginPath(); g.moveTo(62, 72); g.lineTo(53, 90); g.moveTo(62, 72); g.lineTo(72, 90);
    g.moveTo(65, 58); g.lineTo(55, 68); g.moveTo(65, 58); g.lineTo(75, 66); g.stroke();
    g.fillRect(40, 93, 9, 5); g.fillRect(54, 93, 9, 5); g.fillRect(68, 93, 9, 5); g.fillRect(82, 93, 9, 5);
  },
  roundabout(g) {
    plate(g, 'disc', BLUE);
    g.strokeStyle = WHITE; g.fillStyle = WHITE; g.lineWidth = 9; g.lineCap = 'butt';
    for (let k = 0; k < 3; k++) {
      const a0 = k * (Math.PI * 2 / 3) - 0.3, a1 = a0 + 1.35;
      // traffic turns anticlockwise on the sign, as it does on the road
      g.beginPath(); g.arc(64, 64, 27, -a0, -a1, true); g.stroke();
      const hx = 64 + Math.cos(-a1) * 27, hz = 64 + Math.sin(-a1) * 27;
      const tx = Math.sin(-a1), tz = -Math.cos(-a1);       // along the turn
      const rx = Math.cos(-a1), rz = Math.sin(-a1);
      g.beginPath();
      g.moveTo(hx + tx * 15, hz + tz * 15);
      g.lineTo(hx + rx * 11, hz + rz * 11); g.lineTo(hx - rx * 11, hz - rz * 11);
      g.closePath(); g.fill();
    }
  },
  parking(g) { plate(g, 'square', BLUE); text(g, 'P', 64, 68, 86, WHITE); },
  bus(g) {
    plate(g, 'square', BLUE);
    g.fillStyle = WHITE; g.beginPath(); g.roundRect(24, 22, 80, 84, 5); g.fill();
    g.fillStyle = BLACK;
    g.beginPath(); g.roundRect(34, 34, 60, 50, 7); g.fill();
    g.fillStyle = WHITE; g.fillRect(40, 41, 48, 20);
    g.fillRect(41, 68, 9, 7); g.fillRect(78, 68, 9, 7);
    g.fillStyle = BLACK; g.fillRect(39, 84, 11, 9); g.fillRect(78, 84, 11, 9);
  },
  zone30(g) {
    plate(g, 'tall', WHITE);
    outline(g, 'tall'); g.lineWidth = 2.5; g.strokeStyle = BLACK; g.stroke();
    g.beginPath(); g.arc(64, 50, 32, 0, Math.PI * 2); g.fillStyle = RED; g.fill();
    g.beginPath(); g.arc(64, 50, 24, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill();
    text(g, '30', 64, 52, 29, BLACK);
    text(g, 'ZÓNA', 64, 100, 24, BLACK);
  },
  dead_end(g) {
    plate(g, 'square', BLUE);
    g.fillStyle = WHITE; g.fillRect(55, 44, 18, 62);
    g.fillStyle = RED; g.fillRect(36, 28, 56, 17);
  },
};

// ---- posters: what hangs in a lit shelter panel ----
function poster(g, k) {
  const W = 128, H = 192;
  const grad = (a, b) => { const q = g.createLinearGradient(0, 0, 0, H); q.addColorStop(0, a); q.addColorStop(1, b); return q; };
  if (k === 0) {
    g.fillStyle = grad('#3b2114', '#b9773c'); g.fillRect(0, 0, W, H);
    g.fillStyle = '#f2e6d0'; g.beginPath(); g.roundRect(40, 78, 48, 46, 8); g.fill();
    g.strokeStyle = '#f2e6d0'; g.lineWidth = 6; g.beginPath(); g.arc(92, 98, 12, -1.2, 1.2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3;
    for (const x of [52, 64, 76]) { g.beginPath(); g.moveTo(x, 70); g.quadraticCurveTo(x + 7, 60, x, 50); g.stroke(); }
    text(g, 'KÁVA S SEBOU', 64, 28, 17, '#f6ead6');
    text(g, '39 Kč', 64, 158, 34, '#ffd27a');
  } else if (k === 1) {
    g.fillStyle = grad('#1f6fb8', '#8fd0ee'); g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffe07a'; g.beginPath(); g.arc(92, 52, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1b5b97';
    for (let i = 0; i < 3; i++) {
      g.beginPath(); g.moveTo(0, 118 + i * 20);
      for (let x = 0; x <= W; x += 16) g.quadraticCurveTo(x + 8, 108 + i * 20, x + 16, 118 + i * 20);
      g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.globalAlpha = 0.45 + i * 0.2; g.fill();
    }
    g.globalAlpha = 1;
    text(g, 'LÉTO', 46, 44, 30, '#ffffff'); text(g, 'NA LABI', 52, 74, 21, '#ffffff');
    text(g, 'půjčovna lodí', 64, 174, 14, '#eaf6ff', 'normal');
  } else if (k === 2) {
    g.fillStyle = grad('#2f7d43', '#c9dd8a'); g.fillRect(0, 0, W, H);
    for (const [x, y, c] of [[38, 104, '#e2452c'], [64, 96, '#f0a321'], [90, 106, '#e2452c'], [52, 126, '#f0a321'], [78, 128, '#7a2f8a']]) {
      g.fillStyle = c; g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
    }
    text(g, 'FARMÁŘSKÉ', 64, 28, 19, '#ffffff'); text(g, 'TRHY', 64, 56, 34, '#ffffff');
    text(g, 'každou sobotu', 64, 168, 15, '#f4ffe6', 'normal');
  } else {
    g.fillStyle = grad('#141526', '#5a1f55'); g.fillRect(0, 0, W, H);
    g.strokeStyle = '#ff9bd2'; g.lineWidth = 2;
    for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(64, 96); g.lineTo(64 + Math.cos(i * 0.7) * 90, 96 + Math.sin(i * 0.7) * 90); g.globalAlpha = 0.25; g.stroke(); }
    g.globalAlpha = 1;
    text(g, 'KONCERT', 64, 60, 25, '#ffffff'); text(g, 'NA NÁBŘEŽÍ', 64, 86, 17, '#ffd0ec');
    text(g, 'pátek 20:00', 64, 150, 19, '#ffe27a');
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
}

function timetable(g) {
  g.fillStyle = '#f4f3ee'; g.fillRect(0, 0, 64, 96);
  g.fillStyle = BLUE; g.fillRect(0, 0, 64, 16);
  text(g, 'MHD', 32, 9, 11, '#ffffff');
  g.fillStyle = '#5d6168';
  for (let r = 0; r < 11; r++) for (let c = 0; c < 4; c++) if ((r * 7 + c * 3) % 5) g.fillRect(6 + c * 14, 23 + r * 6.4, 9, 2);
}

// the rim colour of each face, for the wash under it (blue where not named)
const RIM_RED = 'rgba(255,0,0,0.0079)', RIM_WHITE = 'rgba(255,255,255,0.0079)', RIM_BLUE = 'rgba(0,128,128,0.0079)';
const RIM = {
  give_way: RIM_RED, stop: RIM_RED, no_entry: RIM_RED, speed30: RIM_RED, speed50: RIM_RED, speed70: RIM_RED,
  speed90: RIM_RED, main_road: RIM_WHITE, main_end: RIM_WHITE, zone30: RIM_WHITE,
};

/** Paint the colour canvas and the glow canvas (black but for what is lit at night). */
export function paintStreetAtlas() {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = ATLAS_PX; return c; };
  const cv = mk(), g = cv.getContext('2d');
  // Under every plate, a wash of the plate's own edge colour at two parts in
  // 255 of alpha: it covers no sample, but it is what the texture filter mixes
  // into the plate's outermost texel. Bare canvas there is transparent BLACK,
  // and every sign in town wore a dark line round its rim. (At that alpha a
  // canvas keeps a channel as 0, a half or full, hence these plain colours.)
  const wash = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, SIGN_PX, SIGN_PX); };
  for (const name of Object.keys(SIGNS)) {
    const [cx, cy, shape] = SIGNS[name];
    wash(cx * SIGN_PX, cy * SIGN_PX, RIM[name] ?? RIM_BLUE);
    wash(cx * SIGN_PX, cy * SIGN_PX + BACK_DY, 'rgba(128,128,128,0.0079)');
    g.save(); g.translate(cx * SIGN_PX, cy * SIGN_PX); PAINT[name](g); g.restore();
    g.save(); g.translate(cx * SIGN_PX, cy * SIGN_PX + BACK_DY); plate(g, shape, BACK); g.restore();
  }
  for (let k = 0; k < AD_COUNT; k++) {
    const p = PANELS['ad' + k];
    g.save(); g.translate(p[0], p[1]); g.beginPath(); g.rect(0, 0, p[2], p[3]); g.clip(); poster(g, k); g.restore();
  }
  { const p = PANELS.timetable; g.save(); g.translate(p[0], p[1]); timetable(g); g.restore(); }
  { // glass: mostly not there, a little sky in it, one diagonal glint. Painted
    // a margin larger than the cell so the mips never pull in bare canvas.
    const p = PANELS.glass, m = 12;
    g.fillStyle = 'rgba(168,198,214,0.30)'; g.fillRect(p[0] - m, p[1] - m, p[2] + 2 * m, p[3] + 2 * m);
    g.save(); g.beginPath(); g.rect(p[0] - m, p[1] - m, p[2] + 2 * m, p[3] + 2 * m); g.clip();
    g.strokeStyle = 'rgba(235,245,250,0.22)'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(p[0] - m, p[1] + p[3]); g.lineTo(p[0] + p[2] + m, p[1] - 4); g.stroke(); g.restore();
  }
  { const p = PANELS.frame; g.fillStyle = '#3b3e43'; g.fillRect(p[0] - 8, p[1] - 8, p[2] + 16, p[3] + 16); }
  // what glows after dark: the posters, behind their own diffuser, and the
  // timetable a little
  const gv = mk(), e = gv.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, ATLAS_PX, ATLAS_PX);
  for (let k = 0; k < AD_COUNT; k++) { const p = PANELS['ad' + k]; e.drawImage(cv, p[0], p[1], p[2], p[3], p[0], p[1], p[2], p[3]); }
  { const p = PANELS.timetable; e.globalAlpha = 0.5; e.drawImage(cv, p[0], p[1], p[2], p[3], p[0], p[1], p[2], p[3]); e.globalAlpha = 1; }
  return [cv, gv];
}

/**
 * The one material every textured street object wears. Built without its
 * pictures where there is no document (node tests, which never look at it).
 */
export function streetDecoMaterial() {
  // NoBlending is what lets the alpha through. three calls a material that is
  // neither transparent nor specially blended OPAQUE and writes its alpha as
  // 1.0, so with the default blending the coverage was always full: a round
  // sign stood in a black square and the shelter's glass was a blue-grey slab.
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0,
    alphaToCoverage: true, blending: THREE.NoBlending });
  // Where the frame is not multisampled that alpha goes nowhere and the black
  // square is back. There the atlas is cut by an ordered dither instead: a
  // plate's edge is one pixel of it, the shelter glass a fine screen at its
  // own 30 percent. See js/coverage.js.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCoverage = COVERAGE;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COVERAGE_GLSL)
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n'
        + '\tif ( uCoverage < 0.5 && diffuseColor.a < atcBayer4( gl_FragCoord.xy ) ) discard;');
  };
  mat.customProgramCacheKey = () => 'atc-streetdeco';
  if (typeof document !== 'undefined') {
    const [cv, gv] = paintStreetAtlas();
    const tex = (c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return t;
    };
    mat.map = tex(cv);
    mat.emissiveMap = tex(gv);
  }
  return mat;
}
