// ELEVENLABS_API_KEY=… node scripts/gen-prologue-audio.mjs
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { calls, parkingLines, tableTalk } from '../js/prologue-dialogue.js';
const out = new URL('../public/assets/last-train/', import.meta.url);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw Error('Set ELEVENLABS_API_KEY to render recordings.');
const voices = {
  care: 'EXAVITQu4vr4xnSDxMaL',
  father: 'iP95p4xoKVk53GoZ742B',
  friend: 'CwhRBWXzGAHq8TQ4Fs17',
};
const tracks = [...calls, ...parkingLines, ...tableTalk]
  .filter((l) => l[3])
  .map(([id, , text, role, direction]) => [
    id,
    'text-to-speech/' + voices[role],
    { model_id: 'eleven_v4', language_code: 'cs', text: '[' + direction + '] ' + text },
  ]);
const effects = [
  [
    'phone-ring',
    3.5,
    'Close, small mobile phone vibrating against a jacket zip, two restrained electronic incoming call pulses. Dry, no voices.',
  ],
  [
    'door',
    2.8,
    'From a passenger vestibule in a Czech intercity train. Two brief warning beeps, paired plug doors hiss into their seals, heavy latch clicks. One event.',
  ],
  [
    'open',
    1.7,
    'Close train door pneumatic release, sliding metal and rubber door guides, short soft stop. Opening only.',
  ],
  [
    'junction',
    3.8,
    'Inside a modern Czech intercity passenger coach crossing one set of points. A distant soft double thump underneath, a brief window rattle then quiet. No engine roar.',
  ],
  [
    'coach-pass',
    3.7,
    'From INSIDE a sealed train coach at speed an opposing passenger train rushes past the window. Low muffled pressure swell, three soft pulses, recedes suddenly.',
  ],
  [
    'platform-pass',
    5,
    'From a railway platform, electric passenger train passes the listener outdoors. Sharp wheel hiss with audible Doppler and wind, then recedes. No horn.',
  ],
  [
    'passenger',
    3.4,
    'Close interior of a quiet railway coach. One passenger walks past on carpet with a coat brushing a seat and a faint rustle of a newspaper. No intelligible speech.',
  ],
  [
    'skip-rail',
    4.2,
    'A brief rhythmic steel wheel clickety clack transitioning to a soft air rush, brisk train travel montage, gentle decay to silence. No music.',
  ],
];
tracks.push(
  ...effects.map(([id, duration_seconds, text]) => [
    id,
    'sound-generation',
    { model_id: 'eleven_text_to_sound_v3', duration_seconds, text },
  ]),
);
tracks.push([
  'roof-music',
  'music',
  {
    model_id: 'music_v2_5',
    music_length_ms: 52000,
    force_instrumental: true,
    prompt:
      'Intimate Czech drama film score at evening. Sparse felt upright piano, three descending notes separated by silence, a solo viola enters almost inaudibly. Restrained melancholy, fragile and warm. No percussion, no singing, no narration. Quiet ending suitable for a crossfade.',
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
    if (!r.headers.get('content-type')?.includes('audio') || bytes.length < 500)
      throw Error('Invalid audio ' + id);
    const tmp = new URL(id + '.part', out);
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    console.log(id, body.model_id, bytes.length);
    break;
  }
}
