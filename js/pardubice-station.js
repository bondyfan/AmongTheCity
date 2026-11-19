import * as THREE from 'three';
import { stationKit } from './stationkit.js';
import { worldAt } from './station-layout.js';
import { buildUnderpass } from './pardubice-underpass.js';
import { buildPlatforms } from './pardubice-platforms.js';

// Pardubice hlavní nádraží, the permanent part: both underpasses below, the
// platforms' canopies and furniture above. Built once when the player first
// comes near (js/station-passages.js update) and kept for the session.
export function pardubiceStation(s, scene, world) {
  const under = new THREE.Group();
  under.name = s.name + ' • podchody';
  under.position.set(s.x, s.bottom, s.z);
  under.rotation.y = -s.angle;
  const below = stationKit(under);
  buildUnderpass(s, below);
  below.finish();
  scene.add(under);

  const origin = worldAt(s, -30, 0),
    ground = world.heightAt(origin.x, origin.z, world.terrain.heightAt(origin.x, origin.z) + 1);
  const over = new THREE.Group();
  over.name = s.name + ' • nástupiště';
  over.position.set(s.x, ground, s.z);
  over.rotation.y = -s.angle;
  // what a prop at (u, v) stands on, from the group's own level; a deck that
  // passes overhead (the footbridge) is not it
  const Y = (u, v) => {
    const p = worldAt(s, u, v);
    return world.heightAt(p.x, p.z, ground + 1) - ground;
  };
  const above = stationKit(over);
  const roofs = buildPlatforms(s, above, Y);
  above.finish();
  scene.add(over);
  let shown = -1;
  s.dress = {
    update(night) {
      if (Math.abs(night - shown) < 0.02) return;
      shown = night;
      above.night(night);
    },
    cover: roofs.cover,
    lid(u, v) {
      const y = roofs.lid(u, v);
      return y === null ? null : ground + y;
    },
  };
  return under;
}
