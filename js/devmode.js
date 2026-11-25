// ---- Dev tools: teleports and a car spawner, behind ?devmode ----
//
// Off unless the URL says so, so a normal player can never trip over it and a
// build needs no separate flavour: `?devmode` on the address is the whole gate.
//
// It APPENDS to the settings panel rather than living in settings.js, and that
// is deliberate. settings.js owns the player's real preferences — things that
// persist, fork the quality preset and are read every frame. Dev actions are
// none of those: they are one-shot verbs that need the game's own objects
// (world, player, vehicles). Keeping them in their own module means the
// settings file stays a pure preferences store, and it means this file can be
// deleted whole without touching anything a player uses.
//
// It also has to survive the panel being rebuilt: initSettings() constructs the
// panel once, but it is re-created whenever settings.js is edited during a dev
// session, so the section re-attaches on demand rather than exactly once.

import { CAR_KINDS } from './vehicles.js';
import { DEV_QUICK, DEV_MONEY_WHY, parseDevAmount, quickLabel } from './devmoney.js';
import { kc } from './prices.js';

export const isDevMode = () => /(^|[?&])devmode(=|&|$)/.test(location.search);

// Every teleport is a real place, converted from its lat/lon through the same
// origin the tile pipeline uses (Pardubice hlavní nádraží). The station entry
// is the SPAWN forecourt rather than the raw origin node — OSM parks that node
// amid the tracks, and arriving between the rails is not a useful teleport.
export const DEV_PLACES = [
  { n: 'Pardubice hl. nádraží', x: 25, z: -122, h: Math.PI },
  { n: 'Pardubice, most přes Labe', x: -802, z: -995, h: 0 },
  { n: 'Pardubice letiště', x: -1257, z: 2032, h: 0 },
  { n: 'Praha, Václavské nám.', x: -95270, z: -5517, h: Math.PI },
  { n: 'Praha, letiště', x: -107193, z: -7688, h: 0 },
  // …and the east. Zlín is 163 km from the spawn, which is four minutes in the
  // Gripen and two hours in an Octavia, so it needs a door of its own.
  { n: 'Olomouc, Horní nám.', x: 107101, z: 48709, h: Math.PI },
  { n: 'Otrokovice', x: 127335, z: 91433, h: 0 },
  // …on třída Tomáše Bati rather than on the square itself: náměstí Míru is
  // roofed by OC Zlaté jablko, and arriving inside a shopping centre is not a
  // useful teleport (the same reason the station entry is its forecourt).
  { n: 'Zlín, tř. T. Bati', x: 136864, z: 89742, h: Math.PI / 2 },
  { n: 'Kudlov', x: 135947, z: 92122, h: 0 },
  { n: 'Březůvky', x: 140461, z: 97194, h: 0 },
  // The D11 (round 8), eastbound towards Hradec. Each door stands on the
  // verge 9.5 m right of the carriageway's centreline (3.25 m off the
  // asphalt, on the flat bench the ground is clamped to), looking along the
  // motorway: never ON a lane, where the first truck ends the reproduction.
  // Points from js/d11.js d11At at the official km, checked clear of every
  // other road and off every bridge deck.
  { n: 'D11, rovina u Kostelní Lhoty (km 30)', x: -54566, z: -9850, h: -1.26 },
  { n: 'D11, exit 8 Jirny', x: -75904, z: -10051, h: -1.51 },          // 250 m before the diverge
  { n: 'D11, most přes Labe u Poděbrad', x: -42885, z: -9607, h: -1.49 }, // 60 m before the deck
  { n: 'D11, ekodukt Žehuň', x: -32663, z: -9945, h: -1.37 },          // 90 m before the green bridge
  { n: 'D11, estakáda u Chlumce', x: -25041, z: -10649, h: -1.23 },    // 50 m before the 542 m viaduct
  { n: 'D11, exit 68 Chýšť', x: -17468, z: -11309, h: -1.17 },
  { n: 'D11/D35, křižovatka Sedlice', x: -1870, z: -12849, h: -0.97 },
  // on the Benzina forecourt, 3 m beside the lane in to the pumps and 3 m
  // short of the canopy (a building=roof footprint, which city.collide holds
  // solid: a door under it lands inside a box), facing the pumps
  { n: 'D11, odpočívka Osice', x: -4202.5, z: -11741.5, h: -1.3 },
];

