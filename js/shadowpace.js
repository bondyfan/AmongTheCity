// ---- shadowpace.js: how often the shadow map is redrawn ----------------------
// The shadow pass draws the whole neighbourhood a second time, from the light.
// Two waves of work made that neighbourhood 40 percent more triangles and the
// box it is drawn into 60 percent larger, and gave the night a shadow-casting
// moon. Measured in the old town at midnight on the medium preset: the pass was
// 5.9 ms of an 18.8 ms frame, nearly a third, for shadows that are a faint blue
// under a light that does not move in a minute. That is where the night frame
// went over the original's (wave 3 table: +19 percent in the old town, +35
// percent in the wood).
//
// So below the high tier the MOON's shadows are redrawn every other frame.
// Nothing swims: three computes the shadow matrix when it draws the map and
// keeps it with the map, so a frame that skips the pass samples the old map
// through the old matrix, exactly as it was drawn. The only thing that is late
// is a moving caster's shadow, by one frame, in moonlight. By day every frame
// is drawn on every tier: a car's sun shadow trailing it by a frame is visible.

let odd = 0;

/**
 * Call once per RENDERED frame.
 * @param settings  the live settings (js/settings.js)
 * @param nightK    0 by day, 1 at deep night (sky.nightK)
 * @returns true when the shadow map should be drawn this frame
 */
export function shadowDue(settings, nightK) {
  odd ^= 1;
  // the high tier (and any custom profile that asked for its 4096 map) pays
  // for every frame
  if ((settings?.shadowRes ?? 2048) >= 4096) return true;
  return !(nightK > NIGHT_FROM) || odd === 0;
}

// The moon has taken over from the sun by here (sky.js hands the one light
// over through twilight); below it the light is still the low sun.
const NIGHT_FROM = 0.6;
