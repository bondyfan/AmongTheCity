// Render every line of js/chatterlines.js to speech via the ElevenLabs TTS API.
//   ELEVENLABS_API_KEY=sk_... node scripts/gen-voices.mjs
// Writes <line id>__<cast key>.mp3 into public/assets/voices/ — the folder
// js/audio.js reaches into for any buffer name prefixed "v/". Same key, same
// conventions and the same skip-what-exists rule as ../gen-sounds.mjs; that
// script does the city's bangs and hums, this one does its mouths.
//
// THE CORPUS IS NOT IN THIS FILE. It is imported from js/chatterlines.js, the
// module the GAME imports, which is the entire point: the text in the bubble
// and the text that was sent to the voice model are the same string or the
// build is broken, and there is no second place for a typo fix to fail to
// land. allClips() there is the authority on which files must exist.
//
// COST. ~900 clips of ~30 characters is ~26 000 characters, comfortably inside
// a Creator month, and only files that are MISSING are billed — re-running
// after adding twenty lines bills twenty lines. FORCE=1 re-renders everything
// and should be reached for roughly never; changing a line's text means
// deleting that line's mp3s, which `--stale` does for you.
//
// A run that dies halfway is not a problem: everything already on disk is
// skipped, so you re-run it and it picks up where it stopped.

import { writeFile, mkdir, access, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allClips, CAST } from '../js/chatterlines.js';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('ELEVENLABS_API_KEY is not set — nothing generated.');
  console.error('Run:   ELEVENLABS_API_KEY=sk_... node scripts/gen-voices.mjs');
  console.error('Only missing files are billed (FORCE=1 regenerates everything);');
  console.error('with no voices on disk the game shows the bubbles and stays silent.');
  process.exit(1);
}
const FORCE = process.env.FORCE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'assets', 'voices');

// ---- the cast --------------------------------------------------------------
// The ONLY place an ElevenLabs voice id appears. js/chatterlines.js knows the
// four cast members by key and gender and nothing else, because a vendor
// identifier has no business in a module the browser downloads.
//
// These four are premade multilingual voices. They speak Czech with a trace of
// an accent — which, for a city where half the walkers are somebody's cousin
// from somewhere, is survivable, and it is the trade for not putting a real
// person's cloned voice in a shipped game. Swap any id here for a Czech clone
// from your own account and delete that cast key's mp3s to re-render it:
//   node scripts/gen-voices.mjs --stale && node scripts/gen-voices.mjs
const VOICES = {
  m1: 'iP95p4xoKVk53GoZ742B',   // Chris — middle-aged, casual, down-to-earth
  m2: 'pqHfZKP75CvOlQylNhV4',   // Bill  — older, gruffer, the man at the bus stop
  f1: 'XrExE9yKIg1WjnnlVkGX',   // Matilda — middle-aged woman
  f2: 'cgSgspJ2msm6clMCkdW9',   // Jessica — younger woman
};

// eleven_v3 is the only model here that takes a DELIVERY DIRECTION, and the
// direction is most of the performance: the same six words are a different
// line shouted after a car than muttered into a coat collar, and the corpus
// carries a `tts` note for every one of them for exactly this reason. v3 reads
// bracketed tags inline, so the note is prepended as one — it is stripped from
// the audio, never spoken.
const MODEL = process.env.MODEL || 'eleven_v3';

// Mono, 64 kbps: this is a two-second shout that will be low-passed into
// oblivion by the distance filter in audio.js before anybody hears it. 128 kbps
// stereo would triple the download for a difference that does not survive the
// first ten metres.
const FORMAT = 'mp3_44100_64';

// Three at a time, and that number is measured rather than chosen: at six, a
// Creator-tier key answers the first ~180 clips and then returns 429
// concurrent_limit_exceeded for the remaining 720 — the whole run failed in
// under a minute and looked, from the console, exactly like success. The
// per-tier concurrency cap is small, so the throughput that matters comes from
// not being throttled, not from more workers.
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

