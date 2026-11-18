// Midpoint of the western footway on Masarykovův most, from the Kolín tile.
export const bridge = { x: -39551.5, z: 244.05, h: -2.25 };
export const roof = { x: -38871.9, z: 871.5, h: 0.18 };
export const platforms = [2, 4, 5];
export const trackNumber = { 2: 2, 4: 6, 5: 8 };
export function newTrip(previous, random = Math.random) {
  const choices = platforms.filter((p) => p !== previous);
  return { platform: choices[Math.floor(random() * choices.length)], remaining: 210 };
}
export const stationEntry = { x: -38850.9, z: 761.7, h: 0 };
export const stationExit = { x: 21.73, z: -96.52, h: 0 };
export const kolinPlatform = { x: -38832, z: 724, h: 0 };
export const pardubicePlatform = { x: 31, z: -32, h: 0 };
export const stops = ['bridge', 'station', 'coach', 'arrival', 'forecourt', 'done'];

export function storyStart(solo, city, saved, empty) {
  if (!solo || city === 'praha') return null;
  if (saved && stops.includes(saved)) return saved;
  return empty && city === 'pardubice' ? 'bridge' : null;
}