// Czech names for the kinds vehicles.js exports, so the dropdown reads like a
// car park and not like an enum. Anything the roster gains later still shows
// up — it just shows up under its own id until it is named here.
const KIND_LABEL = {
  octavia: 'Škoda Octavia', fabia: 'Škoda Fabia', bmw: 'BMW',
  mercedes: 'Mercedes', tesla: 'Tesla Model 3', van: 'Dodávka',
  octaviaCombi: 'Škoda Octavia Combi', roadster: 'Tesla Roadster',
  truck: 'Náklaďák', bus: 'Autobus',
  sedan: 'Sedan', hatch: 'Hatchback', kombi: 'Kombi', suv: 'SUV',
  heli: '🚁 Vrtulník', gripen: '✈️ Gripen (stíhačka)',
};

const CSS = `
#atc-dev-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; }
#atc-dev-grid .atc-dev-btn {
  display: block; width: 100%; padding: 9px 10px; cursor: pointer;
  font: 600 12.5px/1.2 system-ui, sans-serif; color: #dbe7f6; text-align: left;
  background: #1d2636; border: 1px solid #33425c; border-radius: 8px;
}
#atc-dev-grid .atc-dev-btn:hover { background: #26334a; border-color: #4a6288; }
#atc-dev-grid .atc-dev-btn:active { transform: translateY(1px); }
.atc-dev-row {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; background: #161e2b; border: 1px solid #2a3550; border-radius: 8px;
}
.atc-dev-row select {
  flex: 1; padding: 6px 8px; border-radius: 6px; background: #0f1725;
  color: #dbe7f6; border: 1px solid #33425c; font: 500 12.5px system-ui, sans-serif;
}
/* the id is needed to beat "#atc-dev-grid .atc-dev-btn { width: 100% }": without
   it the Spawnout button took the whole row and the dev tab scrolled sideways */
#atc-dev-grid .atc-dev-row .atc-dev-btn { width: auto; flex: 0 0 auto; }
.atc-set-h3.atc-dev-h3 { color: #ffb454; }
#atc-dev-money { display: grid; gap: 8px; margin-bottom: 12px; }
#atc-dev-money .atc-dev-row { grid-column: auto; }
#atc-dev-money input {
  flex: 1; min-width: 0; padding: 7px 9px; border-radius: 6px; background: #0f1725;
  color: #dbe7f6; border: 1px solid #33425c; font: 500 13px system-ui, sans-serif;
}
#atc-dev-money input:focus { outline: none; border-color: #ffb454; }
#atc-dev-money .atc-dev-quick { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; }
#atc-dev-money .atc-dev-btn {
  padding: 8px 10px; cursor: pointer; font: 600 12.5px/1.2 system-ui, sans-serif;
  color: #dbe7f6; background: #1d2636; border: 1px solid #33425c; border-radius: 8px;
}
#atc-dev-money .atc-dev-btn:hover { background: #26334a; border-color: #4a6288; }
#atc-dev-money .atc-dev-btn:active { transform: translateY(1px); }
#atc-dev-money .atc-dev-add { color: #0b111b; background: #ffb454; border-color: #ffb454; }
#atc-dev-money .atc-dev-add:hover { background: #ffc477; border-color: #ffc477; }
#atc-dev-money .atc-dev-msg { margin: 0 2px; font: 500 12px/1.4 system-ui, sans-serif; color: #8ea3c0; }
#atc-dev-money .atc-dev-msg.ok { color: #7fd18a; }
#atc-dev-money .atc-dev-msg.bad { color: #ff8a7a; }

`.replace('#2a3purple', '#2a3550');