// …and the backoff that makes the cap survivable. A 429 is not a failure, it
// is the server saying "later": retrying it after a moment turns a dead clip
// into a slow one, and a run that needed a second pass into one that finishes.
// 5xx gets the same treatment (the service having a bad second); a 4xx that is
// NOT 429 is us being wrong about the request and no amount of waiting fixes
// it, so it fails immediately and loudly.
const RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function render(clip, attempt = 0) {
  const voice = VOICES[clip.castKey];
  if (!voice) throw new Error(`no ElevenLabs voice for cast key "${clip.castKey}"`);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clip.tts ? `[${clip.tts}] ${clip.text}` : clip.text,
        model_id: MODEL,
        // Say it in Czech, not in Czech-shaped English. Without this the model
        // is free to guess from the text, and a three-word line ("No dovolte!")
        // does not give it enough to guess right.
        language_code: 'cs',
        voice_settings: {
          // Low stability is the setting that lets a shout be a shout. The
          // default sits the model in its safe, level, audiobook register,
          // which is the single most common way street dialogue comes back
          // sounding like a museum guide.
          stability: 0.35,
          similarity_boost: 0.75,
          style: 0.45,
          use_speaker_boost: true,
        },
      }),
    });
  if (!res.ok) {
    const why = (await res.text()).slice(0, 200);
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRIES) {
      // 0.8s, 1.6s, 3.2s, 6.4s, 12.8s, jittered so three workers that were
      // throttled together do not all come back in the same millisecond and
      // throttle each other again.
      const wait = 800 * 2 ** attempt * (0.7 + Math.random() * 0.6);
      await sleep(wait);
      return render(clip, attempt + 1);
    }
    throw new Error(`${res.status} ${why}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- --stale: delete the mp3s whose line no longer exists or has changed ----
// The failure this exists to prevent is silent and nasty: fix a typo in a line,
// re-run, nothing regenerates (the file is still there), and from then on the
// bubble reads one sentence while the voice says another. There is no hash in
// an mp3 to compare against, so the honest tool is "here are the files no
// current clip claims, and here is the flag that deletes the ones you edited".
async function stale() {
  const want = new Set(allClips().map((c) => c.file + '.mp3'));
  let have = [];
  try { have = await readdir(OUT); } catch { return; }
  const orphans = have.filter((f) => f.endsWith('.mp3') && !want.has(f));
  for (const f of orphans) { await unlink(join(OUT, f)); console.log('removed orphan', f); }
  console.log(`${orphans.length} orphan(s) removed; ${have.length - orphans.length} kept.`);
  console.log('NOTE: an EDITED line keeps its id, so its mp3 is not an orphan —');
  console.log('delete those by hand (or FORCE=1) or the voice will say the old text.');
}

// ---- run -------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--stale')) { await stale(); process.exit(0); }

await mkdir(OUT, { recursive: true });

// Optional filter: `node scripts/gen-voices.mjs near_miss` or `... m2`
// regenerates just the matching clips, so tuning one category or re-casting
// one voice does not re-bill the set.
const only = args.filter((a) => !a.startsWith('-'));
let clips = allClips();
if (only.length) {
  clips = clips.filter((c) => only.some((o) => c.file.includes(o)));
  console.log(`filter: ${only.join(', ')} → ${clips.length} clip(s)`);
}

const todo = [];
for (const c of clips) {
  if (!FORCE && await exists(join(OUT, c.file + '.mp3'))) continue;
  todo.push(c);
}
const chars = todo.reduce((n, c) => n + c.text.length, 0);
console.log(`${clips.length} clip(s) in the corpus, ${clips.length - todo.length} already on disk.`);
console.log(`rendering ${todo.length} — about ${chars} characters, cast ${CAST.map((c) => c.key).join('/')}, model ${MODEL}`);
if (!todo.length) { console.log('nothing to do.'); process.exit(0); }

let done = 0, failed = 0;
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const c = todo[i];
    try {
      await writeFile(join(OUT, c.file + '.mp3'), await render(c));
      done++;
      if (done % 25 === 0 || done + failed === todo.length) {
        console.log(`  ${done + failed}/${todo.length}  (${failed} failed)`);
      }
    } catch (e) {
      failed++;
      // Keep going. One 429 must not cost the other 899 clips, and every one
      // that failed is simply missing next run — which is the run that fixes it.
      console.error(`FAIL ${c.file}: ${String(e.message || e).slice(0, 160)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
console.log(`done. ${done} written, ${failed} failed.`);
if (failed) console.log('re-run to pick up the failures — existing files are skipped.');
