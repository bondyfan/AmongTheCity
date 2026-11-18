import * as THREE from 'three';
import { street } from './prologue-route.js';

// The pavement of Dukelských hrdinů at dusk. He walks home along the car park,
// the hospital rings, he stops to look at the screen, and the call is filmed
// in a handful of shots: a long lens down the pavement, a profile, his face.
// Offsets are (right, up, forward) from his eyes; the road is on his right.
// The phone is in his right hand, so the camera keeps to his left.
const along = { x: -0.4937, z: 0.8696 }; // the footway's own direction
export const streetHeading = Math.atan2(-along.x, -along.z);
const right = { x: Math.cos(streetHeading), z: -Math.sin(streetHeading) };
const lerp = THREE.MathUtils.lerp;

// [from → to] camera offset, look-at offset, lens. `hold` shots do not ease.
const shots = {
  ring: { cam: [-1.7, -0.5, 13], to: [-1.3, -0.38, 9.5], look: [0, -0.45, 0], fov: 30, fixed: true },
  profile: { cam: [-3.7, -0.12, 1.5], to: [-3.2, -0.1, 1.0], look: [0, -0.12, 0.45], fov: 36 },
  front: { cam: [-0.42, -0.02, 1.5], to: [-0.34, 0, 1.22], look: [0.02, -0.04, 0], fov: 34 },
  push: { cam: [-1.05, -0.12, 2.5], to: [-0.72, -0.08, 1.65], look: [0.05, -0.1, 0], fov: 36 },
  close: { cam: [-0.2, 0.02, 0.86], to: [-0.15, 0.03, 0.66], look: [0.015, -0.01, 0], fov: 32 },
  behind: { cam: [-1.25, 0.42, -2.9], to: [-1.05, 0.5, -3.4], look: [0.5, -0.1, 6], fov: 40 },
  side: { cam: [-1.2, -0.02, 0.62], to: [-0.98, 0, 0.5], look: [0, -0.03, 0.05], fov: 33 },
  leave: { cam: [-0.6, 1.4, -5], to: [-0.3, 3.4, -8.5], look: [0.4, -0.5, 4], fov: 42 },
};
const byLine = ['profile', 'front', 'push', 'close', 'behind', 'side', 'leave'];

export function streetScene(world, player, act) {
  const eyes = new THREE.Vector3(),
    target = new THREE.Vector3(),
    anchor = new THREE.Vector3();
  let s = 0,
    speed = 0,
    gait = 0,
    ringing = 0,
    shot = '',
    shotAge = 0;
  const at = (metres) => ({ x: street.x + along.x * metres, z: street.z + along.z * metres });
  function offset(out, [r, u, f], base) {
    return out.set(base.x + right.x * r - Math.sin(streetHeading) * f, base.y + u, base.z + right.z * r - Math.cos(streetHeading) * f);
  }
  return {
    // Where he has got to, for the birds on the pavement ahead of him.
    get metres() {
      return s;
    },
    spot: at,
    begin() {
      s = speed = gait = ringing = shotAge = 0;
      shot = '';
      const p = at(0);
      act.place(p.x, world.heightAt(p.x, p.z), p.z, streetHeading);
    },
    // line: -1 while it rings, then the index of the spoken line.
    pose(dt, line, speech) {
      if (line < 0) ringing += dt;
      // He hears it, slows, stops and reads the screen. Answering, he walks
      // on slowly through her first sentence and stops dead at his question.
      const want = line < 0 ? (ringing < 2.4 ? 1.3 : 0) : line === 0 ? 0.8 : 0;
      speed += (want - speed) * Math.min(1, dt * (want > speed ? 1.6 : 2.6));
      if (speed < 0.03 && want === 0) speed = 0;
      s += speed * dt;
      gait += speed * dt * 1.6;
      const p = at(s);
      act.place(p.x, world.heightAt(p.x, p.z), p.z, streetHeading);
      if (speed > 0) act.cit.walk(gait, speed / 5.6, 0, speed);
      else player._stand();
      act.perform(dt, {
        gesture: line < 0 ? (ringing > 1.9 ? 'read' : null) : line >= 6 ? null : 'ear',
        emotion: line >= 3,
        speech,
        light: line >= 1 ? 0.75 : 0,
        bow: line >= 6 ? 0.22 : 0,
      });
    },
    camera(camera, dt, line) {
      const name = line < 0 ? 'ring' : byLine[Math.min(line, byLine.length - 1)];
      act.eyes(eyes);
      if (name !== shot) {
        shot = name;
        shotAge = 0;
        anchor.copy(eyes);
      }
      shotAge += dt;
      const def = shots[name],
        t = 1 - Math.exp(-shotAge * 0.34);
      // a fixed camera stays where the shot began and lets him walk into it
      const base = def.fixed ? anchor : eyes;
      const mix = def.cam.map((v, i) => lerp(v, def.to[i], t));
      offset(camera.position, mix, base);
      offset(target, def.look, eyes);
      camera.lookAt(target);
      camera.near = 0.03;
      camera.fov = def.fov;
      camera.updateProjectionMatrix();
    },
  };
}
