import { PARDUBICE, inRect } from './station-layout.js';
import { plate } from './stationkit.js';
import { sectorAt, tracksOf, nextTrain, clock } from './pardubice-signs.js';

// The platforms of Pardubice hlavní nádraží above ground, as rebuilt by 2024:
// long canopies on one row of teal steel columns, their roofs salmon red from
// above (ČÚZK aerial photo) and pale ribbed sheet from below, brick benches
// with wooden seats, navy plates with track and sector hung at the edges, the
// station's name, a clock and the next train on a post, the lift towers of the
// eastern underpass. Station frame (x = u, z = v), y from `ground`.
const BAY = 8, // metres between canopy columns
  ROOF = 4.05, // underside of a canopy at its spine
  LEAN = 0.07; // how far its two wings rise towards the edges (radians)

// The paved edges that trains stand at, as straight lines [u0, v0, u1, v1]
// read off the platform polygons; `side` is where the platform lies (+1: south
// of the line).
const edges = [
  [-125.5, -13.3, 93.8, -13.5, -1],
  [-125, -5.2, 109.6, -4.7, 1],
  [-125, 5.2, 171.5, 5.6, -1],
  [-180.6, 18.5, 172.1, 19, 1],
  [-225, 28.7, 211.4, 29.5, -1],
  [-177.4, 37.2, 257.6, 37.8, 1],
  [-145.4, 47.2, 59.8, 48.5, -1],
  [59.8, 48.5, 242.1, 48.5, -1],
  [-21.2, 75.5, 229.4, 76, 1],
  [-21.1, 82.8, 229.3, 83.3, -1],
];

