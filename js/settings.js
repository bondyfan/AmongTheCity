// ---- Settings: the ⚙️ panel — presets, advanced graphics, game options ----
// Woods-style options panel rebuilt for the city, fully self-contained: every bit of DOM
// and CSS is injected from here so index.html and style.css stay untouched (the v2 contract
// keeps modules in their own files). main.js calls initSettings(apply) once; each change is
// persisted to localStorage AND pushed through apply(settings, changedKey), so toggles take
// effect live without a reload. Preset semantics copy the Woods panel players already know:
// picking Low/Medium/High stamps all graphics keys at once, and touching any advanced field
// forks the dropdown to "Vlastní" (custom) so the label never lies about what's on screen.

const LS_KEY = 'atc-settings';

// The graphics keys a preset owns. mouseLook and volume are personal preferences, not
// performance knobs — presets leave them alone and changing them never forks to custom.
const PRESETS = {
  low:    { shadows: false, shadowRes: 1024, resScale: 0.75, viewChunks: 3, traffic: 60,
            ortho: false, facades: false, trees: true, peds: 12, bloom: false, rays: false,
            interiors: false, buildingR: 80 },
  medium: { shadows: true,  shadowRes: 2048, resScale: 1,    viewChunks: 4, traffic: 240,
            ortho: true,  facades: true,  trees: true, peds: 60, bloom: true,  rays: true,
            interiors: true, buildingR: 160 },
  high:   { shadows: true,  shadowRes: 4096, resScale: 2,    viewChunks: 6, traffic: 240,
            ortho: true,  facades: true,  trees: true, peds: 60, bloom: true,  rays: true,
            interiors: true, buildingR: 280 },
};
const GFX_KEYS = Object.keys(PRESETS.medium);
const DEFAULTS = { preset: 'medium', ...PRESETS.medium, mouseLook: true, volume: 0.8,
  showFps: false };

// The live settings object — handed out by reference so main can keep one pointer to it.
let S = { ...DEFAULTS };
export function getSettings() { return S; }

// Merge the saved blob over defaults, but only keys we know and only matching types — an
// old or hand-edited localStorage entry must never punch a hole in the settings object.
function load() {
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
  } catch { /* corrupt blob → keep defaults */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* private mode etc. */ }
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// All styling namespaced atc- so nothing collides with the game's own stylesheet. Colors
// follow the city HUD (slate blue) but the shapes — rounded opt rows, 2-col grid, ✕ in a
// bordered square — mirror the Woods settings panel players are used to.
const CSS = `
#atc-gear {
  position: fixed; top: 44px; right: 12px; z-index: 20; pointer-events: auto;
  width: 38px; height: 38px; font-size: 19px; line-height: 1; cursor: pointer;
  background: rgba(12,16,24,0.72); color: #e8ecf4;
  border: 1px solid rgba(140,170,220,0.3); border-radius: 10px;
}
#atc-gear:hover { background: rgba(38,48,74,0.85); }
#atc-set {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(640px, 94vw); max-height: 84vh; z-index: 40; display: none;
  flex-direction: column; color: #e8ecf4;
  font-family: 'Trebuchet MS','Segoe UI',sans-serif;
  background: linear-gradient(#1b2230, #131926);
  border: 2px solid #3d4f74; border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6);
}
#atc-set.atc-open { display: flex; }
.atc-set-head {
  display: flex; align-items: center; padding: 14px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.12);
}
.atc-set-head h2 { font-size: 20px; letter-spacing: 1px; margin: 0; }
.atc-set-close {
  margin-left: auto; width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
  background: none; border: 1px solid rgba(255,255,255,0.3); color: inherit; font-size: 16px;
}
.atc-set-close:hover { background: rgba(255,255,255,0.1); }
.atc-set-body { padding: 12px 20px 18px; overflow-y: auto; }
.atc-set-h3 {
  font-size: 13px; letter-spacing: 2px; text-transform: uppercase; opacity: 0.7;
  margin: 12px 0 8px;
}
.atc-set-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.atc-opt {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 13px; border-radius: 10px; cursor: pointer;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
}
.atc-opt:hover { border-color: rgba(140,170,220,0.55); }
.atc-opt-label { font-weight: bold; font-size: 13.5px; }
.atc-opt-label output { opacity: 0.7; font-weight: normal; margin-left: 6px; }
.atc-opt select {
  background: rgba(0,0,0,0.35); color: inherit; border: 1px solid rgba(255,255,255,0.25);
  border-radius: 7px; padding: 4px 8px; font-size: 13px; cursor: pointer;
}
.atc-opt input[type="checkbox"] { width: 20px; height: 20px; margin: 0; cursor: pointer;
  accent-color: #7fa8e8; }
.atc-opt input[type="range"] { width: 120px; accent-color: #7fa8e8; cursor: pointer; }
.atc-set-note { font-size: 12px; opacity: 0.6; margin: 14px 2px 0; line-height: 1.5; }
@media (max-width: 560px) { .atc-set-grid { grid-template-columns: 1fr; } }
`;

