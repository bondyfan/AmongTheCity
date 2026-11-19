// ---- creatorstyle.js: the character creator's stylesheet ----------------------
// The creator borrows the menu's card, pill and buttons (js/menustyle.js) and
// adds only its own layout: a stage on the left, the choices on the right.

export const CREATOR_CSS = `
#atc-creator {
  /* above the boot cover (40) and every panel (60): it opens over either */
  position: fixed; inset: 0; z-index: 70; overflow: hidden; color: #f3eee6;
  font-family: 'Avenir Next','Segoe UI',system-ui,-apple-system,sans-serif;
  background: radial-gradient(ellipse 90% 80% at 32% 55%, #2a2f55 0%, #14172e 45%, #080914 100%);
  display: flex; align-items: stretch; justify-content: center;
  opacity: 0; transition: opacity 0.35s ease;
  user-select: none; -webkit-user-select: none;
}
#atc-creator.atc-cr-in { opacity: 1; }
#atc-creator.atc-cr-modal { background: rgba(6,7,18,0.82); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.atc-cr-stage { position: relative; flex: 1 1 52%; min-width: 0; }
.atc-cr-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.atc-cr-stage canvas:active { cursor: grabbing; }
.atc-cr-hint { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; font-size: 12px;
  letter-spacing: 1.5px; text-transform: uppercase; color: #c9b9a4; opacity: 0.7; pointer-events: none; }
.atc-cr-side { flex: 0 1 470px; display: flex; flex-direction: column; justify-content: center; padding: 22px 26px 22px 6px; box-sizing: border-box; min-width: 0; }
.atc-cr-card { width: 100%; max-height: 100%; box-sizing: border-box; padding: 22px 22px 16px; text-align: left;
  display: flex; flex-direction: column; min-height: 0;
  background: rgba(14,16,34,0.6); border: 1px solid rgba(255,255,255,0.13); border-radius: 20px;
  backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%);
  box-shadow: 0 30px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08); }
.atc-cr-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0 -6px; padding: 0 6px 4px; }
.atc-cr-kicker { font-size: 11px; letter-spacing: 4px; text-transform: uppercase; color: #ffcf96; margin: 0 0 6px 2px; }
.atc-cr-title { margin: 0 0 4px; font-size: 30px; font-weight: 800; letter-spacing: 1px; color: #fff6e8; }
.atc-cr-sub { margin: 0 0 16px; font-size: 13.5px; line-height: 1.45; color: #cfc4b6; }
.atc-cr-label { display: block; font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase; color: #c9b9a4; margin: 14px 0 7px 4px; }
.atc-cr-pill { display: flex; padding: 3px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); }
.atc-cr-tones { display: flex; gap: 10px; padding: 2px 4px; }
.atc-cr-tone { appearance: none; width: 38px; height: 38px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 2px solid rgba(255,255,255,0.2); box-shadow: inset 0 -6px 10px rgba(0,0,0,0.18); transition: transform 0.12s ease, border-color 0.12s ease; }
.atc-cr-tone:hover { transform: scale(1.08); }
.atc-cr-tone[aria-checked="true"] { border-color: #ffc27a; box-shadow: 0 0 0 3px rgba(255,180,100,0.3), inset 0 -6px 10px rgba(0,0,0,0.18); }
.atc-cr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
.atc-cr-opt { appearance: none; position: relative; padding: 0; cursor: pointer; overflow: hidden; aspect-ratio: 3 / 4;
  border-radius: 12px; border: 2px solid rgba(255,255,255,0.12); background: #1b1e38 center / cover no-repeat;
  transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease; }
.atc-cr-opt:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.35); }
.atc-cr-opt[aria-checked="true"] { border-color: #ffb067; box-shadow: 0 0 0 3px rgba(255,170,90,0.28); }
.atc-cr-opt:focus-visible, .atc-cr-tone:focus-visible { outline: 2px solid #ffc27a; outline-offset: 2px; }
.atc-cr-foot { flex: none; display: flex; gap: 10px; margin-top: 16px; }
.atc-cr-foot .atc-menu-btn { margin: 0; animation: none; }
.atc-cr-foot .atc-cr-quiet { flex: 0 0 auto; width: auto; padding: 15px 16px; font-size: 15px; font-weight: 600; }
.atc-cr-none { font-size: 13px; color: #cfc4b6; padding: 4px; }
/* a low window (a laptop with the dock up): tighter, so nothing needs scrolling */
@media (max-height: 860px) {
  .atc-cr-side { padding-top: 12px; padding-bottom: 12px; }
  .atc-cr-card { padding: 16px 18px 12px; }
  .atc-cr-title { font-size: 24px; }
  .atc-cr-sub { margin-bottom: 8px; font-size: 12.5px; }
  .atc-cr-label { margin: 9px 0 5px 4px; }
  .atc-cr-grid { grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 6px; }
  .atc-cr-tone { width: 30px; height: 30px; }
  .atc-cr-foot { margin-top: 12px; }
  .atc-cr-foot .atc-menu-btn { padding-top: 11px; padding-bottom: 11px; }
}
@media (max-width: 820px) {
  #atc-creator { flex-direction: column; }
  .atc-cr-stage { flex: 0 0 38%; }
  .atc-cr-side { flex: 1 1 auto; padding: 0 12px 12px; justify-content: flex-start; min-height: 0; }
  .atc-cr-title { font-size: 24px; }
}
`;
