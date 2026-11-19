import { trainStart, trainStop, trainSet, sfx, storyRecording, storyTone } from './audio.js';

// What the railway sounds like in the story. The last train is not one of the
// timetable's (js/trains.js), so nothing ever started the ride sound for it:
// this gives it the same synthesised ride (a low idle at the platform that
// fades with distance, the roar and the rail joints inside), a horn as it
// pulls out and the brakes as it comes in. The stations speak too: a three
// note chime and an announcement thrown round the hall by its own echo.
const VMAX = 44.4; // m/s, the story train's top speed (prologue.js)
const HEAR = 60; // metres at which a walker stops hearing it

export function trainVoice(hud) {
  let on = false,
    horned = false,
    braked = false,
    live = true,
    speech = null;
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
    // [id, speaker, words] from prologue-dialogue.js; level 0..1 by distance.
    announce([id, who, words], level = 1) {
      [659, 523, 784].forEach((note, i) => setTimeout(() => live && storyTone(note, 0.36, 0.1 * level), i * 430));
      setTimeout(() => {
        if (!live) return;
        hud.say(who, words);
        const done = () => live && hud.say();
        speech = storyRecording(id, { hall: true, level: 1.7 * level, end: done, missing: () => setTimeout(done, 9000) });
      }, 1600);
    },
    stop() {
      live = false;
      speech?.stop();
      if (on) trainStop();
      on = false;
    },
  };
}
