import * as THREE from 'three';
import { stationKit } from './stationkit.js';
import { worldAt, inRect } from './station-layout.js';
import { buildUnderpass } from './pardubice-underpass.js';
import { buildPlatforms } from './pardubice-platforms.js';
import { buildBridge } from './pardubice-lavka.js';

// Pardubice hlavní nádraží, the permanent part: both underpasses below, the
// platforms' canopies and furniture and the footbridge above. Built once when the player first
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
  buildBridge(s, above, Y, ground);
  above.finish();
  scene.add(over);
  let shown = -1;
  s.dress = {
    update(night) {
      if (Math.abs(night - shown) < 0.02) return;
      shown = night;
      above.night(night);
      below.night(night);
    },
    // (somebody walking under the footbridge is under a roof too)
    cover: (u, v) => roofs.cover(u, v) || inRect(s.deck, u, v, 0.5),
    lid(u, v) {
      const y = roofs.lid(u, v);
      if (y !== null) return ground + y;
      return inRect(s.deck, u, v, 0.5) ? s.deck.y - 1.4 : null;
    },
  };
  return under;
}
