// ---- mwsigns.js: every sign on the D11 and the D35, planned from the facts ----
// Pure: its only imports are js/d11.js and the baked slip table js/mwslips.js
// (plain constants). The chunk mesher reads it on the main thread AND in the
// mesh worker, js/mwsolids.js builds the colliders from it and js/mwatlas.js
// paints the faces it names, so all three agree by construction. No three, no
// DOM, no tile data, no clock, no random: every client and thread plans the
// same signs whatever order its tiles arrived in (co-op safe).
//
// WHAT A CZECH DRIVER READS (vyhláška 294/2015, TP 65, photos of the D11/D1):
//   per exit and direction   IS 9 advance boards on the right verge 1000 m
//                            and 500 m before the deceleration lane, an
//                            overhead gantry where that lane starts (a through
//                            panel over the running lanes, the exit panel
//                            with its EXIT number over the exit lane), and the
//                            exit number with its diagonal arrow in the gore
//   rest areas               advance boards with the services' pictograms
//   after every entry        an IS 8a distance board (towns ahead, whole km)
//   every 500 m              a kilometrovník (IS 18b: black on retroreflective
//                            orange, decimal comma), right verge
//   the ends                 IP 15a "Dálnice" where it begins, IP 15b where it
//                            ends (the D0 knot, and the world's edge at
//                            D11_WORLD_END_KM, where the owner wants the
//                            motorway to say it stops)
// Colour: white on green, the real Czech motorway colour (the brief settles it).
//
// OWNERSHIP. Every item belongs to the ONE chunk its owner point lies in: a
// gantry its span's midpoint, a board its panel's centre, a km board its post.
// plannedMotorwaySigns(key) returns exactly the items owned by that key, so a
// gantry straddling a chunk border is built once, never twice or not at all.
//
// CROSS SECTION (js/lanes.js, metres from the carriageway centreline, + right
// of travel): the drawn asphalt ends at 6.25; the crash barrier line the
// MOTORWAY-LOOK package draws is assumed at or inside 7.0. So a post stands at
// POST_OFF >= 7.6, a panel's near edge at PANEL_NEAR, gantry legs at LEG_OFF.
// Nothing is planned on a bridge deck (d11.onBridge), under an overpass or an
// ecoduct, or on a slip road's asphalt (the baked corridors of mwslips.js).

import { d11At, d11Locate, d11Line, onBridge, UP, ROAD, EXITS, REST, ECODUCTS,
  D35_SHARED, D11_WORLD_END_KM } from './d11.js';
import { SLIPS, OVERPASS, KM_SKIP } from './mwslips.js';

export const CHUNK_M = 120;          // js/config.js CHUNK (not imported: config is not worker-lean)
export const POST_OFF = 7.6;         // m, a small post (km board, IP 15) from the centreline
export const PANEL_NEAR = 7.5;       // m, the near edge of a verge panel
export const LEG_OFF = 8.6;          // m, a gantry leg (its footing clears the barrier)
export const GANTRY_CLEAR = 5.4;     // m, panel bottom over the road (ČSN 73 6101: 4.8 + reserve)
export const GANTRY_PANEL_H = 3.0;   // m, gantry panel height
export const PARTNER_PROBE = 12.4;   // m, js/lanes.js measured carriageway spacing (p50 12.44)

// Panel sizes in metres [w, h] and the bottom edge above the road level.
export const SIZE = {
  exit: [4.6, 3.0], thru: [5.3, 3.0], adv: [3.45, 2.25], rest: [3.6, 2.25],
  dist: [3.2, 1.6], gore: [1.4, 1.05], ip15: [1.25, 1.25], plate: [1.6, 0.4], km: [0.62, 0.44],
};

const OTHER = { E: 'W', W: 'E', S: 'N', N: 'S' };
const STEP = 0.02;                   // km, a nudge step
const CLEAR_BRIDGE = 0.04, CLEAR_OVER = 0.045, CLEAR_ECO = 0.07;

// ---- faces: what the atlas must paint, keyed by its content ----------------
// A face key is a pure string of its content, so two carriageways that sign
// the same thing share one cell of the atlas.
const roadShield = (r) => r;          // refs are already 'D11', 'I/36', 'II/322', 'E67'

function addFace(faces, key, spec) { if (!faces.has(key)) faces.set(key, spec); return key; }

// The E road number shown beside the D11 / D35 on through panels.
const E_REF = { D11: 'E67', D35: 'E442' };

