// ---- creator.js: choose who you are ----------------------------------------------
//
// The screen a new campaign opens with, and the same screen behind "Vzhled
// postavy" in the settings. The player picks a build, a skin tone, a face (with
// its hair), a style of clothes and an outfit; the result is one short code
// (js/characters/appearance.js) that the save keeps, free roam reads and the
// co-op layer sends to everybody else.
//
// What it offers is whatever the loaded catalogue has: the lists are computed,
// never written down here. With no people bank loaded there is nothing to
// choose from and showCreator() resolves at once with the code it was given.
//
// As a step before the game (from the menu) it has one way out, forward. As a
// dialog over the running game it follows the house rules for dialogs: Escape
// closes it, and so does a click whose press AND release both land outside
// the card.

import { MENU_CSS } from '../menustyle.js';
import { CREATOR_CSS } from './creatorstyle.js';
import { peopleReady } from './avatars.js';
import { creatorOptions, describeLook, encodeLook, validLook, defaultLook, loadMyLook, saveMyLook, setLookFor, styleName } from './appearance.js';
import { baseId } from '../identity.js';

const TONES = [0xf3d2b3, 0xdba878, 0xb07a4f, 0x6e4a30];
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function css(id, text) {
  if (document.getElementById(id)) return;
  const st = el('style'); st.id = id; st.textContent = text;
  document.head.appendChild(st);
}

/** The code the local player wears right now (their choice, or the default for their uid). */
export function myLook() {
  return validLook(loadMyLook()) ?? defaultLook(baseId());
}

/** Keep a choice: storage, and the registry every body is built from. */
export function commitLook(code) {
  const c = validLook(code);
  if (!c) return '';
  saveMyLook(c);
  setLookFor(baseId(), c);
  return c;
}

/**
 * showCreator({ code, modal, start }) -> Promise<string | null>
 *   code   the look to open on (default: the player's current one)
 *   modal  true over a running game: can be cancelled (resolves null)
 *   start  the label of the confirming button
 * Resolves with the chosen code, already committed.
 */
