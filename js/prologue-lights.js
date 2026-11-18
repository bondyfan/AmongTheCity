import * as THREE from 'three';

// The story has two real lamps and no more. Every lit material in the city is
// compiled for the number of lights in the scene, so the two exist from the
// first frame to the last and are only moved, tinted and dimmed: his face and
// the stair-head door on the roof, the bedside lamp and the monitor in the
// hospital, then the platform and the inside of the coach.
export function storyLights(scene) {
  const a = new THREE.PointLight(0xffffff, 0, 4, 2),
    b = new THREE.PointLight(0xffffff, 0, 4, 2);
  scene.add(a, b);
  return {
    a,
    b,
    off() {
      a.intensity = b.intensity = 0;
    },
    dispose() {
      for (const l of [a, b]) {
        l.removeFromParent();
        l.dispose();
      }
    },
  };
}
