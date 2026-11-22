// ---- Settings: the ⚙️ panel — presets, advanced graphics, game options ----
// Woods-style options panel rebuilt for the city, fully self-contained: every bit of DOM
// and CSS is injected from here so index.html and style.css stay untouched (the v2 contract
// keeps modules in their own files). main.js calls initSettings(apply) once; each change is
// persisted to localStorage AND pushed through apply(settings, changedKey), so toggles take
// effect live without a reload. Preset semantics copy the Woods panel players already know:
// picking Low/Medium/High stamps all graphics keys at once, and touching any advanced field
// forks the dropdown to "Vlastní" (custom) so the label never lies about what's on screen.

// The name-tag range ladder comes FROM nametags.js rather than being retyped
// here: this panel is the only thing that moves that number, and two lists
// that must match are one list that will not.
import { NAME_RANGES } from './nametags.js';
// traffic, the crowd and the police: fixed outside ?devmode (js/worldsettings.js)
import { WORLD, WORLD_ROWS, worldValues, storedWorld, forStorage } from './worldsettings.js';
import { SETTINGS_CSS } from './settingsstyle.js';

const LS_KEY = 'atc-settings';

// The graphics keys a preset owns. mouseLook and volume are personal preferences, not
// performance knobs — presets leave them alone and changing them never forks to custom.
// `ao` and `ortho` belong to the presets now. Both were switchable but neither
// was ever STAMPED by one, so the aerial ground came up off on a fresh profile
// and ambient occlusion only survived because an absent key reads as on — a
// default nobody chose and nothing recorded. The low preset keeps them off:
// SSAO is a full-screen pass and the photo is a texture fetch per cell, which
// is exactly what the low preset exists to skip.
const PRESETS = {
  low:    { shadows: false, shadowRes: 1024, resScale: 0.75, viewChunks: 3,
            ortho: false, facades: false, trees: true, grass: false, bloom: false, rays: false,
            ao: false, interiors: false, buildingR: 80, mblur: false, flare: false,
            tramMasts: false, cloudDist: 'medium', facadeFx: false, groundDetail: false },
  medium: { shadows: true,  shadowRes: 2048, resScale: 1,    viewChunks: 4,
            ortho: true,  facades: true,  trees: true, grass: true, bloom: true,  rays: true,
            ao: true,  interiors: true, buildingR: 160, mblur: true, flare: true,
            tramMasts: true, cloudDist: 'medium', facadeFx: true, groundDetail: true },
  high:   { shadows: true,  shadowRes: 4096, resScale: 2,    viewChunks: 6,
            ortho: true,  facades: true,  trees: true, grass: true, bloom: true,  rays: true,
            ao: true,  interiors: true, buildingR: 280, mblur: true, flare: true,
            tramMasts: true, cloudDist: 'far', facadeFx: true, groundDetail: true },
};
const GFX_KEYS = Object.keys(PRESETS.medium);

// Bumped when a default changes in a way a saved profile would otherwise hide.
// Applied ONCE, and only to a 'custom' profile — a named preset already gets the
// fresh table above, and someone who deliberately chose 'low' should keep it.
const SCHEMA = 2;
const NEW_ON = ['ao', 'ortho', 'grass'];
// showNames / nameDist are co-op preferences, not performance knobs: a name
// tag is a handful of sprites, so they live in "Hra" beside mouse look and
// never fork the graphics preset. showNames existed as a hardcoded `true` on
// NetGame that nothing could ever flip — this is where the player gets the
// switch. nameDist is metres of visible range (nametags.NAME_RANGES).
// chatter / chatBubbles / chatVoice are three switches and not one because the
// two halves of a spoken line fail for different people. Somebody streaming
// wants the bubbles and not the voices; somebody who reads Czech slowly wants
// the voices and not the bubbles; somebody in an office wants neither and
// still wants the city. `chatter` is the master (off = the crowd goes back to
// being scenery), the other two only say how a line is delivered.
const DEFAULTS = { preset: 'medium', ...PRESETS.medium, mouseLook: true, volume: 0.8,
  showFps: false, showNames: true, nameDist: NAME_RANGES[1],
  chatter: true, chatBubbles: true, chatVoice: true, ...WORLD };

// The live settings object — handed out by reference so main can keep one pointer to it.
let S = { ...DEFAULTS };
export function getSettings() { return S; }
// May this session run on a developer's own traffic, crowd and police? Only
// behind ?devmode and never in co-op (shareWorld). `kept` is what storage held.
const devmode = () => /(^|[?&])devmode(=|&|$)/.test(globalThis.location?.search ?? '');
let free = false, kept = {}, resync = () => {};
/** Co-op: those three numbers are everybody's, so a ?devmode choice is set
 *  aside for the session (kept in storage for the next one). */
