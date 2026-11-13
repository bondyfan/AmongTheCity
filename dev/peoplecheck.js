// ---- dev/peoplecheck.js: look at people inside the RUNNING game ------------
// Dev-only, loaded by hand from the console of the real game:
//     const pc = await import('/dev/peoplecheck.js');
// It wraps postfx.render so a shot can be taken through the game's own
// post-processing from anywhere, and can stage a line-up of citizens (all five
// archetypes, an officer, a medic) on the pavement in front of the player.
// Nothing in the game imports this file.

const A = window.__atc;
const wc = await import('/js/worldclock.js');
const { makeCitizen } = await import('/js/citizen.js');
const { archetypeAt } = await import('/js/people.js');
const { seededRnd } = await import('/js/wardrobe.js');

export const state = { cam: null, fn: null, stage: [], last: performance.now() };

if (!window.__pcInstalled) {
  window.__pcInstalled = true;
  const orig = A.postfx.render.bind(A.postfx);
  A.postfx.render = function (...a) {
    const s = window.__pc;
    if (s?.fn) s.fn();
    const c = s?.cam;
    if (c) {
      const cam = A.camera;
      cam.position.set(c[0], c[1], c[2]); cam.lookAt(c[3], c[4], c[5]);
      if (c[6] && cam.fov !== c[6]) { cam.fov = c[6]; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld(true);
    }
    return orig(...a);
  };
}
window.__pc = state;

export const time = (t) => wc.setSoloTime(t);
const sup = (x, z) => A.world.supportY(x, z, A.world.heightAt(x, z) + 2);

/** Look at a moving thing ({x, z, heading, mesh}) from `dist` metres, `ang`
 *  radians round from its front. Re-aimed every frame. */
export function follow(q, o = {}) {
  state.target = { q, ...o };
  state.fn = () => {
    step();
    const f = state.target, t = f.q, h = t.heading ?? 0, a = f.ang ?? 0.3;
    const x = t.x ?? t.pos.x, z = t.z ?? t.pos.z, y = t.mesh?.getWorldPosition ? t.mesh.position.y : (t.y ?? 0);
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const dx = fx * Math.cos(a) + fz * Math.sin(a), dz = fz * Math.cos(a) - fx * Math.sin(a);
    state.cam = [x + dx * (f.dist ?? 4), y + (f.hgt ?? 1.3), z + dz * (f.dist ?? 4), x, y + (f.aim ?? 0.85), z, f.fov ?? 40];
  };
}

/** A fixed shot. */
export function shot(px, py, pz, tx, ty, tz, fov = 50) {
  state.fn = step;
  state.cam = [px, py, pz, tx, ty, tz, fov];
}

export function free() { state.fn = step; state.cam = null; }

/** Stand n seeded citizens on the pavement around (x, z), walking to and fro
 *  across the view; an officer and a medic are among them. */
export function stage(x, z, n = 14, depth = 28, o = {}) {
  for (const c of state.stage) c.dispose();
  state.stage.length = 0;
  for (let i = 0; i < n; i++) {
    const real = Math.random;
    let c;
    Math.random = seededRnd((o.seed ?? 700) + i * 13);
    try {
      c = makeCitizen(i === 2 ? { role: 'police' } : i === 5 ? { role: 'medic' } : { archetype: o.arch ?? archetypeAt((i * 0.37) % 1).key });
    } finally { Math.random = real; }
    c.group.scale.setScalar(0.9);
    A.scene.add(c.group);
    const r = seededRnd(90 + i);
    c.x = x - 7 + r() * 14; c.z = z + (i / n) * depth; c.x0 = c.x;
    c.h = r() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
    c.speed = o.speed ?? (1.1 + r() * 0.5); c.walkT = r() * 6;
    state.stage.push(c);
  }
  if (!state.fn) state.fn = step;
  return state.stage;
}

function step() {
  const now = performance.now(), dt = Math.min(0.05, (now - state.last) / 1000);
  state.last = now;
  for (const c of state.stage) {
    if (c.frozen) continue;
    const d = c.speed * dt;
    c.x += -Math.sin(c.h) * d;
    if (Math.abs(c.x - c.x0) > 6) c.h = -c.h;
    c.walkT += d * 1.6;
    c.group.position.set(c.x, sup(c.x, c.z), c.z);
    c.group.rotation.y = c.h;
    c.walk(c.walkT, c.speed / 1.4, 0, c.speed);
  }
}

/** Draw calls and triangles of the last frame, with and without the people. */
export function cost() {
  const info = A.renderer.info.render;
  return { calls: info.calls, triangles: info.triangles, fps: A.fps, peds: A.peds.peds.length };
}

export { A, makeCitizen, sup };