let styled = false;
function injectCss() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---- the pose readout ------------------------------------------------------
// Debugging this world by description does not work. "There is a beige strip
// across the road near the hotel" costs a round trip and a guess; the same
// report with the exact spot and the exact heading is a teleport away from
// being reproduced. So devmode carries a live readout of where the player is
// and which way they are looking, and one button that puts all of it on the
// clipboard in a form that can be pasted straight into a message.
//
// lat/lon is in there deliberately: it is the one coordinate that means
// something OUTSIDE this project, so a report can be checked against the
// aerial photo, the cadastre or OSM without anyone converting anything.
function poseBlock(p) {
  if (!p) return 'no pose';
  const n = (v, d = 1) => (v === undefined || v === null ? '?' : v.toFixed(d));
  return [
    `x ${n(p.x)}  z ${n(p.z)}  y ${n(p.y)}`,
    `lat ${n(p.lat, 6)}  lon ${n(p.lon, 6)}`,
    `heading ${n(p.headingDeg, 0)}°  pitch ${n(p.pitchDeg, 0)}°`,
    `tile ${p.tile}  chunk ${p.chunk}`,
    `in ${p.ride ?? 'on foot'}${p.place ? '  ·  ' + p.place : ''}`,
  ].join('\n');
}

function mountPose(actions, host) {
  if (document.getElementById('atc-dev-pose')) return;
  const txt = document.createElement('div');
  txt.id = 'atc-dev-pose';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'atc-dev-copy';
  btn.textContent = '⧉ Kopírovat pozici a pohled';
  // first on the tab, above the traffic and crowd rows settings.js put there
  host.prepend(txt, btn);

  // A timer, not requestAnimationFrame: rAF does not fire in a background tab,
  // and a readout that goes blank the moment you alt-tab is exactly the readout
  // you wanted to read. Ten hertz is plenty for numbers a human types out.
  let last = null;
  setInterval(() => {
    last = actions.pose?.() ?? null;
    txt.textContent = poseBlock(last);
  }, 100);

  btn.addEventListener('click', async () => {
    const p = last;
    if (!p) return;
    const text = poseBlock(p);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard refused (insecure origin, no permission) — fall back to a
      // selection the player can copy by hand rather than silently doing nothing
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    btn.textContent = '✓ zkopírováno';
    btn.classList.add('ok');
    setTimeout(() => {
      btn.textContent = '⧉ Kopírovat pozici a pohled';
      btn.classList.remove('ok');
    }, 1200);
  });
}

