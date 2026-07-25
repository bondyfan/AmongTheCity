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

// [filename, prompt, duration seconds] — names must match the sfx() calls in
// main.js. Keep prompts dry/close/no-music so they sit in the mix like the
// Woods set does. The engine while DRIVING is procedural (audio.js) — only
// the start-up crank is a sample, because a starter motor is hard to synth.
const SOUNDS = [
  ['door_open',    'car door opening, quick mechanical latch click, exterior', 0.7],
  ['door_close',   'car door closing with a solid thunk', 0.8],
  ['engine_start', 'compact car engine starting, short crank then idle', 1.8],
  ['horn',         'short friendly car horn beep, city street', 0.8],
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function gen([name, text, duration]) {
  const path = join(OUT, name + '.mp3');
  if (!FORCE && await exists(path)) { console.log('skip (exists):', name); return; }
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, duration_seconds: duration, prompt_influence: 0.5 }),
  });
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
