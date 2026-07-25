// ---- Player: on-foot movement, and the seat-of-the-pants car handoff ----
// GTA-style third-person walking: WASD is CAMERA-relative (W always runs away
// from the camera), the body eases its heading toward wherever you push, and
// the world's collide() keeps you out of buildings and the Labe. While inCar
// the player is an invisible passenger — pos/heading mirror the car so the
// streamer, minimap and the exit math all keep reading one source of truth.
//
// Directions follow the ARCHITECTURE.md convention throughout:
//   dir(h) = (−sin h, −cos h), mesh.rotation.y = heading, h = atan2(−dx, −dz).

import { WALK, PLAYER_SCALE } from './config.js';
import { makeCitizen } from './citizen.js';

const TWO_PI = Math.PI * 2;
// the protagonist's fixed outfit — blue jacket so you always find yourself
const LOOK = { jacket: 0x3a63a8, pants: 0x2f3540, skin: 0xd9a066, hair: 0x3a2a1a };

export class Player {
  constructor(scene, x, z, heading) {
    const c = makeCitizen(LOOK);
    this.mesh = c.group;
    this._animate = c.walk;
    this.pos = { x, z };
    this.heading = heading;
    this.speed = 0;          // m/s along _dir
    this.walkT = 0;          // stride phase, advanced by distance
    this.inCar = null;       // car object (vehicles.js) or null
    this._dirX = 0; this._dirZ = -1;  // last move direction — decel glides along it
    this._world = null;      // remembered from update() so setInCar(null) can collide
    this.mesh.scale.setScalar(PLAYER_SCALE);
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = heading;
    scene.add(this.mesh);
  }

  update(dt, { input, camYaw, world }) {
    this._world = world;
    if (this.inCar) {
      // ride along invisibly; input belongs to the car while we're in it
      this.pos.x = this.inCar.x; this.pos.z = this.inCar.z;
      this.heading = this.inCar.heading;
      this.speed = this.inCar.speed;
      return;
    }

    // --- stick → world direction, relative to the camera yaw ---
    // camera forward f = dir(camYaw); screen-right r = dir(camYaw − π/2) =
    // (cos, −sin) — verified against f × up. moveZ is −1 for W (Woods input).
    const mx = input.moveX, mz = input.moveZ;
    const fX = -Math.sin(camYaw), fZ = -Math.cos(camYaw);
    const rX = Math.cos(camYaw), rZ = -Math.sin(camYaw);
    let wx = fX * -mz + rX * mx, wz = fZ * -mz + rZ * mx;
    const wl = Math.hypot(wx, wz);
    const moving = wl > 1e-3;
    if (moving) { wx /= wl; wz /= wl; this._dirX = wx; this._dirZ = wz; }

    // --- speed: snap accel toward jog/sprint, same rate braking to a stop ---
    const sprint = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    const target = moving ? (sprint ? WALK.sprint : WALK.jog) : 0;
    const dv = WALK.accel * dt;
    this.speed = this.speed < target
      ? Math.min(target, this.speed + dv)
      : Math.max(target, this.speed - dv);

    // --- heading eases toward the move direction, shortest way around ---
    if (moving) {
      const want = Math.atan2(-wx, -wz);
      let d = want - this.heading;
      d = ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
      const step = WALK.turn * dt;
      this.heading += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }

    // --- move + collide; substep so a dt spike can't tunnel a thin wall ---
    const dist = this.speed * dt;
    if (dist > 0) {
      const steps = Math.max(1, Math.ceil(dist / (WALK.radius * 0.8)));
      const sx = this._dirX * dist / steps, sz = this._dirZ * dist / steps;
      for (let i = 0; i < steps; i++) {
        this.pos.x += sx; this.pos.z += sz;
        world.collide(this.pos, WALK.radius);
      }
      this.walkT += dist * 1.6; // stride phase rides on distance, not time
    }

    // --- place + animate; heightAt handles bridge decks ---
    this.mesh.position.set(this.pos.x, world.heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.mesh.rotation.y = this.heading;
    this._animate(this.walkT, Math.min(1.25, this.speed / WALK.jog));
  }

  // Entering: hide the box person, the car owns the transform from here.
  // Exiting (null): step out 1.4 m to the car's RIGHT — right of dir(h) is
  // dir(h − π/2) = (cos h, −sin h) — then let the world push us clear of any
  // wall the car parked against, and reappear standing.
  setInCar(car) {
    if (car) {
      this.inCar = car;
      this.mesh.visible = false;
      return;
    }
    const c = this.inCar;
    this.inCar = null;
    if (c) {
      this.pos.x = c.x + Math.cos(c.heading) * 1.4;
      this.pos.z = c.z - Math.sin(c.heading) * 1.4;
      this.heading = c.heading;
      this.speed = 0;
      this._dirX = -Math.sin(c.heading); this._dirZ = -Math.cos(c.heading);
      const world = this._world;
      let y = 0;
      if (world) {
        // a couple of passes settle corner cases (door opens into a wall AND
        // the river bank, say); collide() returns false once we sit clean
        for (let i = 0; i < 3 && world.collide(this.pos, WALK.radius); i++);
        y = world.heightAt(this.pos.x, this.pos.z);
      }
      this.mesh.position.set(this.pos.x, y, this.pos.z);
      this.mesh.rotation.y = this.heading;
      this._animate(this.walkT, 0); // limbs relaxed the instant we appear
    }
    this.mesh.visible = true;
  }
}