export function buildPlatforms(s, k, Y) {
  const { platforms, bay, lifts } = PARDUBICE;
  // nothing may stand in a stair mouth or in front of a lift
  const taken = [...s.flights.map((f) => f.span), ...lifts.map((l) => ({ u0: l.u - 1.3, u1: l.u + 1.3, v0: l.v - 1.3, v1: l.v + 1.3 }))];
  const free = (u, v, pad = 0.7) => !taken.some((r) => inRect(r, u, v, pad));
  const canopies = [];

  function canopy(pl) {
    const [from, to] = pl.roof,
      mid = (pl.v0 + pl.v1) / 2,
      half = (pl.v1 - pl.v0) / 2 + 0.15,
      lift = (Math.sin(LEAN) * half) / 2;
    canopies.push({ u0: from, u1: to, v0: mid - half, v1: mid + half, y: (u) => Y(u, mid) + ROOF });
    for (let u = from; u < to - 0.5; u += BAY) {
      const long = Math.min(BAY, to - u),
        c = u + long / 2,
        y = Y(c, mid);
      for (const side of [-1, 1]) {
        const v = mid + (side * half) / 2,
          lean = { x: -side * LEAN };
        k.box(c, y + ROOF + lift + 0.03, v, long + 0.02, 0.06, half, 'soffit', lean);
        k.box(c, y + ROOF + lift + 0.1, v, long + 0.02, 0.07, half + 0.1, 'roof', lean);
        k.box(c, y + ROOF + 2 * lift + 0.06, mid + side * half, long + 0.02, 0.16, 0.07, 'white');
        // the strip lights, one each side of the spine, and what they light
        k.box(c, y + ROOF - 0.02 + lift * 0.5, mid + side * half * 0.45, 1.6, 0.05, 0.14, 'lamp');
      }
      k.light(c, y, mid, long + 2, 2 * half + 1.5);
      k.box(c, y + ROOF - 0.16, mid, long + 0.02, 0.32, 0.36, 'teal');
      for (const end of u + BAY >= to - 0.5 ? [u, u + long] : [u]) {
        // a rib across at every column, and the column where the floor is free
        for (const side of [-1, 1]) k.box(end, y + ROOF + lift - 0.08, mid + (side * half) / 2, 0.14, 0.18, half, 'teal', { x: -side * LEAN });
        if (!free(end, mid)) continue;
        k.box(end, y + ROOF / 2, mid, 0.32, ROOF, 0.32, 'teal');
        k.box(end, y + 0.13, mid, 0.46, 0.26, 0.46, 'dark');
      }
    }
  }

  function lines() {
    for (const [u0, v0, u1, v1, side] of edges) {
      const count = Math.ceil((u1 - u0) / 10); // short pieces: the paving is not level
      for (let i = 0; i < count; i++) {
        const a = u0 + ((u1 - u0) * i) / count,
          b = u0 + ((u1 - u0) * (i + 1)) / count,
          c = (a + b) / 2,
          v = v0 + ((v1 - v0) * (i + 0.5)) / count,
          y = Y(c, v + side);
        k.box(c, y + 0.02, v + side * 0.14, b - a, 0.04, 0.28, 'white');
        k.box(c, y + 0.022, v + side * 0.56, b - a, 0.04, 0.4, 'concrete');
        k.box(c, y + 0.024, v + side * 0.86, b - a, 0.044, 0.12, 'yellow');
      }
    }
  }

  // A brick bench with a wooden seat, the kind the old station was known for.
  function bench(u, v, round = false) {
    const y = Y(u, v);
    if (round) {
      k.round(u, y + 0.22, v, 1.7, 0.44, 'brick');
      k.round(u, y + 0.47, v, 2.3, 0.06, 'wood');
      k.round(u, y + 0.62, v, 1.2, 0.36, 'brick');
      return;
    }
    k.box(u, y + 0.22, v, 1.5, 0.44, 0.5, 'brick');
    k.box(u, y + 0.47, v, 2.3, 0.06, 0.62, 'wood');
  }

  // Track and sector on a plate hung across the platform, as "4E" / "5E".
  function sectorPlates(pl, u, y, mid, half) {
    const letter = sectorAt(u);
    pl.tracks.forEach((track, i) => {
      if (!track) return;
      const v = mid + (i ? 1 : -1) * (half - 1.25);
      k.box(u, y + 3.72, v, 0.04, 0.5, 0.04, 'steel');
      k.box(u, y + 3.26, v, 0.05, 0.5, 0.74, 'navy');
      k.both(u, y + 3.26, v, 0.7, 0.46, Math.PI / 2, 128, plate([track + letter]), 'sec' + track + letter, 0.03);
    });
  }

  // The post with a clock and the next departure, across the platform.
  function infoPost(pl, u, mid) {
    const y = Y(u, mid);
    k.box(u, y + 1.75, mid, 0.18, 3.5, 0.18, 'dark');
    k.box(u, y + 3.15, mid, 0.16, 0.7, 2.9, 'dark');
    pl.tracks.forEach((track, i) => {
      if (!track) return;
      const yaw = i ? -Math.PI / 2 : Math.PI / 2,
        nx = i ? -1 : 1;
      k.sign(u + nx * 0.085, y + 3.15, mid - nx * 1.08, 0.62, 0.62, yaw, 128, clock, 'clock');
      k.sign(u + nx * 0.085, y + 3.15, mid + nx * 0.34, 2.1, 0.6, yaw, 384, nextTrain(track), 'next' + track);
    });
  }

  function nameSign(u, y, v) {
    for (const side of [-1.2, 1.2]) k.box(u + side, y + 3.72, v, 0.04, 0.5, 0.04, 'steel');
    k.box(u, y + 3.24, v, 3.3, 0.56, 0.05, 'navy');
    k.both(u, y + 3.24, v, 3.2, 0.5, 0, 512, plate(['Pardubice hl. n.']), 'name', 0.03);
  }

  function dress(pl) {
    const mid = (pl.v0 + pl.v1) / 2,
      half = (pl.v1 - pl.v0) / 2;
    const [from, to] = pl.roof ?? [pl.u0 + 20, pl.u1 - 20];
    // under the canopy: names, plates and benches in a steady rhythm
    for (let u = from + 12, n = 0; u < to - 6; u += 12, n++) {
      const y = Y(u, mid);
      if (n % 4 === 1) nameSign(u, y, mid + (n % 8 === 1 ? -1 : 1) * (half - 2.2));
      if (n % 3 === 0) sectorPlates(pl, u, y, mid, half);
      const side = n % 2 ? 0.9 : -0.9;
      if (n % 2 === 0 && free(u + 4, mid + side, 1.6)) bench(u + 4, mid + side, n % 10 === 4);
      if (n % 4 === 2 && free(u + 6.4, mid, 1)) {
        k.box(u + 6.4, Y(u + 6.4, mid) + 0.45, mid, 0.42, 0.9, 0.42, 'dark');
        k.box(u + 6.4, Y(u + 6.4, mid) + 0.92, mid, 0.48, 0.05, 0.48, 'steel');
      }
    }
    // in the open beyond it: the info post, sector posts, steel benches
    for (const [a, b] of [[pl.u0 + 8, from - 6], [to + 6, pl.u1 - 8]]) {
      if (b - a < 12) continue;
      infoPost(pl, a < from ? b - 4 : a + 4, mid);
      for (let u = a < from ? b - 22 : a + 22; a < from ? u > a : u < b; u += a < from ? -40 : 40) {
        const y = Y(u, mid);
        k.box(u, y + 1.8, mid, 0.1, 3.6, 0.1, 'steel');
        pl.tracks.forEach((track, i) => {
          if (!track) return;
          const v = mid + (i ? 0.5 : -0.5);
          k.box(u, y + 3.3, v, 0.05, 0.5, 0.8, 'navy');
          k.both(u, y + 3.3, v, 0.76, 0.46, Math.PI / 2, 128, plate([track + sectorAt(u)]), 'sec' + track + sectorAt(u), 0.03);
        });
        const bu = u + (a < from ? 6 : -6);
        k.box(bu, Y(bu, mid) + 0.44, mid, 1.8, 0.05, 0.46, 'dark');
        k.box(bu, Y(bu, mid) + 0.7, mid + 0.22, 1.8, 0.4, 0.04, 'dark');
        for (const leg of [-0.8, 0.8]) k.box(bu + leg, Y(bu, mid) + 0.22, mid, 0.05, 0.44, 0.44, 'dark');
      }
    }
  }

  // A lift of the eastern underpass where it comes out on a platform.
  function liftTower(l) {
    const y = Y(l.u, l.v);
    k.box(l.u, y + 1.5, l.v, 2.1, 3.0, 2.1, 'glass');
    k.box(l.u, y + 1.45, l.v, 1.5, 2.9, 1.5, 'steel');
    for (const du of [-1.05, 1.05]) for (const dv of [-1.05, 1.05]) k.box(l.u + du, y + 1.55, l.v + dv, 0.1, 3.1, 0.1, 'dark');
    k.box(l.u, y + 3.1, l.v, 2.4, 0.14, 2.4, 'dark');
    const east = l.u > PARDUBICE.B,
      nx = east ? -1 : 1; // its door looks back towards the stairs
    k.box(l.u + nx * 1.07, y + 1.1, l.v, 0.04, 2.1, 1.1, 'steel');
    k.sign(l.u + nx * 1.1, y + 2.5, l.v, 1.3, 0.3, (nx * Math.PI) / 2, 256, plate(['Výtah · podchod · hala']), 'lifttop');
  }

  // Over every stair mouth: which way is out.
  function exits() {
    for (const f of s.flights) {
      if (f.axis !== 'u') continue;
      const dir = Math.sign(f.b - f.a),
        u = f.b + dir * 1.6,
        y = Y(u, f.c);
      if (f.to !== 1) k.box(u, y + 3.72, f.c, 0.04, 0.5, 0.04, 'steel');
      else k.box(u, y + 1.65, f.c + 1.9, 0.08, 3.3, 0.08, 'steel');
      const v = f.to === 1 ? f.c + 1.9 : f.c;
      k.box(u, y + 3.22, v, 0.05, 0.5, 2.3, 'navy');
      k.both(u, y + 3.22, v, 2.2, 0.44, Math.PI / 2, 384, plate(['↓ Východ · Hala · náměstí Jana Pernera']), 'exitdown', 0.03);
    }
  }

  for (const pl of platforms) {
    if (pl.roof) canopy(pl);
    dress(pl);
  }
  canopy(bay);
  dress(bay);
  lines();
  for (const l of lifts) liftTower(l);
  exits();
  return {
    cover: (u, v) => canopies.some((c) => inRect(c, u, v, 0.3)),
    lid(u, v) {
      const c = canopies.find((r) => inRect(r, u, v, 0.3));
      return c ? c.y(u) : null;
    },
  };
}
