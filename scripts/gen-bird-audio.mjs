// ELEVENLABS_API_KEY=… node scripts/gen-bird-audio.mjs [--only id,id]
//
// The sound of birds going up (js/birds.js): one pigeon, a few, a whole flock
// off a square, a flurry of sparrows, a crow. One file per id into
// public/assets/sounds/, where js/audio.js sfxAt() finds them by name. A file
// that exists is left alone, so a second run only fills what is missing.
//
// The recordings come back quiet (peaks around -20 dB): each was brought up to
// a -3 dB peak afterwards with ffmpeg (volume filter), and that is what is in
// the repository.
//
// Costs credits: run it only when asked to.
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';

const out = new URL('../public/assets/sounds/', import.meta.url);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw Error('Set ELEVENLABS_API_KEY to render recordings.');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

// [id, seconds, what to record]
const effects = [
  ['birds_takeoff_one', 1.4, 'Close up, outdoors in a quiet city street. A single pigeon takes off from the pavement: a quick burst of clapping wing beats, loud at first and fading as it flies away. Only wings, no cooing, no voices, no traffic, no music.'],
  ['birds_takeoff_few', 2.0, 'Close up, outdoors in a quiet city street. Four pigeons take off from the pavement one after another: overlapping clapping wing beats and a whistle of feathers, fading as they fly away. Only wings, no cooing, no voices, no traffic, no music.'],
  ['birds_takeoff_flock', 2.8, 'Outdoors on a city square. A startled flock of a dozen pigeons bursts up from the cobblestones all at once: a dense loud flurry of many clapping wings, then the flock wheels away and fades. Only wings, no cooing, no voices, no traffic, no music.'],
  ['birds_takeoff_small', 1.6, 'Close up, outdoors. A group of sparrows flushes from the ground: a light, fast, soft whirr of many small wings, very quick, fading as they dart away. Only wings, no chirping, no voices, no traffic, no music.'],
  ['birds_takeoff_crow', 2.2, 'Outdoors at the edge of a town. One large crow takes off: slow heavy wing beats, and two harsh caws as it flies away. No other birds, no voices, no traffic, no music.'],
];

await mkdir(out, { recursive: true });
for (const [id, duration_seconds, text] of effects) {
  if (only && !only.has(id)) continue;
  const file = new URL(id + '.mp3', out);
  if (await stat(file).catch(() => null)) { console.log(id, 'exists, kept'); continue; }
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ model_id: 'eleven_text_to_sound_v3', duration_seconds, text }),
    });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && i < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2200 * (i + 1)));
        continue;
      }
      throw Error(id + ' ' + r.status + ' ' + (await r.text()).slice(0, 450));
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!r.headers.get('content-type')?.includes('audio') || bytes.length < 500) throw Error('Invalid audio ' + id);
    const tmp = new URL(id + '.part', out);
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    console.log(id, bytes.length);
    break;
  }
}
