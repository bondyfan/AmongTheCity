import { roofFrame } from './prologue-route.js';
import { world2, deckY } from './prologue-roof.js';

// After the call the roof is his to walk, but not to fall from: the felt is a
// deck with an edge he cannot cross, and the one way down is the cat ladder on
// the end wall. E takes hold of it, S climbs down (W back up), and the clock
// runs the whole time.
const LADDER = { x: -3.6, z: -0.36 }, // on the outside face of the end wall
  REACH = 1.7,
  DOWN = 3.1, // m/s on the rungs
  UP = 2.0;
// what stands on the deck, as boxes in the roof frame: [x0, x1, z0, z1]
const solids = [
  [0.7, 3.8, 7.75, 11.05], // stair head
  [-3.0, -2.1, 4.35, 5.45], // chimney
  [2.6, 3.5, 12.85, 13.95], // chimney
  [-1.25, 0.65, 6.2, 7.6], // skylight
  [1.4, 2.4, 1.7, 2.7], // hatch
];
const sin = Math.sin(roofFrame.h),
  cos = Math.cos(roofFrame.h);
const local = (x, z) => ({ x: (x - roofFrame.x) * cos - (z - roofFrame.z) * sin, z: (x - roofFrame.x) * sin + (z - roofFrame.z) * cos });

export function roofWalk(world, player, input) {
  let state = 'off', // 'roof' free on the deck, 'ladder' on the rungs
    top = 0,
    foot = 0,
    height = 0, // feet above the ladder's foot
    phase = 0;
  const onDeck = (p, pad = 0) => p.x > -4.3 - pad && p.x < 4.3 + pad && p.z > 0.5 - pad && p.z < 24.6 + pad;
  return {
    get state() {
      return state;
    },
    ladderTop() {
      const p = world2(LADDER.x, 0.9);
      return { x: p.x, y: top, z: p.z };
    },
    // Hand the roof over to the player where the film left him.
    begin() {
      state = 'roof';
      top = deckY(world) + 0.035;
      const f = world2(LADDER.x, -1.2);
      foot = world.terrain.heightAt(f.x, f.z);
    },
    // --- the deck, for the world's support and collision (see prologue.js)
    carrying(x, z) {
      return state === 'roof' && onDeck(local(x, z), 0.4);
    },
    support() {
      return top;
    },
    // ONLY A WALKER WHO IS ON THE DECK. This used to pull ANY point the world
    // asked about onto the roof, from anywhere: the helicopters parked at the
    // airports ask world.collide every frame, so they were carried to this
    // roof in Kolín and dropped beside the house (Frank, 25 Nov 2026: "jak
    // potom slízá z toho baráku, tak tam jsou nějaké vrtulníky").
    collide(pos, r, opts) {
      if (state !== 'roof' || !opts?.interior) return false;
      const p = local(pos.x, pos.z),
        x0 = p.x,
        z0 = p.z;
      if (!onDeck(p, 1.5)) return false;
      if (Number.isFinite(opts.yHi) && Number.isFinite(opts.yLo) && (opts.yHi < top - 0.5 || opts.yLo > top + 2.5)) return false;
      p.x = Math.max(-4.3 + r, Math.min(4.3 - r, p.x));
      p.z = Math.max(0.5 + r, Math.min(24.6 - r, p.z));
      for (const [a, b, c, d] of solids) {
        if (p.x <= a - r || p.x >= b + r || p.z <= c - r || p.z >= d + r) continue;
        const out = [p.x - a + r, b + r - p.x, p.z - c + r, d + r - p.z],
          n = out.indexOf(Math.min(...out));
        if (n === 0) p.x = a - r;
        else if (n === 1) p.x = b + r;
        else if (n === 2) p.z = c - r;
        else p.z = d + r;
      }
      if (p.x === x0 && p.z === z0) return false;
      Object.assign(pos, world2(p.x, p.z));
      return true;
    },
    // --- the ladder
    near() {
      if (state !== 'roof') return false;
      const p = local(player.pos.x, player.pos.z);
      return Math.hypot(p.x - LADDER.x, p.z - 0.9) < REACH;
    },
    mount() {
      if (!this.near()) return false;
      state = 'ladder';
      this.turned = true; // the camera should come round behind him (see prologue.js)
      height = top + 0.3 - foot;
      player._stand();
      return true;
    },
    // Writes the body while he is on the rungs; false when he is not.
    pose(dt) {
      if (state !== 'ladder') return false;
      const keys = input.keys;
      const move = (keys.has('KeyS') || keys.has('ArrowDown') ? -DOWN : 0) + (keys.has('KeyW') || keys.has('ArrowUp') ? UP : 0);
      height = Math.min(top + 0.3 - foot, height + move * dt);
      phase += Math.abs(move) * dt * 2.6;
      const p = world2(LADDER.x, LADDER.z - 0.16);
      player.pos.x = p.x;
      player.pos.z = p.z;
      player.y = foot + Math.max(0, height);
      player.vy = 0;
      player.speed = 0;
      player.grounded = true;
      player.heading = roofFrame.h + Math.PI; // facing the wall
      player.mesh.position.set(p.x, player.y, p.z);
      player.mesh.rotation.y = player.heading;
      player._stand();
      const swing = Math.sin(phase),
        j = player._cit.parts;
      j.armL.rotation.x = 2.45 + 0.35 * swing;
      j.armR.rotation.x = 2.45 - 0.35 * swing;
      j.elbowL.rotation.x = 0.48;
      j.elbowR.rotation.x = 0.48;
      j.legL.rotation.x = 0.38 - 0.35 * swing;
      j.legR.rotation.x = 0.38 + 0.35 * swing;
      j.kneeL.rotation.x = -0.5 + 0.35 * swing;
      j.kneeR.rotation.x = -0.5 - 0.35 * swing;
      if (height <= 0) {
        // down: a step back from the wall and the street is his
        const g = world2(LADDER.x, -1.3);
        player.pos.x = g.x;
        player.pos.z = g.z;
        player.y = world.heightAt(g.x, g.z);
        player.heading = roofFrame.h;
        state = 'off';
        player._stand();
      } else if (height >= top + 0.3 - foot && move > 0) {
        // back over the coping
        const g = world2(LADDER.x, 1.0);
        player.pos.x = g.x;
        player.pos.z = g.z;
        player.y = top;
        state = 'roof';
        player._stand();
      }
      return true;
    },
    // 0 at the top … 1 on the ground, for the HUD
    get progress() {
      return 1 - Math.max(0, height) / Math.max(1, top - foot);
    },
  };
}
