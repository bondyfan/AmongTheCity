// ---- pieces.js: a building as a pile of boxes that happen to be touching ----
// This is the Teardown trick, and it is the whole reason a missile can take a
// bite out of a block of flats and leave the staircase hanging in the air.
//
// A plan (interiors.js) describes surfaces: this slab, that partition, a stair
// run. Geometry made from those surfaces — one quad per wall — is unbreakable,
// because breaking it means re-triangulating it at runtime. So nothing here
// emits a surface. Every slab is a grid of TILES, every wall a row of PANELS,
// every stair a stack of STEPS, and each one is an independent box with its own
// centre, size, yaw and colour. A wall is then not a thing that can be holed;
// it is 40 things that can be individually deleted, and deleting the ones a
// blast sphere touches leaves a ragged edge for free.
//
// The cost of that freedom is piece count, so the two knobs that matter are
// tile size and panel width, both scaled by footprint size in interiors.js and
// re-checked here against a hard per-floor cap. A 240 m² block of flats over
// four storeys lands around 850 pieces; a 13 000 m² shopping centre around
// 3500. At those counts one InstancedMesh per building draws the lot in one
// call and a full rebuild after a hit costs well under a millisecond.
//
// Two build phases, because they are needed at different moments:
//   interiorPieces(plan)  — floors, ceilings, the inner leaf of the outer wall,
//                           partitions, stairs, railings, furniture. Built as
//                           soon as the player walks near, while the chunk mesh
//                           still draws the pretty textured facade outside.
//   shellPieces(plan)     — the outer wall itself, with REAL window openings
//                           and panes, the roof and its parapet. Built at the
//                           same moment, because a window you can see through
//                           has to exist before anybody shoots the place, and
//                           because "before" and "after" must be one geometry.
//
// A piece = { x, y, z, hx, hy, hz, yaw, col, k, kind, weak }
//   x/y/z  world centre (y is the box centre, not its base)
//   hx/hy/hz  half-extents BEFORE yaw; hx runs along the piece's own length
//   yaw    rotation about y that maps local +x onto the wall direction
//   col    palette hex, k a per-piece brightness multiplier (grime + variety)
//   kind   'floor'|'ceil'|'wall'|'ext'|'glass'|'stair'|'rail'|'prop'|'roof'
//   weak   true = glass/furniture/railings: shatters early, never holds a
//          building up (the support solver treats it as cargo, not structure)
// Optional stamps some pieces carry: uv (facade-atlas sub-rect), signText/
// signBg/signFg (the wordmark contract), goods (shelf stock), balcony
// (panelák balcony pieces) and french (novostavba window rails).

import { pointInPolygon, polygonArea, distPointToSegment } from './geo.js';
import { INTERIOR, ROOF_DARKEN, WALL_AO } from './config.js';
import { planToWorld } from './interiors.js';

// The facade's own wall colour for this building, stamped onto the plan by
// interiorsim before anything is built. It comes from meshes.js (which owns the
// palette and needs three.js to mix it) and is passed in rather than imported,
// so this module stays a pure-data unit the headless tests can exercise.
const wallHexOf = (plan) => plan.wallHex ?? plan.pal.trim;

const I = INTERIOR;
// Ground-floor slab height. This has to clear the WHOLE of config's LAYER_Y
// ladder, not just the terrain: green 0.05, water 0.08, paved 0.10, rail 0.14,
// footway 0.16, road 0.20, marking 0.26. The first attempt at 0.09 sat one
// centimetre under the `paved` layer, and OSM draws car parks and plazas right
// through building footprints — so every shop floor shimmered against the
// paving it was standing on. 0.30 is above the lot, and a 30 cm threshold is
// what a Czech shop entrance actually has.
const GROUND_LIFT = I.groundLift;
const PROP_LIFT = 0.015;    // furniture rests ON the floor, not IN its surface
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

// module scratch — build-time only, but a mall runs this loop 20 000 times
const _w = { x: 0, z: 0 };
const _probe = { x: 0, z: 0, t: 0 };

// ---- v7 facade grammar palette --------------------------------------------
// What makes a curtain wall read as a curtain wall is not the glass, it is the
// THIN DARK LINES between the panes — so mullions and window frames get their
// own near-black metals rather than the building's plaster hue.
const MULLION_C = 0x2b2e33;     // storefront/pavilion mullions
const FRAME_C = 0x33373d;       // office curtain-wall frames and spandrel joints
const GLASS_C = 0x9fb4c4;       // same pane hex the ext path already uses
const FRENCH_C = 0x3f444a;      // novostavba French-balcony rails
// panelák balcony rail panels — the pastel infill boards every sídliště wears
const RAIL_CS = [0xc9cdd1, 0xbcc6cc, 0xcfc8ba, 0xb8c2b4];

// ---- footprint tests -----------------------------------------------------
// Plans are rectangles in the OBB; the real building is a polygon. Every piece
// is therefore accepted or rejected by its own centre, which is what lets an
// L-shaped or trapezoid footprint host a rectangular layout and simply lose the
// parts that stick out. `margin` additionally keeps slabs from poking through
// the facade — skipped on very complex rings, where the O(n) edge scan would
// dominate the build (a floodplain-era Labe warehouse carries 500 nodes).
function footTest(plan) {
  const ring = plan.ring, holes = plan.holes;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cheap = ring.length > 120;
  return (x, z, margin) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
    if (!pointInPolygon(x, z, ring)) return false;
    if (holes) for (const h of holes) if (h.length >= 3 && pointInPolygon(x, z, h)) return false;
    if (!margin || cheap) return true;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (distPointToSegment(x, z, a[0], a[1], b[0], b[1], _probe) < margin) return false;
    }
    return true;
  };
}

// ---- emit helpers --------------------------------------------------------

let _seq = 0;   // per-build piece counter, feeds the colour jitter salt

function push(out, x, y, z, hx, hy, hz, yaw, col, kind, weak, kLo, kHi) {
  const s = ++_seq;
  const lo = kLo ?? 0.9, hi = kHi ?? 1.06;
  const p = {
    x, y, z, hx, hy, hz, yaw, col, kind, weak: !!weak,
    k: lo + rnd(out._seed | 0, s) * (hi - lo),
  };
  out.push(p);
  return p;                      // callers stamp `leaf` on perimeter pieces
}

// Split a wall's 0..1 length into alternating solid/gap spans from its door
// list. Doing it once up front means the panel loop never has to reason about
// partial overlaps: a span is either wall or opening, all the way through.
function spansOf(gaps) {
  if (!gaps || !gaps.length) return [[0, 1, false]];
  const g = gaps.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = 0;
  for (const [a, b] of g) {
    if (a > t + 1e-4) out.push([t, a, false]);
    out.push([Math.max(t, a), Math.min(1, b), true]);
    t = Math.max(t, b);
  }
  if (t < 1 - 1e-4) out.push([t, 1, false]);
  return out;
}

// One plan wall → a row of panels standing on floor `fy`. Openings become a
// HEADER piece only (the bit of wall above the door), which is what stops a
// doorway reading as a missing tooth: you walk through a real lintel.
function emitWall(out, plan, w, fy, thick, col, kind, panelW, weak, doorH) {
  const du = w.u1 - w.u0, dv = w.v1 - w.v0;
  const L = Math.hypot(du, dv);
  if (L < 0.12) return;
  const alongU = Math.abs(du) >= Math.abs(dv);
  const yaw = plan.fr.yaw + (alongU ? 0 : Math.PI / 2);
  const test = plan._foot;
  const hTop = w.hTop, hd = doorH ?? I.doorH;
  for (const [t0, t1, isGap] of spansOf(w.gaps)) {
    const segL = (t1 - t0) * L;
    if (segL < 0.06) continue;
    let yB = 0, yT = hTop;
    if (isGap) {
      if (hTop <= hd + 0.06) continue;      // opening reaches the ceiling: nothing to build
      yB = hd; yT = hTop;
    }
    const n = Math.max(1, Math.round(segL / panelW));
    const pw = segL / n;
    for (let i = 0; i < n; i++) {
      const c = t0 + ((i + 0.5) * pw) / L;
      const u = w.u0 + du * c, v = w.v0 + dv * c;
      planToWorld(plan.fr, u, v, _w);
      // half the panel length: a partition may reach right up to the outer
      // wall, but never through it
      if (!test(_w.x, _w.z, pw * 0.5)) continue;
      push(out, _w.x, fy + (yB + yT) / 2, _w.z,
        pw / 2, (yT - yB) / 2, thick / 2, yaw, col, kind, weak);
    }
  }
}

// A slab: tile the OBB, drop tiles outside the footprint or inside a void
// (atrium, stair well). `top` is the walking surface; the box hangs below it,
// so a floor at y = 3.1 really is at 3.1 when you stand on it.
//
// The subtlety is the VOIDS, and getting it wrong is what sealed the first
// version's staircases shut: a stair well is 5.5 × 1.5 m while a big
// building's tiles are 5–7 m across, so testing only the tile CENTRE against
// the void left four tiles overlapping the hole and the player climbed nine
// treads into a ceiling. A tile that touches a void is therefore SUBDIVIDED
// (4 × 4) and only the sub-tiles genuinely outside the hole are kept — a clean
// opening at the size the plan asked for, at the cost of a few dozen pieces
// per floor instead of a coarser grid everywhere.
function emitSlab(out, plan, top, voids, tile, col, kind, dark, split, thick) {
  const fr = plan.fr, test = plan._foot;
  const kLo = (dark ?? 1) * 0.86, kHi = (dark ?? 1) * 1.05;
  const nu = Math.max(1, Math.ceil((fr.hu * 2) / tile));
  const nv = Math.max(1, Math.ceil((fr.hv * 2) / tile));
  const tu = (fr.hu * 2) / nu, tv = (fr.hv * 2) / nv;
  const inVoid = (u, v) => {
    if (!voids) return false;
    for (const o of voids) if (u > o.u0 && u < o.u1 && v > o.v0 && v < o.v1) return true;
    return false;
  };
  // A tile is CLEAR when its centre is at least its own half-diagonal inside
  // the outline — that is the exact condition for the whole tile to fit, and
  // testing only the centre (as the first version did) is what let 5 m slabs
  // stick a metre out through the facade like shelves.
  const emit = (u, v, hu, hv) => {
    planToWorld(fr, u, v, _w);
    // A slab that SPLITS at the boundary must fit whole (half-diagonal); one
    // that does not split — a ceiling, a roof — only needs its centre inside,
    // or a coarse grid over a small building rejects every tile and leaves the
    // place with no lid at all.
    // …but an un-split slab still may not sail a metre and a half past the
    // wall on a coarse grid: cap the overhang at the eaves depth a real roof
    // would have.
    const m = Math.hypot(hu, hv);
    if (!test(_w.x, _w.z, split === false ? Math.min(0.6, m * 0.5) : m)) return;
    const T = thick ?? I.slabT;
    push(out, _w.x, top - T / 2, _w.z, hu, T / 2, hv,
      fr.yaw, col, kind, false, kLo, kHi);
  };
  // boundary tiles subdivide until the pieces are small enough to follow the
  // wall; ~0.7 m sub-tiles reach to within half a metre of the ring, which is
  // inside the outer wall's own thickness and therefore invisible
  const SUB = clamp(Math.round(Math.max(tu, tv) / 0.7), 2, 5);
  for (let iu = 0; iu < nu; iu++) {
    const u0 = -fr.hu + iu * tu, u = u0 + tu / 2;
    for (let iv = 0; iv < nv; iv++) {
      const v0 = -fr.hv + iv * tv, v = v0 + tv / 2;
      let cut = false;
      if (voids) for (const o of voids)
        if (u0 < o.u1 && u0 + tu > o.u0 && v0 < o.v1 && v0 + tv > o.v0) { cut = true; break; }
      if (!cut && split !== false) {
        planToWorld(fr, u, v, _w);
        cut = !test(_w.x, _w.z, Math.hypot(tu, tv) / 2);     // crosses the wall
      }
      if (!cut) { emit(u, v, tu / 2, tv / 2); continue; }
      const su = tu / SUB, sv = tv / SUB;
      for (let a = 0; a < SUB; a++) for (let b = 0; b < SUB; b++) {
        const cu = u0 + (a + 0.5) * su, cv2 = v0 + (b + 0.5) * sv;
        if (inVoid(cu, cv2)) continue;
        emit(cu, cv2, su / 2, sv / 2);
      }
    }
  }
}

