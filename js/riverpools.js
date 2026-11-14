// The Vltava through Prague is not a sloping river, it is a STAIRCASE of flat
// pools, each held up by a weir: Šítkovský (by Mánes), Staroměstský (beside
// Charles Bridge), Helmovský (at the tip of Štvanice) and Trojský (Troja).
// The generic water level in meshes.js is a soft minimum of the ground along
// the outline, which is right for the Labe and for ponds, but over the Vltava
// it tilted the surface by up to 5 m across the channel (the Old Town bank is
// traced on the quay wall top) and smeared the weirs into ramps hundreds of
// metres long. So for the bodies listed here the level is authored instead:
// one flat number per pool, a short ramp across each weir line.
//
// WORKER SAFE: imported by meshes.js, which runs inside js/meshworker.js. Pure
// data and arithmetic: no DOM, no clock, no randomness, and no dependence on
// which tiles are loaded. A body is recognised by a STABLE KEY taken from its
// own geometry (first outer vertex, rounded, and its outer vertex count), so
// the main thread and every worker reach the same answer for the same point.
//
// Coordinates: x east, z south (metres from the Pardubice origin). Levels are
// metres above sea level (Bpv), derived from ČÚZK DMR 5G (the LiDAR reads the
// water surface): outline ground p2 minus 0.3 per pool, which keeps 98 % of the
// bank dry. Real pool elevations (Povodí Vltavy) were not available.

// pool levels, upstream to downstream
export const POOLS = {
  A: 187.1,   // above Šítkovský jez: Vyšehrad, Výtoň, Rašínovo nábřeží
  B: 185.4,   // Šítkovský to Staroměstský: Střelecký ostrov, Most Legií, Národní divadlo
  C: 184.5,   // Staroměstský to Helmovský: Karlův most, Mánesův most, Čechův most, Štvanice S arm
  D: 180.3,   // Helmovský to Trojský: Štvanice N arm, Holešovice, Libeň
};

// Each weir is a CUT LINE across the whole channel, bank to bank, passing
// through the islands it meets (land, so the line may wander inside them).
// `cut` is the part that matters; `loop` closes it into a big polygon around
// everything DOWNSTREAM of the weir. The loops are nested (each contains all
// the ones below it), so a point's pool is found by asking the innermost first.
// Lines were placed on the DMR in-channel steps and the locks that bypass each
// weir (scratch survey weirmap.mjs): Smíchov lock z -5285, Staroměstský raft
// pass at (-96382, -5878), Štvanice lock x -94460, the Troja step at x -95215.
const WEIR_DEFS = [
  {
    name: 'Šítkovský jez', up: 'A', down: 'B',
    // Smíchov bank through the lock canal, Dětský ostrov, the diagonal weir
    // to Slovanský ostrov, down the island and across the arm under Mánes
    cut: [[-96620, -5290], [-96520, -5270], [-96470, -5232], [-96250, -5160],
      [-96215, -5030], [-96100, -5030]],
    // the crest proper (open water, no island): only these get a stone strip
    crest: [[1, 2], [2, 3], [4, 5]],
    loop: [[-90000, -5030], [-90000, -13000], [-99000, -13000], [-99000, -5290]],
  },
  {
    name: 'Staroměstský jez', up: 'B', down: 'C',
    // Novotného lávka (Old Town mills) diagonally upstream to Kampa, kinked
    // at the raft pass whose walls are the two slim islands of the outline
    cut: [[-96150, -5985], [-96243, -5963], [-96382, -5893], [-96530, -5872], [-96620, -5872]],
    crest: [[1, 2], [2, 3]],
    loop: [[-99000, -5872], [-99000, -13000], [-90000, -13000], [-90000, -5985]],
  },
  {
    name: 'Helmovský jez', up: 'C', down: 'D',
    // Holešovice bank to the west tip of Štvanice, through the island, and
    // across the south arm at the Štvanice lock (the DMR drop at x -94460)
    cut: [[-95060, -7250], [-95015, -7130], [-94975, -7040], [-94884, -6965], [-94800, -7015],
      [-94600, -7060], [-94460, -7080], [-94460, -6850]],
    crest: [[1, 2], [2, 3]],
    loop: [[-90000, -6850], [-90000, -13000], [-99000, -13000], [-99000, -7250]],
  },
  {
    // below Troja the river is handed back to the generic level field: the
    // DMR there falls 2 m over 2 km and no pool can be read from it
    name: 'Trojský jez', up: 'D', down: null,
    cut: [[-95240, -9300], [-95212, -9080], [-95200, -8860], [-95200, -8600]],
    crest: [[1, 2]],
    loop: [[-99000, -8600], [-99000, -13000], [-95240, -13000]],
  },
];

// half-width of the ramp across a weir line: the water surface is tessellated
// at 8 m, so a 7 m ramp is the shortest that still reads as a sloping face
export const WEIR_HALF = 3.5;

