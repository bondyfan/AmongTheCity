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

export const isDevMode = () => /(^|[?&])devmode(=|&|$)/.test(location.search);

// Every teleport is a real place, converted from its lat/lon through the same
// origin the tile pipeline uses (Pardubice hlavní nádraží). The station entry
// is the SPAWN forecourt rather than the raw origin node — OSM parks that node
// amid the tracks, and arriving between the rails is not a useful teleport.
export const DEV_PLACES = [
  { n: 'Pardubice hl. nádraží', x: 25, z: -122, h: Math.PI },
  { n: 'Pardubice — most přes Labe', x: -802, z: -995, h: 0 },
  { n: 'Pardubice letiště', x: -1257, z: 2032, h: 0 },
  { n: 'Praha — Václavské nám.', x: -95270, z: -5517, h: Math.PI },
  { n: 'Praha — letiště', x: -107193, z: -7688, h: 0 },
  // …and the east. Zlín is 163 km from the spawn, which is four minutes in the
  // Gripen and two hours in an Octavia, so it needs a door of its own.
  { n: 'Olomouc — Horní nám.', x: 107101, z: 48709, h: Math.PI },
  { n: 'Otrokovice', x: 127335, z: 91433, h: 0 },
  // …on třída Tomáše Bati rather than on the square itself: náměstí Míru is
  // roofed by OC Zlaté jablko, and arriving inside a shopping centre is not a
  // useful teleport (the same reason the station entry is its forecourt).
  { n: 'Zlín — tř. T. Bati', x: 136864, z: 89742, h: Math.PI / 2 },
  { n: 'Kudlov', x: 135947, z: 92122, h: 0 },
  { n: 'Březůvky', x: 140461, z: 97194, h: 0 },
];

// Czech names for the kinds vehicles.js exports, so the dropdown reads like a
// car park and not like an enum. Anything the roster gains later still shows
// up — it just shows up under its own id until it is named here.
const KIND_LABEL = {
  octavia: 'Škoda Octavia', fabia: 'Škoda Fabia', bmw: 'BMW',
  mercedes: 'Mercedes', tesla: 'Tesla', van: 'Dodávka',
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
.atc-dev-row .atc-dev-btn { width: auto; flex: 0 0 auto; }
.atc-set-h3.atc-dev-h3 { color: #ffb454; }
`.replace('#2a3purple', '#2a3550');

let styled = false;
function injectCss() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * actions: {
 *   teleport(place) — place is one of DEV_PLACES
 *   spawnCar(kind)  — kind is a CAR_KINDS entry
 * }
 * Safe to call repeatedly; it re-attaches only when the section is missing.
 */
export function initDevMode(actions) {
  if (!isDevMode()) return false;
  injectCss();

  const attach = () => {
    const body = document.querySelector('#atc-set .atc-set-body')
      ?? document.querySelector('#atc-set > div')
      ?? document.getElementById('atc-set');
    if (!body || document.getElementById('atc-dev-grid')) return !!body;

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
    for (const k of [...CAR_KINDS, 'heli', 'gripen']) {
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
