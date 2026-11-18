// Local metres. The station and its walkable decks share these dimensions.
export const platforms = [-18, -38];
export const trainZ = -22.9;
export const doorX = 14;
export const depth = 3.6;
export const stops = ['bridge', 'station', 'coach', 'arrival', 'forecourt', 'done'];

export function storyStart(solo, city, saved, empty) {
  if (!solo || city === 'praha') return null;
  if (saved && stops.includes(saved)) return saved;
  return empty && city === 'pardubice' ? 'bridge' : null;
}

const inRect = (x, z, a, b, c, d) => x >= a && x <= b && z >= c && z <= d;

// A foot may only transfer to a connected deck within stepping height. This
// matters where the concourse crosses directly underneath two platforms.
export function floorAt(x, z, from, arrival) {
  const levels = [];
  const deck = (a, b, c, d, h) => {
    if (inRect(x, z, a, b, c, d)) levels.push(h);
  };
  if (!arrival) {
    deck(-2.65, 2.65, 53, 81, 2.4);
    deck(-2.65, 2.65, 41, 53, (z - 41) / 5);
    deck(-6.6, 6.6, 27.6, 41, 0);
  }
  // The only opening in the street facade is the central doorway.
  deck(-2.4, 2.4, 26.7, 28.4, 0);
  const bench = Math.abs(Math.abs(x) - 7) < 1.32 && [14, 19, 24].some((row) => Math.abs(z - row) < 0.45);
  if (!bench) deck(arrival ? -17.8 : -11.3, arrival ? 17.8 : 11.3, 10, 27, 0);
  deck(-2.05, 2.05, 2, 10, ((z - 10) * depth) / 8);
  deck(-1.95, 2.05, -42, 2, -depth);
  for (const p of platforms) {
    deck(1.9, 11, p - 1.25, p + 1.25, (-depth * (11 - x)) / 9);
    // Opening through the platform for the flight of stairs.
    deck(-23, 32, p - 3, p - 1.26, 0);
    deck(-23, 32, p + 1.26, p + 3, 0);
    deck(11, 32, p - 3, p + 3, 0);
    deck(-23, 1.9, p - 3, p + 3, 0);
  }
  deck(doorX - 0.55, doorX + 0.55, trainZ + 0.2, -20.94, 0.12);
  deck(12.9, 15.6, trainZ - 1.13, trainZ + 1.18, 0.18);
  deck(-8.6, 13.1, trainZ - 0.3, trainZ + 0.3, 0.18);
  return levels.find((h) => Math.abs(h - from) < 0.32) ?? null;
}

export const openingCalls = [
  ['Nemocnice', 'Dobrý večer. Prvních dvě stě padesát tisíc na operaci přišlo. Na druhou polovinu máme čtyřiadvacet hodin.'],
  ['Ty', 'A když ty peníze neseženu?'],
  ['Koordinátorka', 'Termín nabídnou dál. Pan doktor se bojí, že vaše dcera čekání na další termín nemusí zvládnout.'],
  ['Ty', 'Je ještě vzhůru? … Tak jí ráno řekněte, že zavolám.'],
  ['Máma · zpráva', 'Nový majitel našel v bytě za skříní její obrázky. Vzala jsem ti je k sobě.'],
  ['Vašek · příchozí hovor', 'Dostaneš se dneska do Pardubic? Sebrali mi papíry. Potřebuju tě za volantem.'],
  ['Vašek', 'Mám kupce na jedno kupé. Milionový auto. Dvě stě sedmdesát tisíc pro tebe.'],
  ['Ty', 'A majitel o tom samozřejmě neví. … Vašku, já ty peníze fakt potřebuju dneska.'],
  ['Vašek', 'Při předání. Jak jsme spolu vozili ty ojetiny, vždycky jsem tě vyplatil. Počkám před nádražím.']
];
