// Render the flight's public address, cabin and chime sounds with ElevenLabs.
//   ELEVENLABS_API_KEY=... node scripts/gen-flight-audio.mjs
//   ELEVENLABS_API_KEY=... node scripts/gen-flight-audio.mjs --only=board-740,chime
//
// Writes one mp3 per line into public/assets/flight/<id>.mp3, and the two chimes as
// chime.mp3 and cabin-chime.mp3. The text comes from js/flight-announce-lines.js,
// the same module the game imports, so what is spoken is what is shown.
//
// A two-language line is two requests, one per language, joined into one file in
// playback order: the Czech part is said with language_code cs and the English part
// with en, so neither language is read with the other's accent. The join is a byte
// concatenation of the two mp3 streams, which decoders play straight through.
//
// Only files that do not exist yet are billed: re-running costs nothing for lines
// already on disk. A line that fails is missing next run, which is the run that
// fixes it. Delete a line's mp3 by hand to re-render it after editing its text.

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { LINES, SOUND_IDS } from '../js/flight-announce-lines.js';

const out = new URL('../public/assets/flight/', import.meta.url);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw Error('Set ELEVENLABS_API_KEY to render the flight audio.');

// The voices the project already uses (scripts/gen-prologue-audio.mjs and
// scripts/gen-voices.mjs). The airport's public address is the station announcer
// of the last train, a calm female; the cabin crew is a younger woman; the captain
// is an older man.
const VOICE = {
  pa: 'EXAVITQu4vr4xnSDxMaL',      // Sarah, the station announcer of the prologue
  crew: 'cgSgspJ2msm6clMCkdW9',    // Jessica, from js/chatterlines.js
  captain: 'pqHfZKP75CvOlQylNhV4', // Bill, older and deeper
};

// The two chimes are sounds, not speech.
const SOUNDS = {
  chime: {
    duration_seconds: 2,
    text: 'A classic airport public address chime: two clean bell-like tones, a bright ding followed by a lower dong. Dry, no reverb, no voice, no music, about two seconds.',
  },
  'cabin-chime': {
    duration_seconds: 1.6,
    text: 'A single soft aircraft cabin chime: one clean bright electronic tone with a short bell decay. Dry, no reverb, no voice, no music, about one and a half seconds.',
  },
};

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
const wanted = (id) => !only || only.includes(id);

// Every request goes through here, so the count printed at the end is the real one.
let requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 and 5xx are the service asking for patience: retry with jittered backoff.
// Any other 4xx means the request itself is wrong, and waiting does not fix it.
async function post(endpoint, body) {
  for (let attempt = 0; ; attempt++) {
    requests++;
    const res = await fetch('https://api.elevenlabs.io/v1/' + endpoint, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!res.headers.get('content-type')?.includes('audio') || bytes.length < 500)
        throw Error('invalid audio (' + bytes.length + ' bytes)');
      return bytes;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) {
      await sleep(1500 * 2 ** attempt * (0.7 + Math.random() * 0.6));
      continue;
    }
    throw Error(res.status + ' ' + (await res.text()).slice(0, 300));
  }
}

// Each response starts with an ID3v2 tag. Joined mid-stream it is a packet that is
// not an mp3 frame, so it is cut out; the frames after it are the audio.
function joinMp3(parts) {
  return Buffer.concat(parts.map((b) => {
    if (b.subarray(0, 3).toString('latin1') !== 'ID3') return b;
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return b.subarray(10 + size);
  }));
}

const speak = (role, lang, text) =>
  post('text-to-speech/' + VOICE[role] + '?output_format=mp3_44100_64', {
    model_id: 'eleven_v4',
    language_code: lang,
    text,
    voice_settings: { stability: 0.6, similarity_boost: 0.75, use_speaker_boost: true },
  });

const jobs = [
  ...LINES.map((line) => ({
    id: line.id,
    render: async () => {
      // one request per language, in playback order
      const parts = [];
      for (const p of line.parts) parts.push(await speak(line.role, p.lang, p.text));
      return joinMp3(parts);
    },
  })),
  ...SOUND_IDS.map((id) => ({
    id,
    render: () => post('sound-generation', {
      model_id: 'eleven_text_to_sound_v3',
      duration_seconds: SOUNDS[id].duration_seconds,
      text: SOUNDS[id].text,
    }),
  })),
].filter((j) => wanted(j.id));

await mkdir(out, { recursive: true });
let written = 0, skipped = 0, failed = 0;
for (const job of jobs) {
  const file = new URL(job.id + '.mp3', out);
  if (await stat(file).catch(() => null)) { skipped++; continue; }
  try {
    const bytes = await job.render();
    const tmp = new URL(job.id + '.part', out);
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    written++;
    console.log(job.id, bytes.length, 'bytes');
  } catch (e) {
    failed++;
    console.error('FAIL', job.id + ':', String(e.message || e).slice(0, 300));
  }
}
console.log(`done. ${written} written, ${skipped} already on disk, ${failed} failed, ${requests} ElevenLabs request(s).`);
if (failed) console.log('re-run to pick up the failures, existing files are skipped.');
