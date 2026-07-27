// ---- netvehicles: GHOST VEHICLES, the fix for "he sees me stuck in a car" ----
//
// THE BUG THIS EXISTS TO KILL (F9). v1 sent a peer's vehicle as
// {k, id, seat} where id = hash(kind + ':' + colour). That is a TYPE, not an
// IDENTITY: ~90 cars alive in the city collapse onto ~35-41 distinct ids, so
// the receiver looked that id up in ITS OWN traffic/parked pools, found some
// unrelated Fabia half a district away, and glued the peer's avatar to it.
// The avatar then either sat frozen at a red light or drove off on its own
// while its real owner was doing 90 km/h somewhere else. No amount of
// interpolation can rescue that, because the object being interpolated is the
// wrong object.
//
// THE FIX. Stop looking anything up. A peer's vehicle is a PROXY WE OWN, keyed
// by the peer's uid: one ghost per uid, built from the wire fields
// {kd: kind, cl: colour}, its transform written from every packet
// {x, z, h, sp} and smoothed between packets. Position, heading and speed all
// come from the one client that actually simulates that car — us guessing is
// exactly what broke.
//
// WHAT A GHOST IS NOT. It is deliberately NOT in vehicles.cars, NOT in
// traffic.cars and NOT in main's _crashList():
//   · not in vehicles.cars  → Vehicles.update() never fights us for the mesh,
//   · not in traffic.cars   → the AI never tries to drive it, pedestrians
//                             never brake for a car whose future they cannot
//                             know, and E can never "steal" someone's car,
//   · not in the crash list → local physics never collides with it.
// That last one is not squeamishness: a ghost's position is a REPLAY, so an
// impulse applied to it is thrown away on the next packet while the impulse
// applied to the local car is kept. The two clients would disagree about who
// got shoved where, and the disagreement grows every frame. Vehicles that are
// simulated somewhere else must be visual only, full stop.
//
// SEATING. seatAnchor(uid, seat) returns the WORLD point of a real seat on the
// ghost — the same local anchor vehicles.seatAnchor() gives the local player,
// rotated by the ghost's live heading. So a remote driver sits behind his own
// wheel, turns with the car, and rides the bridge deck the car is on.
//
// PASSENGERS RIDING SOMETHING WE ALREADY DRAW. A peer in seat > 0 may be
// sitting in a car that already exists on this client — OUR car, or another
// peer's ghost. Building him a second car would draw a z-fighting duplicate
// around the first. So a passenger first tries to BIND to a vehicle already on
// screen (proximity + kind), and only builds his own ghost if nothing matches.
//
// Import-time safety: nothing here touches the DOM or the network. Materials
// and geometry come from vehicles.js/helicopter.js caches and are SHARED with
// the local fleet — see dispose() for why that means a ghost must not dispose
// them.

import { makeCarMesh, seatAnchor as carSeatAnchor, normalizeKind } from './vehicles.js';
import { Helicopter, seatAnchor as heliSeatAnchor } from './helicopter.js';
import { PLAYER_SCALE } from './config.js';

