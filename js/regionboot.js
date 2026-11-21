// ---- Boot in the live region (js/regions.js) ----
// main.js's boot was written for one world: read the save or the menu's city,
// load data/manifest.json, fall back to the single Pardubice file. These are
// the few answers that change when the page is another region, kept here so
// main.js asks one function per question and the Czech path stays the line
// it always was.
//
// Pure apart from what regions.js reads (the URL, sessionStorage once).

import { region, arrival, spawnPose, dataUrl } from './regions.js';

/** The URL of the live region's tile manifest. */
export const manifestUrl = () => dataUrl('manifest.json');

/** May this region fall back to the single-file Pardubice of old? Only the
 *  Czech world: Mahé booting into Pardubice would be a silent teleport. */
export const legacyFallback = () => region().czech;

/** What the menu would have said, when a crossing already said it: the plane
 *  lands you in play, not on the title screen. null = show the menu. */
export function arrivalChoice() {
  const c = arrival()?.carry?.live?.choice;
  return c && (c.mode === 'single' || c.mode === 'server') ? { ...c, name: arrival().carry.live.name } : null;
}

// The place object boot shows on the cover and hands the career. In another
// region it is the region itself: START_PLACES are Czech cities.
const placeOf = (r) => ({ id: r.id, name: r.name, to: r.to, at: r.at });

/**
 * Where boot stands the player: the hand-over's pose after a crossing, the
 * career's answer in the Czech world, and on another region its own home
 * spawn unless the save was taken there. `careerStart` is career.startPoint.
 * { x, z, heading, place, saved, y?, arrived? }
 */
export function regionStartPoint(careerStart) {
  const r = region(), a = arrival();
  if (a) {
    return { x: a.pose.x, z: a.pose.z, heading: a.pose.heading, y: a.pose.y,
      place: r.czech ? careerStart().place : placeOf(r), saved: false, arrived: true };
  }
  const sp = careerStart();
  if (r.czech) return sp;
  if (sp.saved) return { ...sp, place: placeOf(r) };
  const home = spawnPose(r.id, r.home) ?? { x: r.offset?.x ?? 0, z: r.offset?.z ?? 0, heading: 0 };
  return { x: home.x, z: home.z, heading: home.heading, place: placeOf(r), saved: false };
}

/** The boot cover's line: "Přijíždíte do Pardubic…", "Přilétáte na Mahé…". */
export function arriveLine(sp, fallback) {
  if (sp?.arrived && sp.place?.to) return 'Přilétáte ' + sp.place.to + '…';
  if (!region().czech && sp?.place?.to) return 'Přijíždíte ' + sp.place.to + '…';
  return fallback(sp?.place);
}
