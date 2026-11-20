// ---- stores/logodraw.js: the chains' marks, drawn by hand in code ----
// Canvas 2D only. These are the 'drawn' style of js/stores/signpaint.js: each
// chain's mark rebuilt from plain shapes and type (a disc and a ring, a
// letter, two arcs), in the proportions the real sign has. Nothing here is a
// copy of a logo file or a traced image. Whether the public game shows these,
// the plain name panels or look-alike names is the owner's decision; the
// switch is SIGN_STYLE.logos and it ships on 'plain'.
//
// Every painter draws into a design space: tile(g) 256 x 256, band(g) 1024 x 256.

const FONT = 'Arial, Helvetica, sans-serif';
const fitFont = (g, text, wide, max, style = 'bold') => {
  let size = max;
  g.font = `${style} ${size}px ${FONT}`;
  const tw = g.measureText(text).width;
  if (tw > wide) { size = Math.floor(size * wide / tw); g.font = `${style} ${size}px ${FONT}`; }
  return size;
};
const mid = (g) => { g.textAlign = 'center'; g.textBaseline = 'middle'; };

// the golden arches: two tall arcs side by side, drawn as strokes
function arches(g, cx, cy, w, h, colour) {
  g.strokeStyle = colour; g.lineWidth = w * 0.13; g.lineCap = 'butt'; g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(cx - w / 2, cy + h / 2);
  g.bezierCurveTo(cx - w * 0.46, cy - h * 0.85, cx - w * 0.06, cy - h * 0.85, cx, cy + h * 0.18);
  g.bezierCurveTo(cx + w * 0.06, cy - h * 0.85, cx + w * 0.46, cy - h * 0.85, cx + w / 2, cy + h / 2);
  g.stroke();
}

const TILE = {
  lidl(g) {
    g.fillStyle = '#0050aa'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#fff000'; g.beginPath(); g.arc(128, 128, 112, 0, 7); g.fill();
    g.strokeStyle = '#e60a14'; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 104, 0, 7); g.stroke();
    // L, a tilted i with a red dot and stem, D, L
    g.fillStyle = '#0050aa'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.font = `bold 92px ${FONT}`;
    g.fillText('L', 36, 160);
    g.fillText('D', 116, 160);
    g.fillText('L', 180, 160);
    g.save(); g.translate(98, 160); g.rotate(-0.42);
    g.fillStyle = '#e60a14'; g.fillRect(-9, -56, 18, 56);
    g.beginPath(); g.arc(0, -72, 11, 0, 7); g.fill();
    g.restore();
  },
  kaufland(g) {
    g.fillStyle = '#e10915'; g.fillRect(0, 0, 256, 256);
    // a K of plain wedges: the stem, and two arms that meet it
    g.fillStyle = '#ffffff';
    g.fillRect(52, 44, 46, 168);
    g.beginPath(); g.moveTo(104, 122); g.lineTo(196, 44); g.lineTo(204, 104); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(104, 134); g.lineTo(204, 152); g.lineTo(196, 212); g.closePath(); g.fill();
  },
  penny(g) {
    g.fillStyle = '#cd1414'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ffffff'; mid(g);
    fitFont(g, 'PENNY', 196, 70);
    g.fillText('PENNY', 120, 132);
    g.fillStyle = '#ffd400'; g.beginPath(); g.arc(232, 152, 10, 0, 7); g.fill();
  },
  mcdonalds(g) {
    g.fillStyle = '#da291c'; g.fillRect(0, 0, 256, 256);
    arches(g, 128, 124, 176, 150, '#ffc72c');
  },
  kfc(g) {
    g.fillStyle = '#e4002b'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ffffff';
    for (const x of [70, 116, 162]) g.fillRect(x, 26, 24, 70);
    mid(g);
    g.font = `italic bold 104px ${FONT}`;
    g.fillText('KFC', 128, 168);
  },
  burgerking(g) {
    g.fillStyle = '#f5ebdc'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ff8732';
    g.beginPath(); g.ellipse(128, 86, 104, 62, 0, Math.PI, 0); g.fill();
    g.beginPath(); g.ellipse(128, 172, 104, 50, 0, 0, Math.PI); g.fill();
    g.fillStyle = '#d62300'; mid(g);
    g.font = `bold 46px ${FONT}`;
    g.fillText('BURGER', 128, 108);
    g.fillText('KING', 128, 152);
  },
};

