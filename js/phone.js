// ---- phone.js: the phone the player takes out of his pocket ----
// Frank, 22 Nov 2026: "vytáhnu mobil a tam si to koupím." The campaign already
// shows a phone (js/prologue-hud.js `.journey-phone`: a call, a message); this
// is the one the player holds himself, in the same dark frame, and it is a
// panel (js/panel.js) in everything that matters: Escape and a click outside
// put it away, it never keeps the mouse, and it closes its siblings.
//
// The game does not stop under it. That is the point of buying a ticket on a
// phone: the train leaves while he is still looking at the screen.
//
// One screen for now (the tickets, js/phone-tickets.js). A screen is
// { title, build(body), refresh(), key(digit) }.

import { makePanel, el } from './panel.js';

const TICK = 400;      // ms between refreshes of an open screen

/**
 * makePhone({ clock }) → { panel, isOpen, show(screen), close(), toggle(screen) }
 *   clock() → "14:32", the game's hour for the status bar
 */
export function makePhone({ clock = () => '' } = {}) {
  let screen = null, timer = 0;
  const panel = makePanel({ title: 'Mobil', narrow: true, onClose: () => { clearInterval(timer); timer = 0; } });
  panel.root.classList.add('atc-phone-back');
  panel.card.classList.add('atc-phone');
  // the status bar over the app: the hour, the speaker slot, the signal
  const bar = el('div', 'atc-phone-bar');
  const time = el('span', 'ph-time');
  bar.append(time, el('i'), el('span', 'ph-net', '5G'));
  panel.card.prepend(bar);

  const refresh = () => {
    time.textContent = clock();
    screen?.refresh?.();
  };

  // the screen's own keys: 1, 2, 3 press its buttons
  window.addEventListener('keydown', (e) => {
    if (!panel.isOpen || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (m && screen?.key?.(Number(m[1]))) e.preventDefault();
  });

  return {
    panel,
    get isOpen() { return panel.isOpen; },
    get screen() { return screen; },
    refresh,
    show(next) {
      if (next && next !== screen) {
        screen = next;
        panel.body.textContent = '';
        screen.build(panel.body);
      }
      if (screen) panel.setTitle(screen.title);
      panel.open();
      refresh();
      if (!timer) timer = setInterval(refresh, TICK);
    },
    close() { panel.close(); },
    toggle(next) { if (panel.isOpen) panel.close(); else this.show(next); },
  };
}
