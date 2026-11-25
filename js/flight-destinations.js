// ---- flight-destinations.js: where the check-in desks will sell you a seat to ----
// Pure. Frank, 25 Nov 2026: "Ať se tam dá vybrat, kam letět, ale aktuálně bude
// povolené jenom Seychely." So every desk shows a real list of places, and
// only the ones with a route in js/flight-trip.js can be bought; the rest say
// they are coming. From Pardubice and Prague that is Mahé; from Mahé it is the
// way home, to either of the two.

import { routesFrom } from './flight-trip.js';

// The places on the list that do not fly yet: what a Czech departure board
// would plausibly show, in Czech.
const SOON = [
  { id: 'dxb', name: 'Dubaj', country: 'Spojené arabské emiráty' },
  { id: 'lon', name: 'Londýn', country: 'Velká Británie' },
  { id: 'bcn', name: 'Barcelona', country: 'Španělsko' },
  { id: 'rom', name: 'Řím', country: 'Itálie' },
  { id: 'tfs', name: 'Tenerife', country: 'Španělsko' },
  { id: 'hrg', name: 'Hurghada', country: 'Egypt' },
  { id: 'nyc', name: 'New York', country: 'USA' },
  { id: 'bkk', name: 'Bangkok', country: 'Thajsko' },
];
const NAMES = {
  sez: { name: 'Mahé', country: 'Seychely' },
  ped: { name: 'Pardubice', country: 'Česko' },
  prg: { name: 'Praha', country: 'Česko' },
};

/**
 * The list a desk at airport `home` shows, bookable first:
 * [{ id, name, country, open, route?, fare?, via?, hours?, no? }]
 */
export function destinationsFrom(home) {
  const open = routesFrom(home).map((r) => ({
    id: r.dest, ...NAMES[r.dest], open: true, route: r.dir, fare: r.fare, via: r.via, hours: r.hours, no: r.no,
  }));
  const have = new Set(open.map((d) => d.id));
  return [...open, ...SOON.filter((d) => !have.has(d.id)).map((d) => ({ ...d, open: false }))];
}
