// Sitting down in the coach, as a movement and not as a cut. He turns in the
// aisle, backs up to the cushion, folds at the hips and lowers himself; the
// camera is the game's own and stays where the player put it. Standing up is
// the same movement played back. u runs along the train, v across it.
const SIT = 1.25, // seconds to sit down
  RISE = 0.85,
  DROP = 0.425, // how far the hips come down onto the cushion
  AISLE = 0.12; // where he stands in the aisle before he sits
const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;
// the short way round from one heading to another
function turn(from, to, t) {
  const d = ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return from + d * t;
}

export function seating(player) {
  let seat = null, // { u, v } of the cushion
    t = 0, // 0 standing in the aisle … 1 seated
    rising = false,
    from = null,
    age = 0;
  return {
    get taken() {
      return seat !== null;
    },
    get settled() {
      return seat !== null && t === 1 && !rising;
    },
    // Begin to sit on `target` from where he stands (train frame), facing `heading`.
    sit(target, u, v, heading) {
      seat = target;
      from = { u, v, heading };
      t = 0;
      rising = false;
    },
    rise() {
      if (seat) rising = true;
    },
    // Write the body for this frame. `frame` gives the train: worldAt(u, v),
    // the floor height and the heading that faces the seat's way. Returns
    // false once he is on his feet in the aisle again.
    pose(dt, frame) {
      if (!seat) return false;
      age += dt;
      t = rising ? Math.max(0, t - dt / RISE) : Math.min(1, t + dt / SIT);
      if (rising && t === 0) {
        const p = frame.worldAt(seat.u, AISLE);
        Object.assign(player.pos, p);
        player.y = frame.floor;
        player.heading = frame.facing;
        seat = null;
        player._stand();
        return false;
      }
      // first third: step to the seat and turn; the rest: down onto it
      const walk = ease(Math.min(1, t / 0.34)),
        fold = ease(Math.max(0, (t - 0.3) / 0.7));
      const u = mix(from.u, seat.u, walk),
        v = mix(mix(from.v, AISLE, walk), seat.v, fold);
      const p = frame.worldAt(u, v);
      player.pos.x = p.x;
      player.pos.z = p.z;
      player.y = frame.floor;
      player.vy = 0;
      player.speed = 0;
      player.grounded = true;
      player.heading = turn(from.heading, frame.facing, walk);
      player.mesh.position.set(p.x, frame.floor - DROP * fold, p.z);
      player.mesh.rotation.y = player.heading;
      player._sit(fold, 0);
      const j = player._cit.parts;
      // the weight goes forward over the knees on the way down, then settles back
      j.torso.rotation.x += -0.42 * Math.sin(fold * Math.PI) * (rising ? 0.7 : 1);
      // one hand finds the seat back while he lowers himself
      j.armR.rotation.x += -0.5 * Math.sin(fold * Math.PI);
      if (t === 1) {
        // seated: he breathes, and now and then looks out of the window
        j.torso.rotation.x += 0.012 * Math.sin(age * 1.3);
        const glance = Math.max(0, Math.sin(age * 0.23)) ** 3;
        j.head.rotation.y = 0.75 * glance;
        j.head.rotation.x = 0.05 + 0.03 * Math.sin(age * 0.9);
      }
      return true;
    },
    clear() {
      seat = null;
      t = 0;
      rising = false;
    },
  };
}