export function shareWorld() {
  if (free) kept = storedWorld(S);
  free = false;
  Object.assign(S, WORLD);
  resync();
  return S;
}

// Merge the saved blob over defaults, but only keys we know and only matching types — an
// old or hand-edited localStorage entry must never punch a hole in the settings object.
function load() {
  free = devmode();
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    for (const k of Object.keys(DEFAULTS))
      if (typeof saved[k] === typeof DEFAULTS[k]) S[k] = saved[k];
    if (!['low', 'medium', 'high', 'custom'].includes(S.preset)) S.preset = 'custom';
    // A named preset is the SOURCE OF TRUTH, not a label over stale numbers:
    // when the preset table itself changes between versions (traffic doubled,
    // buildingR added), a profile saved as "medium" must get the new medium —
    // only "custom" keeps hand-tuned values verbatim.
    if (PRESETS[S.preset]) Object.assign(S, PRESETS[S.preset]);
    // …but a CUSTOM profile keeps its values verbatim, which quietly defeats a
    // default that changes underneath it: ambient occlusion and the aerial
    // ground were never in the preset table at all, so every profile that had
    // touched any graphics toggle carried `ortho: false` forever and the new
    // default would have looked like it did nothing. A profile written before
    // this stamp has no opinion about these keys — it only ever recorded the
    // old absence — so they take the new default once, and stay the user's to
    // change afterwards.
    if (!(saved.v >= SCHEMA) && S.preset === 'custom') {
      for (const k of NEW_ON) S[k] = true;
    }
    S.v = SCHEMA;
    // A range that is not one of the offered steps (an old build, a hand-edited
    // blob) would leave the <select> showing nothing and the value unreachable
    // — snap it to the nearest rung instead of trusting it.
    if (!NAME_RANGES.includes(S.nameDist))
      S.nameDist = NAME_RANGES.reduce((a, b) =>
        Math.abs(b - S.nameDist) < Math.abs(a - S.nameDist) ? b : a, NAME_RANGES[1]);
    // a stored traffic, crowd or police value never leaks into the classic game
    kept = storedWorld(saved);
    Object.assign(S, worldValues(saved, free));
  } catch { /* corrupt blob → keep defaults */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(forStorage(S, kept, free))); } catch { /* private mode etc. */ }
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};


