// ---- A stand-in Mahé until the real tiles are built ----
// The flight (js/flight.js, the atc-letiste work) has to be testable end to end
// before Frank has said yes to downloading the island's data. This writes the
// smallest world the region boot accepts: a manifest and ONE tile holding the
// runway of Seychelles International at its published reference point, on flat
// ground at sea level. Nothing here is downloaded; the numbers are the AIP's
// aerodrome reference point and the runway's length, width and bearing, and
// scripts/mahe/build.mjs overwrites every file this writes.
//
//   node scripts/mahe/stub.mjs            → public/data/regions/mahe/{manifest.json,tiles/}

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { project, REGIONS } from '../../js/regions.js';

const R = REGIONS.mahe;
const OUT = 'public/data/regions/mahe';
if (existsSync(`${OUT}/manifest.json`) && !JSON.parse(readFileSync(`${OUT}/manifest.json`, 'utf8')).stub) {
  console.error('a real Mahé manifest is there already; the stub never replaces real data');
  process.exit(1);
}
const ARP = project(-4.674167, 55.521944, R);   // 4°40'27"S 55°31'19"E
const LEN = 2987, W = 45, BEARING = 128 * Math.PI / 180;   // true, 13 → 31 runs NW → SE
const ex = Math.sin(BEARING), ez = -Math.cos(BEARING);      // east, south components
const nw = [ARP.x - ex * LEN / 2, ARP.z - ez * LEN / 2], se = [ARP.x + ex * LEN / 2, ARP.z + ez * LEN / 2];
const r1 = (v) => Math.round(v * 10) / 10;
const tx = Math.floor(ARP.x / R.tile), tz = Math.floor(ARP.z / R.tile);
const tile = {
  tx, tz, stub: true,
  buildings: [], rails: [], water: [], waterways: [], green: [], zones: [], paved: [], trees: [],
  pois: [], venues: [], signals: [], signs: [], crossings: [], power: [], furniture: [], calming: [], barriers: [],
  roads: [{ p: [nw.map(r1), se.map(r1)], t: 'runway', w: W, v: 0, d: 0, ref: '13/31' }],
};
mkdirSync(`${OUT}/tiles`, { recursive: true });
writeFileSync(`${OUT}/tiles/${tx}_${tz}.json`, JSON.stringify(tile));
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
  stub: true, origin: R.origin, offset: R.offset, tile: R.tile, routes: R.data + 'routes/',
  tiles: [{ tx, tz, f: `${R.data}tiles/${tx}_${tz}.json`, n: 1 }],
}));
console.log('stub Mahé: tile', tx, tz, 'runway 13 end', nw.map(r1), '31 end', se.map(r1));