export async function showCreator({ code = myLook(), modal = false, start = modal ? 'Uložit vzhled' : '▶ Hrát' } = {}) {
  if (!peopleReady() || typeof document === 'undefined') return validLook(code) ?? null;
  const O = creatorOptions();
  if (!O.all.length) return validLook(code) ?? null;
  const { makeStage } = await import('./creatorstage.js');
  css('atc-menu-css', MENU_CSS);
  css('atc-creator-css', CREATOR_CSS);

  return new Promise((resolve) => {
    const at = describeLook(code) ?? describeLook(defaultLook(baseId())) ?? {};
    const S = { sex: at.sex ?? O.sexes[0], tone: at.tone ?? 0, style: at.style ?? 'casual', head: at.head?.id ?? null, body: at.body?.id ?? null };

    const root = el('div'); root.id = 'atc-creator';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Tvůrce postavy');
    if (modal) root.classList.add('atc-cr-modal');
    const stageBox = el('div', 'atc-cr-stage');
    const canvas = el('canvas');
    stageBox.append(canvas, el('div', 'atc-cr-hint', 'Tažením otočíš postavu'));
    const side = el('div', 'atc-cr-side'), card = el('div', 'atc-cr-card');
    card.append(el('div', 'atc-cr-kicker', modal ? 'Vzhled postavy' : 'Poslední vlak · než vyrazíš'),
      el('h2', 'atc-cr-title', 'Tvoje postava'),
      el('p', 'atc-cr-sub', 'Vyber si, jak budeš ve městě vypadat. Stejně tě uvidí i ostatní hráči.'));
    // the choices scroll if they must; the buttons under them never leave the screen
    const list = el('div', 'atc-cr-list');
    card.appendChild(list);
    const sect = (label) => { list.appendChild(el('div', 'atc-cr-label', label)); const d = el('div'); list.appendChild(d); return d; };
    const sexBox = sect('Postava'), toneBox = sect('Barva pleti'), headBox = sect('Obličej a účes'),
      styleBox = sect('Styl oblečení'), bodyBox = sect('Oblečení');
    const foot = el('div', 'atc-cr-foot');
    const dice = el('button', 'atc-menu-btn atc-cr-quiet', '🎲 Náhodně'); dice.type = 'button';
    const go = el('button', 'atc-menu-btn primary', start); go.type = 'button';
    foot.append(dice, go);
    if (modal) { const back = el('button', 'atc-menu-btn atc-cr-quiet', 'Zpět'); back.type = 'button'; back.addEventListener('click', () => close(null)); foot.prepend(back); }
    card.appendChild(foot);
    side.appendChild(card);
    root.append(stageBox, side);
    document.body.appendChild(root);
    const stage = makeStage(canvas);
    requestAnimationFrame(() => root.classList.add('atc-cr-in'));

    const thumbs = new Map();
    const thumbOf = (id, mode) => {
      const k = mode + id;
      if (!thumbs.has(k)) thumbs.set(k, stage.thumb(id, mode));
      return thumbs.get(k);
    };
    const first = (list, id) => (list.some((a) => a.id === id) ? id : list[0]?.id ?? null);
    // every choice narrows the ones under it: keep what still fits, else take the first
    const settle = () => {
      if (!O.sexes.includes(S.sex)) S.sex = O.sexes[0];
      const tones = O.tones(S.sex);
      if (!tones.includes(S.tone)) S.tone = tones[0];
      S.head = first(O.heads(S.sex, S.tone), S.head);
      const styles = O.styles(S.sex, S.tone);
      if (!styles.includes(S.style)) S.style = styles[0];
      S.body = first(O.bodies(S.sex, S.tone, S.style), S.body);
    };
    const codeNow = () => encodeLook({ head: S.head ?? S.body, body: S.body });

    const pill = (box, items, cur, pick, aria) => {
      box.textContent = '';
      const p = el('div', 'atc-cr-pill'); p.setAttribute('role', 'radiogroup'); p.setAttribute('aria-label', aria);
      for (const [val, label] of items) {
        const b = el('button', 'atc-place-opt', label); b.type = 'button';
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(val === cur));
        b.addEventListener('click', () => pick(val));
        p.appendChild(b);
      }
      box.appendChild(p);
    };
    const grid = (box, list, cur, mode, pick, aria) => {
      box.textContent = '';
      if (!list.length) { box.appendChild(el('div', 'atc-cr-none', 'Tady zatím nic není.')); return; }
      const g = el('div', 'atc-cr-grid'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', aria);
      list.forEach((a, i) => {
        const b = el('button', 'atc-cr-opt'); b.type = 'button';
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(a.id === cur));
        b.setAttribute('aria-label', `${aria} ${i + 1}`);
        b.style.backgroundImage = `url(${thumbOf(a.id, mode)})`;
        // the first picture may be drawn with the small far texture: redo it once the sharp one is in
        stage.sharp(a.id).then((late) => {
          if (!late || done) return;
          thumbs.set(mode + a.id, stage.thumb(a.id, mode));
          if (b.isConnected) b.style.backgroundImage = `url(${thumbs.get(mode + a.id)})`;
        });
        b.addEventListener('click', () => pick(a.id));
        g.appendChild(b);
      });
      box.appendChild(g);
    };
    const paint = (focus = 'body') => {
      settle();
      pill(sexBox, O.sexes.map((s) => [s, s === 'f' ? 'Žena' : 'Muž']), S.sex, (v) => { S.sex = v; paint(); }, 'Postava');
      toneBox.textContent = '';
      const tb = el('div', 'atc-cr-tones'); tb.setAttribute('role', 'radiogroup'); tb.setAttribute('aria-label', 'Barva pleti');
      for (const t of O.tones(S.sex)) {
        const b = el('button', 'atc-cr-tone'); b.type = 'button';
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t === S.tone));
        b.setAttribute('aria-label', `Odstín ${t + 1}`);
        const sample = O.heads(S.sex, t)[0]?.skin;
        b.style.background = hex(sample ?? TONES[Math.min(TONES.length - 1, t)]);
        b.addEventListener('click', () => { S.tone = t; paint('face'); });
        tb.appendChild(b);
      }
      toneBox.appendChild(tb);
      grid(headBox, O.heads(S.sex, S.tone), S.head, 'face', (id) => { S.head = id; paint('face'); }, 'Obličej');
      pill(styleBox, O.styles(S.sex, S.tone).map((s) => [s, styleName(s)]), S.style, (v) => { S.style = v; S.body = null; paint(); }, 'Styl oblečení');
      grid(bodyBox, O.bodies(S.sex, S.tone, S.style), S.body, 'body', (id) => { S.body = id; paint(); }, 'Oblečení');
      stage.setLook({ head: S.head, body: S.body });
      stage.focus(focus);
    };
    paint();

    dice.addEventListener('click', () => {
      const pick = (a) => a[(Math.random() * a.length) | 0];
      S.sex = pick(O.sexes); S.tone = pick(O.tones(S.sex));
      S.head = pick(O.heads(S.sex, S.tone))?.id ?? null;
      S.style = pick(O.styles(S.sex, S.tone)); S.body = pick(O.bodies(S.sex, S.tone, S.style))?.id ?? null;
      paint();
    });

    let done = false;
    // a click outside counts only when its press began outside too
    let downOut = false;
    const onDown = (e) => { downOut = e.target === root || e.target === side || e.target === stageBox; };
    const onClick = (e) => { if (modal && downOut && (e.target === root || e.target === side)) close(null); downOut = false; };
    const onKey = (e) => {
      if (e.key === 'Escape' && modal) { e.stopPropagation(); close(null); } else if (e.key === 'Enter') { e.preventDefault(); go.click(); }
    };
    function close(result) {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('pointerdown', onDown); root.removeEventListener('click', onClick);
      if (modal) delete document.body.dataset.panelOpen;
      root.classList.remove('atc-cr-in');
      setTimeout(() => { stage.dispose(); root.remove(); }, 360);
      resolve(result);
    }
    go.addEventListener('click', () => close(commitLook(codeNow()) || null));
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', onDown); root.addEventListener('click', onClick);
    if (modal) { document.exitPointerLock?.(); document.body.dataset.panelOpen = '1'; }
    go.focus({ preventScroll: true });
    list.scrollTop = 0;
    // for the dev harness and the tests of the flow
    root.__creator = { state: S, code: codeNow, stage, close };
  });
}
