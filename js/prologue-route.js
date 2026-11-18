// Midpoint of the western footway on Masarykovův most, from the Kolín tile.
export const bridge = { x: -39551.5, z: 244.05, h: -2.25 };
// The pavement of Dukelských hrdinů where the hospital rings, walking home.
export const street = { x: -38909.2, z: 811.7, h: 0 };
// The block of flats beside the butcher U Nováků. The frame sits on the middle
// of its end wall: local -z looks out over the shop towards the station,
// local +x runs along the wall to the right, local +z back along the roof.
export const roofFrame = { x: -38966.35, z: 850, h: -0.5243, floors: 13.6 };
export const roof = { x: roofFrame.x, z: roofFrame.z, h: roofFrame.h };
// The campaign opens at eight in the evening (its clock: js/prologue-clock.js).
export const hours = { street: 20 };
export const platforms = [2, 4, 5];
export const trackNumber = { 2: 2, 4: 6, 5: 8 };
// "Poslední vlak ti jede za tři minuty."
export const DEPARTS_IN = 180;
export function newTrip(previous, random = Math.random) {
  const choices = platforms.filter((p) => p !== previous);
  return { platform: choices[Math.floor(random() * choices.length)], remaining: DEPARTS_IN };
}
export const stationEntry = { x: -38850.9, z: 761.7, h: 0 };
export const stationExit = { x: 21.73, z: -96.52, h: 0 };
export const kolinPlatform = { x: -38832, z: 724, h: 0 };
export const pardubicePlatform = { x: 31, z: -32, h: 0 };
export const stops = ['bridge', 'station', 'coach', 'arrival', 'forecourt', 'done'];

// The campaign is played in one sitting: nothing is saved before its end, so
// an unfinished chapter in an older save starts again on the street in Kolín.
export function storyStart(solo, city, saved, empty) {
  if (!solo || city === 'praha') return null;
  if (saved === 'done') return 'done';
  if (saved && stops.includes(saved)) return 'bridge';
  return empty && city === 'pardubice' ? 'bridge' : null;
}