export function initSettings(apply) {
  load();
  document.head.appendChild(el('style', '', '')).textContent = SETTINGS_CSS;

  // syncUI re-reads S into every control — one list of closures instead of a key→element
  // map, so preset picks (which rewrite eight keys at once) refresh everything in one call.
  const refreshers = [];
  const syncUI = () => { for (const f of refreshers) f(); };

  function change(key, value) {
    S[key] = value;
    // any hand-tuned graphics value forks the preset — the dropdown flips to "Vlastní" so
    // Low/Medium/High never claims to describe a mix the player invented themselves
    if (GFX_KEYS.includes(key)) S.preset = 'custom';
    save(); syncUI(); apply(S, key);
  }
  function pickPreset(name) {
    S.preset = name;
    if (PRESETS[name]) Object.assign(S, PRESETS[name]); // 'custom' keeps current values
    save(); syncUI(); apply(S, 'preset');
  }

  // <select> values are strings — recover the typed value (number/string) from the option
  // pair list instead of parsing, so 0.75 stays a number and 'medium' stays a string.
  function selectRow(key, label, options, onPick) {
    const row = el('label', 'atc-opt', `<span class="atc-opt-label">${label}</span>`);
    const sel = el('select');
    for (const [v, text] of options) {
      const o = el('option', '', ''); o.value = String(v); o.textContent = text;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const pair = options.find(([v]) => String(v) === sel.value);
      if (pair) (onPick || ((val) => change(key, val)))(pair[0]);
    });
    refreshers.push(() => { sel.value = String(S[key]); });
    row.appendChild(sel);
    return row;
  }
  function toggleRow(key, label) {
    const row = el('label', 'atc-opt', `<span class="atc-opt-label">${label}</span>`);
    const cb = el('input'); cb.type = 'checkbox';
    cb.addEventListener('change', () => change(key, cb.checked));
    refreshers.push(() => { cb.checked = S[key]; });
    row.appendChild(cb);
    return row;
  }
  // a row that DOES something instead of holding a value: the listener is whoever
  // catches the window event (main.js), so this file needs to know nothing of it
  function actionRow(label, text, event) {
    const row = el('div', 'atc-opt', `<span class="atc-opt-label">${label}</span>`);
    const b = el('button', 'atc-set-act', text); b.type = 'button';
    // the dialog it opens takes the screen: this panel steps aside first
    b.addEventListener('click', () => { closePanel(); window.dispatchEvent(new CustomEvent(event)); });
    row.appendChild(b);
    return row;
  }
  function sliderRow(key, label) { // 0..1 range with a live % readout in the label
    const row = el('label', 'atc-opt');
    const lab = el('span', 'atc-opt-label', label);
    const out = el('output');
    lab.appendChild(out);
    const rng = el('input'); rng.type = 'range';
    rng.min = '0'; rng.max = '1'; rng.step = '0.05';
    rng.addEventListener('input', () => change(key, Number(rng.value)));
    refreshers.push(() => {
      rng.value = String(S[key]); out.textContent = Math.round(S[key] * 100) + '%';
    });
    row.append(lab, rng);
    return row;
  }

  // ---- panel DOM ----
  // Three TABS rather than one long scroll: the graphics list has grown to
  // sixteen rows and the game options were falling off the bottom of it, and
  // the dev tools have no business being in the same list as the volume
  // slider. Tabs also give the dev section somewhere to put a live readout
  // without it hovering over the game.
  const panel = el('div'); panel.id = 'atc-set';
  const head = el('div', 'atc-set-head', '<h2>Nastavení</h2>');
  const closeBtn = el('button', 'atc-set-close', '✕');
  head.appendChild(closeBtn);
  const tabs = el('div', 'atc-set-tabs');
  const body = el('div', 'atc-set-body');
  const pages = {};
  function page(id, label) {
    const b = el('button', 'atc-set-tab', label);
    b.type = 'button'; b.dataset.tab = id;
    tabs.appendChild(b);
    const d = el('div', 'atc-set-page');
    d.dataset.tab = id;
    body.appendChild(d);
    pages[id] = d;
    b.addEventListener('click', () => showTab(id));
    return d;
  }
  function showTab(id) {
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === id);
    for (const k of Object.keys(pages)) pages[k].classList.toggle('on', k === id);
    // the campaigns page is filled by whoever knows the campaigns (main.js,
    // js/campaignmenu.js), fresh every time it is opened
    if (id === 'story') window.dispatchEvent(new CustomEvent('atc:campaigns', { detail: { box: pages.story, close: closePanel } }));
  }

  const gPage = page('gfx', 'Grafika');
  const hPage = page('game', 'Hra');
  page('story', 'Kampaně');
  const gGrid = el('div', 'atc-set-grid');
  gGrid.append(
    selectRow('preset', '⚡ Kvalita', [['low', 'Nízká (rychlá)'], ['medium', 'Střední'],
      ['high', 'Vysoká'], ['custom', 'Vlastní']], pickPreset),
    selectRow('resScale', 'Rozlišení obrazu', [[0.75, 'Rychlé (0.75×)'],
      [1, 'Normální (1×)'], [2, 'Nativní (ostré)']]),
    toggleRow('shadows', 'Stíny'),
    selectRow('shadowRes', 'Rozlišení stínů', [[1024, '1024 (rychlé)'], [2048, '2048'],
      [4096, '4096 (ostré)']]),
    selectRow('viewChunks', 'Dohlednost', [[3, 'Krátká'], [4, 'Střední'],
      [5, 'Daleká'], [6, 'Nejdelší']]),
    // how far out the box shells (real window reveals, brand signage) exist —
    // this is what keeps a Kaufland reading KAUFLAND from across the car park
    // Clouds sit 1.1–2.4 km above the ground, so the whole sky is in view from
    // anywhere — this is the one draw distance you can always see the effect of.
    // The whole field is one draw call now (clouds.js); what a longer range
    // costs is fill, not draws.
    selectRow('cloudDist', 'Dohlednost mraků', [['medium', 'Střední'],
      ['far', 'Daleko'], ['furthest', 'Nejdál']]),
    selectRow('buildingR', 'Dohlednost budov (interiéry)', [[80, 'Krátká'],
      [160, 'Střední'], [280, 'Daleká'], [450, 'Extrémní']]),
    toggleRow('ortho', 'Letecký podklad (ČÚZK)'),
    // street-level detail on the ground (js/groundglsl.js): shader arithmetic
    // and a few texture reads per ground pixel, no draw call; off on low
    toggleRow('groundDetail', 'Detail povrchů zblízka'),
    toggleRow('grass', 'Tráva (3D stébla)'),
    toggleRow('ao', 'Ambient occlusion (stíny v koutech)'),
    // window reveals, ledge shadows, grime and sky in the glass on every wall
    // (js/facadefx.js): no draw call, only pixel shading, so off on Low
    toggleRow('facadeFx', 'Hloubka oken a patina fasád'),
    toggleRow('bloom', 'Bloom (záře světel)'),
    toggleRow('rays', 'Sluneční paprsky'),
    toggleRow('mblur', 'Motion blur (rozmaz při rychlosti)'),
    toggleRow('flare', 'Lens flare (odlesky od slunce)'),
    // Interiors stream only around a walking player, so the cost is bounded —
    // but on a weak machine the plan+geometry build is the one hitch left, and
    // this is the switch that removes it. Wrecked buildings stay wrecked.
    toggleRow('interiors', 'Interiéry budov'),
  );
  gPage.appendChild(gGrid);
  const hGrid = el('div', 'atc-set-grid');
  hGrid.append(
    toggleRow('showFps', 'Zobrazit FPS'),
    toggleRow('mouseLook', 'Mouse look (kurzor v okně)'),
    // Co-op: the name over a friend's head, and how far away it survives. The
    // labels are distances in the world's own terms — 120 m is the far side of
    // a square, 2 km is the next village.
    toggleRow('showNames', 'Jména hráčů nad hlavou'),
    toggleRow('chatter', 'Lidé ve městě mluví'),
    toggleRow('chatBubbles', 'Bubliny s textem'),
    toggleRow('chatVoice', 'Namluvené hlasy'),
    selectRow('nameDist', 'Dosah jmen', [[NAME_RANGES[0], 'Blízko (120 m)'],
      [NAME_RANGES[1], 'Střední (400 m)'], [NAME_RANGES[2], 'Daleko (900 m)'],
      [NAME_RANGES[3], 'Přes celé město (2 km)']]),
    sliderRow('volume', 'Hlasitost'),
    actionRow('Vzhled postavy', 'Změnit…', 'atc:look'),
  );
  hPage.appendChild(hGrid);
  gPage.appendChild(el('p', 'atc-set-note', 'Změna pokročilé volby přepne kvalitu na '
    + '„Vlastní“. Největší dopad na plynulost mají rozlišení obrazu, stíny a dohlednost.'));
  // The dev page exists only behind ?devmode; devmode.js fills it with the
  // teleports and spawners. Traffic, the crowd and the police live here and
  // nowhere else, and a co-op session greys them out (shareWorld).
  if (devmode()) {
    const w = el('div', 'atc-set-grid');
    for (const [k, label, rungs] of WORLD_ROWS) {
      const row = w.appendChild(selectRow(k, label, rungs)), sel = row.lastChild;
      refreshers.push(() => { sel.disabled = !free; });
    }
    page('dev', '🛠 Dev').append(el('h3', 'atc-set-h3', 'Provoz a lidé'), w, el('p', 'atc-set-note',
      'Mimo ?devmode a v co-opu platí pevně: hustota provozu běžná, chodci rušno, policejní hlídky běžně.'));
  }
  panel.append(head, tabs, body);
  showTab('gfx');

  const gear = el('button', '', '⚙️'); gear.id = 'atc-gear'; gear.title = 'Nastavení';
  document.body.append(gear, panel);

  // body.dataset.panelOpen is the cross-module "a modal owns the mouse" flag — main reads
  // it to skip the pointer-lock re-grab on click, otherwise mouseLook would swallow the
  // very click meant for a checkbox.
  function openPanel() {
    panel.classList.add('atc-open'); document.body.dataset.panelOpen = '1';
    if (pages.story.classList.contains('on')) showTab('story');   // (its list may have changed since)
  }
  function closePanel() { panel.classList.remove('atc-open'); delete document.body.dataset.panelOpen; }
  gear.addEventListener('click', () =>
    panel.classList.contains('atc-open') ? closePanel() : openPanel());
  closeBtn.addEventListener('click', closePanel);

  // Escape closes the panel — capture phase + stopPropagation so the game's own key
  // handling never sees the press that dismissed a modal. While pointer-locked the browser
  // consumes Escape to release the lock first, so the panel closes on the second press —
  // which is exactly the natural order (free the cursor, then dismiss the dialog).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel.classList.contains('atc-open')) return;
    e.stopPropagation();
    closePanel();
  }, true);

  resync = syncUI;
  syncUI();   // paint the loaded values into the controls before the first open
  return S;
}