// ---- the distance boards ---------------------------------------------------
// The towns an IS 8a names, per carriageway: [name, km of its exit on THIS
// road]; a D35 northbound board names Praha over the D11 (Sedlice at D11
// km 84) through `via`.
const DIST = {
  // [name, km of its exit, major]: a major town is named on every board until
  // it is passed (the far end of the road), the others while they are next
  E: [['Poděbrady', 39], ['Chlumec n. Cidlinou', 62], ['Pardubice', 84], ['Hradec Králové', 90, 1], ['Jaroměř', 108, 1]],
  W: [['Chlumec n. Cidlinou', 62], ['Poděbrady', 42], ['Praha', 0, 1]],
  S: [['Pardubice', 144], ['Chrudim', 157, 1]],
  N: [['Hradec Králové', 131], ['Praha', 127, 1, 84]],
};

/** The lines of the distance board standing at `km` on `cw`: [[name, whole km]], nearest first. */
export function distLines(cw, km) {
  const up = UP[cw], out = [];
  // ahead by at least 3 km; the first major one always, up to two others before it
  const ahead = (DIST[cw] ?? []).filter((d) => (d[1] - km) * up >= 3);
  const major = ahead.findIndex((d) => d[2]);
  const pick = major < 0 ? ahead.slice(0, 3) : [...ahead.slice(0, major).slice(0, 2), ahead[major]];
  for (const d of pick) out.push([d[0], Math.round(Math.abs(d[1] - km) + (d[3] ?? 0))]);
  return out;
}

/** "68,5": a km for a board, one decimal, Czech decimal comma. */
export function kmText(km) {
  const t = Math.round(km * 10);
  return Math.floor(t / 10) + ',' + (t % 10);
}

// ---- the plan ---------------------------------------------------------------
let PLAN = null;   // { byKey: Map, all: [], faces: Map }

function ecoAt(km, cw) {
  for (const e of ECODUCTS) {
    const s = e[cw];
    if (s && km >= s.km0 - CLEAR_ECO && km <= s.km1 + CLEAR_ECO) return true;
  }
  return false;
}
function overAt(km, cw) {
  const l = OVERPASS[cw];
  if (l) for (let i = 0; i < l.length; i++) if (Math.abs(l[i] - km) < CLEAR_OVER) return true;
  return false;
}
// the slip corridors of one carriageway, [km lo, km hi]
const CORR = {};
function corridors(cw) {
  if (CORR[cw]) return CORR[cw];
  const out = [];
  for (const k of Object.keys(SLIPS)) {
    if (!k.endsWith(':' + cw)) continue;
    const s = SLIPS[k];
    if (s[2] != null) out.push([Math.min(s[2], s[3]) - 0.02, Math.max(s[2], s[3]) + 0.02 + (s[2] === s[3] ? 0.25 : 0)]);
    if (s[5] != null) out.push([Math.min(s[5], s[6]) - 0.02 - (s[5] === s[6] ? 0.25 : 0), Math.max(s[5], s[6]) + 0.02]);
  }
  // exit 1 eastbound also has the Černý Most slip (alt), unbaked: keep clear
  return (CORR[cw] = out);
}
function inCorridor(km, cw) {
  const c = corridors(cw);
  for (let i = 0; i < c.length; i++) if (km >= c[i][0] && km <= c[i][1]) return true;
  return false;
}

/**
 * The world's end of each carriageway's plan, [lo, hi] official km: nothing
 * past D11_WORLD_END_KM (the tile ways run on over no terrain), nothing in the
 * D0 knot before km 0.
 */
function planRange(cw) {
  const q = d11Line(cw);
  const a = q.km[0], b = q.km[q.n - 1];
  let lo = Math.min(a, b), hi = Math.max(a, b);
  if (ROAD[cw] === 'D11') hi = Math.min(hi, D11_WORLD_END_KM - 0.05);
  return [lo, hi];
}

function blocked(km, cw, verge, taken, gap) {
  const [lo, hi] = planRange(cw);
  if (km < lo || km > hi) return true;
  if (onBridge(km, cw, CLEAR_BRIDGE) || ecoAt(km, cw) || overAt(km, cw)) return true;
  // a verge item keeps off this carriageway's slip roads; a gantry ('far')
  // keeps its far leg off the other carriageway's (the leg stands on its verge)
  if (verge === true && inCorridor(km, cw)) return true;
  if (verge === 'far' && inCorridor(km, OTHER[cw])) return true;
  if (taken) for (let i = 0; i < taken.length; i++) if (Math.abs(taken[i] - km) < gap) return true;
  return false;
}

