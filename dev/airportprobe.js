// dev/airportprobe.js: drive the airport and the flight from the console.
//   const P = await import('/dev/airportprobe.js');
//   P.money(50000); P.at('counter'); P.press('KeyE'); P.walk('lane'); P.ff(20);
//   P.view([x, y, z], [tx, ty, tz]) renders the live scene from a throwaway
//   camera into an overlay (for a screenshot); P.unview() takes it away.
// Development only: nothing in the game imports it.

import { toWorld, COUNTERS, LANES, GATES, STAND, DOORS } from '/js/airport-plan.js';
import { seatAt, STAIRS, STAIRS_FOOT_X, DOOR_L1 } from '/js/airliner-layout.js';

const A = () => window.__atc;
const PLACES = {
  forecourt: () => ({ ...toWorld(0, -32), h: Math.PI }),
  doors: () => ({ ...toWorld(-5, -27), h: Math.PI }),
  counter: () => ({ ...toWorld(COUNTERS[2].u, COUNTERS[2].v - 1.1), h: Math.PI }),
  lane: () => ({ ...toWorld(LANES[0].u, 6.2), h: Math.PI }),
  pastLane: () => ({ ...toWorld(LANES[0].u, 14.5), h: Math.PI }),
  gate: () => ({ ...toWorld(GATES[1].desk.u, GATES[1].desk.v - 1.2), h: Math.PI }),
  apron: () => ({ x: STAND.x + 10, z: STAND.z - 20, h: 0 }),
};

export const money = (n) => A().wallet.setMoney(n);
export const flight = () => A().airport?.flight ?? null;
export function at(name) {
  const p = PLACES[name]();
  const pl = A().player;
  pl.pos.x = p.x; pl.pos.z = p.z; pl.heading = p.h ?? 0;
  pl.y = A().world.supportY(p.x, p.z, 1e4);
  return p;
}
export const press = (code) => A().input.keyHandlers.get(code)?.();
/** Run the whole game synchronously for `s` seconds of sim time. */
export function ff(s, dt = 1 / 30) { for (let t = 0; t < s; t += dt) A().stepGame(dt); }
/** Walk the real player along straight legs to a named place or [x, z]; → 'ok' or 'STUCK x,z'. */
export function walk(to, max = 4000, near = 0.5) {
  const { player, input, world } = A();
  const p = Array.isArray(to) ? { x: to[0], z: to[1] } : PLACES[to]();
  input.keys.add('KeyW');
  let i = 0;
  for (; i < max; i++) {
    const dx = p.x - player.pos.x, dz = p.z - player.pos.z;
    if (Math.hypot(dx, dz) < near) break;
    player.update(1 / 60, { input, camYaw: Math.atan2(-dx, -dz), world });
    // the airport sees every step (the security arch is a line he crosses)
    A().airport?.update(1 / 60);
  }
  input.keys.delete('KeyW');
  return i < max ? 'ok' : 'STUCK ' + player.pos.x.toFixed(1) + ',' + player.pos.z.toFixed(1);
}

let overlay = null;
export function view(eye, look, W = 1280, H = 720, fov = 60) {
  const { renderer, scene, camera } = A();
  const cam = new (camera.constructor)(fov, W / H, 0.05, 2500);
  cam.position.set(...eye);
  cam.lookAt(...look);
  const old = renderer.getSize(new (camera.position.constructor)()), pr = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.9);
  renderer.setSize(old.x, old.y, false);
  renderer.setPixelRatio(pr);
  overlay ??= Object.assign(document.createElement('img'), { style: 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;z-index:99999' });
  overlay.src = url;
  document.body.append(overlay);
  return url.length;
}
export function unview() { overlay?.remove(); }

/** A plane-local point of the airliner where it stands now, in world metres. */
export function local(lx, lz) {
  const m = flight().plane, c = Math.cos(m.heading), s = Math.sin(m.heading);
  return [m.x + lx * c + lz * s, m.z - lx * s + lz * c];
}
/** From the gate desk out of the gate door, across the apron, up the stairs, into the aisle by row 14. */
export function board() {
  const g = DOORS.find((d) => d.id === 'gate2');
  const steps = [
    toWorld(g.u, g.v - 1.5), toWorld(g.u, g.v + 2.5),
    local(STAIRS_FOOT_X - 2, STAIRS.zCentre), local(STAIRS_FOOT_X + 0.2, STAIRS.zCentre),
    local(STAIRS.platformOuter + 0.3, STAIRS.zCentre), local(DOOR_L1.x + 0.3, DOOR_L1.z),
    local(0, -16.2), local(0, seatAt(14, 'A').z - 0.35),
  ];
  const out = [];
  for (const p of steps) {
    const r = walk(Array.isArray(p) ? p : [p.x, p.z], 4000, 0.25);
    out.push(r);
    if (r !== 'ok') break;
  }
  return out;
}

/** Render `eye` → `look` (or the game's own camera when eye is null) and send it to the local sink. */
export function shot(name, eye = null, look = null, W = 1280, H = 720, fov = 60) {
  const { renderer, scene, camera } = A();
  let cam = camera;
  if (eye) {
    cam = new (camera.constructor)(fov, W / H, 0.05, 2500);
    cam.position.set(...eye);
    cam.lookAt(...look);
  }
  const w0 = renderer.domElement.width, h0 = renderer.domElement.height, pr = renderer.getPixelRatio();
  const aspect = camera.aspect;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  if (!eye) { camera.aspect = W / H; camera.updateProjectionMatrix(); }
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.88);
  if (!eye) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
  renderer.setSize(w0 / pr, h0 / pr, false);
  renderer.setPixelRatio(pr);
  fetch('http://127.0.0.1:5499/' + name, { method: 'POST', body: url }).catch(() => {});
  return url.length;
}

/**
 * Straight onto final with the passenger in 14A, landing at local hour `h`
 * (0..24, e.g. 23.5 for a night landing): 'home' comes down on 27 at
 * Pardubice, 'out' on 13 at SEZ (from a page opened with ?region=mahe).
 */
export async function final(dir = 'home', h = 23.5) {
  const T = await import('/js/flight-trip.js');
  const carry = T.carryFor({ ...T.newTrip(), state: 'flying', dir, no: T.ROUTES[dir].no, seat: '14A' }, { dep: 0.4, arr: h / 24 });
  A().airport.resume(carry);
  return carry;
}
/** A pilot's eye: the airliner's nose, looking `ahead` m along its heading and `down` degrees under the horizon. */
export function cockpit(ahead = 2000, down = 3.2) {
  const m = flight().plane, fx = -Math.sin(m.heading), fz = -Math.cos(m.heading);
  const eye = [m.x + fx * 17, m.y + 4.2, m.z + fz * 17];
  return [eye, [eye[0] + fx * ahead, eye[1] - Math.tan(down * Math.PI / 180) * ahead, eye[2] + fz * ahead]];
}

/** The whole way from the counter to seat 14A, as the player does it. → the trip's state at each step. */
export function toSeat() {
  const log = [];
  money(50000);
  at('counter'); ff(0.3); press('KeyE'); ff(0.2); log.push(flight().trip.state);
  const a = toWorld(10, 1);
  walk([a.x, a.z]); walk('lane'); walk('pastLane'); log.push(flight().trip.state);
  walk('gate'); ff(0.3); press('KeyE'); ff(0.5); log.push(flight().trip.state);
  log.push(board().join(','));
  ff(0.3); log.push(flight().trip.state);
  press('KeyE'); ff(3); log.push(flight().trip.state + '/' + flight().phase);
  return log;
}