// The wall against the street, panel by panel, from the real footprint ring.
// `leaf` decides which of the two jobs this is: 'lin' builds the thin inner
// lining that lets you see a WALL from inside while the textured facade outside
// is still doing the looking, 'ext' builds the full-thickness outer wall that
// replaces both once the building is in pieces. Windows are real openings in
// either case — a sill piece, a glass pane, a spandrel above — because a
// window you can blow out of its frame is worth three of a painted one.
function emitPerimeter(out, plan, fi, leaf) {
  const ring = plan.ring, fr = plan.fr;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const fy = plan.floors[fi].y;
  // The INNER lining spans the room height (sH − slab). The OUTER leaf must
  // clad the FULL storey — slab edge included — or every floor line becomes a
  // 26 cm horizontal slit and the storeys read as levitating plates. The
  // facade atlas maps one cell per full storey anyway, so ext panels spanning
  // sH also line the paint up better with the flat-facade LOD.
  const roomH = plan.storeys === 1 ? plan.usable : plan.sH - I.slabT;
  const wallH = leaf === 'ext'
    ? (plan.storeys === 1 ? plan.usable + I.slabT : plan.sH)
    : roomH;
  const thick = leaf === 'ext' ? I.extT + I.linT : I.linT;
  const pal = plan.pal;
  // The OUTER leaf wears the facade's own colour and the facade's own window
  // rhythm (one bay per 2.7 m, the atlas's spacing), so promoting a building
  // from painted quads to solid boxes does not change what it looks like — it
  // only changes what can happen to it. The inner lining stays interior white.
  const col = leaf === 'ext' ? wallHexOf(plan) : pal.wall;
  // the outer leaf panels ARE atlas bays, so their width is the atlas bay pitch
  const cells = plan.cells ?? { cellA: [0, 0.75, 0.125, 1], storeC: null, bays: 4, atlasN: 8, bayW: 2.7 };
  const panelW = leaf === 'ext' ? cells.bayW : plan.panel;
  const ent = plan.entrance;
  // industrial halls and parking decks are mostly blank wall with strip
  // glazing high up; housing is windows everywhere. This one number is why a
  // panelák and a warehouse read differently from inside.
  const winChance = plan.use === 'industrial' || plan.use === 'parking' ? 0.3
    : plan.use === 'garage' ? 0.15
    : plan.use === 'mall' || plan.use === 'supermarket' ? (fi === 0 ? 0.8 : 0.5)
    : 0.72;
  const sill = 0.85, winH = Math.min(1.55, wallH - sill - 0.35);
  // ---- v7 facade grammar flags (outer leaf only) ----
  // offices drop the atlas for a curtain wall (two hash-picked variants);
  // novostavby drop it for white plaster with tall windows; restaurants and
  // mall entrances get glazed runs handled per edge below
  const officeVar = leaf === 'ext' && plan.use === 'office' ? (plan.officeVar ?? 'bands') : null;
  const novaExt = leaf === 'ext' && plan.nova && plan.use === 'flats';
  // hash-picked window-surround contrast for the generic housing stock — the
  // jambs read a shade lighter, which is a painted šambrána at zero pieces
  const surK = leaf === 'ext' && (plan.use === 'house' || plan.use === 'flats')
    && !plan.nova && rnd(plan.id, 83) < 0.4 ? 1.13 : 1;
  const N = ring.length;

  for (let ei = 0; ei < ring.length; ei++) {
    const a = ring[ei], b = ring[(ei + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.2) continue;
    const ux = dx / L, uz = dz / L;
    // inward normal: the interior of a positive-area ring lies on (−dz, dx)
    const inx = -sgn * uz, inz = sgn * ux;
    const yaw = Math.atan2(-uz, ux);
    // Both leaves put their INNER face at the same depth (extT + linT from the
    // ring), so swapping the thin lining for the full-thickness outer wall the
    // moment a building is damaged does not move a single interior surface —
    // the room you were standing in stays exactly where it was.
    const off = leaf === 'ext' ? thick / 2 : I.extT + I.linT / 2;
    const n = Math.max(1, Math.round(L / panelW));
    const pw = L / n;
    // where the street door sits along THIS edge, in metres from a
    const door = (ent && ent.i === ei && fi === 0)
      ? { c: L * ent.t, w: ent.w } : null;
    // fake AO to match the facade's own ground-edge darkening, so the two
    // representations agree in VALUE as well as in hue
    const ao = (y) => WALL_AO + (1 - WALL_AO) * Math.min(1, (y - plan.y0) / 4);
    // A fast-food pavilion is glass on the whole entrance side AND around both
    // its corners (the two adjacent edges) — that wrap is what sells "modern
    // drive-through" over "shed with a sign". A mall glazes a tall PORTAL: the
    // entrance bay run only, but through the first TWO storeys.
    const glassRun = leaf === 'ext' && plan.use === 'restaurant' && ent
      && (ei === ent.i || ei === (ent.i + 1) % N || ei === (ent.i + N - 1) % N);
    const portalC = leaf === 'ext' && plan.use === 'mall' && ent
      && ei === ent.i && fi <= 1 ? L * ent.t : null;
    const portalHalf = portalC === null ? 0 : clamp(L * 0.22, 3.5, 8);

    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * pw;
      const px = a[0] + ux * s + inx * off, pz = a[1] + uz * s + inz * off;
      let yB = fy, yT = fy + wallH;
      const isDoor = door && Math.abs(s - door.c) < door.w / 2 + pw * 0.5;
      if (isDoor) {
        // the entrance: only the lintel above it, and only if there is room
        if (fy + I.entryH + 0.25 > yT) continue;
        yB = fy + I.entryH;
      }

      if (leaf === 'ext') {
        const yTw = fy + wallH;
        // flat-colour bay piece (no atlas) — the special facade grammars below
        // are exactly the buildings whose real counterparts DON'T wear Czech
        // plaster-and-sill paint, so they emit plain boxes and let colour and
        // proportion do the talking. Same placement math as put() underneath.
        const flat = (y0, y1, u0f, u1f, c2, lo, hi) => {
          if (y1 - y0 < 0.02 || u1f - u0f < 0.01) return null;
          const cx2 = px + ux * (u0f + u1f - 1) * pw * 0.5;
          const cz2 = pz + uz * (u0f + u1f - 1) * pw * 0.5;
          const p = push(out, cx2, (y0 + y1) / 2, cz2, (u1f - u0f) * pw / 2,
            (y1 - y0) / 2, thick / 2, yaw, c2, 'ext', false, lo, hi);
          p.leaf = 'ext';
          return p;
        };

        // ---- GLAZED FRONTAGE: fast-food pavilion / mall entrance portal ----
        // Big panes between thin dark mullions; the restaurant hangs its
        // cladding band (brand `clad` — McDonald's anthracite, KFC red) over
        // the glass, the mall just keeps a floor-line strip between storeys.
        if (glassRun || (portalC !== null && Math.abs(s - portalC) < portalHalf)) {
          const isRest = plan.use === 'restaurant';
          const clad = isRest ? (plan.brand?.clad ?? 0x45423e) : col;
          const bandH = isRest ? clamp(wallH * 0.2, 0.6, 1.0) : Math.min(0.35, wallH * 0.1);
          const gB = fy + (fi === 0 ? 0.12 : 0.05);
          const gT = yTw - bandH;
          const mull = (sm) => {         // a mullion on the bay boundary
            if (sm < 0.03 || sm > L - 0.03) return;
            push(out, a[0] + ux * sm + inx * off, (gB + gT) / 2,
              a[1] + uz * sm + inz * off, 0.055, (gT - gB) / 2, thick * 0.4,
              yaw, MULLION_C, 'ext', false, 0.95, 1.0).leaf = 'ext';
          };
          mull(s - pw / 2);
          if (i === n - 1) mull(s + pw / 2);
          // the pane — a door bay keeps its opening and gets a glass header
          const pB = isDoor ? fy + I.entryH + 0.05 : gB;
          if (gT - pB > 0.3)
            push(out, px + inx * thick * 0.22, (pB + gT) / 2,
              pz + inz * thick * 0.22, pw / 2 - 0.08, (gT - pB) / 2, 0.028,
              yaw, GLASS_C, 'glass', true, 0.9, 1.05).leaf = 'ext';
          // base strip under the glass, cladding band above it
          if (!isDoor && gB - fy > 0.04)
            flat(fy, gB, 0, 1, clad, 0.9, 0.98);
          if (yTw - gT > 0.05) flat(gT, yTw, 0, 1, clad, 0.95, 1.03);
          continue;
        }

        // ---- CURTAIN-WALL OFFICE: two hash-picked variants ----
        // 'bands' = continuous horizontal glass with slim spandrels (the glass
        // fraction lands ~0.8); 'grid' = a grid of tall windows in dark frames.
        // Both wear wallHex — classify() stamped the cool grey onto f.c, so
        // the far LOD's flat box is already the same colour.
        if (officeVar && !(fi === 0 && cells.storeC)) {
          if (isDoor) { flat(yB, yTw, 0, 1, col, 0.94, 1.0); continue; }
          const kA = ao(fy + wallH * 0.5);
          if (officeVar === 'bands') {
            const gB = fy + wallH * 0.30, gT = fy + wallH * 0.88;
            flat(fy, gB, 0, 1, col, kA * 0.92, kA * 1.0);       // spandrel
            flat(gT, yTw, 0, 1, col, kA * 0.94, kA * 1.02);     // floor strip
            flat(gB, gT, 0, 0.045, FRAME_C, 0.96, 1.0);         // band joint
            if (i === n - 1) flat(gB, gT, 0.955, 1, FRAME_C, 0.96, 1.0);
            push(out, px + inx * thick * 0.22, (gB + gT) / 2,
              pz + inz * thick * 0.22, pw / 2 - 0.09, (gT - gB) / 2, 0.028,
              yaw, GLASS_C, 'glass', true, 0.9, 1.05).leaf = 'ext';
          } else {
            const wy0 = fy + wallH * 0.20, wy1 = fy + wallH * 0.84;
            const gFrac = 0.64, gj = (1 - gFrac) / 2;
            flat(fy, wy0, 0, 1, col, kA * 0.9, kA * 0.98);
            flat(wy1, yTw, 0, 1, col, kA * 0.94, kA * 1.02);
            flat(wy0, wy1, 0, gj, FRAME_C, 0.94, 1.0);          // dark frame
            flat(wy0, wy1, 1 - gj, 1, FRAME_C, 0.94, 1.0);
            push(out, px + inx * thick * 0.22, (wy0 + wy1) / 2,
              pz + inz * thick * 0.22, gFrac * pw / 2 - 0.02, (wy1 - wy0) / 2,
              0.028, yaw, GLASS_C, 'glass', true, 0.9, 1.05).leaf = 'ext';
          }
          continue;
        }

        // ---- NOVOSTAVBA: white plaster, tall windows, French balconies ----
        if (novaExt && !(fi === 0 && cells.storeC)) {
          if (isDoor) { flat(yB, yTw, 0, 1, col, 0.94, 1.02); continue; }
          const kA = ao(fy + wallH / 2);
          if (wallH < 2.2 || rnd(plan.id, 8100 + fi * 89 + ei * 11 + i) < 0.15) {
            flat(fy, yTw, 0, 1, col, kA * 0.95, kA * 1.03);
            continue;
          }
          const wy0 = fy + wallH * 0.24, wy1 = fy + wallH * 0.88;
          const gFrac = 0.6, gj = (1 - gFrac) / 2;
          flat(fy, wy0, 0, 1, col, kA * 0.93, kA * 1.0);
          flat(wy1, yTw, 0, 1, col, kA * 0.96, kA * 1.04);
          flat(wy0, wy1, 0, gj, col, kA * 0.9, kA * 0.97);
          flat(wy0, wy1, 1 - gj, 1, col, kA * 0.9, kA * 0.97);
          push(out, px + inx * thick * 0.22, (wy0 + wy1) / 2,
            pz + inz * thick * 0.22, gFrac * pw / 2 - 0.05, (wy1 - wy0) / 2,
            0.028, yaw, GLASS_C, 'glass', true, 0.9, 1.05).leaf = 'ext';
          // the French balcony: a flush dark rail across the pane's lower half
          // — floor-to-ceiling glass on an upper storey NEEDS one to read as a
          // dwelling rather than an office
          if (fi > 0 && rnd(plan.id, 8200 + fi * 131 + ei * 17 + i) < 0.6)
            push(out, px - inx * (off + 0.05), wy0 + 0.55, pz - inz * (off + 0.05),
              pw * gFrac / 2 - 0.02, 0.5, 0.03, yaw, FRENCH_C, 'rail', true,
              0.9, 1.0).french = true;
          continue;
        }

        // ---- the OUTER leaf is the facade, as boxes, WITH REAL WINDOWS ----
        // Each atlas BAY becomes five pieces: plaster below the sill, plaster
        // above the lintel, a jamb either side, and a translucent PANE in the
        // hole between them. Every solid piece samples the exact sub-rectangle
        // of the window atlas the painted facade would have used at that spot,
        // so the wall keeps its sills, lintels, mullions and grime — and the
        // window is a real opening you can see through, into the rooms.
        //
        // That is why the atlas's window band is fixed (WIN_BAND / WIN_FRAC in
        // meshes.js): the paint and the hole have to agree on where the window
        // is, or you get a painted window next to a real one.
        const cell = (fi === 0 && cells.storeC) ? cells.storeC : cells.cellA;
        const cu = cell[0] + ((i % cells.bays) / cells.bays) * (1 / cells.atlasN);
        const cw = 1 / (cells.bays * cells.atlasN);
        const cv0 = cell[1], cvH = cell[3] - cell[1];
        const uvOf = (fu0, fu1, fv0, fv1) =>
          [cu + cw * fu0, cv0 + cvH * fv0, cu + cw * fu1, cv0 + cvH * fv1];
        // corrugated-look striping: an industrial hall alternates panel-column
        // brightness, which reads as profiled sheet cladding at zero cost
        const stripeK = plan.use === 'industrial' ? (i % 2 ? 0.85 : 1.03) : 1;
        const put = (y0, y1, u0f, u1f, uv, kM) => {
          if (y1 - y0 < 0.02 || u1f - u0f < 0.01) return;
          const cx2 = px + ux * (u0f + u1f - 1) * pw * 0.5;
          const cz2 = pz + uz * (u0f + u1f - 1) * pw * 0.5;
          const k = ao((y0 + y1) / 2) * stripeK * (kM ?? 1);
          const p = push(out, cx2, (y0 + y1) / 2, cz2, (u1f - u0f) * pw / 2,
            (y1 - y0) / 2, thick / 2, yaw, col, 'ext', false, k * 0.95, k * 1.02);
          p.leaf = 'ext';
          p.uv = uv;
          return p;
        };
        const storefront = fi === 0 && cells.storeC && !isDoor;
        // a storefront is GLASS nearly wall to wall — a shop you cannot see
        // into is a painted shop, which is exactly the complaint this fixes
        const b0 = storefront ? 0.055 : (cells.band?.[0] ?? 0.29);
        const b1 = storefront ? 0.80 : (cells.band?.[1] ?? 0.74);
        const frac = storefront ? 0.86 : (cells.frac ?? 0.54);
        const wy0 = yB + (yT - yB) * b0, wy1 = yB + (yT - yB) * b1;
        // a door bay or a windowless use stays solid
        const solid = isDoor || (!storefront && winChance < 0.35) || (yT - yB) < 2.2;
        if (solid) {
          const fv0 = (yB - fy) / wallH, fv1 = (yT - fy) / wallH;
          put(yB, yT, 0, 1, uvOf(0, 1, fv0, fv1));
          continue;
        }
        const j0 = (1 - frac) / 2, j1 = 1 - j0;
        const fvB = (yB - fy) / wallH, fvT = (yT - fy) / wallH;
        const fw0 = (wy0 - fy) / wallH, fw1 = (wy1 - fy) / wallH;
        put(yB, wy0, 0, 1, uvOf(0, 1, fvB, fw0));            // under the sill
        put(wy1, yT, 0, 1, uvOf(0, 1, fw1, fvT));            // over the lintel
        put(wy0, wy1, 0, j0, uvOf(0, j0, fw0, fw1), surK);   // left jamb
        put(wy0, wy1, j1, 1, uvOf(j1, 1, fw0, fw1), surK);   // right jamb
        // the pane: thin, set into the reveal, and see-through in both
        // directions — this is what lets you look into a lit room from the
        // street without anybody having to fire a rocket at it first
        const gx = px + inx * thick * 0.22, gz = pz + inz * thick * 0.22;
        push(out, gx, (wy0 + wy1) / 2, gz, frac * pw / 2, (wy1 - wy0) / 2, 0.025,
          yaw, 0x9fb4c4, 'glass', true, 0.9, 1.05).leaf = 'ext';
        continue;
      }

      // ---- the INNER lining: plain plaster, plus a pane you can shatter ----
      if (isDoor) {
        push(out, px, (yB + yT) / 2, pz, pw / 2, (yT - yB) / 2, thick / 2,
          yaw, col, leaf, false).leaf = leaf;
        continue;
      }
      const wants = winH > 0.6 && rnd(plan.id, 5000 + fi * 97 + ei * 13 + i) < winChance;
      if (!wants) {
        const k = ao(fy + wallH / 2);
        push(out, px, (yB + yT) / 2, pz, pw / 2, wallH / 2, thick / 2,
          yaw, col, leaf, false, k * 0.94, k * 1.03).leaf = leaf;
        continue;
      }
      const wy0 = fy + sill, wy1 = fy + sill + winH;
      const k0 = ao(fy + sill / 2), k1 = ao((wy1 + yT) / 2);
      push(out, px, (fy + wy0) / 2, pz, pw / 2, (wy0 - fy) / 2, thick / 2,
        yaw, col, leaf, false, k0 * 0.94, k0 * 1.03).leaf = leaf;   // under-sill
      push(out, px, (wy1 + yT) / 2, pz, pw / 2, (yT - wy1) / 2, thick / 2,
        yaw, col, leaf, false, k1 * 0.94, k1 * 1.03).leaf = leaf;   // spandrel
      // the pane, thinner than the wall and set back into the reveal. `leaf`
      // matters: the lining's whole set — walls AND glass — is retired when the
      // outer wall arrives, or every window would end up double glazed.
      push(out, px + inx * thick * 0.18, (wy0 + wy1) / 2, pz + inz * thick * 0.18,
        pw / 2 - 0.09, winH / 2, 0.03, yaw, 0xa8c4d8, 'glass', true, 0.92, 1.1).leaf = leaf;
    }
  }
}

