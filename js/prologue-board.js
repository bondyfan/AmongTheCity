import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { stationEntry, trackNumber } from './prologue-route.js';

export function departureBoard(scene, world, trip) {
  const group = new THREE.Group(),
    kit = scenery(group);
  group.name = 'Kolín • odjezdová tabule';
  group.rotation.y = -0.61;
  group.position.set(stationEntry.x, 0, stationEntry.z);
  for (const x of [-2.05, 2.05]) kit.box(x, 1.76, 0, 0.1, 3.52, 0.12, 0x69767a);
  kit.box(0, 2.7, 0, 4.48, 1.36, 0.19, 0x222d31);
  kit.sign(0, 3.82, 0.12, 4.8, 0.69, ['KOLÍN'], 0, '#1d4380');
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 300;
  const ctx = canvas.getContext('2d'),
    texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(4.32, 1.24),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  screen.position.set(0, 2.7, 0.102);
  group.add(screen);
  kit.finish();
  scene.add(group);
  let old = '';
  return {
    update(status) {
      group.position.y = world.heightAt(stationEntry.x, stationEntry.z);
      if (old === status) return;
      old = status;
      ctx.fillStyle = '#111c23';
      ctx.fillRect(0, 0, 1024, 300);
      ctx.fillStyle = '#1c3c51';
      ctx.fillRect(0, 0, 1024, 70);
      ctx.fillStyle = '#ebf3ef';
      ctx.font = '600 41px sans-serif';
      ctx.fillText('ODJEZDY', 28, 50);
      ctx.font = '25px sans-serif';
      ctx.fillText('SMĚR', 28, 110);
      ctx.fillText('NÁST.', 705, 110);
      ctx.fillText('KOLEJ', 878, 110);
      ctx.fillStyle = '#ffcf68';
      ctx.font = 'bold 57px monospace';
      ctx.fillText('Pardubice hl. n.', 25, 184);
      ctx.fillText(trip.platform, 725, 184);
      ctx.fillText(trackNumber[trip.platform], 904, 184);
      ctx.fillStyle = '#aec3cb';
      ctx.fillRect(26, 209, 970, 2);
      ctx.font = '31px monospace';
      ctx.fillText(status, 28, 264);
      texture.needsUpdate = true;
    },
    dispose() {
      screen.removeFromParent();
      screen.material.dispose();
      screen.geometry.dispose();
      texture.dispose();
      kit.dispose();
    },
  };
}
