// ---- flight-camera.js: from seat 14A, or from outside ----
// Two shots and the C key between them (the key that is first person in a
// car). INSIDE is the passenger's own eyes: a seated eye point fixed to the
// airframe, so the cabin pitches and banks with it and the horizon tilts in
// the window, which is the whole sensation of a take-off. The mouse looks
// round within what a neck allows. It starts turned toward the window and a
// little forward, where the wing and the ground going by are. OUTSIDE is a
// chase from behind and above, far enough back for a 36 m wingspan, lagging
// the airframe a little in yaw so a turn reads as a turn.
//
// Camera rules from main.js still hold: the boom never goes under the
// ground, and the near plane is pulled in only while we are inside, where a
// seat back is 40 cm from the lens.

import * as THREE from 'three';

const LOOK = { yaw: 1.0, pitch: -0.12 }; // toward the window (left of the nose) with the seat ahead in view, a little down
const YAW = [-1.0, 2.5], PITCH = [-0.65, 0.55];
const CHASE = { dist: 62, up: 14 };
const _q = new THREE.Quaternion(), _qLook = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3(), _t = new THREE.Vector3();

export function flightCamera() {
  let inside = true, yaw = LOOK.yaw, pitch = LOOK.pitch, chaseYaw = null, orbit = 0, lift = 0.22;
  return {
    get inside() { return inside; },
    toggle() { inside = !inside; chaseYaw = null; return true; },
    set(v) { inside = v; chaseYaw = null; },
    reset() { yaw = LOOK.yaw; pitch = LOOK.pitch; orbit = 0; lift = 0.22; },
    /**
     * @param group the airliner's group (its matrixWorld is current)
     * @param eye the seated eye point in the airliner's own frame
     * @param ground (x, z) → height, to keep the chase out of the tarmac
     * → 'inside' or 'outside' (main.js hides the player's own body inside)
     */
    frame(camera, dt, drag, group, eye, ground) {
      const sens = 0.0034;
      if (inside) {
        yaw = Math.max(YAW[0], Math.min(YAW[1], yaw - (drag?.x ?? 0) * sens));
        pitch = Math.max(PITCH[0], Math.min(PITCH[1], pitch - (drag?.y ?? 0) * sens));
        group.updateMatrixWorld();
        camera.position.copy(_v.set(eye.x, eye.y, eye.z).applyMatrix4(group.matrixWorld));
        group.getWorldQuaternion(_q);
        _e.set(pitch, yaw, 0, 'YXZ');
        _qLook.setFromEuler(_e);
        camera.quaternion.copy(_q).multiply(_qLook);
        if (camera.near !== 0.04 || Math.abs(camera.fov - 64) > 0.1) {
          camera.near = 0.04; camera.fov = 64; camera.updateProjectionMatrix();
        }
        return 'inside';
      }
      orbit -= (drag?.x ?? 0) * sens;
      lift = Math.max(0.02, Math.min(1.1, lift + (drag?.y ?? 0) * sens));
      const h = group.rotation.y;
      if (chaseYaw === null) chaseYaw = h;
      chaseYaw += Math.atan2(Math.sin(h - chaseYaw), Math.cos(h - chaseYaw)) * Math.min(1, dt * 1.4);
      const a = chaseYaw + orbit, d = CHASE.dist;
      _t.set(group.position.x, group.position.y + 4, group.position.z);
      camera.position.set(_t.x + Math.sin(a) * Math.cos(lift) * d, _t.y + Math.sin(lift) * d + 2, _t.z + Math.cos(a) * Math.cos(lift) * d);
      const floor = ground(camera.position.x, camera.position.z) + 1.5;
      if (camera.position.y < floor) camera.position.y = floor;
      camera.lookAt(_t);
      if (camera.near !== 0.3 || Math.abs(camera.fov - 55) > 0.1) {
        camera.near = 0.3; camera.fov = 55; camera.updateProjectionMatrix();
      }
      return 'outside';
    },
  };
}
