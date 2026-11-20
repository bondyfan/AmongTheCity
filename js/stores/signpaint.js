// ---- stores/signpaint.js: what a chain store's sign shows ----
// Canvas 2D only, called on the main thread by js/wordmarkatlas.js paintMark
// for a label that js/stores/signs.js made ('@lidl/sq'). Importing this file
// touches no DOM, so it may sit in the mesh worker's import graph unused.
//
// SIGN_STYLE.logos decides how close to the real mark a sign goes:
//   'drawn'  each chain's mark rebuilt from plain shapes (js/stores/logodraw.js).
//            The default: the owner chose the drawn marks (20 Nov 2026).
//   'plain'  the chain's own colours and its name in bold type, nothing drawn,
//            which is what the far fascias have always shown.

import { chainById, hoursText } from './chains.js';
import { parseSign } from './signs.js';
import { drawTile, drawBand } from './logodraw.js';

export const SIGN_STYLE = { logos: 'drawn' };

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
const FONT = 'Arial, Helvetica, sans-serif';

/** Bold text fitted into a box: the largest size up to `max` that is no wider than `wide`. */
function fit(g, text, wide, max, weight = 'bold') {
  let size = max;
  g.font = `${weight} ${size}px ${FONT}`;
  const tw = g.measureText(text).width;
  if (tw > wide) { size = Math.max(8, Math.floor(size * wide / tw)); g.font = `${weight} ${size}px ${FONT}`; }
  return size;
}

function band(g, chain) {
  g.fillStyle = css(chain.sign.bg);
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = css(chain.sign.fg);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  fit(g, chain.sign.text ?? chain.label, 900, 176);
  g.fillText(chain.sign.text ?? chain.label, 512, 136);
  if (chain.sign.rule !== undefined) {              // a coloured rule under the name
    g.fillStyle = css(chain.sign.rule);
    g.fillRect(170, 226, 684, 14);
  }
}

function tile(g, chain) {
  g.fillStyle = css(chain.sign.bg);
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = css(chain.sign.fg);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const big = chain.sign.big;
  if (big) {
    fit(g, big, 190, 170);
    g.fillText(big, 128, 108);
    fit(g, chain.label, 214, 40);
    g.fillText(chain.label, 128, 214);
  } else {
    const words = (chain.sign.text ?? chain.label).split(' ');
    if (words.length > 1) {
      const size = Math.min(...words.map((t) => fit(g, t, 214, 96)));
      g.font = `bold ${size}px ${FONT}`;
      words.forEach((t, i) => g.fillText(t, 128, 134 + (i - (words.length - 1) / 2) * size * 1.05));
    } else {
      fit(g, words[0], 214, 120);
      g.fillText(words[0], 128, 134);
    }
  }
}

function hours(g, chain) {
  g.fillStyle = '#f4f4f1';
  g.fillRect(0, 0, 205, 256);
  g.fillStyle = css(chain.sign.bg === 0xffffff ? chain.sign.fg : chain.sign.bg);
  g.fillRect(0, 0, 205, 56);
  g.fillStyle = css(chain.sign.bg === 0xffffff ? 0xffffff : chain.sign.fg);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  fit(g, chain.label, 180, 34);
  g.fillText(chain.label, 102, 30);
  g.fillStyle = '#22262b';
  g.font = `bold 21px ${FONT}`;
  g.fillText('OTEVÍRACÍ DOBA', 102, 86);
  g.font = `20px ${FONT}`;
  g.fillText('pondělí až neděle', 102, 124);
  const t = hoursText(chain);
  fit(g, t, 180, 36);
  g.fillText(t, 102, 172);
  g.font = `15px ${FONT}`;
  g.fillStyle = '#5a6067';
  g.fillText('Těšíme se na vás', 102, 224);
}

/**
 * Paint the sign a label names into the w x h rectangle at (ox, oy).
 * Returns false for a label that is not a store sign (the caller typesets it).
 */
export function paintStoreSign(g, brand, label, ox, oy, w, h) {
  const k = parseSign(label);
  const chain = k && chainById(k.id);
  if (!chain) return false;
  g.save();
  // each variant is drawn in its own design space and stretched over the slot:
  // the quad it is shown on has that variant's true proportions
  const drawn = SIGN_STYLE.logos === 'drawn';
  if (k.variant === 'sq') {
    g.setTransform(w / 256, 0, 0, h / 256, ox, oy);
    if (drawn) {
      g.fillStyle = css(chain.sign.bg); g.fillRect(0, 0, 256, 256);
      if (!drawTile(g, chain.id)) tile(g, chain);
    } else tile(g, chain);
  } else if (k.variant === 'hours') { g.setTransform(w / 205, 0, 0, h / 256, ox, oy); hours(g, chain); }
  else { g.setTransform(w / 1024, 0, 0, h / 256, ox, oy); if (!drawn || !drawBand(g, chain.id)) band(g, chain); }
  g.restore();
  return true;
}