// ---- tuning --------------------------------------------------------------
const SMOOTH = 12;      // 1/s — how hard the rendered pose chases the target
const TURN_K = 11;      // 1/s — heading is eased quicker; turns should lead
const DR_MAX = 0.30;    // s of dead reckoning allowed on one packet (see below)
const SNAP_D = 40;      // m — further than this is a teleport, not a drive
const REAP_S = 35;      // s of silence before a ghost reaps itself
const BIND_R = 4.0;     // m — "the passenger is in THAT vehicle" radius
const UNBIND_R = 9.0;   // m — …and how far it has to drift to be wrong
// A remote client can change how its car LOOKS only this often. Rebuilding a
// ghost mints a licence-plate CanvasTexture per (kind|colour) into a cache
// that is never evicted, so an unthrottled `cl` field is a memory bomb aimed
// at everyone else in the room. 2 s and a hard ceiling make it a non-event.
const SKIN_CD = 0.75;
const SKIN_MAX = 24;
// …and the OTHER direction, which SKIN_CD/SKIN_MAX do not cover at all. Both
// of those live on the ghost RECORD, and a record dies with drop() — which is
// what a peer sends every time they step out of a car (veh:null). So the cycle
// "get in wearing a new colour, get out, repeat" resets the counter every time
// and mints one 256×56 licence-plate CanvasTexture per lap into vehicles.js's
// _plateMats, which nothing ever evicts. Measured: 300 laps → 303 textures, at
// 10 Hz that is ~35 MB of everyone else's GPU per minute, from one client.
// So the paint a ghost may WEAR is budgeted globally and per kind: the first
// SKIN_KEYS distinct (kind, colour) pairs are free, after that a newcomer
// re-uses a pair already paid for — picked from the colour itself, so a given
// peer keeps one stable (if borrowed) paint instead of strobing. 256 pairs is
// far more than a full room reaches in a session and the local traffic fleet's
// own palette is untouched, so an honest player never sees this.
const SKIN_KEYS = 256;
const _skinPool = new Map();   // kind -> [colours already minted for that kind]
let _skinN = 0;
function budgetColor(kind, color) {
  let pool = _skinPool.get(kind);
  if (!pool) _skinPool.set(kind, pool = []);
  if (pool.includes(color)) return color;
  // always let a kind have its FIRST colour, or a ghost of an unseen kind
  // could not be built at all once the budget ran out
  if (_skinN < SKIN_KEYS || pool.length === 0) { _skinN++; pool.push(color); return color; }
  return pool[(color >>> 3) % pool.length];
}
// Cushion top → where a citizen GROUP origin (its feet) has to sit so the
// folded hips rest on the cushion. Same constant player.js uses for the local
// player; duplicated rather than imported because player.js keeps it private.
const SIT_DROP = 0.78 * PLAYER_SCALE;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

// Every number that reaches a mesh or a seat anchor came off the wire, and a
// single NaN in a transform poisons the whole subtree's matrix — three.js will
// happily render nothing at all after that. So the wire is parsed, never
// trusted: non-finite in, default out.
function readState(v) {
  if (!v || typeof v !== 'object') return null;
  const k = v.k === 'heli' ? 'heli' : v.k === 'car' ? 'car' : null;
  // 'train' and 'jet' land here and are DELIBERATELY refused rather than
  // approximated. This module owns two meshes; a Gripen is neither, and the
  // failure mode of guessing is loud: netcity used to label a fighter k:'car',
  // which built an Octavia, snapped it to the road under an aircraft doing
  // 600 km/h and handed it to traffic.actors as an obstacle. Returning null
  // makes sync() drop the ghost, and netcity then leaves the pilot's avatar at
  // the position he reported — which mirrors the aircraft, altitude included —
  // in a sitting pose with his name tag over him. That is exactly how a
  // train passenger is already drawn, and it is right for the same reason:
  // the seat is real even when we cannot draw the thing it is bolted to.
  if (!k) return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.z)) return null;
  return {
    k,
    // an unknown kind string must NOT reach geomFor(): it would cache a whole
    // extra copy of the octavia geometry under that name, once per string a
    // hostile client feels like inventing
    kind: k === 'car' ? normalizeKind(v.kd) : 'heli',
    color: (fin(v.cl, 0x8a9096) >>> 0) & 0xffffff,
    x: v.x, z: v.z,
    y: Number.isFinite(v.y) ? v.y : null,    // cars derive it; a heli must send it
    h: fin(v.h, 0),
    sp: clamp(fin(v.sp, 0), -80, 80),
    seat: clamp(Math.round(fin(v.st, 0)), 0, 7),
  };
}