// Nudge a planned km out of trouble: first back against the travel (a sign
// is better early than late), then forward, at most `reach` km each way.
function settle(km, cw, verge, taken, gap = 0.06, reach = 0.3) {
  if (!blocked(km, cw, verge, taken, gap)) return km;
  const up = UP[cw];
  for (let d = STEP; d <= reach + 1e-9; d += STEP) {
    if (!blocked(km - up * d, cw, verge, taken, gap)) return km - up * d;
  }
  for (let d = STEP; d <= reach + 1e-9; d += STEP) {
    if (!blocked(km + up * d, cw, verge, taken, gap)) return km + up * d;
  }
  return null;
}

const _p = { x: 0, z: 0, dx: 0, dz: 0 };
const _loc = {};

// the frame at km: centreline point, travel direction
function frame(km, cw) {
  const p = d11At(km, cw, _p);
  if (!p) return null;
  return { cx: p.x, cz: p.z, dx: p.dx, dz: p.dz };
}

const keyOf = (x, z) => Math.floor(x / CHUNK_M) + ',' + Math.floor(z / CHUNK_M);

function push(plan, it, ox, oz) {
  it.key = keyOf(ox, oz);
  it.ox = ox; it.oz = oz;
  plan.all.push(it);
  let a = plan.byKey.get(it.key);
  if (!a) plan.byKey.set(it.key, a = []);
  a.push(it);
}

// a verge board: a panel facing the oncoming traffic, its near edge at PANEL_NEAR
function board(plan, cw, km, kind, f, w, h, y, sub) {
  const fr = frame(km, cw);
  if (!fr) return;
  const off = PANEL_NEAR + w / 2;
  const it = { t: 'board', kind, cw, km, ...fr, off, w, h, y, f, sub: sub ?? null };
  push(plan, it, fr.cx - fr.dz * off, fr.cz + fr.dx * off);
}

// A portal over both carriageways, its far leg on the other one's verge; or,
// where that verge is taken by a slip road (`cant`), a cantilever: one leg on
// this verge and the beam ending free over the inner lane.
function gantry(plan, cw, km, panels, cant = false) {
  const fr = frame(km, cw);
  if (!fr) return;
  const rx = -fr.dz, rz = fr.dx;                 // right of travel
  // the partner carriageway: a probe one measured spacing to the left
  const loc = d11Locate(fr.cx - rx * PARTNER_PROBE, fr.cz - rz * PARTNER_PROBE, _loc);
  let left = -LEG_OFF;
  if (cant) left = -4.4;
  else if (loc && loc.cw === OTHER[cw]) left = -(PARTNER_PROBE - loc.off + LEG_OFF);
  const right = LEG_OFF;
  const it = { t: 'gantry', cw, km, ...fr, left, right, cant, panels };
  const mid = (left + right) / 2;
  push(plan, it, fr.cx + rx * mid, fr.cz + rz * mid);
}

function shields(refs) { return refs.map(roadShield); }

