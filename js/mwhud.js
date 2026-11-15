// ---- mwhud.js: what the HUD says on the D11 / D35 ----
// Pure text helpers over js/d11.js, for js/place.js (where am I) and the trip
// readout in js/main.js (the next exit). Czech, with the decimal comma.

import { d11Locate, EXITS, D11_WORLD_END_KM } from './d11.js';

const _loc = {};

/** "Praha" / "Hradec Králové" / ...: where carriageway `cw` is signed to at `km`. */
export function towards(cw, km) {
  if (cw === 'E') return km < 90 ? 'Hradec Králové' : 'Jaroměř';
  if (cw === 'W') return 'Praha';
  if (cw === 'S') return 'Olomouc';
  return 'Hradec Králové';
}

/** "68,4": one decimal, comma. */
export function kmComma(km) {
  const t = Math.round(km * 10);
  return (t < 0 ? '-' : '') + Math.floor(Math.abs(t) / 10) + ',' + (Math.abs(t) % 10);
}

/**
 * "D11, km 68,4, směr Hradec Králové" while (x, z) is on a D11 / D35
 * carriageway (within its drawn asphalt), else null. Past the world's end
 * the km would name road that is not there, so nothing is said.
 */
export function motorwayPlace(x, z) {
  const l = d11Locate(x, z, _loc);
  if (!l || l.off < -6.6 || l.off > 6.6) return null;
  if (l.road === 'D11' && l.km > D11_WORLD_END_KM) return null;
  return l.road + ', km ' + kmComma(l.km) + ', směr ' + towards(l.cw, l.km);
}

/**
 * The exit a route leaves the motorway by at node (x, z): { exit, street }
 * with the destinations of the slip as signed, or null when (x, z) is not a
 * D11 / D35 diverge (a D0 or D1 slip, a rest area), or when `ahead` (the far
 * end of the route's next piece, [x, z]) is still on the same carriageway:
 * the route carries straight on past the slip. For js/navigation.js.
 */
const _ah = {};
export function exitJointAt(x, z, ahead = null) {
  const l = d11Locate(x, z, _loc);
  if (!l || Math.abs(l.off) > 4) return null;
  if (ahead) {
    const a = d11Locate(ahead[0], ahead[1], _ah);
    if (a && a.cw === l.cw && Math.abs(a.off) < 6) return null;
  }
  let best = null, bd = 160 * 160, bs = null;
  for (const e of EXITS) {
    const s = e[l.cw];
    if (!s) continue;
    for (const p of [s.div, s.alt]) {
      if (!p) continue;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = e; bs = p === s.alt ? s.alt : s; }
    }
  }
  if (!best) return null;
  return { exit: best.n, street: bs.to.slice(0, 2).join(', ').replace('Wroclaw', 'Wrocław') };
}

/** "800 m" / "1,2 km": a distance as a Czech driver reads it off a sign. */
export function fmtExitDist(m) {
  if (m < 950) return Math.max(50, Math.round(m / 50) * 50) + ' m';
  return kmComma(m / 1000) + ' km';
}

/**
 * The trip HUD's exit line, or '': "Exit 68 Nové Město, Lázně Bohdaneč, 1,2 km"
 * from navigation.nextTurn when the next instruction is a motorway exit
 * within 3 km.
 */
export function exitHudText(nav) {
  const t = nav?.nextTurn;
  if (!t || t.dir !== 'exit' || !(t.dist < 3000)) return '';
  return 'Exit ' + t.exit + ' ' + t.street + ', ' + fmtExitDist(t.dist);
}

/** Write the exit line into the trip HUD element (a span made on first use). */
export function setExitLine(el, text) {
  let s = el.querySelector('.nv-exit');
  if (!s) {
    if (!text) return;
    s = document.createElement('span');
    s.className = 'nv-exit';
    // white on motorway green, the colour of the sign it repeats
    s.style.cssText = 'font:700 14px/1.2 system-ui,sans-serif;color:#fff;background:#00764c;'
      + 'border:1.5px solid #f4f6f1;border-radius:4px;padding:2px 8px;margin-bottom:3px;text-shadow:none';
    el.insertBefore(s, el.firstChild);
  }
  s.textContent = text;
  s.style.display = text ? '' : 'none';
}