// Roof + parapet. Only ever built in the shell phase, because until something
// tears the building open the chunk mesh's own roof cap is doing the job.
function emitRoof(out, plan) {
  // the facade caps its roof at wall × ROOF_DARKEN; match it, or every damaged
  // building suddenly grows a different-coloured lid
  const wall = wallHexOf(plan);
  emitSlab(out, plan, plan.top, null, plan.tile * 1.6, wall, 'roof', ROOF_DARKEN, false);
  const ring = plan.ring;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  for (let ei = 0; ei < ring.length; ei++) {
    const a = ring[ei], b = ring[(ei + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 0.25) continue;
    const ux = dx / L, uz = dz / L, inx = -sgn * uz, inz = sgn * ux;
    const yaw = Math.atan2(-uz, ux);
    const n = Math.max(1, Math.round(L / (plan.panel * 1.4)));
    const pw = L / n;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * pw;
      // the parapet starts a few centimetres ABOVE the roof deck: sharing the
      // plane with the slab it stands on is a z-fight waiting to happen
      push(out, a[0] + ux * s + inx * 0.16, plan.top + 0.31, a[1] + uz * s + inz * 0.16,
        pw / 2, 0.26, 0.16, yaw, wall, 'ext', false, ROOF_DARKEN * 0.95, ROOF_DARKEN * 1.08);
    }
  }
}