function build() {
  const plan = { byKey: new Map(), all: [], faces: new Map() };
  const F = plan.faces;
  // fixed cells every board composes from
  addFace(F, 'back', { type: 'back' });
  addFace(F, 'kmplate', { type: 'kmplate' });
  for (const c of '0123456789,') addFace(F, 'k' + c, { type: 'glyph', c });
  addFace(F, 'd1000', { type: 'plate', text: '1000 m' });
  addFace(F, 'd500', { type: 'plate', text: '500 m' });
  addFace(F, 'ip15a', { type: 'ip15', end: false });
  addFace(F, 'ip15b', { type: 'ip15', end: true });

  // km positions already used on each carriageway's verge / overhead, so two
  // things never stand in the same 60 m
  const verge = { E: [], W: [], S: [], N: [] }, over = { E: [], W: [], S: [], N: [] };

  // 1. gantries, then the gore and advance boards, exit by exit
  for (const e of EXITS) {
    if (e.outside) continue;
    for (const cw of ['E', 'W', 'S', 'N']) {
      const s = e[cw];
      if (!s || !s.div) continue;
      if (e.n === 1 && cw === 'E') continue;      // inside the D0 knot, before km 0
      const up = UP[cw];
      const sl = SLIPS[e.id + ':' + cw];
      const div = s.div.km;
      // the deceleration lane: the baked 3-lane piece, at most 350 m (exit 8's
      // real third lane out of Prague runs 600 m into it), else the median
      let dec = sl && sl[4] != null ? sl[4] : div - up * 0.21;
      if (Math.abs(div - dec) > 0.35) dec = div - up * 0.25;
      if (Math.abs(div - dec) < 0.08) dec = div - up * 0.15;
      const shared = ROAD[cw] === 'D11' && div >= D35_SHARED[0] && div <= D35_SHARED[1];
      const fx = addFace(F, 'X|' + e.n + '|' + s.to.join(';') + '|' + s.refs.join(';'),
        { type: 'exit', n: e.n, to: s.to, refs: shields(s.refs) });
      const thruRefs = [ROAD[cw], E_REF[ROAD[cw]]];
      if (shared) thruRefs.splice(1, 0, 'D35');
      const thru = (s.thru ?? []).slice(0, 3).map((t) => t.replace('Wroclaw', 'Wrocław'));
      const ft = addFace(F, 'T|' + thru.join(';') + '|' + thruRefs.join(';'),
        { type: 'thru', to: thru, refs: thruRefs });
      let gk = settle(dec, cw, 'far', over[cw], 0.25, 0.25), cant = false;
      if (gk == null) { gk = settle(dec, cw, false, over[cw], 0.25, 0.25); cant = true; }
      if (gk != null) {
        over[cw].push(gk);
        gantry(plan, cw, gk, [
          { f: ft, off: -1.25, w: SIZE.thru[0], h: GANTRY_PANEL_H },
          { f: fx, off: 4.15, w: SIZE.exit[0], h: GANTRY_PANEL_H },
        ], cant);
      }
      // the gore: EXIT nn and the diagonal arrow, in the wedge
      if (sl && sl[0] != null) {
        const fg = addFace(F, 'G|' + e.n, { type: 'gore', n: e.n });
        const fr = frame(sl[0], cw);
        if (fr && !onBridge(sl[0], cw, 0.02)) {
          const off = (6.25 + sl[1] - 2.75) / 2;
          const it = { t: 'board', kind: 'gore', cw, km: sl[0], ...fr, off, w: SIZE.gore[0], h: SIZE.gore[1], y: 1.0, f: fg, sub: null };
          push(plan, it, fr.cx - fr.dz * off, fr.cz + fr.dx * off);
          verge[cw].push(sl[0]);
        }
      }
      // advance boards
      for (const [d, plate] of [[1.0, 'd1000'], [0.5, 'd500']]) {
        const k = settle(dec - up * d, cw, true, verge[cw]);
        if (k == null) continue;
        verge[cw].push(k);
        board(plan, cw, k, 'adv', fx, SIZE.adv[0], SIZE.adv[1], 1.9, { f: plate, w: SIZE.plate[0], h: SIZE.plate[1] });
      }
    }
  }
  // 2. rest areas: advance boards with the pictograms
  for (const r of REST) {
    for (const cw of ['E', 'W', 'S', 'N']) {
      const s = r[cw];
      if (!s || !s.div) continue;
      const up = UP[cw];
      const sl = SLIPS[r.id + ':' + cw];
      let dec = sl && sl[4] != null ? sl[4] : s.div.km - up * 0.2;
      if (Math.abs(s.div.km - dec) > 0.35) dec = s.div.km - up * 0.25;
      const fr0 = addFace(F, 'R|' + r.name + '|' + [s.parking ? 'P' : '', s.fuel ? 'F' : '', s.food ? 'R' : '', s.wc ? 'W' : ''].join(''),
        { type: 'rest', name: r.name, parking: !!s.parking, fuel: !!s.fuel, food: !!s.food, wc: !!s.wc });
      for (const [d, plate] of [[1.0, 'd1000'], [0.5, 'd500']]) {
        const k = settle(dec - up * d, cw, true, verge[cw]);
        if (k == null) continue;
        verge[cw].push(k);
        board(plan, cw, k, 'rest', fr0, SIZE.rest[0], SIZE.rest[1], 1.9, { f: plate, w: SIZE.plate[0], h: SIZE.plate[1] });
      }
    }
  }
  // 3. distance boards 300 m past the end of every acceleration lane
  for (const e of EXITS) {
    if (e.outside) continue;
    for (const cw of ['E', 'W', 'S', 'N']) {
      const s = e[cw];
      if (!s || !s.mer) continue;
      const up = UP[cw];
      const sl = SLIPS[e.id + ':' + cw];
      const acc = sl && sl[7] != null ? sl[7] : s.mer.km + up * 0.28;
      const k = settle(acc + up * 0.3, cw, true, verge[cw], 0.08, 0.4);
      if (k == null) continue;
      const lines = distLines(cw, k);
      if (!lines.length) continue;
      verge[cw].push(k);
      const fd = addFace(F, 'D|' + lines.map((l) => l.join(' ')).join(';'), { type: 'dist', lines });
      board(plan, cw, k, 'dist', fd, SIZE.dist[0], SIZE.dist[1], 1.6);
    }
  }
  // 4. the ends: IP 15a / 15b
  const ends = [
    ['E', -0.45, 'ip15a'], ['W', 0.56, 'ip15b'],
    ['E', D11_WORLD_END_KM - 0.25, 'ip15b'], ['W', D11_WORLD_END_KM - 0.12, 'ip15a'],
  ];
  for (const [cw, km0, f] of ends) {
    const k = settle(km0, cw, true, verge[cw], 0.03, 0.2);
    if (k == null) continue;
    verge[cw].push(k);
    const fr = frame(k, cw);
    const off = POST_OFF + 0.4;
    const it = { t: 'board', kind: 'ip15', cw, km: k, ...fr, off, w: SIZE.ip15[0], h: SIZE.ip15[1], y: 1.6, f, sub: null };
    push(plan, it, fr.cx - fr.dz * off, fr.cz + fr.dx * off);
  }
  // 5. km boards every 500 m on the right verge: skipped (not moved) where
  // something is in the way, as a real one is left out rather than misplaced
  for (const cw of ['E', 'W', 'S', 'N']) {
    const [lo, hi] = planRange(cw);
    for (let h = Math.ceil(lo * 2); h <= Math.floor(hi * 2); h++) {
      const km = h / 2;
      if (km < 0.5 || KM_SKIP[cw].includes(km)) continue;
      if (blocked(km, cw, true, verge[cw], 0.03)) continue;
      const fr = frame(km, cw);
      if (!fr) continue;
      const it = { t: 'km', cw, km, ...fr, off: POST_OFF, text: kmText(km) };
      push(plan, it, fr.cx - fr.dz * POST_OFF, fr.cz + fr.dx * POST_OFF);
    }
  }
  return plan;
}

