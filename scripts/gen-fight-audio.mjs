// ELEVENLABS_API_KEY=… node scripts/gen-fight-audio.mjs [--only id,id]
//
// The sounds of a fist fight (js/fightsfx.js): two swings, three punches to the
// face, one heavy body hook, a block, and the grunts of whoever is hit, three
// men's and two women's. Frank asked for them made with ElevenLabs on 25 Nov
// 2026 ("i zvuky... přes Eleven Labs"). One file per id into
// public/assets/sounds/, where js/audio.js sfxAt() finds them by name. A file
// that exists is left alone, so a second run only fills what is missing.
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
  ['fight_swing_1', 0.5, 'Close up. A fast fist punch swings through the air: one short, sharp whoosh of an arm and a jacket sleeve cutting the air. No impact, no voice, no music.'],
  ['fight_swing_2', 0.5, 'Close up. A quick boxing jab whips past the microphone: one short airy swish of a cotton sleeve. No impact, no voice, no music.'],
  ['fight_punch_1', 0.5, 'Close up, outdoors. A bare fist punch lands on a man\'s face: one hard, dry, meaty smack with a slight crunch, like a street fight in an action film. One single hit, no voice, no music.'],
  ['fight_punch_2', 0.5, 'Close up. Knuckles hit a jaw: one tight, punchy slap and thud of a fist on a cheek, action film foley. One single hit, no voice, no music.'],
  ['fight_punch_3', 0.5, 'Close up. A punch to the face: one short heavy thwack of skin and bone, dry and punchy. One single impact, no voice, no music.'],
  ['fight_punch_heavy', 0.8, 'Close up. A heavy hook punch lands hard in a man\'s ribs: one deep, powerful, bassy body thump with a rustle of a jacket, action movie foley. One single impact, no voice, no music.'],
  ['fight_block', 0.5, 'Close up. A punch is blocked by raised forearms: one dull, padded thud of a fist on a forearm and a jacket sleeve. Short, no voice, no music.'],
  ['fight_grunt_m_1', 0.7, 'Close up, outdoors. A grown man is punched in the face and lets out one short, pained grunt through his teeth. Nonverbal, no words, no music.'],
  ['fight_grunt_m_2', 0.7, 'Close up. A man is punched in the stomach and lets out one short, winded groan as the air is knocked out of him. Nonverbal, no words, no music.'],
  ['fight_grunt_m_3', 0.8, 'Close up. A man takes a hard punch and gives one sharp, pained exhale and grunt. Nonverbal, no words, no music.'],
  ['fight_grunt_f_1', 0.7, 'Close up, outdoors. A woman is struck and lets out one short, pained gasp. Nonverbal, no words, no music.'],
  ['fight_grunt_f_2', 0.7, 'Close up. A woman is hit and gives one short, pained grunt. Nonverbal, no words, no music.'],
];

await mkdir(out, { recursive: true });
for (const [id, duration_seconds, text] of effects) {
  if (only && !only.has(id)) continue;
  const file = new URL(id + '.mp3', out);
  if (await stat(file).catch(() => null)) { console.log(id, 'exists, kept'); continue; }
  const body = { model_id: 'eleven_text_to_sound_v3', duration_seconds, text, prompt_influence: 0.6 };
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
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