export const WEIRS = WEIR_DEFS.map((w) => {
  const ring = [...w.cut, ...w.loop];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { ...w, ring, bb: [x0, z0, x1, z1],
    upY: POOLS[w.up], downY: w.down ? POOLS[w.down] : null };
});

// The pooled bodies, keyed on their shipped geometry. If the tiles are ever
// rebuilt and a key stops matching, the body silently falls back to the
// generic level (the old look), never to a wrong pool.
const BODIES = [
  { x: -93221.3, z: -8853.8, n: 632, kind: 'main' },     // tile -20_-2 water[42], 28 islands
  { x: -96347.8, z: -2261.9, n: 94, kind: 'south' },     // tile -21_-1 water[32], above Vyšehrad
  { x: -96648.1, z: -5792.4, n: 56, kind: 'certovka' },  // tile -21_-2 water[42]
];
// Čertovka branches off pool B at the south end of Kampa and rejoins pool C
// below Charles Bridge; its level runs linearly between the two mouths
// (projected on the chord, which the channel never doubles back along).
const CERT_S = [-96621, -5618], CERT_N = [-96302, -6215];

function bodyOf(f) {
  if (f._rp !== undefined) return f._rp;
  let kind = null;
  const p = f.o?.[0];
  if (p) for (const b of BODIES) {
    if (f.o.length === b.n && Math.abs(p[0] - b.x) < 0.06 && Math.abs(p[1] - b.z) < 0.06) { kind = b.kind; break; }
  }
  f._rp = kind;
  return kind;
}

function pip(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const zi = poly[i][1], zj = poly[j][1];
    if ((zi > z) !== (zj > z)
      && x < (poly[j][0] - poly[i][0]) * (z - zi) / (zj - zi) + poly[i][0]) c = !c;
  }
  return c;
}

function inLoop(w, x, z) {
  const b = w.bb;
  if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) return false;
  return pip(x, z, w.ring);
}

