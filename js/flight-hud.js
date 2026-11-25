// ---- flight-hud.js: the boarding pass and the map of the trip ----
// The story's HUD (js/prologue-hud.js) already has everything a journey
// needs: the heading card (where you are, what to do), the caption the crew
// speak in, the E button, the T offer and the black card for a cut. The
// flight borrows it whole and adds two things of its own: the boarding pass
// (once the ticket is bought, until the trip is over) and the little map of
// the trip that rides at the top while the hours pass in the window.

import { storyHud } from './prologue-hud.js';
import { clockText } from './flight-trip.js';

const CSS = `
/* the game's own job card sits in the top left corner: the airport's card goes under it */
.flight-hud .journey-heading { top:21%; }
@media (max-height:780px) { .flight-hud .flight-pass { bottom:auto; top:31%; transform:scale(.82); transform-origin:top right; } }
.flight-pass { position:absolute; right:3%; bottom:7%; width:250px; padding:12px 16px 12px; border-radius:10px;
  background:linear-gradient(160deg,#f7f5ef,#e4e7ea); color:#1d2733; text-shadow:none; box-shadow:0 6px 24px #0008;
  font:500 13px/1.35 system-ui,sans-serif; }
.flight-pass header { display:flex; justify-content:space-between; color:#1b3b63; font-weight:700; letter-spacing:.06em;
  font-size:11px; text-transform:uppercase; border-bottom:1px dashed #9aa6b2; padding-bottom:6px; margin-bottom:8px; }
.flight-pass .route { display:flex; justify-content:space-between; align-items:baseline; }
.flight-pass .route b { font-size:26px; letter-spacing:.04em; color:#14202c; }
.flight-pass .route i { font-style:normal; color:#7a8794; font-size:18px; }
.flight-pass .names { display:flex; justify-content:space-between; color:#55626f; font-size:11px; margin-bottom:8px; }
.flight-pass dl { display:grid; grid-template-columns:repeat(4,auto); gap:2px 10px; margin:0; }
.flight-pass dt { color:#7a8794; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
.flight-pass dd { margin:0; font-weight:700; font-size:15px; }
.flight-pass .state { margin-top:8px; padding-top:6px; border-top:1px dashed #9aa6b2; color:#1b3b63; font-weight:600; }
.flight-trip { position:absolute; top:21%; left:50%; transform:translateX(-50%); width:min(560px,86vw); padding:12px 18px 14px;
  background:#0f1822d9; border-radius:8px; border:1px solid #ffffff22; }
.flight-trip .ends { display:flex; justify-content:space-between; font-size:12px; color:#f4cb8d; letter-spacing:.08em;
  text-transform:uppercase; }
.flight-trip .line { position:relative; height:18px; margin:6px 0 8px; }
.flight-trip .line::before { content:''; position:absolute; left:0; right:0; top:8px; border-top:2px dotted #ffffff66; }
.flight-trip .line s { position:absolute; top:4px; width:10px; height:10px; margin-left:-5px; border-radius:50%;
  background:#f4cb8d; }
.flight-trip .line b { position:absolute; top:-3px; margin-left:-11px; font-size:20px; line-height:1; color:#fff;
  }
.flight-trip .times { display:flex; justify-content:space-between; font-size:13px; color:#eadfcf; }
.flight-trip .times strong { color:#fff; font-size:15px; }
`;
let styled = false;

export function flightHud() {
  const hud = storyHud();
  if (!styled) {
    styled = true;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.append(st);
  }
  hud.root.classList.add('flight-hud');
  const pass = document.createElement('section');
  pass.className = 'flight-pass';
  pass.hidden = true;
  const trip = document.createElement('section');
  trip.className = 'flight-trip';
  trip.hidden = true;
  trip.innerHTML = '<div class="ends"><span></span><span></span><span></span></div>' +
    '<div class="line"><s style="left:0"></s><s></s><s style="left:100%"></s><b>✈</b></div>' +
    '<div class="times"><span></span><span></span></div>';
  hud.root.append(pass, trip);
  const [endA, endV, endB] = trip.querySelectorAll('.ends span');
  const [, stop, , plane] = trip.querySelectorAll('.line s, .line b');
  const [flown, local] = trip.querySelectorAll('.times span');
  let passKey = '';
  const put = (n, v) => { if (n.textContent !== v) n.textContent = v; };
  // the story's heading card is never empty in the campaign; at an airport it
  // is, most of the time (driving past the terminal), and an empty card is a box
  const heading = hud.root.querySelector('.journey-heading');
  return {
    ...hud,
    guide(place, task, help = '') {
      heading.hidden = !place && !task;
      hud.guide(place, task, help);
    },
    /**
     * The boarding pass, or null to put it away. `state` is the line under
     * it (what this passenger is to do next); `when` { board, dep } the
     * countdowns of js/flight-schedule.js, else the times of t.depMin.
     */
    pass(t, route, state = '', when = null) {
      pass.hidden = !t;
      if (!t) { passKey = ''; return; }
      const key = [t.no, t.seat, t.gate, t.depMin, state, when?.board, when?.dep].join('|');
      if (key === passKey) return;
      passKey = key;
      const board = when ? when.board : t.depMin == null ? '' : clockText(t.depMin - 20);
      const dep = when ? when.dep : t.depMin == null ? '' : clockText(t.depMin);
      pass.innerHTML = `<header><span>Palubní vstupenka</span><span>${t.no}</span></header>
        <div class="route"><b>${route.from}</b><i>✈</i><b>${route.to}</b></div>
        <div class="names"><span>${route.fromName}</span><span>přes ${route.via}</span><span>${route.toName}</span></div>
        <dl><dt>Gate</dt><dt>Nástup</dt><dt>Odlet</dt><dt>Sedadlo</dt>
        <dd>${t.gate}</dd><dd>${board}</dd><dd>${dep}</dd><dd>${t.seat}</dd></dl>
        <div class="state"></div>`;
      pass.querySelector('.state').textContent = state;
    },
    /**
     * The map of the trip: `k` 0..1 of the way, the stop at `kStop`, hours
     * flown of `hours`, and the local hour (0..1) where the aircraft is.
     */
    trip(route, k, kStop, hoursFlown, localHour) {
      trip.hidden = route === null;
      if (!route) return;
      put(endA, route.fromName);
      put(endV, route.via);
      put(endB, route.toName);
      stop.style.left = (kStop * 100).toFixed(1) + '%';
      plane.style.left = (Math.max(0, Math.min(1, k)) * 100).toFixed(2) + '%';
      const h = Math.floor(hoursFlown), m = Math.floor((hoursFlown - h) * 60);
      const H = Math.floor(route.hours), M = Math.round((route.hours - H) * 60);
      put(flown, `Čas letu ${h}:${String(m).padStart(2, '0')} z ${H}:${String(M).padStart(2, '0')}`);
      put(local, 'Místní čas ' + clockText(localHour * 1440));
    },
  };
}
