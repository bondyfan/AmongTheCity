import { trainStart, trainStop, trainSet, sfx } from './audio.js';

// The last train's own voice. The story train is not one of the timetable's
// (js/trains.js), so nothing ever started the ride sound for it and it stood,
// left and ran in silence. This gives it the same synthesised ride: a low
// idle at the platform that fades with distance, a horn as it pulls out, the
// roar and the rail joints inside, and the same going by when he missed it.
const VMAX = 44.4; // m/s, the story train's top speed (prologue.js)
const HEAR = 60; // metres at which a walker stops hearing it

export function trainVoice() {
  let on = false,
    horned = false;
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
    stop() {
      if (on) trainStop();
      on = false;
    },
  };
}
