// ---- cyclesurvey.js: where a ride meets the roads ------------------------------
// Split out of js/cycleplan.js: the ridden line is walked once, when the plan
// is built, and everything about the carriageways it touches is written down.
// A function of the line and the map, so it is the same on every co-op client.

import { CLS } from './cyclenet.js';
import { SITE } from './crowdsites.js';

const SAMPLE = 2;                 // m between the points a path is asked "whose asphalt is this"
const ALONG_MAX = 30;             // m of carriageway in one run past which a path is running along a road, not over it
const JUNCTION_LEAD = 12, JUNCTION_PAST = 4;   // m of street either side of a junction a rider holds the lane
const RANK = { service: 0, living_street: 1, residential: 2, unclassified: 2, tertiary_link: 3, tertiary: 3,
  secondary_link: 4, secondary: 4, primary_link: 5, primary: 5, trunk_link: 6, trunk: 6, motorway_link: 7, motorway: 7 };

const dist = (x, z) => Math.sqrt(x * x + z * z);

// cross: [{ a0, a1, cx, cz, rdx, rdz, hw, zebra, sig, kerb, give }] sorted by a0.
//   a0..a1  the metres of the line on that road's asphalt
//   kerb    a road worth slowing to look at (not a driveway)
//   give    the rider gives way there (no zebra, no lights, or a bigger road)
// zones: [a0, a1, ...] stretches of STREET where the rider is in the lane, not
//   at its edge (through a junction, across a turn): the traffic is told.
export function survey(plan, opt) {
  const drive = opt.drive;
  const { legs, cum, px, pz, lg } = plan;
  const zones = [];
  // turning across a street: the chord between two ways, either of them a street
  for (let k = 0; k + 1 < legs.length; k++) {
    const a = legs[k], b = legs[k + 1];
    if (b.a0 <= a.a1 || b.a0 > plan.len) continue;
    if (a.w.cls !== CLS.STREET && b.w.cls !== CLS.STREET) continue;
    zones.push(Math.max(0, a.a1 - 5), Math.min(plan.len, b.a0 + 5));
  }
  if (!drive) { plan.zones = mergeZones(zones); return; }
  const out = [], open = [], hits = [];
  const close = (run) => {
    if (run.a1 - run.a0 > ALONG_MAX) { plan.along += run.a1 - run.a0; return; }
    const h = run.hit;
    out.push({ a0: Math.max(0, run.a0 - 1.2), a1: Math.min(plan.len, run.a1 + 1.2),
      cx: h.qx, cz: h.qz, rdx: h.dx, rdz: h.dz, hw: h.hw,
      kerb: h.r.t !== 'service' && h.hw >= 2, zebra: false, sig: false, give: true });
  };
  // off the street: walk the line and ask whose asphalt it is on
  let si = 0;
  for (let a = 0; a <= plan.len; a += SAMPLE) {
    while (si < plan.n - 2 && cum[si + 1] < a) si++;
    const leg = legs[lg[si]];
    hits.length = 0;
    if (leg.w.cls !== CLS.STREET) {
      const f = (a - cum[si]) / ((cum[si + 1] - cum[si]) || 1);
      drive.onAll(px[si] + (px[si + 1] - px[si]) * f, pz[si] + (pz[si + 1] - pz[si]) * f, leg.w.r.l, hits);
    }
    for (const h of hits) {
      let run = null;
      for (const o of open) if (o.r === h.r) run = o;
      if (!run) open.push({ r: h.r, a0: a, a1: a, hit: h, deep: h.d });
      else { run.a1 = a; if (h.d < run.deep) { run.deep = h.d; run.hit = h; } }
    }
    for (let i = open.length - 1; i >= 0; i--) {
      if (a - open[i].a1 > SAMPLE * 1.6) { close(open[i]); open.splice(i, 1); }
    }
  }
  for (const run of open) close(run);
  // on a street: the junctions it passes through. Every vertex of the way is
  // asked which OTHER carriageways it lies on.
  for (const leg of legs) {
    if (leg.w.cls !== CLS.STREET || leg.a0 >= plan.len) continue;
    const w = leg.w, p = w.r.p, own = RANK[w.r.t] ?? 2;
    for (let i = leg.i0 + leg.d; ; i += leg.d) {
      const a = leg.base + Math.abs(w.cum[i] - w.cum[leg.i0]);
      if (a > plan.len) break;
      const q = p[i], b = p[i - leg.d];
      let dx = q[0] - b[0], dz = q[1] - b[1];
      const dl = dist(dx, dz) || 1;
      dx /= dl; dz /= dl;
      hits.length = 0;
      drive.onAll(q[0], q[1], w.r.l, hits);
      let best = null;
      for (const h of hits) {
        if (h.r === w.r || h.r.t === 'service') continue;
        if (Math.abs(h.dx * dx + h.dz * dz) > 0.85) continue;      // the same street, carried on by another way
        if (!best || h.hw > best.hw || (h.hw === best.hw && (RANK[h.r.t] ?? 2) > (RANK[best.r.t] ?? 2))) best = h;
      }
      if (best) {
        zones.push(Math.max(0, a - JUNCTION_LEAD), Math.min(plan.len, a + best.hw + JUNCTION_PAST));
        const give = (RANK[best.r.t] ?? 2) > own;
        const sig = !!(opt.signalWait && opt.signalWait(q[0], q[1], best.dx, best.dz, plan.t0, 0) !== null);
        if (give || sig) {
          out.push({ a0: Math.max(0, a - best.hw - 1.5), a1: Math.min(plan.len, a + best.hw + 1),
            cx: q[0], cz: q[1], rdx: best.dx, rdz: best.dz, hw: best.hw,
            kerb: true, zebra: false, sig, give, street: true });
        }
      }
      if (i === leg.i1) break;
    }
  }
  out.sort((p, q) => (p.a0 - q.a0) || (p.cx - q.cx) || (p.cz - q.cz));
  // two records for one stretch of asphalt (the two halves of a divided road
  // meet at a vertex, a junction mouth is two roads at once): one crossing
  const cross = [];
  for (const c of out) {
    const last = cross[cross.length - 1];
    if (last && c.a0 <= last.a1 + 1) {
      if (c.a1 > last.a1) last.a1 = c.a1;
      if (c.hw > last.hw) { last.cx = c.cx; last.cz = c.cz; last.rdx = c.rdx; last.rdz = c.rdz; last.hw = c.hw; }
      last.kerb = last.kerb || c.kerb;
      continue;
    }
    cross.push(c);
  }
  for (const c of cross) {
    if (c.street) continue;
    c.zebra = !!(opt.sites && opt.sites.has(SITE.ZEBRA, c.cx, c.cz, 5));
    c.sig = !!(opt.signalWait && c.kerb && opt.signalWait(c.cx, c.cz, c.rdx, c.rdz, plan.t0, 0) !== null);
    c.give = !c.zebra && !c.sig;
  }
  plan.cross = cross;
  plan.zones = mergeZones(zones);
}

function mergeZones(z) {
  const pairs = [];
  for (let i = 0; i < z.length; i += 2) if (z[i + 1] > z[i]) pairs.push([z[i], z[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const q of pairs) {
    const k = out.length;
    if (k && q[0] <= out[k - 1] + 0.5) { if (q[1] > out[k - 1]) out[k - 1] = q[1]; } else out.push(q[0], q[1]);
  }
  return out;
}
