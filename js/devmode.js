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
  host.append(txt, btn);

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

/**
 * actions: {
 *   teleport(place) — place is one of DEV_PLACES
 *   spawnCar(kind)  — kind is a CAR_KINDS entry
 *   pose()          — { x, y, z, lat, lon, headingDeg, pitchDeg, tile, chunk,
 *                       ride, place } for the readout
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
