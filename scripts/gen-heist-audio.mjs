// ELEVENLABS_API_KEY=… node scripts/gen-heist-audio.mjs
// The voices, sounds and music of part two (js/heist-dialogue.js). Files that
// exist are kept: delete one to render it again. Run only when asked to: every
// file costs credits.
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { heistLines } from '../js/heist-dialogue.js';
const out = new URL('../public/assets/last-train/', import.meta.url);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw Error('Set ELEVENLABS_API_KEY to render recordings.');
const voices = {
  father: 'iP95p4xoKVk53GoZ742B',
  friend: 'CwhRBWXzGAHq8TQ4Fs17',
  farmer: 'FIZvRDw8uSn8zhHXF8X1', // a young Moravian voice, calm and happy
  radio: 'bfy52CN42mIGk4Q8TZV5',
  buyer: 'A4QaWrc6j9wnj1l191pm', // a calm middle-aged Czech voice
};
const tracks = heistLines.map(([id, , text, role, direction]) => [
  id,
  'text-to-speech/' + voices[role],
  { model_id: 'eleven_v4', language_code: 'cs', text: '[' + direction + '] ' + text },
]);
const effects = [
  ['plate-rip', 2.0, 'A metal car licence plate is torn off its plastic holder by hand: plastic clips snap, thin sheet metal flexes and rings, then the plate drops on gravel. Close, dry. No voices.'],
  ['starter-fail', 2.3, 'From the driver seat of an old petrol saloon car that stood unused for months: the starter motor cranks slowly, labours and gives up. The engine does not start. No voices.'],
  ['starter-catch', 3.4, 'From the driver seat of an old petrol saloon car: the starter motor cranks, the engine coughs, catches and settles into a rough uneven idle. No voices.'],
  ['alarm-chirp', 1.2, 'A tiny electronic double beep from a car alarm module inside a closed car, quiet and high, then silence. No siren.'],
  ['camera-flash', 1.1, 'A roadside speed camera fires: a sharp xenon flash pop and a short capacitor whine. Outdoors, heard from a passing car. No voices.'],
  ['garage-door', 4.2, 'A steel up-and-over lock-up garage door is pulled down by hand: springs creak, metal rattles along its rails and the door slams shut with a booming echo inside the garage. No voices.'],
  ['hens', 9, 'A Czech farmyard before dawn: a few hens cluck softly and scratch, one flaps its wings, a distant cock crows once. Calm, no people, no music.'],
  ['window-climb', 3.2, 'Night, outside a quiet house: someone climbs a creaky wooden ladder in a hurry, pushes a wooden window sash open and drops down onto a wooden floor inside. Close, careful. No voices, no music.'],
  ['house-door', 2.4, 'Inside a silent house: a door latch is turned with a click, a heavy wooden back door opens with a small creak and is closed softly from outside. No voices.'],
  ['villa-alarm', 3.4, 'Inside a house a burglar alarm goes off: a short electronic warble, then a loud two-tone siren echoing in the rooms. Sudden and frightening. No voices.'],
  ['key-pick', 1.3, 'A car key with a plastic fob on a metal ring is picked up from a wooden desk: a small slide and a jingle. Very close, quiet. No voices.'],
  ['forest-night', 14, 'A cold forest at the end of night in Central Europe: light wind in pines, a tawny owl calls twice far away, a twig snaps. Very quiet, no people, no music.'],
];
tracks.push(...effects.map(([id, duration_seconds, text]) => [id, 'sound-generation', { model_id: 'eleven_text_to_sound_v3', duration_seconds, text }]));
tracks.push([
  'reggae',
  'music',
  {
    model_id: 'music_v2_5',
    music_length_ms: 60000,
    force_instrumental: true,
    prompt:
      'Laid-back roots reggae instrumental as if playing from an old van radio. One drop drum beat, deep round bass line, offbeat skank guitar, bubbling organ, a lazy melodica melody. Warm, sunny, slightly lo-fi, 72 bpm. No singing, no speech. Steady groove from the first bar so it can loop.',
  },
]);
tracks.push([
  'villa-music',
  'music',
  {
    model_id: 'music_v2_5',
    music_length_ms: 80000,
    force_instrumental: true,
    prompt:
      'Slow, sneaky detective funk instrumental for a night break-in in a rich house. Muted wah-wah guitar scratches, a creeping electric bass line, tight dry drums with rimshots and closed hi-hat, low Rhodes electric piano chords, a cool vibraphone hook, now and then bongos and a flute lick. Tense but playful, quiet dynamics, 84 bpm. No singing, no speech. Steady groove from the first bar to the last, so it can loop.',
  },
]);
await mkdir(out, { recursive: true });
for (const [id, endpoint, body] of tracks) {
  const file = new URL(id + '.mp3', out);
  if (await stat(file).catch(() => null)) continue;
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.elevenlabs.io/v1/' + endpoint, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
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
    console.log(id, body.model_id, bytes.length);
    break;
  }
}
