// ---- Main menu stylesheet ----
// Kept out of js/menu.js so the menu's logic stays readable. The look: the
// painted dusk town (js/menubg.js) fills the screen, the title rises letter by
// letter with a slow sheen running through it, and the controls sit on one
// frosted glass card, so the town stays visible behind them. Only system fonts:
// the game ships no font files.

export const MENU_CSS = `
#atc-menu {
  position: fixed; inset: 0; z-index: 15; overflow: hidden;
  color: #f3eee6; text-align: center;
  font-family: 'Avenir Next','Segoe UI',system-ui,-apple-system,sans-serif;
  background: #0a0c1a;
  transition: opacity 0.65s ease;
}
#atc-menu.atc-menu-out { opacity: 0; pointer-events: none; }
.atc-menu-scene {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  transform-origin: 52% 70%;
  transition: transform 0.9s cubic-bezier(.2,.7,.2,1), filter 0.9s ease;
  animation: atc-scene-in 2.4s cubic-bezier(.2,.7,.2,1) both;
}
#atc-menu.atc-menu-out .atc-menu-scene { transform: scale(1.14); filter: blur(3px) brightness(1.2); }
@keyframes atc-scene-in { from { transform: scale(1.08); filter: brightness(0.3); } to { transform: none; filter: none; } }
/* a darker band behind the controls so the text never fights the sky */
.atc-menu-shade {
  position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 60% 55% at 50% 42%, rgba(6,7,18,0.55), rgba(6,7,18,0) 70%);
}
.atc-menu-inner {
  position: relative; z-index: 1; height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px 16px 96px;
}
.atc-menu-chip {
  position: absolute; top: 16px; left: 16px; z-index: 2;
  display: flex; align-items: center; gap: 8px; padding: 7px 13px;
  font-size: 12.5px; letter-spacing: 1.5px; text-transform: uppercase;
  color: #f6e7cf; background: rgba(12,14,30,0.5); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 999px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  animation: atc-fade 1s 1.2s both;
}
.atc-menu-chip i { width: 7px; height: 7px; border-radius: 50%; background: #ffb347;
  box-shadow: 0 0 10px #ffb347; animation: atc-blink 2.4s ease-in-out infinite; }
.atc-menu-kicker {
  font-size: 12px; letter-spacing: 5px; text-transform: uppercase; color: #ffcf96;
  margin-bottom: 14px; animation: atc-fade 1s 0.2s both;
}
.atc-menu-title {
  margin: 0; line-height: 0.95; font-weight: 800;
  font-size: clamp(26px, 8.2vw, 104px); letter-spacing: clamp(1px, 0.8vw, 12px);
  filter: drop-shadow(0 6px 30px rgba(255,150,80,0.35)) drop-shadow(0 2px 2px rgba(0,0,0,0.6));
  white-space: nowrap;
}
.atc-menu-title .w { display: inline-block; margin: 0 0.16em; }
.atc-menu-title .l {
  display: inline-block; color: transparent;
  background-image: linear-gradient(110deg, #f4c98f 0%, #fff6e8 30%, #ffffff 48%, #fff6e8 66%, #f0b979 100%);
  background-size: 320% 100%; background-position: 100% 0;
  -webkit-background-clip: text; background-clip: text;
  animation: atc-letter 1s cubic-bezier(.2,.8,.2,1) both, atc-sheen 7s ease-in-out infinite;
  animation-delay: calc(var(--i) * 55ms + 0.3s), calc(var(--i) * 70ms + 2.2s);
}
@keyframes atc-letter {
  from { opacity: 0; transform: translateY(0.45em) scale(0.9); filter: blur(10px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes atc-sheen { 0%, 55% { background-position: 100% 0; } 85%, 100% { background-position: 0% 0; } }
.atc-menu-sub {
  display: flex; align-items: center; gap: 16px; margin: 14px 0 34px;
  font-size: clamp(13px, 1.6vw, 17px); letter-spacing: 8px; text-transform: uppercase;
  color: #ffe2bd; animation: atc-fade 1.2s 1s both;
}
.atc-menu-sub::before, .atc-menu-sub::after {
  content: ''; width: clamp(30px, 8vw, 90px); height: 1px;
  background: linear-gradient(90deg, rgba(255,210,160,0), rgba(255,210,160,0.8));
}
.atc-menu-sub::after { transform: scaleX(-1); }
.atc-menu-card {
  width: min(420px, 100%); box-sizing: border-box; padding: 22px 22px 14px;
  background: rgba(14,16,34,0.52); border: 1px solid rgba(255,255,255,0.13);
  border-radius: 20px; backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%);
  box-shadow: 0 30px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08);
  animation: atc-rise 1s 1.1s cubic-bezier(.2,.8,.2,1) both;
}
@keyframes atc-rise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: none; } }
@keyframes atc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes atc-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.atc-name-row { margin: 0 0 14px; text-align: left; }
.atc-name-label { display: block; font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase;
  color: #c9b9a4; margin: 0 0 6px 4px; }
.atc-menu-name {
  display: block; width: 100%; box-sizing: border-box; padding: 12px 16px; text-align: left;
  font: inherit; font-size: 17px; font-weight: 600; letter-spacing: 1px;
  color: #fff3e0; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; outline: none;
  /* body sets user-select:none and touch-action:none for the canvas; a text
     field needs both back or a phone cannot place a caret in it */
  user-select: text; -webkit-user-select: text; touch-action: manipulation;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.atc-menu-name::placeholder { color: #9b8f86; font-weight: 400; }
.atc-menu-name:focus { background: rgba(255,255,255,0.1); border-color: rgba(255,190,120,0.7);
  box-shadow: 0 0 0 4px rgba(255,170,90,0.15); }
.atc-menu-name.name-missing { border-color: #ff6b5b; animation: atc-name-shake 0.3s; }
@keyframes atc-name-shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
.atc-name-note { margin: 6px 0 0 4px; font-size: 11.5px; opacity: 0.55; transition: color 0.15s ease, opacity 0.15s ease; }
.atc-name-row.miss .atc-name-note { color: #ff9a8d; opacity: 1; }
.atc-menu-btn {
  position: relative; overflow: hidden; display: block; width: 100%; margin: 10px 0; padding: 15px 18px;
  font: inherit; font-size: 18px; font-weight: 700; letter-spacing: 1px; text-align: center;
  color: #fff; cursor: pointer; border-radius: 14px;
  background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16);
  transition: transform 0.15s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.atc-menu-btn:hover:not(:disabled) { transform: translateY(-2px); background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.3); }
.atc-menu-btn:active:not(:disabled) { transform: translateY(0); }
.atc-menu-btn:focus-visible, .atc-menu-new:focus-visible { outline: 2px solid #ffc27a; outline-offset: 3px; }
.atc-menu-btn:disabled { opacity: 0.5; cursor: default; }
.atc-menu-btn small { display: block; font-size: 12.5px; font-weight: 500; letter-spacing: 0.3px; opacity: 0.85; margin-top: 4px; }
/* the one button most players press: warm, alive, impossible to miss */
.atc-menu-btn.primary {
  border: 0; text-shadow: 0 1px 2px rgba(80,20,10,0.45);
  background: linear-gradient(135deg, #ffb347 0%, #ff7f3f 50%, #e5485f 100%);
  box-shadow: 0 10px 30px rgba(255,120,70,0.35), inset 0 1px 0 rgba(255,255,255,0.35);
  animation: atc-glow 3.2s ease-in-out infinite 2.5s;
}
.atc-menu-btn.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #ffc160 0%, #ff8c4c 50%, #ee5468 100%);
  box-shadow: 0 16px 40px rgba(255,120,70,0.5), inset 0 1px 0 rgba(255,255,255,0.4);
}
.atc-menu-btn.primary::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: -60%; width: 40%;
  background: linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,0.45), rgba(255,255,255,0));
  transform: skewX(-20deg); animation: atc-shine 4.5s ease-in-out infinite 2s;
}
@keyframes atc-shine { 0%, 70% { left: -60%; } 100% { left: 130%; } }
@keyframes atc-glow { 0%, 100% { box-shadow: 0 10px 30px rgba(255,120,70,0.35), inset 0 1px 0 rgba(255,255,255,0.35); }
  50% { box-shadow: 0 10px 44px rgba(255,140,80,0.6), inset 0 1px 0 rgba(255,255,255,0.35); } }
.atc-mp-status::before {
  content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%;
  background: #7d7f8f; vertical-align: 1px;
}
.atc-menu-btn.online .atc-mp-status::before { background: #5ee08a; box-shadow: 0 0 8px #5ee08a; animation: atc-blink 1.6s ease-in-out infinite; }
/* where the game begins: two places on one pill, the picked one lit */
.atc-place { display: flex; align-items: center; gap: 10px; margin: 2px 0 8px; }
.atc-place-label { flex: none; font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase; color: #c9b9a4; margin-left: 4px; }
.atc-place-pill { flex: 1; display: flex; padding: 3px; border-radius: 999px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); }
.atc-place-opt {
  flex: 1; appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600;
  letter-spacing: 0.5px; color: #e6dccd; padding: 7px 10px; border-radius: 999px; background: none;
  transition: background 0.15s ease, color 0.15s ease;
}
.atc-place-opt:hover { color: #fff3e0; background: rgba(255,255,255,0.08); }
.atc-place-opt[aria-checked="true"] { color: #2a140c; background: linear-gradient(135deg, #ffd59a, #ffb067);
  box-shadow: 0 2px 10px rgba(255,150,80,0.35); }
.atc-place-opt:focus-visible { outline: 2px solid #ffc27a; outline-offset: 2px; }
.atc-menu-new {
  appearance: none; background: none; border: 0; cursor: pointer; font: inherit;
  font-size: 13px; color: #c9b9a4; padding: 4px 10px; margin: -2px 0 2px;
  text-decoration: underline; text-underline-offset: 3px;
}
.atc-menu-new:hover { color: #ffe2bd; }
.atc-menu-foot {
  position: absolute; left: 0; right: 0; bottom: 14px; z-index: 1; padding: 0 16px;
  font-size: 12px; color: rgba(243,238,230,0.7); line-height: 1.9; animation: atc-fade 1s 1.8s both;
}
.atc-menu-foot kbd {
  display: inline-block; min-width: 18px; padding: 1px 7px; margin: 0 3px 0 0;
  font: 600 11px/1.6 'Avenir Next','Segoe UI',system-ui,sans-serif; color: #fff3e0;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); border-bottom-width: 2px; border-radius: 6px;
}
.atc-menu-foot .sep { opacity: 0.35; margin: 0 6px; }
.atc-menu-credit { font-size: 10.5px; opacity: 0.5; letter-spacing: 0.3px; }
@media (max-width: 600px), (max-height: 560px) {
  .atc-menu-keys { display: none; }
  .atc-menu-kicker { font-size: 10.5px; letter-spacing: 3px; }
  .atc-menu-title { font-size: clamp(24px, 8.6vw, 60px); letter-spacing: 1px; }
  .atc-menu-sub { margin-bottom: 22px; }
  .atc-menu-inner { padding-bottom: 56px; }
}
@media (prefers-reduced-motion: reduce) {
  #atc-menu *, #atc-menu *::before, #atc-menu *::after { animation: none !important; transition: none !important; }
  .atc-menu-title .l { background-position: 50% 0; }
}
`;
