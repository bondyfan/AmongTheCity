// ---- Creole colours on Mahé's houses ----
// OSM draws the footprints of Mahé and almost never says what colour they are.
// Left to the Czech defaults they would come out as Pardubice: grey render and
// red clay tiles. A Seychellois house is something else, and it is the first
// thing anybody notices driving the coast road: walls in white, cream, ochre,
// mint, turquoise, coral; and a roof of corrugated iron painted red oxide,
// green, blue, or left galvanised grey. Hipped as often as gabled.
//
// This runs over the built tiles and fills in only what a mapper did NOT say
// (building:colour, roof:colour, roof:material, roof:shape win), hashed off the
// footprint so the same house keeps its colours on every machine and every
// rebuild. The fields are the tile format's own (c, rc, rm, r; docs/TILE-FORMAT.md),
// so the runtime needs nothing new.
//
//   node scripts/mahe/creole.mjs   (rewrites public/data/regions/mahe/tiles/*.json in place)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'public/data/regions/mahe/tiles';
const WALLS = ['#f4f1e8', '#f4f1e8', '#efe2c0', '#f2d98a', '#e9c46a', '#bfe3c8', '#7fcfc4', '#a8d0e6', '#f0a99a', '#e8b48f', '#c9dd8a', '#f7f3ea'];
const ROOFS = ['#9c3b2a', '#9c3b2a', '#b5452f', '#3e7a4a', '#2f6d45', '#3d6e9c', '#9aa0a3', '#8e9396', '#2f8f8a', '#7a2f25'];
// the town: rendered blocks in white, cream and pale stone, grey iron or flat
const TOWN_WALLS = ['#f4f1e8', '#ece6d6', '#efe2c0', '#e6dccb', '#f7f3ea', '#dfe7ea'];
const METAL = 2;   // js/tiledata.js ROOF_MATERIALS index of 'metal'
const HOUSE = /^(house|residential|yes|detached|semidetached_house|bungalow|hut|cabin|terrace|farm|shed)$/;

const hash = (x, z, s) => {
  let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b1, 2654435761) ^ Math.imul(Math.round(z * 10) ^ s, 0x27d4eb2d);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
const area = (o) => { let a = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]); return Math.abs(a / 2); };
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

// HOW TALL. The island's footprints were traced as building=residential or
// =yes with no levels, which the Czech defaults read as three and two storeys
// (10.5 m and 7.4 m): a coast of blocks. A Seychellois house is a bungalow, a
// bigger one has an upper floor. Only a building with NO levels and no height
// of its own is touched (b.lv absent and one of the two default heights), so a
// mapped number always wins and a second run changes nothing.
const LEVEL_H = 3.1, BASE = 1.2;              // build-region.mjs's own storey and plinth
const DEFAULT_H = new Set([7.4, 10.5]);
function storeys(b, A, x, z) {
  if (b.lv || !DEFAULT_H.has(b.h) || !HOUSE.test(b.t ?? 'yes')) return 0;
  if (A < 90) return 1;
  if (A < 200) return hash(x, z, 9) < 0.65 ? 1 : 2;
  if (A < 450) return 2;
  return 0;                                   // a big block keeps its guess
}

let houses = 0, town = 0, kept = 0, n = 0, lowered = 0;
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  const tile = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
  for (const b of tile.buildings ?? []) {
    n++;
    const [x, z] = b.o[0], A = area(b.o);
    const st = storeys(b, A, x, z);
    if (st) { b.lv = st; b.h = +(st * LEVEL_H + BASE).toFixed(1); lowered++; }
    const small = A < 260 && (b.lv ?? 1) <= 2 && HOUSE.test(b.t ?? 'yes');
    if (b.c && b.rc) { kept++; continue; }
    if (small) {
      houses++;
      b.c ??= pick(WALLS, hash(x, z, 1));
      b.rc ??= pick(ROOFS, hash(x, z, 2));
      b.rm ??= METAL;
      // tin roofs are pitched: a flat guess on a house becomes hipped or gabled
      if (!b.r || b.r === 'flat') b.r = hash(x, z, 3) < 0.55 ? 'hipped' : 'gabled';
    } else {
      town++;
      b.c ??= pick(TOWN_WALLS, hash(x, z, 4));
      if (b.r && b.r !== 'flat') { b.rc ??= pick(['#9aa0a3', '#8e9396', '#9c3b2a', '#3e7a4a'], hash(x, z, 5)); b.rm ??= METAL; }
    }
  }
  writeFileSync(`${DIR}/${f}`, JSON.stringify(tile));
}
console.log(`creole: ${n} buildings, ${houses} houses painted, ${town} town blocks, ${kept} already coloured by their mappers, ${lowered} given their real storeys`);