// A stair run: real treads, 175 mm at a time. The player needs no stair code
// at all — the walk controller already steps up anything under 0.55 m, so
// eighteen boxes ARE a staircase, and the same eighteen boxes tumble
// individually when the shaft takes a hit.
function emitStair(out, plan, st, col) {
  const fr = plan.fr, r = st.rect, test = plan._foot;
  const n = st.steps, rise = (st.y1 - st.y0) / n;
  const L = r.u1 - r.u0, go = L / n;
  const across = r.v1 - r.v0;
  for (let i = 0; i < n; i++) {
    const k = st.dir > 0 ? i : n - 1 - i;
    const u = r.u0 + (k + 0.5) * go, v = (r.v0 + r.v1) / 2;
    const top = st.y0 + (i + 1) * rise;
    planToWorld(fr, u, v, _w);
    // A tread only needs clearance for its own DEPTH: placeCore already
    // proved the whole shaft rectangle sits inside the outline, so the width
    // direction is safe by construction. Demanding the full half-diagonal here
    // cost 33 buildings their staircase — the tests caught it.
    if (!test(_w.x, _w.z, go * 0.6)) continue;
    // each tread is a solid block from the floor up to its own nose: a filled
    // stair, like poured concrete, so nobody can fall between the treads
    const h = top - st.y0;
    push(out, _w.x, st.y0 + h / 2, _w.z, go / 2, h / 2, across / 2 - 0.05,
      fr.yaw, col, 'stair', false, 0.88, 1.02);
  }
}

// Railing round a void — atrium edge, stair well. Weak by design: it is the
// first thing a blast throws off a balcony, which is exactly right.
function emitRail(out, plan, r, fy, col) {
  const fr = plan.fr, test = plan._foot;
  const H = 1.05, T = 0.07;
  const edges = [
    [r.u0, r.v0, r.u1, r.v0], [r.u0, r.v1, r.u1, r.v1],
    [r.u0, r.v0, r.u0, r.v1], [r.u1, r.v0, r.u1, r.v1],
  ];
  for (const [u0, v0, u1, v1] of edges) {
    const du = u1 - u0, dv = v1 - v0, L = Math.hypot(du, dv);
    if (L < 0.4) continue;
    const alongU = Math.abs(du) >= Math.abs(dv);
    const yaw = fr.yaw + (alongU ? 0 : Math.PI / 2);
    const n = Math.max(1, Math.round(L / 2.4));
    const pw = L / n;
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) / n;
      planToWorld(fr, u0 + du * c, v0 + dv * c, _w);
      if (!test(_w.x, _w.z, 0.3)) continue;   // railings ring voids, not walls
      push(out, _w.x, fy + H - 0.05, _w.z, pw / 2, 0.05, T / 2, yaw, col, 'rail', true);
      push(out, _w.x, fy + H * 0.5, _w.z, pw / 2, 0.03, T / 2, yaw, col, 'rail', true);
    }
  }
}

// ---- furniture -----------------------------------------------------------
// Boxes, but the RIGHT boxes: a bed is 2.0 × 1.5 × 0.5 and sits against a
// wall, a classroom is a grid of desks facing a board, a supermarket is aisles
// with a checkout row by the door. This is where "there are rooms in there"
// turns into "somebody lives in there".
const P = {
  sofa: [2.05, 0.88, 0.72, 0x6a5e52], bed: [2.0, 1.45, 0.52, 0xb8a690],
  table: [1.15, 0.78, 0.74, 0x8a6a46], desk: [1.35, 0.68, 0.74, 0x9c7a52],
  wardrobe: [1.25, 0.6, 2.0, 0x7d6248], shelf: [1.7, 0.36, 1.85, 0x8a7150],
  counter: [2.6, 0.65, 0.92, 0xb0b4b8], fridge: [0.68, 0.68, 1.82, 0xd8dade],
  tub: [1.7, 0.76, 0.56, 0xe8ecee], sink: [0.58, 0.45, 0.86, 0xe4e8ea],
  tv: [1.15, 0.09, 0.66, 0x22242a], board: [3.2, 0.07, 1.2, 0x2f4a38],
  rack: [3.4, 1.1, 2.6, 0x8a7a5a], crate: [1.2, 1.1, 1.1, 0xa08a62],
  pew: [3.6, 0.55, 0.95, 0x6b4a2e], altar: [2.4, 1.1, 1.1, 0xc9b184],
  bench: [1.9, 0.55, 0.48, 0x8a7c60], planter: [1.5, 1.5, 0.8, 0x6b7a52],
  kiosk: [3.0, 2.2, 2.4, 0xc4c0b4], car: [4.3, 1.85, 1.45, 0x7a4a44],
  locker: [1.6, 0.45, 1.9, 0x4f6b7a], cabinet: [1.0, 0.5, 1.55, 0x8e8a80],
  shelfrow: [0.95, 6.0, 1.9, 0x9a9a94], checkout: [2.4, 0.8, 1.0, 0xbcbcb6],
  bay: [4.8, 0.12, 0.02, 0xd8d4c8],
  // v5.1 — the props that turn a room into a ROOM somebody works in
  monitor: [0.55, 0.13, 0.4, 0x1c1e24],     // on a desk, so it sits on a plinth
  pctower: [0.2, 0.46, 0.44, 0x2a2d33],
  keyboard: [0.44, 0.15, 0.03, 0x3a3d44],
  chair: [0.52, 0.52, 0.92, 0x35383e],
  server: [0.7, 1.0, 2.0, 0x272a30],        // a comms cabinet in the core
  printer: [0.7, 0.6, 0.5, 0xd2d0c8],
  whiteboard: [2.4, 0.06, 1.2, 0xf0f0ec],
  vending: [1.0, 0.75, 1.85, 0xa8302a],
  watercooler: [0.4, 0.4, 1.25, 0x9fd2e0],
  trolley: [1.0, 0.6, 1.0, 0xbfc3c6],       // the trolley bay by the door
  freezer: [2.4, 1.05, 0.95, 0xe2eaee],     // open-top island freezer
  coldwall: [3.2, 0.9, 2.1, 0xc8d6dc],      // the chiller run along a wall
  bakery: [2.6, 1.0, 1.7, 0xc9a469],
  produce: [2.2, 1.1, 0.85, 0x6f9a54],      // fruit and veg bins
  seatrow: [5.6, 0.85, 0.95, 0x6a2028],     // cinema seating
  screen: [9.5, 0.16, 4.2, 0x121316],
  palletstack: [1.2, 1.0, 1.6, 0xa89060],
  forklift: [2.4, 1.2, 2.0, 0xd8a520],
  gurney: [2.0, 0.8, 0.7, 0xdfe6e8],
  reception: [3.4, 0.9, 1.1, 0x7a5c3c],
  plant: [0.7, 0.7, 1.3, 0x4d7a3e],
  fireext: [0.22, 0.22, 0.6, 0xb01e1e],
  // the panelák ground floor: the mailbox bank in the zádveří, and what
  // actually stands in every kočárkárna in the country
  mailbox: [0.42, 0.3, 1.35, 0xb9b39f],
  pram: [0.95, 0.5, 1.0, 0x4f5a6e],
  bike: [1.75, 0.45, 1.05, 0x8a4a3f],
};
// props that sit ON something else rather than on the floor (desk height)
const ON_DESK = { monitor: 0.74, keyboard: 0.74, printer: 0.74 };

// place one prop at a fraction of the room, hugging a wall when `edge` is set
function prop(out, plan, room, fy, name, uf, vf, yawQ, seed, scale) {
  const spec = P[name];
  if (!spec) return;
  const [w, d, h, col] = spec;
  const s = scale ?? 1;
  const u = room.u0 + (room.u1 - room.u0) * uf;
  const v = room.v0 + (room.v1 - room.v0) * vf;
  planToWorld(plan.fr, u, v, _w);
  // a wardrobe placed 10 cm inside the outline used to stand half-way through
  // the facade; furniture keeps its own footprint clear of the wall
  if (!plan._foot(_w.x, _w.z, Math.hypot(w, d) * 0.5 * (scale ?? 1) + 0.1)) return;
  const swap = yawQ === 1;
  const base = ON_DESK[name] ?? 0;      // monitors stand on desks, not on floors
  // PROP_LIFT: a prop's underside would otherwise sit exactly in the plane of
  // the slab it stands on, and the flat ones (painted parking bays are 2 cm
  // thick) shimmered against it across a whole deck.
  push(out, _w.x, fy + base + PROP_LIFT + (h * s) / 2, _w.z,
    (swap ? d : w) * s / 2, (h * s) / 2, (swap ? w : d) * s / 2,
    plan.fr.yaw, col, 'prop', true, 0.86, 1.1);
}

// a desk with a workstation on it — the single most "somebody works here" object
// in the building, and cheap: four small boxes.
function workstation(out, plan, room, fy, uf, vf, yawQ, seed) {
  prop(out, plan, room, fy, 'desk', uf, vf, yawQ, seed);
  prop(out, plan, room, fy, 'monitor', uf, vf, yawQ, seed + 1);
  prop(out, plan, room, fy, 'keyboard', uf + 0.012, vf + 0.012, yawQ, seed + 2);
  prop(out, plan, room, fy, 'pctower', uf - 0.02, vf - 0.02, yawQ, seed + 3);
  prop(out, plan, room, fy, 'chair', uf, vf + 0.05, yawQ, seed + 4);
}

