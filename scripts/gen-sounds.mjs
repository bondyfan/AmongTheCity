// Generate the city's handful of SFX via the ElevenLabs Sound Effects API.
//   ELEVENLABS_API_KEY=sk_... node scripts/gen-sounds.mjs
// Writes <name>.mp3 into assets/sounds/ (the folder js/audio.js streams
// from). Skips files that already exist unless FORCE=1, so re-running after
// adding a sound only bills the new one. Same endpoint + conventions as
// ../AmongTheWoods/scripts/gen-sounds.mjs — one API, two games.

import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }
const FORCE = process.env.FORCE === '1';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

// [filename, prompt, duration seconds, extraBody?] — names must match the
// sfx()/ambientStart() calls in main.js + audio.js. Keep prompts dry/close/
// no-music so they sit in the mix like the Woods set does. The engine while
// DRIVING is procedural (audio.js), and so is the helicopter rotor — only the
// start-up transients are samples, because a starter motor and a turbine
// spool are the two things synthesis makes sound like a kazoo.
//
// `extraBody` is merged into the request JSON for the one sound that needs a
// hint the others don't: the ambience must LOOP, and ElevenLabs can render it
// seamlessly (matched head/tail) if asked — which beats any crossfade we could
// bodge at runtime, since a wrap-around click in a bed that plays forever is
// the single most noticeable artefact in the whole mix.
const SOUNDS = [
  ['door_open',    'car door opening, quick mechanical latch click, exterior', 0.7],
  ['door_close',   'car door closing with a solid thunk', 0.8],
  ['engine_start', 'compact car engine starting, short crank then idle', 1.8],
  ['horn',         'short friendly car horn beep, city street', 0.8],

  // ---- v4: the city gets a soundtrack of its own ----
  // The bed under everything. It must be EVENTLESS: any siren, shout or door
  // slam baked into it becomes a tic that repeats every ten seconds forever,
  // and the ear finds that within a minute. Distance is the whole brief —
  // nothing in it should sound like it happened next to the player.
  ['city_ambience',
    'Continuous distant city ambience heard from a quiet street corner: a steady low hum of '
    + 'traffic rolling on asphalt several blocks away, faint indistinct murmuring voices of '
    + 'passers-by far off, one distant tram humming along its rails, soft wind moving between '
    + 'buildings. Even, calm and unchanging throughout, seamless 10 second loop with no start '
    + 'and no end, no sudden events, no nearby cars, no sirens, no horns, no music, no clear '
    + 'speech or words', 10.0, { loop: true }],
  // A car going PAST the player — the one traffic sound that is an event, so
  // the doppler is the point: approach, whoosh, recede.
  ['traffic_pass',
    'A single car passing close by at speed on a city street: approaching tyre roar swelling '
    + 'from a distance, a doppler whoosh sweeping past the microphone and a receding hiss of '
    + 'rubber on asphalt fading away, kerbside exterior perspective, dry. Single event, no '
    + 'music, no voice', 2.0],
  ['horn_far',
    'A car horn heard from a block away: two short beeps muffled and dulled by distance with a '
    + 'faint slapback off building facades, thin and far off, quiet street. Single dry event, '
    + 'no music, no voice', 1.0],
  ['horn_angry',
    'An angry driver leaning on the horn: one long aggressive blaring car horn blast with a '
    + 'hard sharp attack and a slight rasp, close and loud on a city street. Single dry event, '
    + 'no music, no voice', 1.4],
  // Covers the first ~4 s of spin-up; audio.js takes over with the procedural
  // rotor once the blades are turning, so this only has to sell the ignition.
  ['heli_start',
    'A small helicopter starting up: a whining turbine spooling up from silence with rising '
    + 'pitch while the main rotor begins to turn, slow heavy blade whooshes accelerating into '
    + 'a faster rhythmic beating, exterior close. Single dry event, no music, no voice', 4.0],
  ['siren_far',
    'A police siren several streets away: a European two-tone wailing siren rising and falling, '
    + 'thinned and reverberant with distance echoing between buildings, faint traffic hum '
    + 'underneath. No music, no voice', 4.0],
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const post = (body) => fetch('https://api.elevenlabs.io/v1/sound-generation', {
  method: 'POST',
  headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function gen([name, text, duration, extra]) {
  const path = join(OUT, name + '.mp3');
  if (!FORCE && await exists(path)) { console.log('skip (exists):', name); return; }
  const base = { text, duration_seconds: duration, prompt_influence: 0.5 };
  let res = await post(extra ? { ...base, ...extra } : base);
  // A hint field the account's API revision doesn't know comes back 422 and
  // would cost us the whole sound over a nicety, so fall back to the plain
  // body once: a 10 s ambience we have to crossfade ourselves still beats an
  // empty assets folder. Only client-side rejections retry — a 5xx is the
  // service being down and hammering it again helps nobody.
  if (!res.ok && extra && res.status >= 400 && res.status < 500) {
    const why = (await res.text()).slice(0, 160);
    console.warn(`${name}: ${res.status} with {${Object.keys(extra)}} — retry plain · ${why}`);
    res = await post(base);
  }
  if (!res.ok) { throw new Error(`${name}: ${res.status} ${await res.text()}`); }
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  console.log('wrote', name + '.mp3');
}

await mkdir(OUT, { recursive: true });
// Optional name filter: `node scripts/gen-sounds.mjs horn` (or ONLY=door)
// regenerates just the matching sounds, so a tweak doesn't re-bill the set.
const only = (process.argv.slice(2).join(',') || process.env.ONLY || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const wanted = only.length ? SOUNDS.filter(([n]) => only.some(o => n.includes(o))) : SOUNDS;
if (only.length) console.log(`filter: ${only.join(', ')} → ${wanted.length} sound(s)`);
for (const s of wanted) {
  try { await gen(s); } catch (e) { console.error(String(e.message || e)); }
}
console.log('done.');
