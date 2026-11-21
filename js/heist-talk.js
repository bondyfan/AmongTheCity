import { storyRecording } from './audio.js';

// Lines that follow one another by themselves (Frank, 18 Nov 2026: nothing
// spoken is skipped or waited for). One conversation at a time: starting a new
// one ends the old. A line is [id, name, words, role]; on the phone the other
// end sounds like a phone and the father does not.
export function talker(hud) {
  let voice = null,
    timer = 0,
    token = 0,
    busy = false,
    role = '',
    finish = null; // what waits for the end of the talk that is running
  function stop() {
    finish = null;
    ++token;
    clearTimeout(timer);
    voice?.stop();
    voice = null;
    busy = false;
    role = '';
    hud.say();
  }
  return {
    get busy() {
      return busy;
    },
    // who is speaking right now ('' between lines) and how loud (0..1)
    get role() {
      return role;
    },
    level() {
      return voice?.intensity() ?? 0;
    },
    run(lines, { phone = false, level = 1.8, gap = 0.45, each, done } = {}) {
      stop();
      busy = true;
      finish = done;
      const mine = token;
      let i = -1;
      const next = () => {
        if (token !== mine) return;
        if (++i >= lines.length) {
          busy = false;
          role = '';
          finish = null;
          hud.say();
          done?.();
          return;
        }
        const [id, name, words, who] = lines[i];
        role = who;
        hud.say(name, words);
        each?.(i, who);
        const on = () => {
          if (token === mine) next();
        };
        voice = storyRecording(id, {
          level,
          meter: true,
          phone: phone && who !== 'father',
          end: () => (timer = setTimeout(on, gap * 1000)),
          missing: () => (timer = setTimeout(on, 1300 + words.length * 62)),
        });
      };
      next();
    },
    // One line on its own (the radio, a word to the car).
    one(line, opts) {
      this.run([line], opts);
    },
    stop,
    // T after a failed mission (js/story-retry.js): the talk is over now, and
    // whatever waited for its last word happens.
    skip() {
      const then = finish;
      stop();
      then?.();
    },
  };
}
