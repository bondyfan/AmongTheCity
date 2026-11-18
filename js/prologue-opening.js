import { hospitalCall, friendCall, bankMessage } from './prologue-dialogue.js';
import { storyRecording } from './audio.js';
import { roofFrame } from './prologue-route.js';
import { storyClock } from './prologue-clock.js';
import { actor } from './prologue-actor.js';
import { streetScene } from './prologue-street.js';
import { ward } from './prologue-ward.js';
import { rooftop } from './prologue-roof.js';

// The film before the game: the call on the street, four seconds at his
// daughter's bed, a black card, the roof, Vašek. One beat at a time:
//   ring1 → call1 → out1 → card → est → drop → sms → ring2 → call2 → done
// E answers a ringing phone. Speech and shots are never skipped.
const SILENT = { est: 5.2, drop: 3.4, sms: 6.2, out1: 3.1, card: 3.3 };
const CUT_AT = 3.2, // seconds into the nurse's long sentence
  CUT_FOR = 4.2;

export function opening({ scene, world, player, hud, birds, lights, done }) {
  const act = actor(player, lights);
  const streetSet = streetScene(world, player, act);
  const roofSet = rooftop(scene, world, player, act, lights);
  const room = ward(scene, lights, roofFrame.x, world.terrain.heightAt(roofFrame.x, roofFrame.z) - 42, roofFrame.z);
  let beat = '',
    age = 0, // seconds in this beat
    line = -1,
    lineAge = 0,
    wait = Infinity, // pause after the voice ends
    safety = 0, // a line never holds the film for ever
    token = 0,
    voice = null,
    ring = null,
    live = true;
  const music = storyRecording('roof-music', { level: 0.2, loop: true });
  const script = () => (beat === 'call1' ? hospitalCall : friendCall);
  function say(index) {
    line = index;
    lineAge = 0;
    voice?.stop();
    const [id, who, words, role] = script()[index];
    hud.say(who, words);
    hud.phone(beat === 'call1' ? 'Nemocnice' : 'Vašek', 'Probíhá hovor');
    hud.action();
    const mine = ++token;
    wait = Infinity;
    safety = Math.max(15, words.length * 0.16);
    voice = storyRecording(id, {
      phone: role !== 'father',
      meter: role === 'father',
      level: role === 'father' ? 0.95 : 1.08,
      end: () => {
        if (live && token === mine) wait = 0.55;
      },
      // no recording: hold the caption for as long as it takes to read
      missing: () => {
        if (live && token === mine) wait = 1.3 + words.length * 0.062;
      },
    });
  }
  function enter(next) {
    beat = next;
    age = 0;
    ring?.stop();
    ring = null;
    if (room.on && next !== 'call1') room.show(false);
    if (next === 'ring1' || next === 'ring2') {
      line = -1;
      voice?.stop();
      hud.say();
      hud.phone(next === 'ring1' ? 'Nemocnice' : 'Vašek');
      hud.action('Přijmout hovor');
      ring = storyRecording('phone-ring', { level: 0.49, loop: true });
      if (next === 'ring2') birds?.scare('roof');
    } else if (next === 'call1' || next === 'call2') say(0);
    else {
      ++token;
      voice?.stop();
      hud.say();
      hud.action();
      hud.phone();
      if (next === 'card') {
        // the cut happens in the dark: a few minutes pass and he is on the roof
        hud.veil(true, 'O chvíli později', 'Kolín · střecha domu');
        storyClock.to(20 + 3 / 60);
        roofSet.begin();
      }
      if (next === 'est') hud.veil(false);
      if (next === 'sms') {
        storyRecording('phone-ring', { level: 0.4 });
        hud.phone(bankMessage[0], '', bankMessage[1]);
      }
    }
  }
  function advance() {
    const order = ['ring1', 'call1', 'out1', 'card', 'est', 'drop', 'sms', 'ring2', 'call2', 'done'];
    const next = order[order.indexOf(beat) + 1];
    if (next === 'done') {
      // he hangs up, and the roof and the three minutes are the player's
      ++token;
      voice?.stop();
      hud.say();
      hud.action();
      hud.phone();
      roofSet.handOver();
      roofSet.release();
      act.release();
      music.stop(2.3);
      hud.veil(false);
      hud.cinema(false);
      beat = 'done';
      done();
      return;
    }
    enter(next);
  }
  function nextLine() {
    if (line + 1 < script().length) say(line + 1);
    else advance();
  }
  storyClock.start(20);
  hud.cinema(true);
  streetSet.begin();
  enter('ring1');
  const onStreet = () => beat === 'ring1' || beat === 'call1' || beat === 'out1';
  const inCut = () => beat === 'call1' && line === 2 && lineAge > CUT_AT && lineAge < CUT_AT + CUT_FOR;
  return {
    get running() {
      return beat !== 'done';
    },
    use() {
      if (beat === 'done') return false;
      // E answers the phone and nothing else: nobody talks faster for a key
      if (beat === 'ring1' || beat === 'ring2') advance();
      return true;
    },
    update(dt) {
      if (beat === 'done') return;
      age += dt;
      storyClock.flow(dt, 20 + 5 / 60);
      if (beat === 'call1' || beat === 'call2') {
        lineAge += dt;
        if ((wait -= dt) <= 0 || (safety -= dt) <= 0) nextLine();
        const cut = inCut();
        if (cut !== room.on) room.show(cut);
        room.update(dt);
      } else if (SILENT[beat]) {
        // the screen goes black a little before a silent beat hands over
        if (beat === 'out1' && age > SILENT[beat] - 1.1) hud.veil(true);
        if (age >= SILENT[beat]) advance();
      }
    },
    pose(dt) {
      if (beat === 'done') return false;
      // while the film is at her bedside he is not in it (and the two lamps are hers)
      if (room.on) return true;
      const speech = voice?.intensity() ?? 0;
      if (onStreet()) streetSet.pose(dt, beat === 'ring1' ? -1 : beat === 'call1' ? line : 6, speech);
      else {
        const calling = beat === 'call2';
        roofSet.pose(dt, {
          gesture: calling ? 'ear' : beat === 'sms' || (beat === 'ring2' && age > 0.9) ? 'read' : null,
          emotion: beat !== 'est' && beat !== 'drop',
          speech,
          down: calling && line >= 7,
          face: calling && line >= 8,
        });
      }
      return true;
    },
    camera(camera, dt) {
      if (beat === 'done') return false;
      if (room.on) room.camera(camera);
      else if (onStreet()) streetSet.camera(camera, dt, beat === 'ring1' ? -1 : beat === 'call1' ? line : 6);
      else roofSet.camera(camera, dt, beat === 'call2' ? 'f' + line : beat === 'ring2' ? 'ring' : beat);
      return true;
    },
    // Test harness: cut straight to a beat (and a line of its call).
    seek(name, index = 0) {
      if (name === 'est' || name === 'drop' || name === 'sms' || name === 'ring2' || name === 'call2') {
        roofSet.begin();
        hud.veil(false);
      }
      enter(name);
      if (index) say(index);
    },
    street: streetSet,
    dispose() {
      live = false;
      voice?.stop();
      ring?.stop();
      music.stop(0.4);
      room.dispose();
      roofSet.dispose();
      act.dispose();
    },
  };
}