export function initSettings(apply) {
  load();
  document.head.appendChild(el('style', '', '')).textContent = CSS;

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

  // ---- panel DOM: head + two labelled sections, Woods layout with Czech labels ----
  const panel = el('div'); panel.id = 'atc-set';
  const head = el('div', 'atc-set-head', '<h2>Nastavení</h2>');
  const closeBtn = el('button', 'atc-set-close', '✕');
  head.appendChild(closeBtn);
  const body = el('div', 'atc-set-body');
  body.appendChild(el('h3', 'atc-set-h3', 'Grafika'));
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
    selectRow('buildingR', 'Dohlednost budov (interiéry)', [[80, 'Krátká'],
      [160, 'Střední'], [280, 'Daleká'], [450, 'Extrémní']]),
    selectRow('traffic', 'Hustota provozu', [[0, 'Žádná'], [60, 'Řídká'],
      [120, 'Běžná'], [240, 'Hustá']]),
    toggleRow('ortho', 'Letecký podklad (ČÚZK)'),
    toggleRow('facades', 'Textury fasád'),
    toggleRow('bloom', 'Bloom (záře světel)'),
    toggleRow('rays', 'Sluneční paprsky'),
    toggleRow('trees', 'Stromy'),
    selectRow('peds', 'Chodci', [[0, 'Žádní'], [12, 'Málo'], [34, 'Běžně'], [60, 'Rušno']]),
    // Interiors stream only around a walking player, so the cost is bounded —
    // but on a weak machine the plan+geometry build is the one hitch left, and
    // this is the switch that removes it. Wrecked buildings stay wrecked.
    toggleRow('interiors', 'Interiéry budov'),
  );
  body.appendChild(gGrid);
  body.appendChild(el('h3', 'atc-set-h3', 'Hra'));
  const hGrid = el('div', 'atc-set-grid');
  hGrid.append(
    toggleRow('showFps', 'Zobrazit FPS'),
    toggleRow('mouseLook', 'Mouse look (kurzor v okně)'),
    sliderRow('volume', 'Hlasitost'),
  );
  body.appendChild(hGrid);
  body.appendChild(el('p', 'atc-set-note', 'Změna pokročilé volby přepne kvalitu na '
    + '„Vlastní“. Největší dopad na plynulost mají rozlišení obrazu, stíny a dohlednost.'));
  panel.append(head, body);

  const gear = el('button', '', '⚙️'); gear.id = 'atc-gear'; gear.title = 'Nastavení';
  document.body.append(gear, panel);

  // body.dataset.panelOpen is the cross-module "a modal owns the mouse" flag — main reads
  // it to skip the pointer-lock re-grab on click, otherwise mouseLook would swallow the
  // very click meant for a checkbox.
  function openPanel() { panel.classList.add('atc-open'); document.body.dataset.panelOpen = '1'; }
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

  syncUI();   // paint the loaded values into the controls before the first open
  return S;
}