// ---- makeGhostCars(vehicles) → the ghost fleet ---------------------------
// `vehicles` is the Vehicles instance (we only need its .scene); a bare
// THREE.Scene is accepted too, so a test can drive this with no fleet.
export function makeGhostCars(vehicles) {
  const scene = vehicles?.scene ?? vehicles ?? null;
  const recs = new Map();          // uid -> record

  const api = {
    // OPTIONAL, set by main.js: the vehicles this client owns and already
    // draws — [game.car, heli, …] or a function returning that. A remote
    // PASSENGER whose reported position sits on one of these rides it instead
    // of getting a duplicate car built around him. Leaving it null is safe;
    // you just get the duplicate.
    localVehicles: null,
    // OPTIONAL: the CityWorld. Cars are sent without a y (the road decides it),
    // so with a world the ghost climbs bridges and ramps like everyone else,
    // and without one it drives along y = 0.
    world: null,
    sync, drop, seatAnchor, update, has, dispose,
    // extras beyond the contract, for HUD/minimap callers that want a pose
    // without walking the internals: pose(uid) and the live count.
    pose, get count() { return recs.size; },
  };

  // ---- appearance ---------------------------------------------------------
  function buildMesh(r, st) {
    disposeMesh(r);
    // Stamped BEFORE the heli branch's `!scene` bail-out. It used to be stamped
    // after, so a headless fleet (no scene) left r.k/r.kind/r.color holding the
    // PREVIOUS vehicle's values and the `changed` test below then compared the
    // new packet against a description of a car that no longer exists.
    r.kind = st.kind; r.color = st.color; r.k = st.k;
    if (st.k === 'heli') {
      // The Helicopter class is used as a MESH HOLDER only — we never call its
      // update(), so no physics of ours ever runs. Its geometry is a module
      // cache and its materials are module singletons, exactly like the cars'.
      // Its constructor adds itself to the scene, so unlike makeCarMesh it
      // needs a real one.
      if (!scene) return;
      const h = new Helicopter(scene, st.x, st.z, st.h);
      h.mesh.userData.ghost = true;
      r.heli = h; r.mesh = h.mesh; r.wheels = null;
    } else {
      const m = makeCarMesh(budgetColor(st.kind, st.color), st.kind);
      m.group.userData.ghost = true;   // a marker any pool filter can look for
      r.mesh = m.group; r.wheels = m.wheels; r.heli = null;
      scene?.add(m.group);
    }
    r.skinT = SKIN_CD; r.skins++;
  }

  // Shared, cached, and used by the local fleet — see the geomFor()/bodyMatFor()
  // /plateMatFor() caches in vehicles.js and heliGeom() in helicopter.js. A
  // ghost that disposed them would take every Octavia in Pardubice with it and
  // leave black holes on the road. So the ONLY thing a ghost owns is its place
  // in the scene graph and the two Groups makeCarMesh built; both die with the
  // last reference. Anything a future ghost allocates for itself must be
  // flagged userData.ghostOwned and is disposed here.
  function disposeMesh(r) {
    if (!r.mesh) return;
    scene?.remove(r.mesh);
    r.mesh.traverse?.((o) => {
      if (!o.userData?.ghostOwned) return;
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
      else m?.dispose?.();
    });
    r.mesh = null; r.wheels = null; r.heli = null;
  }

  // ---- binding: is this passenger already sitting in something we draw? ----
  function localList() {
    const l = typeof api.localVehicles === 'function' ? api.localVehicles() : api.localVehicles;
    return Array.isArray(l) ? l : l ? [...l] : [];
  }
  const isHeli = (v) => v && v.rotorSpeed !== undefined;

  // Is this LOCAL vehicle a thing a rider could actually be sitting in? Three
  // ways it is not, and hostOk() below asks the same question every packet:
  //  · disposed / removed from the scene — three.js nulls `parent` on remove,
  //    which is the only signal a despawned traffic car gives us. Its x/z stay
  //    valid forever, so without this a passenger rides an invisible Fabia.
  //  · INVISIBLE — which under F22 means precisely "a peer holds this
  //    helicopter, so main.js hid our copy and the peer is flying a ghost of it
  //    somewhere else". Binding to it teleported the co-pilot out of a machine
  //    at 40 m and dropped him on the empty pad, still in a sitting pose.
  //  · wrong kind — the local Fabia parked a metre from a peer's bus is a
  //    closer match on DISTANCE than his own bus, and BIND_R (4 m) is wider
  //    than a traffic lane, so "the car next to you" was a live mis-seat.
  function liveHost(v) {
    if (!v || v.disposed) return false;
    const m = v.mesh;
    if (m && (m.parent === null || m.visible === false)) return false;
    return true;
  }
  const kindOfLocal = (v) => normalizeKind(v?.kind);

  function findHost(uid, st) {
    let best = null, bd = BIND_R;
    for (const v of localList()) {
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.z)) continue;
      if (isHeli(v) !== (st.k === 'heli')) continue;
      if (!liveHost(v)) continue;
      if (st.k === 'car' && kindOfLocal(v) !== st.kind) continue;
      const d = Math.hypot(v.x - st.x, v.z - st.z);
      if (d < bd) { bd = d; best = v; }
    }
    for (const [ouid, o] of recs) {
      if (ouid === uid || o.bind || !o.mesh) continue;   // only ride a real ghost
      if (o.k !== st.k) continue;
      if (st.k === 'car' && o.kind !== st.kind) continue;
      const d = Math.hypot(o.rx - st.x, o.rz - st.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  // a host is stale once it drifts away, dies, or turns out to be the very
  // ghost we are updating (peer got out and back in as a driver)
  function hostOk(r, st) {
    const v = r.bind;
    if (!v) return false;
    // same three questions findHost() asks, re-asked every packet: a host can
    // be despawned, hidden (a peer claimed that helicopter) or swapped for a
    // different kind long after the rider bound to it
    if (!liveHost(v)) return false;
    if (st.k === 'car' && (v.rx !== undefined ? v.kind : kindOfLocal(v)) !== st.kind) return false;
    const x = v.rx ?? v.x, z = v.rz ?? v.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    return Math.hypot(x - st.x, z - st.z) < UNBIND_R;
  }

  // ---- sync(uid, v): one packet in --------------------------------------
  function sync(uid, v) {
    if (typeof uid !== 'string' || !uid) return;
    const st = readState(v);
    if (!st) { drop(uid); return; }           // on foot, on a train, or garbage

    let r = recs.get(uid);
    if (!r) {
      r = { uid, k: st.k, kind: st.kind, color: st.color, seat: st.seat,
        mesh: null, wheels: null, heli: null, bind: null, disposed: false,
        rx: st.x, rz: st.z, ry: fin(st.y, 0), rh: st.h,
        tx: st.x, tz: st.z, ty: fin(st.y, 0), th: st.h, sp: st.sp,
        spin: 0, steer: 0, roll: 0, age: 0, last: 0,
        skinT: 0, skins: 0 };
      recs.set(uid, r);
    }
    r.seat = st.seat;
    r.last = 0;

    // ---- who is this rider sitting in? ----
    // A DRIVER always gets his own ghost: his client is the authority for that
    // car, so there is nothing here to bind to. A PASSENGER first tries to ride
    // a vehicle already on screen.
    if (st.seat > 0) {
      if (!hostOk(r, st)) r.bind = findHost(uid, st);
    } else r.bind = null;

    if (r.bind) { disposeMesh(r); r.k = st.k; r.kind = st.kind; return; }

    // appearance: rebuild only on a real change, and — for a CHANGE, never for
    // the first build — only as often as SKIN_CD / SKIN_MAX allow. A ghost that
    // has spent its budget keeps the paint it is wearing; being one colour
    // wrong is a cosmetic bug, being a texture faucet is everyone's bug.
    const changed = r.k !== st.k || r.kind !== st.kind || r.color !== st.color;
    if (!r.mesh || (changed && r.skinT <= 0 && r.skins < SKIN_MAX)) {
      buildMesh(r, st);
      // a fresh mesh has no history worth smoothing from
      r.rx = st.x; r.rz = st.z; r.rh = st.h; r.ry = fin(st.y, r.ry);
    }

    // ---- the target this packet sets ----
    // A jump this big is a respawn/teleport, not a drive: smoothing it would
    // send the ghost sailing across the city through the buildings.
    if (Math.hypot(st.x - r.rx, st.z - r.rz) > SNAP_D) {
      r.rx = st.x; r.rz = st.z; r.rh = st.h; if (st.y !== null) r.ry = st.y;
    }
    r.tx = st.x; r.tz = st.z; r.th = st.h; r.sp = st.sp;
    if (st.y !== null) r.ty = st.y;
    r.age = 0;
  }

  function drop(uid) {
    const r = recs.get(uid);
    if (!r) return;
    disposeMesh(r);
    r.disposed = true;
    recs.delete(uid);
    // anyone riding this ghost loses his seat and re-resolves on his next
    // packet (≤100 ms) rather than pointing at a corpse
    for (const o of recs.values()) if (o.bind === r) o.bind = null;
  }

  // has(uid) = "this peer is riding something and I am tracking it". True for a
  // bound passenger too, who has no mesh of his own but does have a seat.
  function has(uid) { return recs.has(uid); }

  // ---- update(dt): interpolate, dead-reckon, spin the wheels -------------
  function update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);                  // a tab-return spike is not motion
    const k = 1 - Math.exp(-SMOOTH * dt);    // frame-rate independent easing
    const kh = 1 - Math.exp(-TURN_K * dt);
    for (const [uid, r] of recs) {
      r.last += dt;
      if (r.last > REAP_S) { drop(uid); continue; }
      if (r.skinT > 0) r.skinT -= dt;
      if (r.bind || !r.mesh) continue;

      r.age += dt;
      // DEAD RECKONING, capped. At 10 Hz a car doing 25 m/s moves 2.5 m
      // between packets; easing toward the LAST packet alone parks the ghost a
      // car length behind where its driver actually is and every corner reads
      // as lag. So the target is pushed along the car's own heading by its own
      // reported speed — but only for DR_MAX, because a peer who crashed or
      // whose tab froze must stop, not carry on through a wall forever.
      const ex = Math.min(r.age, DR_MAX);
      const fx = -Math.sin(r.th), fz = -Math.cos(r.th);
      const gx = r.tx + fx * r.sp * ex, gz = r.tz + fz * r.sp * ex;

      const px = r.rx, pz = r.rz, ph = r.rh;
      r.rx += (gx - r.rx) * k;
      r.rz += (gz - r.rz) * k;
      // heading over the shortest arc — without the wrap a car crossing ±π
      // spins the long way round like a compass needle
      let dh = r.th - r.rh;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      r.rh += dh * kh;

      // ground: cars are sent without a y (the road under them decides it),
      // so read the local surface — that is what puts a ghost on the bridge
      // deck instead of in the river below it
      if (r.k === 'car') {
        const w = api.world;
        let gy = r.ty;
        if (w?.surfaceY) gy = fin(w.surfaceY(r.rx, r.rz)?.y, gy);
        else if (w?.heightAt) gy = fin(w.heightAt(r.rx, r.rz), gy);
        r.ry += (gy - r.ry) * Math.min(1, dt * 8);
      } else {
        r.ry += (r.ty - r.ry) * k;
      }

      // measured motion beats the reported scalar for the dressing: it is what
      // the eye actually sees, so wheels never spin while the body is still
      const mdx = r.rx - px, mdz = r.rz - pz;
      const mv = Math.hypot(mdx, mdz) / dt * Math.sign(r.sp || 1);

      const m = r.mesh;
      m.position.set(r.rx, r.ry, r.rz);
      m.rotation.y = r.rh;

      if (r.wheels) {
        // steering angle recovered from the kinematic bicycle the local cars
        // use (dθ = −tan(steer)·v/(len·0.6)), so a ghost's wheels point where
        // its trajectory says they must
        const len = 4.5, hz = (r.rh - ph) / dt;
        const want = Math.abs(mv) > 1 ? clamp(-Math.atan(hz * len * 0.6 / mv), -0.55, 0.55) : 0;
        r.steer += (want - r.steer) * Math.min(1, dt * 8);
        r.spin = (r.spin - mv * dt / (m.userData.wheelR || 0.32)) % (Math.PI * 2);
        for (let i = 0; i < 4; i++) {
          const w = r.wheels[i];
          w.rotation.x = r.spin;
          if (i < 2) w.rotation.y = -r.steer;
        }
        // the body leans out of the corner, same feel as the local fleet
        const b = m.userData.body;
        if (b) {
          r.roll += (clamp(r.steer * mv * 0.004, -0.05, 0.05) - r.roll) * Math.min(1, dt * 8);
          b.rotation.z = r.roll;
        }
      } else if (r.heli) {
        // rotors: a parked-looking disc over a machine in flight is the one
        // thing that makes a helicopter read as a prop rather than a vehicle
        const spin = Math.abs(mv) > 0.2 || Math.abs(r.sp) > 0.2 ? 42 : 18;
        if (r.heli._rotor) r.heli._rotor.rotation.y += spin * dt;
        if (r.heli._tail) r.heli._tail.rotation.x += spin * 1.6 * dt;
        // …and the blade→disc swap the real machine does at BLUR_W (40 rad/s).
        // Helicopter.update() owns that line and a ghost never runs update(),
        // so a peer in flight used to show two discrete blades ticking round
        // 0.7 rad a frame — the exact strobe the disc exists to hide.
        const blur = spin >= 40;
        if (r.heli._blades && r.heli._blades.visible === blur) {
          r.heli._blades.visible = !blur;
          if (r.heli._disc) r.heli._disc.visible = blur;
        }
        r.heli.x = r.rx; r.heli.y = r.ry; r.heli.z = r.rz; r.heli.heading = r.rh;
      }
    }
  }

  // ---- seatAnchor(uid, seat) → WORLD seat point, or null ------------------
  // { x, y, z, heading, feetY }. y is the SEAT CUSHION TOP, the same thing
  // player.worldSeatAnchor() returns for the local player; feetY is where a
  // citizen GROUP origin goes so the folded hips rest on that cushion. Put the
  // avatar at feetY, not at y, or it floats a hand above the seat.
  //
  // Every number is guaranteed finite: a NaN here poisons the avatar's matrix
  // and three.js then silently stops drawing it.
  function seatAnchor(uid, seat = 0) {
    const r = recs.get(uid);
    if (!r) return null;
    const i = clamp(Math.round(fin(seat, r.seat)), 0, 7);
    if (r.bind) return hostAnchor(r.bind, i);
    if (!r.mesh) return null;
    const veh = r.k === 'heli'
      ? { rotorSpeed: 0 }
      : { kind: r.kind };
    const a = r.k === 'heli' ? heliSeatAnchor(veh, i) : carSeatAnchor(veh, i);
    return world(a, r.rx, r.ry, r.rz, r.rh);
  }

  // a bound rider sits on somebody else's vehicle: a local car/heli (x/z/
  // heading + a mesh whose y already carries the offroad judder) or another
  // ghost record (rx/rz/rh)
  function hostAnchor(v, i) {
    if (v.disposed) return null;
    const isGhost = v.rx !== undefined;
    const x = isGhost ? v.rx : v.x, z = isGhost ? v.rz : v.z;
    const h = isGhost ? v.rh : (v.heading ?? 0);
    const y = isGhost ? v.ry : fin(v.mesh?.position.y, fin(v.y, 0));
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = isGhost ? v.k === 'heli' : isHeli(v);
    const a = heli ? heliSeatAnchor(v, i) : carSeatAnchor(isGhost ? { kind: v.kind } : v, i);
    return world(a, x, y, z, h);
  }

  // local seat point → world. Rotation convention (ARCHITECTURE.md): local +x
  // maps to (cos h, −sin h), local −z to the forward direction.
  function world(a, x, y, z, h) {
    const c = Math.cos(h), s = Math.sin(h);
    const wx = x + fin(a.x) * c + fin(a.z) * s;
    const wy = y + fin(a.y);
    const wz = z - fin(a.x) * s + fin(a.z) * c;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) return null;
    return { x: wx, y: wy, z: wz, heading: fin(h), feetY: wy - SIT_DROP };
  }

  // pose(uid) → what the ghost looks like right now, for map/HUD callers
  function pose(uid) {
    const r = recs.get(uid);
    if (!r) return null;
    if (r.bind) {
      const v = r.bind, g = v.rx !== undefined;
      return { x: fin(g ? v.rx : v.x), y: fin(g ? v.ry : v.y), z: fin(g ? v.rz : v.z),
        heading: fin(g ? v.rh : v.heading), speed: 0, kind: v.kind ?? 'octavia', riding: true };
    }
    return { x: r.rx, y: r.ry, z: r.rz, heading: r.rh, speed: r.sp, kind: r.kind, riding: false };
  }

  function dispose() {
    for (const uid of [...recs.keys()]) drop(uid);
    recs.clear();
    api.localVehicles = null; api.world = null;
  }

  return api;
}
