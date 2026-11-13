// ---- Panel: the one modal every gameplay screen is built on ----
// The job board, the stats, the food menu, the car dealer and the "new game?"
// question are all the same object: a titled card on a dimmed backdrop. The
// rules for such a thing are written once, here:
//
//  1. ESCAPE CLOSES IT, in the capture phase with stopPropagation, exactly as
//     settings.js and worldmap.js do, so the game never sees the key press
//     that dismissed a dialog.
//  2. A CLICK OUTSIDE CLOSES IT, and "a click outside" means the press AND the
//     release both landed on the backdrop. A drag that starts on a button and
//     ends outside (or text selected from inside out) must not close anything,
//     and neither must a press outside let go over the card, so the targets
//     of pointerdown AND pointerup are remembered and the click is checked
//     against both. Checking the click target alone gets this wrong: the
//     browser reports a click on the common ancestor of the two ends, which
//     for a gesture with one end inside IS the backdrop.
//  3. IT NEVER KEEPS THE MOUSE. Opening releases the pointer lock and raises
//     body.dataset.panelOpen (the flag main.js reads before re-locking on a
//     canvas click). Closing lowers the flag unless another modal (settings,
//     the map) still needs it, and takes the backdrop out of the layout
//     entirely (display:none), so a closed panel cannot intercept anything.
//  4. ONE AT A TIME. Opening a panel closes whichever of its siblings is up.
//
// Styled by css/style.css (.atc-pn-*). Content is the caller's: `body` is an
// empty div to fill.

const _open = new Set();
let _keysBound = false;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
export { el };

// Is some OTHER module's modal up? Those raise the same flag, and lowering it
// under them would let the next click on the canvas grab the pointer back.
function foreignModalOpen() {
  return !!document.querySelector('#atc-set.atc-open, #atc-map.atc-open, .atc-map.atc-open');
}

function bindKeys() {
  if (_keysBound) return;
  _keysBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !_open.size) return;
    e.stopPropagation();
    for (const p of [..._open]) p.close();
  }, true);
}

/** True while any panel built here is open. */
export function anyPanelOpen() { return _open.size > 0; }

/**
 * makePanel({ title, narrow, onClose }) → { root, body, sub, setTitle, open,
 *   close, toggle, isOpen }
 * `sub` is a small right-aligned line in the header (a balance, a count).
 */
export function makePanel({ title = '', narrow = false, onClose = null } = {}) {
  // `.panel` on the BACKDROP, not just the card: input.js refuses to throw a
  // punch for a mousedown inside anything matching `.panel`, and the click
  // that dismisses a dialog from outside must not land on a pedestrian.
  const back = el('div', 'atc-pn-back panel');
  const card = el('div', 'atc-pn' + (narrow ? ' narrow' : ''));
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const head = el('div', 'atc-pn-head');
  const h2 = el('h2', '', title);
  const sub = el('span', 'atc-pn-sub');
  const x = el('button', 'atc-pn-close', '✕');
  x.type = 'button';
  x.title = 'Zavřít (Esc)';
  head.append(h2, sub, x);
  const body = el('div', 'atc-pn-body');
  card.append(head, body);
  back.appendChild(card);
  document.body.appendChild(back);
  bindKeys();

  let downOutside = false, upOutside = false;
  const api = {
    root: back, card, body, sub,
    isOpen: false,
    setTitle(t) { h2.textContent = t; },
    open() {
      if (api.isOpen) return;
      for (const p of [..._open]) p.close();
      api.isOpen = true;
      _open.add(api);
      back.classList.add('atc-open');
      document.exitPointerLock?.();
      document.body.dataset.panelOpen = '1';
      body.scrollTop = 0;
    },
    close() {
      if (!api.isOpen) return;
      api.isOpen = false;
      _open.delete(api);
      back.classList.remove('atc-open');
      if (!_open.size && !foreignModalOpen()) delete document.body.dataset.panelOpen;
      onClose?.();
    },
    toggle() { api.isOpen ? api.close() : api.open(); },
  };
  x.addEventListener('click', () => api.close());
  // rule 2: both ends of the gesture on the backdrop itself. The RELEASE is
  // remembered as well as the press: a press on the backdrop let go over the
  // card also reports its click on the backdrop (the common ancestor again),
  // and that gesture ended inside.
  back.addEventListener('pointerdown', (e) => { downOutside = e.target === back; upOutside = false; });
  back.addEventListener('pointerup', (e) => { upOutside = e.target === back; });
  back.addEventListener('click', (e) => {
    const out = downOutside && upOutside && e.target === back;
    downOutside = upOutside = false;
    if (out) api.close();
  });
  return api;
}

/**
 * A yes/no question on the same card. Resolves true only on the confirm
 * button; Escape, the ✕ and a click outside all mean no.
 */
export function confirmPanel({ title, text, yes = 'Ano', no = 'Zrušit', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const p = makePanel({ title, narrow: true, onClose: () => { p.root.remove(); resolve(answer); } });
    p.body.appendChild(el('p', 'atc-pn-note', text));
    const row = el('div', 'atc-pn-actions');
    const bNo = el('button', 'atc-btn ghost', no);
    const bYes = el('button', 'atc-btn' + (danger ? ' danger' : ''), yes);
    bNo.type = bYes.type = 'button';
    bNo.addEventListener('click', () => p.close());
    bYes.addEventListener('click', () => { answer = true; p.close(); });
    row.append(bNo, bYes);
    p.body.appendChild(row);
    p.open();
    bNo.focus();
  });
}