// ---- money for testing -----------------------------------------------------
// Paid things (first the flight to Mahé, about 20 000 Kč) have to be tried
// without earning the fare first. The field takes any whole amount, the quick
// buttons the usual ones; js/devmoney.js says what counts as an amount and
// main.js's addMoney() pays it as a plain wallet.earn().
function mountMoney(actions, host) {
  if (document.getElementById('atc-dev-money')) return;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (cls, text, fn) => {
    const b = el('button', 'atc-dev-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  const box = el('div');
  box.id = 'atc-dev-money';
  const field = el('input');
  field.type = 'text';                 // not "number": "20 000" with a gap is how Czech writes it
  field.inputMode = 'numeric';
  field.placeholder = 'Částka v Kč';
  field.autocomplete = 'off';
  field.setAttribute('aria-label', 'Kolik peněz přidat (Kč)');
  const msg = el('p', 'atc-dev-msg');

  // The answer to a press stays up for a few seconds, then the line goes
  // back to the live balance.
  let holdUntil = 0;
  const say = (text, kind) => {
    msg.textContent = text;
    msg.classList.toggle('ok', kind === 'ok');
    msg.classList.toggle('bad', kind === 'bad');
    holdUntil = kind ? performance.now() + 4000 : 0;
  };
  const balance = () => {
    const m = actions.money?.();
    return Number.isFinite(m) ? 'Na účtu ' + kc(m) + '.' : '';
  };
  const give = (n) => {
    const after = actions.addMoney?.(n);
    if (!Number.isFinite(after)) { say('Nejdřív spusť hru, v menu se peníze nepřidávají.', 'bad'); return false; }
    say('Přidáno ' + quickLabel(n) + '. Na účtu ' + kc(after) + '.', 'ok');
    return true;
  };
  const submit = () => {
    const r = parseDevAmount(field.value);
    if (!r.ok) { say(DEV_MONEY_WHY[r.why], 'bad'); field.focus(); return; }
    if (give(r.amount)) field.value = '';
  };

  // Typing here must not drive the game: input.js listens on window and
  // would take the digits and the letters as key presses. Escape still
  // closes the panel, because settings.js catches it in the capture phase,
  // before it ever reaches this field.
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  field.addEventListener('keyup', (e) => e.stopPropagation());

  const row = el('div', 'atc-dev-row');
  row.append(field, btn('atc-dev-add', 'Přidat', submit));
  const quick = el('div', 'atc-dev-quick');
  for (const n of DEV_QUICK) quick.appendChild(btn('', quickLabel(n), () => give(n)));

  const h = el('h3', 'atc-set-h3 atc-dev-h3', '💰 Peníze');
  box.append(row, quick, msg);
  // under the pose readout, above the traffic rows: it is the other thing
  // this tab gets opened for
  const after = document.getElementById('atc-dev-copy');
  if (after?.parentNode === host) after.after(h, box);
  else host.prepend(h, box);

  // The balance line keeps up with spending elsewhere (a ticket bought with
  // the panel shut, a pump), on a timer for the same reason as the pose.
  setInterval(() => {
    if (holdUntil && performance.now() < holdUntil) return;
    if (holdUntil) say('');
    const b = balance();
    if (msg.textContent !== b) msg.textContent = b;
  }, 500);
}

/**
 * actions: {
 *   teleport(place) — place is one of DEV_PLACES
 *   spawnCar(kind)  — kind is a CAR_KINDS entry
 *   pose()          — { x, y, z, lat, lon, headingDeg, pitchDeg, tile, chunk,
 *                       ride, place } for the readout
 *   addMoney(n)     : earn n whole koruna; → the new balance, or null when
 *                     there is no game to give it to yet
 *   money()         : the balance, for the line under the money buttons
 * }
 * Safe to call repeatedly; it re-attaches only when the section is missing.
 */
export function initDevMode(actions) {
  if (!isDevMode()) return false;
  injectCss();

  const attach = () => {
    // settings.js gives the dev tools a TAB of their own behind ?devmode; older
    // markup without tabs still works, the tools just land at the bottom of the
    // one page there is.
    const body = document.querySelector('#atc-set .atc-set-page[data-tab="dev"]')
      ?? document.querySelector('#atc-set .atc-set-body')
      ?? document.getElementById('atc-set');
    if (!body || document.getElementById('atc-dev-grid')) return !!body;

    // where you are and what you are looking at, first: it is the thing you
    // open this tab for while something is going wrong
    mountPose(actions, body);
    mountMoney(actions, body);

    const h = document.createElement('h3');
    h.className = 'atc-set-h3 atc-dev-h3';
    h.textContent = '🛠 Dev (?devmode)';
    body.appendChild(h);

    const grid = document.createElement('div');
    grid.id = 'atc-dev-grid';

    for (const p of DEV_PLACES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'atc-dev-btn';
      b.textContent = '📍 ' + p.n;
      b.addEventListener('click', () => actions.teleport?.(p));
      grid.appendChild(b);
    }

    // car spawner: pick a kind, drop it on the road in front of you
    const row = document.createElement('div');
    row.className = 'atc-dev-row';
    const sel = document.createElement('select');
    // The flying machines ride the same dropdown: they are vehicles you walk up
    // to and press E on, exactly like a car, so a separate control would be a
    // second way to say one thing.
    for (const k of [...CAR_KINDS, 'roadster', 'heli', 'gripen']) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = KIND_LABEL[k] ?? k;
      sel.appendChild(o);
    }
    const spawn = document.createElement('button');
    spawn.type = 'button';
    spawn.className = 'atc-dev-btn';
    spawn.textContent = 'Spawnout';
    spawn.addEventListener('click', () => actions.spawnCar?.(sel.value));
    row.append(sel, spawn);
    grid.appendChild(row);

    body.appendChild(grid);
    return true;
  };

  if (!attach()) {
    // the panel is built by initSettings, which may not have run yet — watch
    // for it instead of guessing at a delay
    const mo = new MutationObserver(() => { if (attach()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  return true;
}