function plan() { return PLAN ??= build(); }

// The 4.8 km tiles any sign stands in (tests/mwsigns.test.mjs keeps this list
// equal to the plan). A chunk elsewhere answers at once, without the first
// call decoding the lines and planning the whole road (about 20 ms): a city
// chunk, or a flight over Pardubice, never pays for the motorway.
export const SIGN_TILES = new Set(['-1,-3', '-1,-4', '-10,-2', '-10,-3', '-11,-3', '-12,-2', '-12,-3',
  '-13,-2', '-13,-3', '-14,-3', '-15,-3', '-16,-3', '-17,-2', '-17,-3', '-18,-2', '-2,-3', '-3,-3',
  '-4,-3', '-5,-3', '-6,-3', '-7,-3', '-8,-2', '-8,-3', '-9,-2', '-9,-3', '0,-3', '0,-4', '0,-5',
  '0,-6', '1,-2', '1,-3', '1,-6', '2,-1', '2,-2', '2,0', '3,0', '3,1', '4,1']);
const TILE_CHUNKS = 4800 / CHUNK_M;

/** The items whose owner point lies in chunk `key` ("cx,cz"), or an empty array. */
const NONE = Object.freeze([]);
export function plannedMotorwaySigns(key) {
  const c = key.indexOf(',');
  const tk = Math.floor(+key.slice(0, c) / TILE_CHUNKS) + ',' + Math.floor(+key.slice(c + 1) / TILE_CHUNKS);
  if (!SIGN_TILES.has(tk)) return NONE;
  return plan().byKey.get(key) ?? NONE;
}
/** Every planned item (colliders, tests). Read only. */
export function allMotorwaySigns() { return plan().all; }
/** The faces the plan uses: Map key -> spec, in the order they were first named. */
export function motorwayFaces() { return plan().faces; }
