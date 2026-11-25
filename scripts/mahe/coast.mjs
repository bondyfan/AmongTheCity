// ---- Mahé's coastline, its reef and its islets, as closed rings ----
// OSM draws a coast as many short natural=coastline ways, land on the LEFT of
// their direction, which chain end to start into one closed ring per island.
// The Czech pipeline never needed any of it (a coast is not something Bohemia
// has), so this reads the Seychelles extract directly and writes the rings in
// Mahé's metres for the two steps that need to know where the sea is: the
// terrain (scripts/mahe/terrain.mjs puts the seabed under it) and the water
// (js/mahe/sea.js colours the lagoon by the distance to the shore and the reef).
//
//   node scripts/mahe/coast.mjs [pbf] → data/regions/mahe/coast.json
//     { land: [ring...], reef: [ring...], beach: [ring...] }, ring = [[x, z], ...]

process.env.ATC_REGION = 'mahe';
const { readPbf } = await import('../lib/osmpbf.mjs');
const W = await import('../lib/world-area.mjs');
const { writeFileSync, mkdirSync } = await import('node:fs');

const PBF = process.argv[2] || 'data/regions/mahe/raw/seychelles.osm.pbf';
const OUT = 'data/regions/mahe/coast.json';
const E = W.ENVELOPE, PAD = 0.05;
const inBox = (lat, lon) => lat > E.latS - PAD && lat < E.latN + PAD && lon > E.lonW - PAD && lon < E.lonE + PAD;

const nodes = new Map();          // id → [lat, lon], only inside the padded box
const coast = [];                 // [ids...]
const areas = { reef: [], beach: [] };   // closed ways
const relWays = { reef: [], beach: [] }; // outer way ids from multipolygons
const wayRefs = new Map();        // id → refs, for relation members

readPbf(PBF, {
  onNode(id, lat, lon) { if (inBox(lat, lon)) nodes.set(id, [lat, lon]); },
  onWay(id, refs, t) {
    if (!t) return;
    if (t.natural === 'coastline') coast.push(refs);
    else if (t.natural === 'reef') areas.reef.push(refs);
    else if (t.natural === 'beach' || t.natural === 'sand') areas.beach.push(refs);
    wayRefs.set(id, refs);
  },
  onRelation(id, members, t) {
    if (!t || t.type !== 'multipolygon') return;
    const k = t.natural === 'reef' ? 'reef' : t.natural === 'beach' || t.natural === 'sand' ? 'beach' : null;
    if (k) for (const m of members) if (m.type === 'way' && m.role !== 'inner') relWays[k].push(m.ref);
  },
});

const xz = (id) => { const n = nodes.get(id); return n ? [+W.xOf(n[1]).toFixed(1), +W.zOf(n[0]).toFixed(1)] : null; };
const ringOf = (ids) => {
  const r = [];
  for (const id of ids) { const p = xz(id); if (!p) return null; r.push(p); }
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r.length >= 3 ? r : null;
};

// Chain the coastline: each way's last node is the next way's first.
function chain(ways) {
  const byFirst = new Map();
  for (const w of ways) byFirst.set(w[0], w);
  const used = new Set(), rings = [];
  let open = 0;
  for (const w of ways) {
    if (used.has(w)) continue;
    used.add(w);
    const ids = [...w];
    for (let guard = 0; guard < 100000 && ids[ids.length - 1] !== ids[0]; guard++) {
      const nx = byFirst.get(ids[ids.length - 1]);
      if (!nx || used.has(nx)) break;
      used.add(nx);
      for (let i = 1; i < nx.length; i++) ids.push(nx[i]);
    }
    if (ids[ids.length - 1] !== ids[0]) { open++; continue; }   // runs out of the extract
    rings.push(ids);
  }
  return { rings, open };
}

const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };
const { rings, open } = chain(coast);
const land = [];
for (const ids of rings) {
  const r = ringOf(ids);
  if (!r) continue;
  // inside the island's box at all (the extract holds the whole archipelago)
  const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cz = r.reduce((s, p) => s + p[1], 0) / r.length;
  if (cx < W.xOf(E.lonW) || cx > W.xOf(E.lonE) || cz < W.zOf(E.latN) || cz > W.zOf(E.latS)) continue;
  land.push(r);
}
land.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
const closedRings = (list) => list.filter((ids) => ids.length > 3 && ids[0] === ids[ids.length - 1]).map(ringOf).filter(Boolean);
const fromRel = (ids) => closedRings(ids.map((id) => wayRefs.get(id)).filter(Boolean));
const reef = [...closedRings(areas.reef), ...fromRel(relWays.reef)];
const beach = [...closedRings(areas.beach), ...fromRel(relWays.beach)];

mkdirSync('data/regions/mahe', { recursive: true });
writeFileSync(OUT, JSON.stringify({ land, reef, beach }));
const km2 = (r) => Math.abs(area(r)) / 1e6;
console.log(`coast: ${coast.length} coastline ways → ${land.length} islands (${open} open chains dropped);`
  + ` largest ${km2(land[0] ?? [[0, 0]]).toFixed(1)} km² (Mahé is 157.3 km²), ${reef.length} reefs, ${beach.length} beaches → ${OUT}`);
