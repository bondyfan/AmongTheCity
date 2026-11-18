import { pointInPolygon } from './geo.js';

// Nobody walks across the rails (Frank, 18 Nov 2026): from the hall to a
// platform there is the underpass and nothing else. Inside a station's yard a
// walker may stand on a platform, on the stairs, in the corridor below, or
// where `allow` says (the train and its door); a step anywhere else is taken
// back. Yards are in each station's own frame (js/station-passages.js):
// u along the platforms, v across the tracks, the hall outside the box.
const yards = {
  'Kolín': { u: [-350, 215], v: [-78, 16.9] },
  'Pardubice hl. n.': { u: [-230, 265], v: [-13.2, 92] },
};

export function trackGuard(world) {
  const platforms = new Map(); // station → { count, list }
  let last = null;
  function islands(s) {
    const all = world.city.paved ?? [];
    let own = platforms.get(s);
    if (!own || own.count !== all.length) {
      own = { count: all.length, list: all.filter((p) => p.t === 'platform' && Math.abs(p.o[0][0] - s.x) < 700 && Math.abs(p.o[0][1] - s.z) < 700) };
      platforms.set(s, own);
    }
    return own.list;
  }
  // Call every frame for a walker; returns true when a step was taken back.
  return function keep(player, allow) {
    const { x, z } = player.pos;
    const s = world.stationPassages.nearby(x, z, 460),
      yard = s && yards[s.name];
    if (!yard || !s.group) return false;
    const u = (x - s.x) * s.c + (z - s.z) * s.s,
      v = (z - s.z) * s.c - (x - s.x) * s.s;
    const inside = u > yard.u[0] && u < yard.u[1] && v > yard.v[0] && v < yard.v[1];
    if (
      !inside ||
      allow(x, z) ||
      world.stationPassages.floor(x, z, player.y + 0.4) !== null ||
      islands(s).some((p) => pointInPolygon(x, z, p.o))
    ) {
      last = { x, z };
      return false;
    }
    if (!last) return false;
    player.pos.x = last.x;
    player.pos.z = last.z;
    player.speed = 0;
    return true;
  };
}
