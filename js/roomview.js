// ---- who else is watching this street --------------------------------------
// In a co-op session the question "can the player see this?" has more than one
// player in it (Frank, 21 Nov 2026: every player must see what the other one
// sees). The traffic, the car parks and the kerb cars each decide when a car
// may appear or go by what the LOCAL camera sees; two players side by side
// looking opposite ways then held two different streets (measured on the
// Pardubice graph: 22 % of the cars around them were on both screens).
//
// The peers' cameras do not travel over the wire, only where they stand. So a
// peer counts as looking every way at once, and each client asks the same
// question about the same set of people: is this point near ANY of us.
// Pure; js/main.js builds the list, js/traffic.js and the parked cars read it.

// PARKED CARS IN A SESSION DO NOT FOLLOW THE CLOCK. A car park and a kerb fill
// and empty with the hour, and never where the player could watch a car
// arrive: so what stands in a street is what the hour was when THAT player
// came, and a game hour is a minute. Two players who met on one square an
// hour of the day apart held two different rows of cars, for good. In a
// session every lot and kerb is as full as at this one hour instead (early
// evening: something stands everywhere), so a stall holds a car or does not
// for everybody (js/parkinglots.js, js/kerbparking.js `roomTod`).
export const ROOM_PARK_TOD = 19 / 24;

/** Peers closer than this share a street with us: [{x, z, id}] out of the session's remotes. */
export const ROOM_R = 1200;

/**
 * The peers within `r` of (x, z), written into `out` (pooled records).
 * `remotes` is any iterable of { x, z } (js/netcity.js remote avatars, which
 * mirror whatever the peer rides); `pose(remote)` may return a better place
 * for one (its car), or null.
 */
export function peersNear(remotes, x, z, out = [], r = ROOM_R, pose = null) {
  let n = 0;
  if (remotes) for (const p of remotes) {
    const q = pose?.(p) ?? p;
    const px = q?.x, pz = q?.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
    const dx = px - x, dz = pz - z;
    if (dx * dx + dz * dz > r * r) continue;
    const o = out[n] ??= { x: 0, z: 0, id: null };
    o.x = px; o.z = pz; o.id = p.uid ?? p.id ?? n; n++;
  }
  out.length = n;
  return out;
}

/** Is (x, z) within `r` of anybody in `list`? */
export function nearAny(list, x, z, r) {
  if (!list) return false;
  const r2 = r * r;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].x - x, dz = list[i].z - z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

// ---- where somebody stood a while ago ---------------------------------------
// Whether a car may be handed a mesh near a player depends on whether that
// player could have had it already: a car that drove in from outside his
// circle has a mesh on his screen, one born inside it never had the chance
// (js/traffic.js _readableForAttach). "Born inside" is a question about where
// he stood when the car was born, up to a trip ago, so each player leaves a
// thin trail: a sample every STEP seconds, KEEP seconds deep.
const TRAIL_STEP = 2, TRAIL_KEEP = 200;

export class Trail {
  constructor() { this.t = []; this.x = []; this.z = []; this.seen = 0; }

  /** Note where they are at shared second `t` (cheap to call every sweep). */
  push(t, x, z) {
    this.seen = t;
    let n = this.t.length;
    if (n && t < this.t[n - 1]) n = this.t.length = this.x.length = this.z.length = 0;   // the clock was stepped back
    if (n && t - this.t[n - 1] < TRAIL_STEP) return;
    this.t.push(t); this.x.push(x); this.z.push(z);
    while (this.t.length > 2 && this.t[1] <= t - TRAIL_KEEP) { this.t.shift(); this.x.shift(); this.z.shift(); }
  }

  /**
   * Where they stood at second `t`, into `out` ({x, z}); before the trail
   * began, where it begins (somebody we have only just met is taken to have
   * been standing there all along). null with no samples at all.
   */
  at(t, out) {
    const n = this.t.length;
    if (!n) return null;
    let i = n - 1;
    while (i > 0 && this.t[i] > t) i--;
    out.x = this.x[i]; out.z = this.z[i];
    return out;
  }
}
