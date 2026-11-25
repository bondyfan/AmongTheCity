// ---- flight-sez.js: getting through Seychelles International on foot ----
// The Mahé region draws the terminal at SEZ from its OSM footprint as one solid
// building, and the airport fence closes the apron off from the forecourt, as a
// real one does. So the way between the city and the aircraft is THROUGH the
// terminal, and it is played the way a game plays a door it has no rooms for:
// the screen goes dark for a moment and you come out on the other side.
//
//   landside   the check-in desk at the landside door (js/flight-sezdesk.js):
//              buying the ticket home is check-in, security and the gate in one,
//              and it walks you through to the apron
//   airside    the terminal's door facing the stand: after a flight in, E there
//              takes you out to the forecourt
//
// The airside door is found, not typed in: the point of the terminal's own ring
// nearest the stand, three metres out from it (js/flight-life.js asks once the
// building is loaded).

const DOOR_R = 2.6; // m from a door where E works
const FADE = 0.55; // s of black before the move, and as long after it

export function sezPassage(player, world, hud, airport) {
  let airside = null, passing = null;
  const desk = airport.desk;
  // the passenger's side of the counter: a metre in front of it, toward the door
  const deskFront = desk && { x: desk.x + Math.sin(desk.heading) * 1.1, z: desk.z + Math.cos(desk.heading) * 1.1 };
  const near = (p, q, r) => !!q && Math.hypot(p.x - q.x, p.z - q.z) < r;
  function place(q, heading) {
    player.pos.x = q.x; player.pos.z = q.z;
    player.y = world.supportY(q.x, q.z, world.heightAt(q.x, q.z) + 1.5);
    player.vy = 0; player.speed = 0;
    player.heading = heading;
  }
  return {
    get airside() { return airside; },
    /** The terminal's door toward the stand, once js/flight-life.js has found the building. */
    setAirside(p) { airside = p; },
    nearDesk: (p) => near(p, deskFront, 1.6),
    nearAirside: (p) => near(p, airside, DOOR_R),
    /** Out of the black on the other side: to the apron (toStand) or to the forecourt. */
    through(toStand) {
      if (passing || !airside || !deskFront) return false;
      passing = { t: 0, toStand, moved: false };
      hud.veil(true, toStand ? 'Odbavení' : 'Terminál', toStand ? 'Bezpečnostní kontrola, pas, gate' : 'Pasová kontrola, výdej zavazadel');
      return true;
    },
    get busy() { return !!passing; },
    update(dt, stand) {
      if (!passing) return;
      passing.t += dt;
      if (!passing.moved && passing.t > FADE) {
        passing.moved = true;
        if (passing.toStand) {
          // out of the airside door, facing the aircraft
          place(airside, Math.atan2(-(stand.x - airside.x), -(stand.z - airside.z)));
        } else {
          place(deskFront, desk.heading + Math.PI);
        }
      }
      if (passing.t > FADE * 2.2) { hud.veil(false); passing = null; }
    },
    deskFront,
  };
}

/**
 * The point of a building ring nearest to `p`, pushed `out` metres away from
 * the building toward `p`: a door on the face that looks at p.
 */
export function doorToward(ring, p, out = 3) {
  let best = null, bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
    if (L2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a[0]) * ex + (p.z - a[1]) * ez) / L2));
    const x = a[0] + ex * t, z = a[1] + ez * t, d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) { bd = d; best = { x, z }; }
  }
  if (!best || bd < 1e-6) return best;
  const ux = (p.x - best.x) / bd, uz = (p.z - best.z) / bd;
  return { x: best.x + ux * out, z: best.z + uz * out };
}