// ---- grocery shelving ------------------------------------------------------
// A supermarket aisle used to be one grey monolith per side, which read as a
// warehouse that had already been looted. A real shelf unit is a base, three
// boards, and STOCK: runs of packaging in the colours every Czech shopper
// knows without reading a label — cans in reds and silver, cereal boxes in
// yellows and blues, bottles in greens and browns, the white block of dairy.
// Each run is its own weak box, so a rocket through the wall throws groceries.
const GOODS_HEX = [
  0xc0392f, 0xa93a30, 0xc7cdd1, 0x9ba2a8,           // cans — reds and silver
  0xd9b23c, 0xe3c85a, 0x3f66a8, 0x577fc0, 0x2f4f8a, // boxes — yellows and blues
  0x4c7a42, 0x5f9350, 0x6e4f30, 0x8a6a3e,           // bottles — greens, browns
  0xefede6, 0xf4f2ea,                               // dairy — white
];
// goods density coarsens with building size exactly the way slab tiles do:
// a corner shop stacks 4–7 runs per board, a hypermarket half that, which is
// what keeps a Kaufland interior inside the piece budget.
const goodsKOf = (plan) => clamp(Math.sqrt(plan.area / 900), 1, 2.6);
function shelfUnit(out, plan, room, fy, uf, vf, alongU, seed, runLen) {
  const fr = plan.fr;
  const u = room.u0 + (room.u1 - room.u0) * uf;
  const v = room.v0 + (room.v1 - room.v0) * vf;
  planToWorld(fr, u, v, _w);
  const hl = runLen / 2;
  if (!plan._foot(_w.x, _w.z, Math.hypot(hl, 0.5) + 0.1)) return;
  const cx = _w.x, cz = _w.z;
  const yaw = fr.yaw + (alongU ? 0 : Math.PI / 2);
  const ax = alongU ? fr.ux : fr.vx, az = alongU ? fr.uz : fr.vz;
  // the unit: a plinth and three boards (the stock hides the missing uprights)
  push(out, cx, fy + PROP_LIFT + 0.16, cz, hl, 0.16, 0.45, yaw, 0x8f9296, 'prop', true, 0.9, 1.02);
  const gk = goodsKOf(plan);
  for (let b = 0; b < 3; b++) {
    const by = fy + 0.62 + b * 0.5;                  // board tops at 0.62/1.12/1.62
    push(out, cx, by - 0.025, cz, hl, 0.025, 0.42, yaw, 0xa5a8ab, 'prop', true, 0.9, 1.02);
    const nRuns = clamp(Math.round((4 + rnd(seed, 900 + b) * 3.99) / gk), 2, 7);
    const slot = runLen / nRuns;
    for (let g = 0; g < nRuns; g++) {
      const gl = clamp(slot * (0.62 + rnd(seed, 910 + b * 17 + g) * 0.33), 0.6, 1.4);
      const gc = -hl + (g + 0.5) * slot;
      const col = GOODS_HEX[(rnd(seed, 950 + b * 29 + g) * GOODS_HEX.length) | 0];
      push(out, cx + ax * gc, by + 0.15, cz + az * gc,
        Math.min(gl, slot * 0.95) / 2, 0.15, 0.36, yaw, col, 'prop', true, 0.9, 1.06)
        .goods = true;
    }
  }
}
// a produce bin: a crate on legs with a lid of fruit — green, red, orange or
// yellow — parked where every Czech supermarket parks them, just inside the door
const FRUIT_HEX = [0x5d9a3f, 0xc03a2e, 0xe07b26, 0xd9c32f];
function produceBin(out, plan, room, fy, uf, vf, seed) {
  const u = room.u0 + (room.u1 - room.u0) * uf;
  const v = room.v0 + (room.v1 - room.v0) * vf;
  planToWorld(plan.fr, u, v, _w);
  if (!plan._foot(_w.x, _w.z, 0.85)) return;
  push(out, _w.x, fy + PROP_LIFT + 0.42, _w.z, 0.55, 0.42, 0.45,
    plan.fr.yaw, 0x9a917e, 'prop', true, 0.88, 1.0);
  const col = FRUIT_HEX[(rnd(seed, 7) * FRUIT_HEX.length) | 0];
  push(out, _w.x, fy + PROP_LIFT + 0.93, _w.z, 0.5, 0.09, 0.4,
    plan.fr.yaw, col, 'prop', true, 0.95, 1.08).goods = true;
}

// a row of identical props along the room's long axis (aisles, pews, racking)
function propRow(out, plan, room, fy, name, count, alongU, seed, inset) {
  const ins = inset ?? 0.12;
  for (let i = 0; i < count; i++) {
    const f = ins + ((i + 0.5) / count) * (1 - ins * 2);
    if (alongU) prop(out, plan, room, fy, name, f, 0.5, 1, seed + i);
    else prop(out, plan, room, fy, name, 0.5, f, 0, seed + i);
  }
}

