// ---- trainpeople.js: who sits in the train beside the player ----
// The campaign's train has four people seated in every coach
// (js/prologue-coach.js `riders`). Every train of the open world now is that
// train, so it gets them too, on the same seats: but only ONE train at a time,
// the one he rides or the nearest one he could look into. A modelled person is
// not free, and twelve of them in each of six trains nobody is near would be.
// They are seated one a frame, so a train drawing in never costs a hitch.

import { makeCitizen } from './citizen.js';
import { riders, riderSeat } from './prologue-coach.js';

const SEAT_IN = 95;    // m: a train this near gets its passengers…
const SEAT_OUT = 140;  // …and keeps them until it is this far (inside the coach's own far model)

export function trainPassengers(trains) {
  let host = null, people = [], queue = [];
  const dist = (t, x, z) => {
    let d = Infinity;
    for (const v of t.cars) d = Math.min(d, Math.hypot(v.mesh.position.x - x, v.mesh.position.z - z));
    return d;
  };
  function clear() {
    for (const p of people) { p.group.removeFromParent(); p.dispose(); }
    people = []; queue = []; host = null;
  }
  trains.onRemove = (t) => { if (t === host) clear(); };
  return {
    get host() { return host; },
    get seated() { return people.length; },
    update(dt, focus) {
      if (!focus) return;
      let want = trains.riding, best = SEAT_IN;
      if (!want) for (const t of trains.trains) {
        const d = dist(t, focus.x, focus.z);
        if (d < best) { best = d; want = t; }
      }
      if (host && host !== want && (want || !trains.trains.has(host) || dist(host, focus.x, focus.z) > SEAT_OUT)) clear();
      if (!host && want) {
        host = want;
        want.cars.forEach((v, i) => { for (const r of riders) queue.push({ v, i, r }); });
      }
      const next = queue.shift();
      if (!next) return;
      const seat = riderSeat(next.r);
      const person = makeCitizen({ uid: 'vlak-' + host.id + '-' + next.i + '-' + next.r[0], archetype: next.r[0] === 2 ? 'woman' : 'man' });
      person.sitPose(1, 0);
      person.group.position.set(seat.x, seat.y, seat.z);
      person.group.rotation.y = seat.yaw;
      next.v.coach.model.add(person.group);
      people.push(person);
    },
    dispose: clear,
  };
}
