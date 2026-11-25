// ---- phone-tickets.js: the ticket screen of the phone ----
// Where he is (aboard a train, at a station, or how far the nearest one is),
// which trains stand or are due there, the two tickets with their prices, how
// many of each the phone already holds, and what the conductor will make of
// him (js/tickets.js has the rule).
//
// ticketScreen() is the whole content as plain data, so a test can read it
// without a browser; ticketApp() draws it into the phone (js/phone.js).

import { el } from './panel.js';
import PRICE, { kc } from './prices.js';
import { KINDS, KIND_NAME, MAX_HELD, kindOf, fare } from './tickets.js';

const AT = 260;         // m: this near a station he is "at" it
const DUE = 1800;       // m: a train this near and running for it is "arriving"
const LINE = Object.freeze({
  os: 'Jedna jízda jedním osobním vlakem, jakkoli daleko.',
  r: 'R Pardubice – Praha, jedna jízda. Vezmou ji i v osobním vlaku.',
});

const metres = (d) => (d < 950 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km');
const trainName = (t) => t.label ?? KIND_NAME.os;

/**
 * The screen as data.
 * @param s { tickets, trains, express?, x, z, money }
 * @returns { place, lines[], status, tone, offers[{ kind, name, line, price, count, can, why }], note }
 */
export function ticketScreen({ tickets, trains, express = null, x = 0, z = 0, money = 0 }) {
  const out = { place: '', lines: [], status: '', tone: '', offers: [], note: '' };
  const riding = trains?.riding ?? null;
  let lead = 'os';
  if (riding) {
    lead = kindOf(riding);
    out.place = 'Ve vlaku: ' + trainName(riding);
    out.lines.push(!riding.halted ? 'Příští stanice: ' + (riding.nextStopName ?? 'zatím neznámá')
      : !riding.stopName ? 'Stojí na trati'
        : riding.stopName + ' · odjezd za ' + Math.ceil(riding.dwellLeft ?? 0) + ' s');
    const state = tickets.ride?.state ?? 'open';
    if (state === 'valid') { out.status = 'Jízdenka je označená. Platí, dokud nevystoupíš.'; out.tone = 'good'; }
    else if (state === 'off') { out.status = 'Průvodčí tě v další stanici vysadí.'; out.tone = 'warn'; }
    else if (tickets.has(lead)) { out.status = 'Jízdenku máš. Průvodčí ji označí po odjezdu.'; out.tone = 'good'; }
    else { out.status = 'Jedeš bez jízdenky. Kup ji, než přijde průvodčí.'; out.tone = 'warn'; }
  } else {
    const st = trains?.stationNear?.(x, z) ?? null;
    if (!st) out.place = 'Žádná stanice v dohledu';
    else if (st.d > AT) {
      out.place = 'Nejbližší stanice';
      out.lines.push(st.name + ' · ' + metres(st.d));
    } else {
      out.place = st.name;
      let standing = null, sd = Infinity;
      for (const t of trains.trains) {
        if (t.halted && t.station && t.stopName === st.name) {
          out.lines.push(trainName(t) + ' · odjezd za ' + Math.ceil(t.dwellLeft ?? 0) + ' s');
          const d = Math.hypot(t.x - x, t.z - z);
          if (d < sd) { sd = d; standing = t; }
        } else if (!t.halted && t.nextStopName === st.name && Math.hypot(t.x - st.x, t.z - st.z) < DUE) {
          out.lines.push(trainName(t) + ' · přijíždí');
        }
      }
      if (standing) lead = kindOf(standing);
      // the express's own timetable, while it is not at the platform itself
      const dep = express?.hintAt?.(x, z);
      if (dep && !out.lines.some((l) => l.startsWith(dep.split(' · ')[0]))) out.lines.push(dep);
      if (!out.lines.length) out.lines.push('Teď tu žádný vlak nestojí');
    }
    out.note = 'Jízdenka je na jednu jízdu jedním vlakem. Bez ní zaplatíš průvodčímu jízdné a přirážku '
      + kc(PRICE.train.fine) + '.';
  }
  for (const kind of [lead, ...KINDS.filter((k) => k !== lead)]) {
    const price = fare(kind), count = tickets.count(kind);
    const why = count >= MAX_HELD ? 'Víc se jich do mobilu nevejde' : money < price ? 'Chybí ti ' + kc(price - money) : '';
    out.offers.push({ kind, name: KIND_NAME[kind], line: LINE[kind], price, count, can: !why, why });
  }
  return out;
}

/**
 * The screen for js/phone.js.
 * @param host { tickets, trains, express?, player, money() }
 */
export function ticketApp(host) {
  const rows = new Map();      // kind → { row, title, line, pay, btn }
  let order = '', place, lines, status, note, list;

  const read = () => ticketScreen({
    tickets: host.tickets, trains: host.trains, express: host.express,
    x: host.player?.pos?.x ?? 0, z: host.player?.pos?.z ?? 0, money: host.money(),
  });

  function buy(kind) {
    const res = host.tickets.buy(kind);
    const r = rows.get(kind);
    if (r) {
      r.row.classList.remove('bought', 'refused');
      void r.row.offsetWidth;                       // restart the flash
      r.row.classList.add(res.ok ? 'bought' : 'refused');
    }
    refresh();
    return res.ok;
  }

  function build(body) {
    const where = el('div', 'atc-phone-where');
    place = el('strong');
    lines = el('div', 'ph-lines');
    where.append(place, lines);
    status = el('div', 'atc-phone-status');
    list = el('div', 'atc-phone-list');
    for (const kind of KINDS) {
      const row = el('div', 'atc-pn-row');
      const main = el('div', 'pr-main');
      const title = el('div', 'pr-title'), line = el('div', 'pr-line');
      main.append(title, line);
      const side = el('div', 'pr-side');
      const pay = el('span', 'pr-pay cost');
      const btn = el('button', 'atc-btn');
      btn.type = 'button';
      btn.addEventListener('click', () => buy(kind));
      side.append(pay, btn);
      row.append(el('span', 'pr-icon', '🎫'), main, side);
      rows.set(kind, { row, title, line, pay, btn });
    }
    note = el('p', 'atc-pn-note');
    body.append(where, status, list, note);
  }

  function refresh() {
    if (!place) return;
    const s = read();
    place.textContent = s.place;
    const text = s.lines.join('\n');
    if (lines.textContent !== text) lines.textContent = text;
    status.textContent = s.status;
    status.className = 'atc-phone-status' + (s.tone ? ' ' + s.tone : '');
    status.hidden = !s.status;
    note.textContent = s.note;
    note.hidden = !s.note;
    // the ticket for the train in front of him comes first (moved only when
    // the order really changes: a row taken out mid-click loses the click)
    const next = s.offers.map((o) => o.kind).join();
    if (next !== order) { order = next; for (const o of s.offers) list.append(rows.get(o.kind).row); }
    s.offers.forEach((o, i) => {
      const r = rows.get(o.kind);
      r.title.textContent = o.name + (o.count ? ' · máš ' + o.count : '');
      r.line.textContent = o.why || o.line;
      r.pay.textContent = kc(o.price);
      r.btn.textContent = 'Koupit (' + (i + 1) + ')';
      r.btn.disabled = !o.can;
      r.row.classList.toggle('active', o.count > 0);
    });
  }

  return {
    title: 'Jízdenky',
    build, refresh,
    /** 1 and 2 buy the first and the second ticket on the screen. */
    key(n) {
      const kind = order.split(',')[n - 1];
      if (!kind || rows.get(kind)?.btn.disabled) return false;
      buy(kind);
      return true;
    },
  };
}
