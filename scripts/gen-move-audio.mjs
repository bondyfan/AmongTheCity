// ELEVENLABS_API_KEY=… node scripts/gen-move-audio.mjs [--voices] [--only id,id]
//
// The sounds of the doors and the body (the step between parts one and two of
// the campaign): a locked handle, a door opening and slamming, the central
// locking, a body on tarmac, a landing, a hand on a bonnet, handcuffs, getting
// up. One file per id into public/assets/sounds/, where js/audio.js sfx() and
// sfxOr() find them by name. A file that exists is left alone, so a second
// run only fills what is missing. --voices adds the three spoken lines.
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
  ['car_door_locked', 1.0, 'Close up, outdoors. A hand pulls a locked car door handle twice, quick: two short hollow plastic and metal clacks of a handle that does not release, a slight rattle of the door in its frame. No door opening, no voices, no engine.'],
  ['car_door_open', 1.2, 'Close up, outdoors. A modern hatchback car door handle is pulled, the latch releases with a click and the door swings open on its hinge with a soft creak of the check strap. Opening only, no slam, no voices.'],
  ['car_door_slam', 1.0, 'From inside a modern car: the driver pulls the door shut. One solid, damped, low thud of a well sealed car door closing, a faint rattle of the window glass, then silence. One event, no voices.'],
  ['car_lock', 0.8, 'Close up. Central locking of a car engages: one firm double clunk of four door lock actuators at once. Dry, no beep, no voices.'],
  ['body_fall', 1.2, 'Outdoors on a street. A grown man in a jacket falls and lands hard on asphalt: a heavy dull thud of a body, cloth scraping on tarmac, a short exhaled grunt. No words, no music.'],
  ['jump_land', 0.6, 'Close up. Two sneakers land on concrete pavement after a jump: one compact double thud with a little grit under the soles. No voice.'],
  ['vault', 0.9, 'Close up. A palm slaps down on the sheet metal bonnet of a car and a person swings over it: a hollow metallic thump, a quick rustle of a nylon jacket. No voice.'],
  ['handcuffs', 1.5, 'Close up. Steel police handcuffs are put on two wrists: a short chain jingle, then two fast metallic ratchet zips, each ending in a click. No voices.'],
  ['getup', 1.0, 'Close up, outdoors. A person pushes up from the ground and gets to their feet: palms and shoes scraping on gritty asphalt, cloth rustling, one short breath of effort. No words.'],
];

// [id, voice, text, direction]: Czech, the same model the campaign's lines use
const voices = [
  ['voice_carjack_m', 'iP95p4xoKVk53GoZ742B', 'Hej! To je moje auto!', 'shouting, shocked and angry, outdoors'],
  ['voice_carjack_f', 'EXAVITQu4vr4xnSDxMaL', 'Hej! To je moje auto!', 'shouting, frightened and angry, outdoors'],
  ['voice_police_out', 'CwhRBWXzGAHq8TQ4Fs17', 'Policie! Vystupte z vozu!', 'a policeman shouting an order, firm, outdoors'],
  ['voice_police_hands', 'CwhRBWXzGAHq8TQ4Fs17', 'Ruce za hlavu!', 'a policeman shouting an order, firm, close'],
];

const tracks = effects.map(([id, duration_seconds, text]) => [
  id, 'sound-generation', { model_id: 'eleven_text_to_sound_v3', duration_seconds, text },
]);
if (args.includes('--voices')) {
  for (const [id, voice, text, direction] of voices)
    tracks.push([id, 'text-to-speech/' + voice, { model_id: 'eleven_v4', language_code: 'cs', text: '[' + direction + '] ' + text }]);
}

await mkdir(out, { recursive: true });
for (const [id, endpoint, body] of tracks) {
  if (only && !only.has(id)) continue;
  const file = new URL(id + '.mp3', out);
  if (await stat(file).catch(() => null)) { console.log(id, 'exists, kept'); continue; }
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
    if (!r.headers.get('content-type')?.includes('audio') || bytes.length < 500)
      throw Error('Invalid audio ' + id);
    const tmp = new URL(id + '.part', out);
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    console.log(id, body.model_id, bytes.length);
    break;
  }
}
