import { storyClock } from './prologue-clock.js';
import { rideTalk, rideNag, swapAsk, swapInsist, driveTalk, dropLine, dropTalk, byeTalk } from './heist-dialogue.js';
import { farm, hours, dist } from './heist-route.js';

// THE RIDE TO THE FOREST (Frank, 21 Nov 2026). Jarda drives, and out on the
// road he weaves from one side to the other. The father says so and offers to
// drive; Jarda says no and weaves worse; the father insists, and Jarda pulls
// over, walks round the bonnet and gets in on the other side. The rest of the
// way the player drives and Jarda talks. At the forest the player gets out,
// Jarda moves back across, wishes him luck and goes home.
//   ride   Jarda at the wheel: the talk, the first swerves, the two arguments
//   swap   stopped on the verge: change seats
//   drive  the player at the wheel
//   drop   stopped by the forest: get out
// `update` returns true when he is on his feet by the forest road. A ride
// skipped on a retry (js/story-retry.js) is the old one: Jarda drives it all.
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const km = (m) => (m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km');
const END = { x: farm.ride.at(-1)[0], z: farm.ride.at(-1)[1] };

export function rideScript({ hud, talk, farmer, host, player, goal }) {
  let stage = 'ride',
    age = 0,
    beat = 0, // where the talk has got to in `ride`
    wait = 3.5,
    far = 1,
    said = false;
  const van = farmer.van;
  const onFoot = () => !player.inCar && !player.boarding && !player.exiting;
  const then = (seconds, next) => () => {
    beat = next;
    wait = seconds;
  };
  function enter(next) {
    stage = next;
    age = 0;
    hud.action();
    if (next === 'swap') goal(null);
    if (next === 'drive') {
      far = Math.max(200, dist(van, END));
      goal(END, 'Les u Ráb');
      said = false;
    }
    if (next === 'drop') {
      goal(null);
      storyClock.to(hours.drop);
      talk.run(farmer.hopped ? dropTalk : [dropLine], { gap: 0.7 });
    }
  }
  return {
    get stage() {
      return stage;
    },
    // can this stretch be skipped with T (only while Jarda still drives)?
    get skippable() {
      return stage === 'ride' && !farmer.hopped && farmer.stage === 'ride' && beat < 6;
    },
    // E: nobody gets out of a van that is moving
    use() {
      return stage === 'ride';
    },
    update(dt) {
      age += dt;
      if (stage === 'ride') {
        storyClock.to(lerp(hours.farm, hours.drop, age / 130));
        hud.guide('', '', '');
        if (farmer.stage === 'stopped') return enter('drop'), false;
        if (farmer.stage === 'swap') return enter('swap'), false;
        if (farmer.hopped) return false; // the skipped ride says nothing more
        wait -= dt;
        // 0 the track → 1 on the road, the first swerves → 2 "I'll drive" → 3 worse → 4 "stop" → 5 pulling over
        if (beat === 0 && wait <= 0) (beat = -1), talk.run(rideTalk, { gap: 1.3, done: then(0.5, 1) });
        else if (beat === 1 && wait <= 0 && farmer.onRoad) (beat = -1), farmer.weave(1), talk.run(rideNag, { gap: 0.9, done: then(3.2, 2) });
        else if (beat === 2 && wait <= 0) (beat = -1), talk.run(swapAsk, { gap: 0.6, done: then(5.5, 3) });
        else if (beat === 3) farmer.weave(2), (beat = 4);
        else if (beat === 4 && wait <= 0) (beat = -1), talk.run(swapInsist, { gap: 0.6, done: then(0, 5) });
        else if (beat === 5 && farmer.pullOver()) beat = 6;
        return false;
      }
      if (stage === 'swap') {
        const out = player.inCar !== van;
        hud.guide('Silnice na Ráby', 'Sedni si za volant', out ? 'Obejdi dodávku ke dveřím řidiče a stiskni E' : 'E: vystup a obejdi dodávku');
        if (out) goal(van, 'Dodávka', false);
        if (host.driving() === van && farmer.stage === 'shotgun') enter('drive');
        return false;
      }
      if (stage === 'drive') {
        const left = dist(van, END);
        storyClock.to(lerp(hours.farm + 0.12, hours.drop, 1 - left / far));
        hud.guide('Ráby', left < 45 ? 'Zastav u lesa a vystup' : 'Dojeď k lesu', km(left));
        if (!said && age > 3) (said = true), talk.run(driveTalk, { gap: 3.5 });
        if ((van.damage ?? 0) >= 1) host.fail('wreck');
        // stopped by the forest, or out of the van anywhere near it
        else if (left < 45 && (host.driving() !== van ? onFoot() : Math.abs(van.speed) < 0.9 && left < 30)) enter('drop');
        return false;
      }
      // drop: he gets out; Jarda takes his van back
      hud.guide('Ráby', 'Vystup', 'E');
      if (onFoot() && dist(player.pos, van) > 2.2) {
        if (farmer.hopped) farmer.leave();
        else {
          farmer.takeWheel();
          talk.run(byeTalk, { gap: 0.6, done: () => farmer.leave() });
        }
        return true;
      }
      return false;
    },
    // T on a retry: Jarda drives the whole way, and it is over in a moment
    skip() {
      if (!this.skippable || !farmer.skipRide(hud)) return false;
      talk.stop();
      return true;
    },
  };
}