function furnish(out, plan, floor, room, fi) {
  const fy = floor.y, seed = plan.id * 31 + fi * 7;
  const w = room.u1 - room.u0, d = room.v1 - room.v0;
  if (w < 1.2 || d < 1.2) return;
  const R = (s) => rnd(seed, s + Math.round((room.u0 + room.v0) * 7));
  switch (room.kind) {
    case 'living':
      prop(out, plan, room, fy, 'sofa', 0.22, 0.5, 0, seed);
      prop(out, plan, room, fy, 'table', 0.5, 0.5, 0, seed + 1);
      prop(out, plan, room, fy, 'tv', 0.9, 0.5, 1, seed + 2);
      if (R(3) < 0.7) prop(out, plan, room, fy, 'shelf', 0.5, 0.92, 0, seed + 3);
      break;
    case 'bedroom': case 'hotelroom':
      prop(out, plan, room, fy, 'bed', 0.35, 0.4, 0, seed + 4);
      prop(out, plan, room, fy, 'wardrobe', 0.88, 0.85, 0, seed + 5);
      if (room.kind === 'hotelroom') prop(out, plan, room, fy, 'desk', 0.2, 0.9, 0, seed + 6);
      break;
    case 'kitchen':
      prop(out, plan, room, fy, 'counter', 0.5, 0.12, 0, seed + 7);
      prop(out, plan, room, fy, 'fridge', 0.9, 0.14, 0, seed + 8);
      prop(out, plan, room, fy, 'table', 0.42, 0.68, 0, seed + 9);
      break;
    case 'bath':
      prop(out, plan, room, fy, 'tub', 0.4, 0.2, 0, seed + 10);
      prop(out, plan, room, fy, 'sink', 0.85, 0.8, 0, seed + 11);
      break;
    case 'hall':
      prop(out, plan, room, fy, 'shelf', 0.5, 0.1, 0, seed + 12, 0.7);
      break;
    case 'classroom': {
      const cols = clamp(Math.floor(w / 1.9), 1, 4), rows = clamp(Math.floor(d / 1.7), 1, 4);
      for (let c = 0; c < cols; c++) for (let r2 = 0; r2 < rows; r2++)
        prop(out, plan, room, fy, 'desk', 0.16 + (c + 0.5) / cols * 0.68,
          0.3 + (r2 + 0.5) / rows * 0.6, 0, seed + c * 5 + r2);
      prop(out, plan, room, fy, 'board', 0.5, 0.04, 0, seed + 20);
      prop(out, plan, room, fy, 'desk', 0.5, 0.16, 0, seed + 21, 1.1);
      break;
    }
    case 'ward': {
      const n = clamp(Math.floor(w / 2.4), 1, 4);
      propRow(out, plan, room, fy, 'gurney', n, true, seed + 30, 0.1);
      prop(out, plan, room, fy, 'cabinet', 0.5, 0.9, 0, seed + 33);
      prop(out, plan, room, fy, 'sink', 0.06, 0.9, 0, seed + 34);
      break;
    }
    case 'office': {
      // a grid of workstations, not a scatter of desks: rows facing one way is
      // what an open-plan floor actually looks like from a hole in the wall
      const cols = clamp(Math.floor(w / 2.6), 1, 5), rows = clamp(Math.floor(d / 2.4), 1, 5);
      for (let c = 0; c < cols; c++) for (let r2 = 0; r2 < rows; r2++)
        workstation(out, plan, room, fy, 0.14 + (c + 0.5) / cols * 0.72,
          0.16 + (r2 + 0.5) / rows * 0.68, 0, seed + 40 + c * 11 + r2 * 3);
      prop(out, plan, room, fy, 'cabinet', 0.06, 0.5, 1, seed + 87);
      if (R(88) < 0.5) prop(out, plan, room, fy, 'whiteboard', 0.5, 0.03, 0, seed + 88);
      if (R(89) < 0.4) prop(out, plan, room, fy, 'printer', 0.92, 0.1, 0, seed + 89);
      if (R(90) < 0.35) prop(out, plan, room, fy, 'plant', 0.94, 0.9, 0, seed + 90);
      break;
    }
    case 'vestibule': {                  // the trolley bay just inside the door
      const n = clamp(Math.floor(d / 1.4), 1, 8);
      for (let i = 0; i < n; i++)
        prop(out, plan, room, fy, 'trolley', 0.72, 0.1 + ((i + 0.5) / n) * 0.8, 1, seed + 500 + i,
          1 + R(510 + i) * 0.5);
      if (plan.brand?.bakery) prop(out, plan, room, fy, 'bakery', 0.3, 0.25, 0, seed + 520);
      prop(out, plan, room, fy, 'vending', 0.15, 0.9, 0, seed + 521);
      // the promo island and the first produce bins — the shop starts here
      if (d > 10)
        shelfUnit(out, plan, room, fy, 0.5, 0.5, false, seed + 522, Math.min(6, d * 0.3));
      const nb = clamp(Math.floor(d / 5), 1, 4);
      for (let i = 0; i < nb; i++)
        produceBin(out, plan, room, fy, 0.38, 0.42 + ((i + 0.5) / nb) * 0.45, seed + 525 + i);
      break;
    }
    case 'cinema': {                     // Cinema City under the roof of AFI Palác
      const rows = clamp(Math.floor(d / 1.1), 3, 14);
      for (let i = 0; i < rows; i++)
        prop(out, plan, room, fy, 'seatrow', 0.5, 0.34 + ((i + 0.5) / rows) * 0.6, 0,
          seed + 540 + i, Math.min(1.5, w / 6.2));
      prop(out, plan, room, fy, 'screen', 0.5, 0.04, 0, seed + 570, Math.min(1.4, w / 10));
      break;
    }
    case 'foyer': {
      prop(out, plan, room, fy, 'reception', 0.2, 0.5, 0, seed + 580);
      for (let i = 0; i < 3; i++) {
        prop(out, plan, room, fy, 'bench', 0.35 + R(590 + i) * 0.5, 0.2 + R(600 + i) * 0.6, 0, seed + 590 + i);
        prop(out, plan, room, fy, 'vending', 0.3 + R(610 + i) * 0.5, 0.06, 0, seed + 610 + i);
      }
      break;
    }
    case 'unit': {                       // a mall shop / department store unit
      const n = clamp(Math.floor(d / 2.6), 1, 4);
      propRow(out, plan, room, fy, 'shelf', n, false, seed + 50, 0.16);
      prop(out, plan, room, fy, 'counter', 0.12, 0.5, 1, seed + 55);
      break;
    }
    case 'sales': {
      // Supermarket sales floor, laid out the way the chain really lays it out:
      // the aisle count and till count come from the brand (Kaufland runs a
      // ~4 200 m² hall with eight-plus tills, Lidl six aisles and four, Penny
      // five and three), the chiller run goes along a wall, the island freezers
      // sit in the middle, produce greets you at the door — and Lidl gets its
      // famous non-food middle aisle.
      const br = plan.brand;
      const n = clamp(br?.aisles ?? Math.floor(d / 3.4), 1, 12);
      for (let i = 0; i < n; i++) {
        const vf = 0.16 + ((i + 0.5) / n) * 0.66;
        const segs = clamp(Math.floor(w / 7), 1, 6);
        const mid = br?.middleAisle && i === (n >> 1);
        for (let j = 0; j < segs; j++) {
          const uf = 0.1 + ((j + 0.5) / segs) * 0.8;
          if (mid) prop(out, plan, room, fy, 'crate', uf, vf, 1, seed + 60 + i * 9 + j, 1.6);
          else shelfUnit(out, plan, room, fy, uf, vf, true, seed + 60 + i * 9 + j,
            6 * Math.min(1.4, w / (segs * 7)));
        }
      }
      const tills = clamp(br?.tills ?? Math.floor(w / 4.5), 1, 12);
      for (let i = 0; i < tills; i++)
        prop(out, plan, room, fy, 'checkout', 0.08 + ((i + 0.5) / tills) * 0.84, 0.05, 0, seed + 90 + i);
      // the perimeter: chillers down one flank, freezers in a middle run
      const chill = clamp(Math.floor(w / 4), 1, 7);
      for (let i = 0; i < chill; i++)
        prop(out, plan, room, fy, 'coldwall', 0.1 + ((i + 0.5) / chill) * 0.8, 0.95, 0, seed + 120 + i);
      const froz = clamp(Math.floor(w / 6), 1, 5);
      for (let i = 0; i < froz; i++)
        prop(out, plan, room, fy, 'freezer', 0.12 + ((i + 0.5) / froz) * 0.76, 0.9 - 0.06, 0, seed + 140 + i);
      // produce greets you at the door: crates with fruit-coloured tops
      const bins = clamp(Math.floor(d / 2.6), 2, 8);
      for (let i = 0; i < bins; i++)
        produceBin(out, plan, room, fy, 0.05 + (i % 2) * 0.06,
          0.12 + ((i + 0.5) / bins) * 0.62, seed + 160 + i);
      if (br?.racking) {                 // a hobbymarket is racking, not shelving
        const rr = clamp(Math.floor(d / 5), 1, 5);
        for (let i = 0; i < rr; i++)
          prop(out, plan, room, fy, 'rack', 0.5, 0.2 + ((i + 0.5) / rr) * 0.6, 0, seed + 180 + i,
            Math.min(1.7, w / 10));
      }
      break;
    }
    case 'storage': case 'hall': {
      const n = clamp(Math.floor(d / 5.5), 1, 6);
      for (let i = 0; i < n; i++) {
        const vf = 0.12 + ((i + 0.5) / n) * 0.76;
        const segs = clamp(Math.floor(w / 12), 1, 6);
        for (let j = 0; j < segs; j++)
          prop(out, plan, room, fy, 'rack', 0.1 + ((j + 0.5) / segs) * 0.8, vf, 0, seed + 100 + i * 11 + j,
            Math.min(1.6, w / (segs * 8)));
      }
      for (let i = 0; i < 5; i++)
        prop(out, plan, room, fy, 'crate', R(120 + i), R(130 + i), 0, seed + 120 + i);
      for (let i = 0; i < 4; i++)
        prop(out, plan, room, fy, 'palletstack', 0.1 + R(200 + i) * 0.8, 0.1 + R(210 + i) * 0.8, 0, seed + 200 + i);
      if (R(220) < 0.6) prop(out, plan, room, fy, 'forklift', 0.2 + R(221) * 0.6, 0.5, 1, seed + 221);
      prop(out, plan, room, fy, 'fireext', 0.02, 0.5, 0, seed + 222);
      break;
    }
    case 'deck': {                       // parking: painted bays + a few cars
      const rows = clamp(Math.floor(d / 6), 1, 5);
      for (let r2 = 0; r2 < rows; r2++) {
        const vf = 0.12 + ((r2 + 0.5) / rows) * 0.76;
        const bays = clamp(Math.floor(w / 2.6), 1, 22);
        for (let i = 0; i < bays; i++) {
          const uf = 0.06 + ((i + 0.5) / bays) * 0.88;
          prop(out, plan, room, fy, 'bay', uf, vf, 1, seed + 150 + r2 * 31 + i);
          if (rnd(seed, 200 + r2 * 41 + i) < 0.34)
            prop(out, plan, room, fy, 'car', uf, vf, 1, seed + 250 + r2 * 41 + i);
        }
      }
      break;
    }
    case 'diner': {
      // counter across the back, self-order kiosks by the door, tables in rows
      prop(out, plan, room, fy, 'counter', 0.5, 0.9, 0, seed + 700, Math.min(2.4, w / 4));
      const cols = clamp(Math.floor(w / 2.8), 1, 6), rows = clamp(Math.floor(d / 2.6), 1, 4);
      for (let c = 0; c < cols; c++) for (let r2 = 0; r2 < rows; r2++) {
        const uf = 0.14 + (c + 0.5) / cols * 0.72, vf = 0.14 + (r2 + 0.5) / rows * 0.6;
        prop(out, plan, room, fy, 'table', uf, vf, 0, seed + 710 + c * 7 + r2);
        prop(out, plan, room, fy, 'chair', uf - 0.03, vf, 0, seed + 730 + c * 7 + r2);
        prop(out, plan, room, fy, 'chair', uf + 0.03, vf, 0, seed + 750 + c * 7 + r2);
      }
      for (let i = 0; i < 3; i++)
        prop(out, plan, room, fy, 'vending', 0.2 + i * 0.3, 0.08, 0, seed + 770 + i);
      prop(out, plan, room, fy, 'fridge', 0.9, 0.9, 0, seed + 780);
      break;
    }
    case 'nave': {
      const n = clamp(Math.floor(d / 1.4), 2, 16);
      propRow(out, plan, room, fy, 'pew', n, false, seed + 300, 0.18);
      prop(out, plan, room, fy, 'altar', 0.5, 0.06, 0, seed + 330);
      break;
    }
    case 'garage':
      if (R(340) < 0.55) prop(out, plan, room, fy, 'car', 0.5, 0.5, 0, seed + 341);
      prop(out, plan, room, fy, 'shelf', 0.5, 0.94, 0, seed + 342, 0.8);
      break;
    case 'concourse': {
      const n = clamp(Math.floor(Math.max(w, d) / 9), 1, 5);
      for (let i = 0; i < n; i++) {
        prop(out, plan, room, fy, 'bench', 0.15 + R(350 + i) * 0.7, 0.15 + R(360 + i) * 0.7, R(370 + i) < 0.5 ? 1 : 0, seed + 350 + i);
        prop(out, plan, room, fy, 'planter', 0.15 + R(380 + i) * 0.7, 0.15 + R(390 + i) * 0.7, 0, seed + 380 + i);
      }
      break;
    }
    case 'atrium': {
      prop(out, plan, room, fy, 'planter', 0.5, 0.5, 0, seed + 400, 1.6);
      for (let i = 0; i < 3; i++)
        prop(out, plan, room, fy, 'kiosk', 0.2 + R(410 + i) * 0.6, 0.2 + R(420 + i) * 0.6, 0, seed + 410 + i);
      break;
    }
    case 'corridor': {
      if (plan.use === 'school') {
        const n = clamp(Math.floor(w / 2.4), 1, 14);
        for (let i = 0; i < n; i++)
          prop(out, plan, room, fy, 'locker', 0.05 + ((i + 0.5) / n) * 0.9, 0.06, 0, seed + 430 + i);
      } else if (plan.use === 'office' || plan.use === 'civic') {
        prop(out, plan, room, fy, 'watercooler', 0.12, 0.12, 0, seed + 440);
        prop(out, plan, room, fy, 'vending', 0.5, 0.08, 0, seed + 441);
        prop(out, plan, room, fy, 'server', 0.86, 0.1, 0, seed + 442);
      } else if (plan.use === 'hospital') {
        const n = clamp(Math.floor(w / 5), 1, 6);
        for (let i = 0; i < n; i++)
          prop(out, plan, room, fy, 'gurney', 0.08 + ((i + 0.5) / n) * 0.84, 0.12, 0, seed + 450 + i);
      }
      prop(out, plan, room, fy, 'fireext', 0.02, 0.5, 0, seed + 460);
      break;
    }
    case 'lobby': {
      // the zádveří: a bank of mailboxes along one wall — the first thing
      // every resident sees — and the house noticeboard beside the door
      const alongU2 = w >= d;
      const nm = clamp(Math.floor(Math.max(w, d) / 0.55), 3, 8);
      for (let i = 0; i < nm; i++) {
        const t = 0.16 + ((i + 0.5) / nm) * 0.68;
        if (alongU2) prop(out, plan, room, fy, 'mailbox', t, 0.13, 0, seed + 470 + i);
        else prop(out, plan, room, fy, 'mailbox', 0.13, t, 1, seed + 470 + i);
      }
      prop(out, plan, room, fy, 'whiteboard', alongU2 ? 0.5 : 0.88,
        alongU2 ? 0.88 : 0.5, alongU2 ? 0 : 1, seed + 480, 0.55);   // nástěnka
      break;
    }
    case 'cellar': {                     // one koje of somebody's hoarded life
      prop(out, plan, room, fy, 'shelf', 0.5, 0.82, 0, seed + 490, 0.7);
      if (R(495) < 0.7) prop(out, plan, room, fy, 'crate', 0.32, 0.3, 0, seed + 491, 0.55);
      if (R(496) < 0.4) prop(out, plan, room, fy, 'crate', 0.7, 0.42, 0, seed + 492, 0.45);
      break;
    }
    case 'pram': {                       // kočárkárna: prams and bikes, always
      prop(out, plan, room, fy, 'pram', 0.25, 0.2, 0, seed + 500);
      prop(out, plan, room, fy, 'pram', 0.58, 0.2, 0, seed + 501);
      prop(out, plan, room, fy, 'bike', 0.4, 0.82, 0, seed + 502);
      prop(out, plan, room, fy, 'bike', 0.78, 0.82, 0, seed + 503);
      break;
    }
    default: break;
  }
}