/** Distance from (x, z) to a weir's cut line. */
export function weirDist(w, x, z) {
  let best = Infinity;
  const c = w.cut;
  for (let i = 0; i < c.length - 1; i++) {
    const ax = c[i][0], az = c[i][1], ex = c[i + 1][0] - ax, ez = c[i + 1][1] - az;
    const L2 = ex * ex + ez * ez;
    let u = ((x - ax) * ex + (z - az) * ez) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - ex * u, dz = z - az - ez * u, d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The main body's pool at a point, without the weir ramps: the index of the
 *  innermost weir loop containing it (-1 above every weir). */
function weirIndex(x, z) {
  for (let k = WEIRS.length - 1; k >= 0; k--) if (inLoop(WEIRS[k], x, z)) return k;
  return -1;
}

/**
 * The authored water level of body `f` at (x, z), or null when `f` is not a
 * pooled body (or the point lies below the last weir), in which case the
 * caller uses its generic level. Pure in the feature's key and the point.
 */
export function riverLevelAt(f, x, z) {
  const kind = bodyOf(f);
  if (!kind) return null;
  if (kind === 'south') return POOLS.A;
  if (kind === 'certovka') {
    const ex = CERT_N[0] - CERT_S[0], ez = CERT_N[1] - CERT_S[1];
    const t = ((x - CERT_S[0]) * ex + (z - CERT_S[1]) * ez) / (ex * ex + ez * ez);
    return POOLS.B + (POOLS.C - POOLS.B) * (t < 0 ? 0 : t > 1 ? 1 : t);
  }
  return poolLevelAt(x, z);
}

/**
 * The main Vltava body's authored level at (x, z), null below Troja. A pure
 * function of the point (js/riverbed.js lowers the bed under it).
 */
export function poolLevelAt(x, z) {
  const k = weirIndex(x, z);
  let y = k < 0 ? POOLS.A : WEIRS[k].downY;
  // a ramp across the nearest weir line: within WEIR_HALF of it the level
  // runs smoothly from the pool above to the pool below
  const kk = k < 0 ? 0 : k;
  for (let j = Math.max(0, kk - 1); j <= Math.min(WEIRS.length - 1, kk + 1); j++) {
    const w = WEIRS[j];
    const d = weirDist(w, x, z);
    if (d >= WEIR_HALF) continue;
    if (w.downY === null) return null;     // the Troja face belongs to the generic field
    const below = k >= j;                  // this point lies downstream of weir j
    const t = below ? 0.5 - 0.5 * d / WEIR_HALF : 0.5 + 0.5 * d / WEIR_HALF;
    return w.downY + (w.upY - w.downY) * smooth(t);
  }
  return y;
}

/** True when `f` is one of the pooled Prague bodies. */
export function isPooled(f) { return !!bodyOf(f); }

// ---- which way the water goes -------------------------------------------------
// The water shader drifts its ripples downstream, which is most of what makes a
// surface read as a river rather than a lake. There is no Vltava centreline in
// the tiles between Vyšehrad and Štvanice, so this one is authored: channel
// midpoints sampled from the shipped outline every 250 to 300 m, upstream to
// downstream (Vyšehrad, Národní divadlo, Karlův most, Letná, Štvanice, Libeň,
// Troja).
const CENTRE = [
  [-96220, -3700], [-96227, -4050], [-96257, -4300], [-96290, -4550], [-96327, -4800],
  [-96345, -5050], [-96370, -5300], [-96390, -5550], [-96370, -5800], [-96335, -6050],
  [-96275, -6300], [-96190, -6550], [-96050, -6750], [-95700, -6900], [-95450, -6937],
  [-95200, -6967], [-94950, -7007], [-94700, -7075], [-94450, -7135], [-94200, -7187],
  [-93950, -7222], [-93700, -7305], [-93450, -7410], [-93200, -7527], [-92950, -7750],
  [-92800, -8050], [-92720, -8400], [-92850, -8700], [-93100, -8880], [-93600, -9052],
  [-93900, -9087], [-94200, -9055], [-94500, -8985], [-94800, -8910], [-95100, -8917],
  [-95400, -8967], [-95700, -9132], [-96000, -9195], [-96300, -9142], [-96600, -9107],
  [-96900, -9177], [-97200, -9457], [-97500, -10027],
];
// m: how far downstream of a weir crest the white water reaches
export const FOAM_LEN = 14;

/**
 * Downstream unit direction and foam (0..1) of body `f` at (x, z) into `out`
 * ({ fx, fz, foam }). Bodies that are not pooled get no flow and no foam.
 */
export function riverFlowAt(f, x, z, out) {
  out.fx = 0; out.fz = 0; out.foam = 0;
  const kind = bodyOf(f);
  if (!kind) return out;
  if (kind === 'south') { out.fz = -1; return out; }
  if (kind === 'certovka') {
    const ex = CERT_N[0] - CERT_S[0], ez = CERT_N[1] - CERT_S[1], L = Math.hypot(ex, ez);
    out.fx = ex / L; out.fz = ez / L;
    return out;
  }
  let best = Infinity;
  for (let i = 0; i < CENTRE.length - 1; i++) {
    const ax = CENTRE[i][0], az = CENTRE[i][1], ex = CENTRE[i + 1][0] - ax, ez = CENTRE[i + 1][1] - az;
    const L2 = ex * ex + ez * ez;
    let u = ((x - ax) * ex + (z - az) * ez) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - ex * u, dz = z - az - ez * u, d = dx * dx + dz * dz;
    if (d < best) { best = d; const L = Math.sqrt(L2); out.fx = ex / L; out.fz = ez / L; }
  }
  out.foam = foamAt(x, z);
  return out;
}

/** White water just below a weir crest: 1 at the foot, fading out by FOAM_LEN. */
export function foamAt(x, z) {
  const k = weirIndex(x, z);
  if (k < 0) return 0;
  const w = WEIRS[k];
  if (w.downY === null) return 0;
  const d = crestDist(w, x, z);
  if (d > FOAM_LEN + WEIR_HALF) return 0;
  const t = (d - WEIR_HALF) / FOAM_LEN;
  return t <= 0 ? 1 : 1 - smooth(t);
}

/** Distance from (x, z) to a weir's crest (open-water part of its cut line). */
export function crestDist(w, x, z) {
  let best = Infinity;
  for (const [i, j] of w.crest) {
    const ax = w.cut[i][0], az = w.cut[i][1], ex = w.cut[j][0] - ax, ez = w.cut[j][1] - az;
    const L2 = ex * ex + ez * ez;
    let u = ((x - ax) * ex + (z - az) * ez) / L2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - ax - ex * u, dz = z - az - ez * u, d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ---- streams that run underground ---------------------------------------------
// The tiles keep a waterway's line and width but not its tunnel=culvert tag
// (scripts/build-region.mjs processWaterLines; fixing it needs a rebuild), so
// these culverted and tunnelled streams were cut through Malá Strana and
// Vyšehrad as open trenches: Brusnice under the castle, the Čertovka tunnel,
// the Botič under Nusle and Vyšehrad. Keyed on the first vertex (rounded).
const CULVERTS = [
  [-96729, -6791], [-96565, -5222], [-96175, -6050], [-96581, -6170], [-96342, -6442],
  [-95532, -3749], [-94112, -3915], [-95491, -3763], [-93665, -4035],
];
/** True for a shipped waterway that really runs in a culvert or tunnel. */
export function isCulvert(f) {
  const p = f.p?.[0];
  if (!p) return false;
  for (const c of CULVERTS) if (Math.abs(p[0] - c[0]) < 1.5 && Math.abs(p[1] - c[1]) < 1.5) return true;
  return false;
}
