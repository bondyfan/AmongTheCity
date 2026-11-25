import { trainStart, trainStop, trainSet, sfx, storyRecording, storyTone } from './audio.js';

// What the railway sounds like in the story. The last train is not one of the
// timetable's (js/trains.js), so nothing ever started the ride sound for it:
// this gives it the same synthesised ride (a low idle at the platform that
// fades with distance, the roar and the rail joints inside), a horn as it
// pulls out and the brakes as it comes in. The stations speak too: a three
// note chime and an announcement thrown round the hall by its own echo.
const VMAX = 44.4; // m/s, the story train's top speed (prologue.js)
const HEAR = 60; // metres at which a walker stops hearing it
// THE LOUDSPEAKERS ARE IN THE STATION (Frank, 25 Nov 2026: "to hlášení zní
// strašně moc nahlas, i když jsem od toho daleko"). An announcement used to
// play at one level wherever he stood. Now it is as loud as he is near: full
// in the hall and on the platforms (within PA_FULL of them), falling away to
// nothing PA_REACH further out, and it follows him while it plays.
export const PA_FULL = 55,
  PA_REACH = 120;
/** 0..1: how much of the station's announcement reaches someone `metres` from it. */
export function paLevel(metres) {
  const k = 1 - Math.max(0, metres - PA_FULL) / PA_REACH;
  return k <= 0 ? 0 : Math.min(1, k) ** 2;
}

export function trainVoice(hud) {
  let on = false,
    horned = false,
    braked = false,
    live = true,
    speech = null,
    base = 1, // the announcement's own level
    heard = 1; // 0..1 by how far he is from the station (hear)
  return {
    // aboard: he is inside it. metres: how far he is from it otherwise.
    update(aboard, metres, speed) {
      const level = aboard ? 1 : Math.max(0, 1 - metres / HEAR) * 0.6;
      if (level < 0.02) {
        if (on) trainStop();
        on = false;
        return;
      }
      trainStart(); // idempotent, and it may have been refused before the first click
      on = true;
      trainSet(Math.abs(speed) / VMAX, level);
    },
    // Once, as the doors have closed and it begins to move.
    depart(aboard, metres) {
      if (horned) return;
      horned = true;
      if (aboard || metres < 140) sfx('train_horn', aboard ? 0.32 : 0.5);
    },
    // Once, on the last metres into the station.
    brake(left, speed) {
      if (braked || left > 95 || speed < 3) return;
      braked = true;
      storyRecording('brake', { level: 0.75 });
    },
    // [id, speaker, words] from prologue-dialogue.js. How loud it is where he
    // stands is hear()'s business, every frame.
    announce([id, who, words], level = 1) {
      base = level;
      [659, 523, 784].forEach((note, i) => setTimeout(() => live && storyTone(note, 0.36, 0.1 * base * heard), i * 430));
      setTimeout(() => {
        if (!live) return;
        hud.say(who, words);
        const done = () => {
          speech = null;
          if (live) hud.say();
        };
        speech = storyRecording(id, { hall: true, level: 1.7 * base * heard, end: done, missing: () => setTimeout(done, 9000) });
      }, 1600);
    },
    // metres from the station whose loudspeakers are talking
    hear(metres) {
      heard = paLevel(metres);
      speech?.set(1.7 * base * heard, 0.2);
    },
    stop() {
      live = false;
      speech?.stop();
      if (on) trainStop();
      on = false;
    },
  };
}
