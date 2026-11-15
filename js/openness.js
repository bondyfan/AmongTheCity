// ---- openness.js: how far the eye can see from here (round 8, HORIZON) ----
// MAIN THREAD, no DOM, no three: a number from the city's chunk index.
//
// The fog wall sat at 422 m (medium, day) everywhere, because everywhere the
// streamed world ended at 480 m: right in a street, a white sheet over the
// open D11, and over the Vltava it took the far bank. How far the wall may go
// depends on what stands round the eye, so this measures it: SIGHT lines in
// DIRS directions, each walked out until a house (or a stand of trees) stands
// within BLOCK m of it, or to REACH. How far each one got past FREE0, as a
// share of the rest of the reach, averaged, shaped and eased over a few
// seconds, is the OPENNESS: 0 in a street (the fog is then exactly what it
// always was), about a half on a Prague embankment (the far bank stops the
// lines across the river at 250 m, the ones along it run free), 1 on the open
// motorway. js/main.js turns it into rings and fog.
//
// THE VLTAVA. On a Prague embankment the eye stands against a wall of houses
// and under an alley of trees, and the lines that matter run over the water to
// the far bank 250 to 400 m off. So where a `water` test is given (main.js:
// in Prague, js/riverpools.js's pools over the lowered bed), a sample over the
// river blocks nothing (a moored boat is not a view), and the share of
// samples that lay over water counts as openness too, twice over: half the
// lines over the river is a view worth the wider window and the farther wall.
//
// Per viewer, not shared: it moves only what this screen draws. Measured once
// a second (16 x 8 samples, a cell lookup and a few dozen distance tests each).

const DIRS = 16, STEP = 30, REACH = 360, FREE0 = 80, BLOCK = 40, TREE = 22, TREES = 4;
const LO = 0.3, HI = 0.8;            // open share -> openness (Pardubice station: 0.23)
const EASE_S = 2.5;                  // seconds to come most of the way
const CHUNK = 120;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** What the last sightShare saw: the share of its samples that lay over water. */
export const SIGHT = { water: 0 };

/** The open share of the sight lines from (x, z), 0..1, or -1 where nothing is indexed yet. */
export function sightShare(chunkIndex, x, z, water = null) {
  SIGHT.water = 0;
  if (!chunkIndex.get(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK))) return -1;
  let open = 0, wet = 0, samples = 0;
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    let blocked = false, free = REACH;
    for (let s = STEP; s <= REACH && !blocked; s += STEP) {
      free = s;
      const px = x + ux * s, pz = z + uz * s;
      samples++;
      if (water && water(px, pz)) { wet++; continue; }
      const cell = chunkIndex.get(Math.floor(px / CHUNK) + ',' + Math.floor(pz / CHUNK));
      if (!cell) continue;               // not indexed yet: nothing known to stand there
      for (const b of cell.buildings) {
        const q = b.o?.[0];
        if (q && (q[0] - px) * (q[0] - px) + (q[1] - pz) * (q[1] - pz) < BLOCK * BLOCK) { blocked = true; break; }
      }
      if (blocked) break;
      let n = 0;
      for (const t of cell.trees) {
        const q = t.p[0];
        if ((q[0] - px) * (q[0] - px) + (q[1] - pz) * (q[1] - pz) < TREE * TREE && ++n >= TREES) { blocked = true; break; }
      }
    }
    open += blocked ? Math.min(1, Math.max(0, (free - STEP - FREE0) / (REACH - FREE0))) : 1;
  }
  SIGHT.water = samples ? wet / samples : 0;
  return open / DIRS;
}

/** The shaped openness for an open share. */
export const opennessOf = (share) => smooth((share - LO) / (HI - LO));

export class Openness {
  // `force` (0..1, a dev harness: __atc.openness.force = 0) pins the value
  constructor() { this.value = 0; this.target = 0; this._t = 0; this._seen = false; this.force = null; }
  /** Once a frame; measures once a second. Returns the eased openness. */
  update(dt, chunkIndex, x, z, water = null) {
    if ((this._t -= dt) <= 0) {
      this._t = 1;
      const share = sightShare(chunkIndex, x, z, water);
      if (share >= 0) {
        this.target = Math.max(opennessOf(share), Math.min(1, SIGHT.water * 2));
        // the first answer is taken as it is: a boot into a field starts open
        if (!this._seen) { this._seen = true; this.value = this.target; }
      }
    }
    if (this.force !== null) return (this.value = this.force);
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / EASE_S));
    if (Math.abs(this.value - this.target) < 1e-4) this.value = this.target;
    return this.value;
  }
  /** Back to the street's 0 at once (a teleport). */
  reset() { this.value = this.target = 0; this._t = 0; this._seen = false; }
}
