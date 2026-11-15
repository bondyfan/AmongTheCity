// ---- Job board (J): today's offers, and the job you are on ----
// A list built on js/panel.js. It knows nothing about the world: js/careerjobs.js
// hands it the offers and the running job and gets two callbacks back, accept
// and abandon. Every name on it comes off the map and goes in as textContent.

import { makePanel, el } from './panel.js';
import { placeLabel } from './jobgen.js';
import { payEstimate, estRouteM, courierLimitS, haulLimitS, fmtDist, fmtClock } from './jobmath.js';
import { kc } from './prices.js';

const ICON = { courier: '📦', taxi: '🚕', haul: '🚚' };

export function jobTitle(job) {
  return job.kind === 'taxi' ? 'Taxi: ' + job.who
    : job.kind === 'haul' ? 'Dálková jízda: ' + job.what : 'Rozvoz: ' + job.what;
}

function row(job, { active = false, onAccept, onAbandon, busy }) {
  const r = el('div', 'atc-pn-row' + (active ? ' active' : ''));
  r.appendChild(el('span', 'pr-icon', ICON[job.kind]));
  const main = el('div', 'pr-main');
  main.appendChild(el('div', 'pr-title', jobTitle(job)));
  main.appendChild(el('div', 'pr-line', placeLabel(job.from) + '  →  ' + placeLabel(job.to)));
  const routeM = estRouteM(job.distM);
  // The courier's clock is an estimate until the route exists, and says so.
  const meta = job.kind === 'taxi'
    ? '≈ ' + fmtDist(routeM) + ' · prémie za plynulou jízdu · potřebuješ auto'
    : job.kind === 'haul'
      ? '≈ ' + fmtDist(routeM) + ' po D11 · limit ' + Math.round(haulLimitS(routeM) / 60) + ' min od vyzvednutí · palivo platíš ty'
      : '≈ ' + fmtDist(routeM) + ' · limit ≈ ' + fmtClock(courierLimitS(routeM)) + ' od vyzvednutí';
  main.appendChild(el('div', 'pr-line', meta));
  const side = el('div', 'pr-side');
  side.appendChild(el('span', 'pr-pay', 'až ' + kc(payEstimate(job.kind, job.distM))));
  const b = el('button', active ? 'atc-btn danger' : 'atc-btn', active ? 'Vzdát' : 'Přijmout');
  b.type = 'button';
  if (!active && busy) { b.disabled = true; b.title = 'Nejdřív dokonči nebo vzdej rozdělanou zakázku'; }
  b.addEventListener('click', () => (active ? onAbandon?.() : onAccept?.(job)));
  side.appendChild(b);
  r.append(main, side);
  return r;
}

export class JobBoard {
  constructor({ onAccept, onAbandon, onOpen }) {
    this.onAccept = onAccept; this.onAbandon = onAbandon;
    this.panel = makePanel({ title: 'ZAKÁZKY' });
    this._onOpen = onOpen;
  }

  get isOpen() { return this.panel.isOpen; }
  close() { this.panel.close(); }

  /** Open (or refresh) with the current state. */
  show({ offers, active, stage, doneToday, where }) {
    const body = this.panel.body;
    body.textContent = '';
    this.panel.sub.textContent = doneToday > 0 ? 'dnes hotovo: ' + doneToday : '';
    const cb = { onAccept: this.onAccept, onAbandon: this.onAbandon, busy: !!active };
    if (active) {
      body.appendChild(el('div', 'atc-pn-h3', 'Rozdělaná zakázka'));
      body.appendChild(row(active, { ...cb, active: true }));
      body.appendChild(el('p', 'atc-pn-note', stage === 'toDrop'
        ? 'Cíl je na mapě a vede k němu čára na silnici. Zastav u značky.'
        : 'Místo vyzvednutí je na mapě. Zastav u značky.'));
    }
    body.appendChild(el('div', 'atc-pn-h3', where ? 'Nabídky: ' + where : 'Nabídky v okolí'));
    if (!offers.length) {
      body.appendChild(el('div', 'atc-pn-empty',
        'Tady teď nikdo nic nepotřebuje. Zkus to o pár ulic dál, nabídky se mění podle čtvrti.'));
    }
    for (const j of offers) if (!active || j.id !== active.id) body.appendChild(row(j, cb));
    const note = el('p', 'atc-pn-note');
    // trusted markup: key names only
    note.innerHTML = '<kbd>J</kbd> zakázky · <kbd>P</kbd> přehled a úspěchy · <kbd>B</kbd> koupit nebo opravit auto · '
      + 'u restaurace <kbd>E</kbd> jídlo · u pumpy drž <kbd>F</kbd>';
    body.appendChild(note);
    if (!this.panel.isOpen) { this.panel.open(); this._onOpen?.(); }
  }
}