const BAND = {
  albert(g) {
    g.fillStyle = '#0072bc'; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#ffffff'; mid(g);
    g.font = `bold 176px ${FONT}`;
    g.fillText('Albert', 512, 138);
  },
  billa(g) {
    g.fillStyle = '#e2001a'; g.fillRect(0, 0, 1024, 256);
    // condensed capitals rising to the right
    g.save(); g.translate(512, 138); g.rotate(-0.07); g.scale(0.82, 1.18);
    g.fillStyle = '#ffe600'; mid(g);
    g.font = `italic bold 178px ${FONT}`;
    g.fillText('BILLA', 0, 0);
    g.restore();
  },
  tesco(g) {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#00539f'; mid(g);
    g.font = `bold 168px ${FONT}`;
    g.fillText('TESCO', 512, 112);
    // a dash under every letter
    g.fillStyle = '#ee1c2e';
    const w = g.measureText('TESCO').width, step = w / 5;
    for (let i = 0; i < 5; i++) g.fillRect(512 - w / 2 + i * step + step * 0.12, 204, step * 0.7, 20);
  },
  globus(g) {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#f39200'; g.beginPath(); g.arc(196, 128, 92, 0, 7); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 9;
    g.beginPath(); g.ellipse(196, 128, 92, 34, 0, 0, 7); g.stroke();
    g.beginPath(); g.ellipse(196, 128, 40, 92, 0, 0, 7); g.stroke();
    g.fillStyle = '#00843d'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `bold 158px ${FONT}`;
    g.fillText('Globus', 330, 138);
  },
  kaufland(g) {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1024, 256);
    g.save(); g.translate(40, 28); g.scale(200 / 256, 200 / 256); TILE.kaufland(g); g.restore();
    g.fillStyle = '#e10915'; g.textAlign = 'left'; g.textBaseline = 'middle';
    fitFont(g, 'Kaufland', 700, 150);
    g.fillText('Kaufland', 280, 136);
  },
  mcdonalds(g) {
    g.fillStyle = '#2f2d2b'; g.fillRect(0, 0, 1024, 256);
    arches(g, 150, 128, 190, 160, '#ffc72c');
    g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    fitFont(g, "McDonald's", 700, 136);
    g.fillText("McDonald's", 290, 136);
  },
  kfc(g) {
    g.fillStyle = '#e4002b'; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#ffffff';
    for (const x of [300, 356, 412]) g.fillRect(x, 40, 30, 176);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `italic bold 190px ${FONT}`;
    g.fillText('KFC', 480, 138);
  },
  burgerking(g) {
    g.fillStyle = '#f5ebdc'; g.fillRect(0, 0, 1024, 256);
    g.save(); g.translate(30, 0); TILE.burgerking(g); g.restore();
    g.fillStyle = '#d62300'; g.textAlign = 'left'; g.textBaseline = 'middle';
    fitFont(g, 'BURGER KING', 690, 120);
    g.fillText('BURGER KING', 310, 136);
  },
  lidl(g) {
    g.fillStyle = '#0050aa'; g.fillRect(0, 0, 1024, 256);
    g.save(); g.translate(384, 0); TILE.lidl(g); g.restore();
  },
  penny(g) {
    g.fillStyle = '#cd1414'; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#ffffff'; mid(g);
    g.font = `bold 176px ${FONT}`;
    g.fillText('PENNY', 490, 138);
    g.fillStyle = '#ffd400'; g.beginPath(); g.arc(820, 190, 20, 0, 7); g.fill();
  },
};

/** Draw chain `id`'s mark as a square tile (256 x 256). False when there is none drawn. */
export function drawTile(g, id) {
  if (TILE[id]) { TILE[id](g); return true; }
  // a band mark on a tile: its field, the mark across the middle
  if (!BAND[id]) return false;
  g.save(); g.scale(0.25, 0.25); g.translate(0, 384);
  BAND[id](g);
  g.restore();
  return 'band';
}
/** Draw chain `id`'s mark as a 4:1 panel (1024 x 256). */
export function drawBand(g, id) {
  if (!BAND[id]) return false;
  BAND[id](g);
  return true;
}
