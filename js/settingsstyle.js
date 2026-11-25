// ---- Settings panel: its stylesheet ----
// Split out of js/settings.js (like js/menustyle.js from js/menu.js) so the
// panel's behaviour stays one readable file. Injected once by initSettings().
// All styling namespaced atc- so nothing collides with the game's own stylesheet. Colors
// follow the city HUD (slate blue) but the shapes (rounded opt rows, 2-col grid, ✕ in a
// bordered square) mirror the Woods settings panel players are used to.
export const SETTINGS_CSS = `
/* ---- tabs ---- */
.atc-set-tabs {
  display: flex; gap: 4px; padding: 0 14px; border-bottom: 1px solid #2a3550;
}
.atc-set-tab {
  appearance: none; cursor: pointer; background: none; border: 0;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  padding: 9px 12px; font: 600 13px system-ui, sans-serif; color: #8ea3c0;
}
.atc-set-tab:hover { color: #cfe0f5; }
.atc-set-tab.on { color: #ffb454; border-bottom-color: #ffb454; }
.atc-set-page { display: none; }
.atc-set-page.on { display: block; }
/* the dev page's live pose readout */
#atc-dev-pose {
  font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #cfe0f5; background: #0f1725; border: 1px solid #2a3550;
  border-radius: 8px; padding: 9px 11px; white-space: pre; margin-bottom: 8px;
}
#atc-dev-copy {
  width: 100%; cursor: pointer; margin-bottom: 12px;
  font: 600 12.5px system-ui, sans-serif; color: #0b111b; background: #ffb454;
  border: 0; border-radius: 7px; padding: 8px;
}
#atc-dev-copy:active { transform: translateY(1px); }
#atc-dev-copy.ok { background: #7fd18a; }
#atc-gear {
  /* Below the top-right status stack, not beside it. The clock used to be the
     only thing in that corner and 44px cleared it; #status-hud now runs clock →
     money → health → armour from 12px down to about 80px, and the gear sat in
     the middle of it. 96px clears the tallest the stack gets (armour visible)
     with room to spare. css/style.css owns #status-hud; this button's CSS is
     injected from here, which is why the two numbers live apart: if the stack
     grows another row, this is the one that has to move. */
  position: fixed; top: 96px; right: 12px; z-index: 20; pointer-events: auto;
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
.atc-set-act {
  background: rgba(127,168,232,0.18); color: inherit; border: 1px solid rgba(140,170,220,0.55);
  border-radius: 7px; padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer;
}
.atc-set-act:hover { background: rgba(127,168,232,0.3); }
.atc-opt input[type="checkbox"] { width: 20px; height: 20px; margin: 0; cursor: pointer;
  accent-color: #7fa8e8; }
.atc-opt input[type="range"] { width: 120px; accent-color: #7fa8e8; cursor: pointer; }
.atc-set-note { font-size: 12px; opacity: 0.6; margin: 14px 2px 0; line-height: 1.5; }
@media (max-width: 560px) { .atc-set-grid { grid-template-columns: 1fr; } }
.atc-camp { grid-template-columns: 1fr; }
.atc-camp-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; cursor: default; }
.atc-camp-card small { display: block; opacity: 0.75; font-size: 12px; margin-top: 3px; }
.atc-camp-card .atc-camp-state { opacity: 0.9; }
.atc-camp-card .atc-camp-run { color: #ffd46c; white-space: nowrap; }
`;