// ---- the two build phases ------------------------------------------------

/**
 * interiorPieces(plan) → piece[]  (floors, ceiling, lining, partitions,
 * stairs, railings, furniture). The chunk mesh keeps drawing the facade.
 */
export function interiorPieces(plan) {
  const out = [];
  out._seed = plan.id;
  _seq = 0;
  plan._foot = footTest(plan);
  const pal = plan.pal;
  // Guard the piece budget by coarsening the slab grid until an estimate of the
  // floor tiles fits. A 200 × 70 m OBB on 1.9 m tiles is 3800 tiles per level;
  // this is what keeps a hypermarket from costing 20 000 boxes.
  let tile = plan.tile;
  const obb = plan.fr.hu * plan.fr.hv * 4;
  const perFloorCap = Math.max(180, Math.floor(plan.pieceBudgetTiles ?? (I.pieceBudget * 0.42) / plan.storeys));
  while ((obb / (tile * tile)) > perFloorCap && tile < 9) tile *= 1.25;
  plan.tileUsed = tile;

  for (let fi = 0; fi < plan.storeys; fi++) {
    const floor = plan.floors[fi];
    // The slab you stand on. Voids: atrium openings and the stair well.
    // GROUND_LIFT: floor 0's slab top would otherwise sit at exactly y = 0,
    // coplanar with the ortofoto ground quad and the terrain plane — two
    // surfaces at the same depth, which is the shimmering "racing" the ground
    // floor of every building showed. Nine centimetres of threshold is below
    // the walk controller's step-up, so it costs the player nothing.
    // The ground floor is a FOUNDATION, not a suspended slab: it reaches from
    // the 30 cm threshold down past the terrain plane, which keeps its
    // underside out of the LAYER_Y ladder as well as its top (the first fix
    // moved the top clear and left the soffit shimmering against the grass at
    // 0.05), and gives the support solver a proper anchor at street level.
    emitSlab(out, plan, floor.y, floor.open,
      tile, pal.floor, 'floor', 1, true, fi === 0 ? GROUND_LIFT + 0.5 : undefined);
    emitPerimeter(out, plan, fi, 'lin');
    for (const w of floor.walls) {
      const isShop = w.kind === 'shopfront';
      emitWall(out, plan, w, floor.y,
        w.kind === 'core' ? I.wallT * 1.5 : isShop ? 0.06 : I.wallT,
        isShop ? 0xa8c4d8 : pal.wall,
        isShop ? 'glass' : 'wall', plan.panel, isShop,
        isShop ? 2.6 : I.doorH);
    }
    if (floor.stair) emitStair(out, plan, floor.stair, pal.trim);
    for (const r of floor.rails) emitRail(out, plan, r, floor.y, pal.trim);
    // the výtah: the plan already carries the shaft walls and the slab holes;
    // what pieces adds is the closed METAL DOOR facing the landing on every
    // floor — thin, trim-coloured, and NOT weak: a lift door is the one thing
    // in a burning panelák that famously refuses to open — plus the cab,
    // parked at ground level behind the ground-floor door.
    if (plan.lift) {
      const ls = plan.lift.shaft;
      const dv = plan.lift.doorOnV1 ? ls.v1 : ls.v0;
      planToWorld(plan.fr, (ls.u0 + ls.u1) / 2, dv, _w);
      if (plan._foot(_w.x, _w.z, 0.3))
        push(out, _w.x, floor.y + I.doorH / 2, _w.z, 0.58, I.doorH / 2, 0.03,
          plan.fr.yaw, pal.trim, 'wall', false, 0.88, 0.96);
      if (fi === 0) {
        planToWorld(plan.fr, (ls.u0 + ls.u1) / 2, (ls.v0 + ls.v1) / 2, _w);
        if (plan._foot(_w.x, _w.z, 0.6))
          push(out, _w.x, floor.y + PROP_LIFT + 1.1, _w.z, 0.75, 1.1, 0.85,
            plan.fr.yaw, 0xb4b8bc, 'prop', true, 0.94, 1.02);
      }
    }
    for (const room of floor.rooms) furnish(out, plan, floor, room, fi);
  }
  // the top floor needs a ceiling of its own — the facade's roof cap is
  // single-sided, so without this you would look up into the sky from indoors
  const topFloor = plan.floors[plan.storeys - 1];
  // the ceiling does NOT subdivide at the boundary: a two-metre inset up there
  // is hidden by the wall head, and subdividing it tripled the piece count of
  // every wide-span building in the city
  emitSlab(out, plan, topFloor.y + plan.sH, topFloor.open, tile * 1.35, pal.ceil, 'ceil', 1, false);
  return out;
}

/**
 * shellPieces(plan) → piece[]  (the outer wall with its window openings, the
 * roof and the parapet). Built the first time a building takes damage, at
 * which point city.js stops drawing that building in the chunk mesh.
 */
// ---- v7 use-class facade extras -------------------------------------------
// The pieces that hang OFF the shell rather than being part of its wall grid:
// canopies, the restaurant's roof-edge overhang, the industrial sectional door
// and its dock bumpers, panelák balconies, and the cheap trims (cornice,
// plinth) that keep two identical footprints from wearing an identical face.
// All deterministic from plan.id; all clear of the LAYER_Y ladder (the lowest
// horizontal face here is a plinth bottom at groundLift = 0.30, four
// centimetres above the 0.26 marking plane the coplanarity test guards).

// an edge of the footprint ring with its outward frame, shared by everything
function edgeFrame(ring, sgn, i) {
  const a = ring[i], b = ring[(i + 1) % ring.length];
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  return { a, L, ux, uz, ox: sgn * uz, oz: -sgn * ux, yaw: Math.atan2(-uz, ux) };
}

// Panelák balconies: a grid of protruding slabs + side cheeks + a weak rail
// panel on the two longest facades, every storey above the first, 2–3 bays
// apart. The slab top sits 2 cm under the room floor so the two never share a
// plane; the rail is `weak` — the first thing a blast throws off, exactly
// like the atrium railings.
function emitBalconies(out, plan) {
  const ring = plan.ring, sgn = polygonArea(ring) > 0 ? 1 : -1;
  const wall = wallHexOf(plan), id = plan.id;
  const railC = RAIL_CS[Math.floor(rnd(id, 87) * RAIL_CS.length) % RAIL_CS.length];
  const D = 1.35, W = 2.4;                       // balcony depth and width
  const byLen = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    byLen.push({ i, L: Math.hypot(bx - ax, bz - az) });
  }
  byLen.sort((p, q) => q.L - p.L);
  for (const ed of byLen.slice(0, 2)) {          // the long facades only
    if (ed.L < 9) continue;
    const e = edgeFrame(ring, sgn, ed.i);
    const step = 2.7 * (rnd(id, 88 + ed.i) < 0.5 ? 2 : 3);   // 2–3 atlas bays
    const cnt = Math.floor((ed.L - 2.2) / step);
    if (cnt < 1) continue;
    const margin = (ed.L - (cnt - 1) * step) / 2;
    for (let fi = 1; fi < plan.storeys; fi++) {
      const by = plan.floors[fi].y;
      for (let k = 0; k < cnt; k++) {
        const s = margin + k * step;
        const bx = e.a[0] + e.ux * s, bz = e.a[1] + e.uz * s;
        push(out, bx + e.ox * (D / 2 + 0.03), by - 0.11, bz + e.oz * (D / 2 + 0.03),
          W / 2, 0.09, D / 2, e.yaw, wall, 'ext', false, 0.88, 0.98).balcony = true;
        for (const sd of [-1, 1])                // side cheeks
          push(out, bx + e.ux * sd * (W / 2 - 0.06) + e.ox * (D / 2 + 0.03),
            by + 0.5, bz + e.uz * sd * (W / 2 - 0.06) + e.oz * (D / 2 + 0.03),
            0.06, 0.52, D / 2 - 0.03, e.yaw, wall, 'ext', false, 0.86, 0.95)
            .balcony = true;
        push(out, bx + e.ox * (D - 0.05), by + 0.53, bz + e.oz * (D - 0.05),
          W / 2, 0.5, 0.035, e.yaw, railC, 'rail', true, 0.92, 1.04).balcony = true;
      }
    }
  }
}

function emitFacadeExtras(out, plan) {
  const use = plan.use, ent = plan.entrance, ring = plan.ring, id = plan.id;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const wall = wallHexOf(plan);
  const fy = plan.floors[0].y;

  if (use === 'restaurant' && ent) {
    const clad = plan.brand?.clad ?? 0x45423e;
    const e = edgeFrame(ring, sgn, ent.i);
    // the low canopy over the entrance run — the pavilion's brow
    push(out, ent.x + ent.nx * 0.95, fy + 2.75, ent.z + ent.nz * 0.95,
      Math.min(ent.w / 2 + 1.6, e.L * 0.45), 0.07, 0.95, e.yaw, clad,
      'ext', false, 0.96, 1.03);
    // and a slight flat-roof overhang along the three glazed edges
    for (const i of [ent.i, (ent.i + 1) % ring.length,
      (ent.i + ring.length - 1) % ring.length]) {
      const g = edgeFrame(ring, sgn, i);
      if (g.L < 2.5) continue;
      const n = Math.max(1, Math.ceil((g.L * 0.92) / 6));
      const pw = (g.L * 0.92) / n;
      for (let k = 0; k < n; k++) {
        const s = g.L * 0.04 + (k + 0.5) * pw;
        push(out, g.a[0] + g.ux * s + g.ox * 0.18, plan.top + 0.08,
          g.a[1] + g.uz * s + g.oz * 0.18, pw / 2, 0.11, 0.34, g.yaw, clad,
          'ext', false, 0.94, 1.0);
      }
    }
  }

  if (use === 'mall' && ent) {
    // the wide canopy over the glazed portal, kept above the door head even
    // when a squat mall runs minimum-height storeys
    const e = edgeFrame(ring, sgn, ent.i);
    const cy = fy + Math.max(2.62, Math.min(plan.sH - 0.15, 3.9));
    push(out, ent.x + ent.nx * 1.25, cy, ent.z + ent.nz * 1.25,
      clamp(e.L * 0.24, 2.5, 7), 0.09, 1.3, e.yaw, wall, 'ext', false, 0.8, 0.88);
  }

  if (use === 'industrial' && ent) {
    // a 4 × 4 m sectional door beside the person door, plus dock bumpers —
    // the two things that say "trucks back up to this wall"
    const e = edgeFrame(ring, sgn, ent.i);
    const doorW = 4, doorH = Math.min(4, plan.usable - 0.5);
    if (doorH > 2.2 && e.L > doorW + ent.w + 4) {
      let s = clamp(e.L * (ent.t <= 0.5 ? 0.75 : 0.25),
        doorW / 2 + 1, e.L - doorW / 2 - 1);
      if (Math.abs(s - e.L * ent.t) < (doorW + ent.w) / 2 + 0.5)
        s = clamp(e.L * ent.t + (s > e.L * ent.t ? 1 : -1) * ((doorW + ent.w) / 2 + 1),
          doorW / 2 + 1, e.L - doorW / 2 - 1);
      const dx2 = e.a[0] + e.ux * s, dz2 = e.a[1] + e.uz * s;
      push(out, dx2 + e.ox * 0.06, fy + doorH / 2, dz2 + e.oz * 0.06,
        doorW / 2, doorH / 2, 0.1, e.yaw, 0x55595e, 'ext', false, 0.92, 1.0);
      for (const c of [-1.55, 1.55])
        push(out, dx2 + e.ux * c + e.ox * 0.14, fy + 0.5, dz2 + e.uz * c + e.oz * 0.14,
          0.28, 0.18, 0.1, e.yaw, 0x2e2f33, 'prop', true, 0.9, 1.0);
    }
  }

  // panelák balconies: the prefab type, or anything six storeys and up
  if (use === 'flats' && !plan.nova && plan.storeys >= 2
      && (plan.osmT === 'panel' || plan.storeys >= 6)) emitBalconies(out, plan);

  // hash-picked trims for the generic housing stock: a cornice strip under the
  // parapet and a darker plinth band at the ground — small, cheap, and enough
  // that two identical footprints stop wearing an identical face. Novostavby
  // always take the cornice (their flat-roof trim line).
  if (use === 'house' || use === 'flats') {
    const cornice = plan.nova || rnd(id, 81) < 0.45;
    const plinth = !plan.nova && rnd(id, 82) < 0.5;
    if (!cornice && !plinth) return;
    for (let i = 0; i < ring.length; i++) {
      const g = edgeFrame(ring, sgn, i);
      if (g.L < 2) continue;
      const n = Math.max(1, Math.ceil(g.L / 6));
      const pw = g.L / n;
      for (let k = 0; k < n; k++) {
        const s = (k + 0.5) * pw;
        const x = g.a[0] + g.ux * s, z = g.a[1] + g.uz * s;
        if (cornice)
          push(out, x + g.ox * 0.10, plan.top - 0.16, z + g.oz * 0.10,
            pw / 2, 0.11, 0.09, g.yaw, wall, 'ext', false, 1.05, 1.12);
        // the plinth may not bar the front door: an 0.8 m band across the
        // opening would out-climb the walk controller's 0.55 m step-up
        if (plinth && !(ent && i === ent.i
            && Math.abs(s - g.L * ent.t) < ent.w / 2 + pw / 2))
          push(out, x + g.ox * 0.045, fy + 0.42, z + g.oz * 0.045,
            pw / 2, 0.40, 0.05, g.yaw, wall, 'ext', false, 0.7, 0.78);
      }
    }
  }
}

// ---- branding -------------------------------------------------------------
// The chain's colours have to live on the SHELL, not on the chunk facade: the
// facade stands down the moment a building is activated, so a fascia painted
// there vanished exactly when you got close enough to read it. Here it stays.
//
// Two pieces of signage, both from boxes, both `kind: 'sign'` so they render
// through an unlit full-bright material (backlit plastic does not take shading):
//   · the FASCIA — a band of brand colour under the parapet of the two longest
//     street frontages, which is what every retail shed in the country wears;
//   · the TOTEM — the pole by the road with the logo on it, which is the thing
//     you actually navigate by. The logo is built from axis-aligned boxes, so
//     the golden arches are two rounded humps (leg-top-leg × 2), which is what
//     they read as from a car anyway.
// Every fascia piece and the totem panel carry the WORDMARK CONTRACT:
// `signText` (the brand label), `signBg` (the fascia colour) and `signFg`
// (white, except the brands that print dark on a light ground — Billa).
// destructible.js renders those faces with a generated wordmark texture, so
// the pieces here stay long boxes — one word reads better on one box than on
// four — split only at 12 m so a rocket can still take the sign apart.
const SIGN = 'sign';
function brandSigns(out, plan) {
  const brand = plan.brand;
  if (!brand?.sign) return;
  const ring = plan.ring, fr = plan.fr;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const label = brand.label ?? '';
  // Ink rule COPIED from meshes.js's far-LOD wordmark — trim colour when the
  // chain defines one, else white, except dark type on a light fascia. The two
  // tiers computing this differently is exactly how a McDonald's ended up
  // red-on-yellow from the road and white-on-yellow up close.
  const lum = 0.299 * (brand.sign >> 16 & 255) + 0.587 * (brand.sign >> 8 & 255)
    + 0.114 * (brand.sign & 255);
  const fg = brand.fg ?? brand.trim ?? (lum > 150 ? 0x23201a : 0xffffff);
  const stamp = (p) => { p.signText = label; p.signBg = brand.sign; p.signFg = fg; return p; };
  // Which edges wear the fascia: the ENTRANCE edge first — the sign belongs
  // over the doors, facing the car park, which is where a shopper actually
  // looks — then the longest remaining edge for the flank. Two longest alone
  // put both Kaufland bands on the service side when the footprint ran
  // deeper than it was wide. (meshes.js's far LOD uses this same rule —
  // change one, change both.)
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    edges.push({ i, L: Math.hypot(bx - ax, bz - az) });
  }
  edges.sort((a, b) => b.L - a.L);
  const entI = plan.entrance?.i;
  if (entI !== undefined) {
    const k = edges.findIndex((e) => e.i === entI);
    if (k > 0 && edges[k].L >= 8) edges.unshift(edges.splice(k, 1)[0]);
  }

  // ---- fascia band ----
  const H = clamp((plan.top - plan.y0) * 0.22, 0.7, 1.6);
  const bandY = plan.top - H / 2 - 0.4;
  for (const e of edges.slice(0, 2)) {
    if (e.L < 8) continue;
    const [ax, az] = ring[e.i], [bx, bz] = ring[(e.i + 1) % ring.length];
    const ux = (bx - ax) / e.L, uz = (bz - az) / e.L;
    const nx = sgn * uz, nz = -sgn * ux;
    const yaw = Math.atan2(-uz, ux);
    const run = e.L * 0.88, n = Math.max(1, Math.ceil(run / 12));
    const pw = run / n;
    // The wordmark goes on ONE piece — the one at the middle of the run — and
    // the rest of the band stays plain fascia colour. The far LOD paints the
    // name once, centred; a name repeated and stretched on every 12 m segment
    // is what made a long Kaufland front morph at the tier swap.
    const mid = (n - 1) >> 1;
    for (let k = 0; k < n; k++) {
      const s = e.L * 0.06 + (k + 0.5) * pw;
      const p = push(out, ax + ux * s + nx * 0.12, bandY, az + uz * s + nz * 0.12,
        pw / 2, H / 2, 0.12, yaw, brand.sign, SIGN, false, 1, 1);
      if (k === mid) stamp(p);
    }
  }

  // ---- totem by the entrance ----
  const ent = plan.entrance;
  if (!ent) return;
  const px = ent.x + ent.nx * 5.5, pz = ent.z + ent.nz * 5.5;
  if (Math.hypot(px - fr.cx, pz - fr.cz) < 2) return;
  const yaw = Math.atan2(-(-ent.nz), -ent.nx) + Math.PI / 2;  // face the street
  // The totem stands clear of its own building — that is the whole point of a
  // totem — but not absurdly: a metre and a half over the parapet, or 5 m over
  // a single-storey drive-through, whichever is taller.
  const base = plan.y0;
  const panelY = Math.max(base + 5.4, plan.top + 1.5);
  const PW = 2.3, PH = 2.6;
  push(out, px, base + (panelY - PH / 2 - base) / 2, pz, 0.22,
    (panelY - PH / 2 - base) / 2, 0.22, yaw, 0x4a4d52, 'ext', false, 0.9, 1);
  stamp(push(out, px, panelY, pz, PW, PH / 2, 0.16, yaw, brand.sign, SIGN, false, 1, 1));
  // the fast-food glyphs, in the brand's second colour, 4 cm proud of the
  // panel — a wordmark can't draw the golden arches. Everyone else's panel is
  // left flat: the stamped signText already puts the name on it.
  const fx = Math.cos(yaw + Math.PI / 2), fz = -Math.sin(yaw + Math.PI / 2);
  const glyph = brand.trim ?? 0xffffff;
  const put = (offU, offY, hu, hy) =>
    push(out, px + Math.cos(yaw) * offU + fx * 0.2, panelY + offY,
      pz - Math.sin(yaw) * offU + fz * 0.2,
      hu, hy, 0.06, yaw, glyph, SIGN, false, 1, 1);
  if (/mcdonald/i.test(brand.label ?? '')) {
    // two arches: leg — top — leg, twice
    for (const c of [-0.72, 0.72]) {
      put(c - 0.44, -0.35, 0.16, 0.85);
      put(c + 0.44, -0.35, 0.16, 0.85);
      put(c, 0.62, 0.6, 0.18);
    }
  } else if (/kfc/i.test(brand.label ?? '')) {
    put(0, 0.75, 1.7, 0.2);                              // the white stripe…
    for (const c of [-0.85, 0, 0.85]) put(c, -0.25, 0.32, 0.72);   // …and K F C
  }
}

export function shellPieces(plan) {
  const out = [];
  out._seed = plan.id ^ 0x5bf03;
  _seq = 1_000_000;
  plan._foot ??= footTest(plan);
  for (let fi = 0; fi < plan.storeys; fi++) emitPerimeter(out, plan, fi, 'ext');
  // a single-storey hall's wall stops at usable height; anything above that
  // (a tall gable, a parapet) is roof work
  emitRoof(out, plan);
  emitFacadeExtras(out, plan);
  brandSigns(out, plan);
  return out;
}
