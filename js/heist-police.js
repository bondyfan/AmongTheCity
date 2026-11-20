import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { storyRecording } from './audio.js';
import * as wanted from './wanted.js';
import { radioPlate, radioBare } from './heist-dialogue.js';
import { city, dist } from './heist-route.js';

// The police on the way home. Three things can put them on him:
//   * the plates. Frank, 18 Nov 2026: "když ho nesundá, tak potom v Pardubicích
//     po něm už pojedou policajti a zatknou ho". The camera over Hradecká reads
//     them (or any other way into town does), and from then on the heat does
//     not cool: they know which car it is. Nothing at the car said so.
//   * a car with no plates at all, to a patrol that gets a good look at it.
//   * the roadblock at the end of 17. listopadu that Vašek rings about.
// Two stars is an arrest, not a shooting (js/policetune.js); the arrest itself
// is the game's own.
const KNOWN_FOR = 150; // seconds a known plate can run before they have him

export function manhunt({ host, scene, world, traffic, talk, car }) {
  // the camera on its pole over Hradecká
  const group = new THREE.Group();
  group.name = 'Příběh • kamera na Hradecké';
  const base = world.heightAt(city.anpr.x, city.anpr.z);
  group.position.set(city.anpr.x + 5.2, base, city.anpr.z);
  scene.add(group);
  const k = scenery(group);
  k.box(0, 3.1, 0, 0.14, 6.2, 0.14, 0x6f757b);
  k.box(-1.5, 6.1, 0, 3.1, 0.1, 0.1, 0x6f757b);
  k.box(-2.7, 5.9, 0, 0.3, 0.26, 0.42, 0xe4e6e8);
  k.box(-2.1, 5.9, 0, 0.26, 0.2, 0.3, 0x2a2d30);
  k.finish();
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.9 }));
  flash.position.set(-2.1, 5.9, 0);
  flash.visible = false;
  group.add(flash);
  let known = false, // the plates were read
    chase = 0,
    look = 0,
    flashT = 0,
    topUp = 0,
    block = null,
    blockSaw = false,
    said = false;
  function radio(line) {
    if (talk.busy) return;
    talk.one(line, { phone: true, level: 1.7 });
  }
  function patrol(x, z, h) {
    const c = traffic.spawnPatrol?.(x, z, h);
    if (!c) return null;
    c.y = world.surfaceY?.(x, z, world.heightAt(x, z))?.y ?? world.heightAt(x, z);
    c._grounded = true;
    traffic.setSiren?.(c, true);
    return c;
  }
  return {
    get known() {
      return known;
    },
    get blocked() {
      return !!block;
    },
    // `bare`: both plates are off. Called while he drives the stolen car.
    update(dt, bare) {
      if (flashT > 0 && (flashT -= dt) <= 0) flash.visible = false;
      // --- the plates
      if (!bare && !known && (dist(car, city.anpr) < 38 || dist(car, city.centre) < 2250)) {
        known = true;
        if (dist(car, city.anpr) < 60) {
          flash.visible = true;
          flashT = 0.14;
          storyRecording('camera-flash', { level: 1.2 });
        }
        setTimeout(() => talk.one(radioPlate, { phone: true, level: 1.7 }), 1400);
        wanted.add(55, 'kradené auto');
      }
      if (known) {
        chase += dt;
        if ((topUp -= dt) <= 0) {
          topUp = 5;
          if (wanted.stars() < 2) wanted.add(55, 'kradené auto');
        }
        if (chase > KNOWN_FOR) host.fail('plate');
        return;
      }
      // --- no plates: a patrol close by takes a second look, and a third
      if (bare && wanted.stars() === 0) {
        const near = traffic.nearestPatrol?.(car.x, car.z, 30);
        look = near ? look + dt : Math.max(0, look - dt * 0.6);
        if (look > 2.4) {
          look = 0;
          if (!said) radio(radioBare);
          said = true;
          wanted.add(50, 'auto bez značek');
        }
      }
      // --- the roadblock
      const d = dist(car, city.block);
      if (!block && d < 650) {
        const b = city.block,
          ax = Math.cos(b.h), az = -Math.sin(b.h); // across the street
        block = [patrol(b.x - ax * 2.4, b.z - az * 2.4, b.h + Math.PI / 2 + 0.12), patrol(b.x + ax * 2.5, b.z + az * 2.5 + 1.0, b.h - Math.PI / 2 + 0.2)].filter(Boolean);
      }
      if (block && !blockSaw && d < city.blockSees) {
        blockSaw = true;
        if (!said) radio(radioBare);
        said = true;
        wanted.add(55, 'ujel zátarasu');
      }
    },
    dispose() {
      for (const c of block ?? []) {
        traffic.setSiren?.(c, false);
        host.dropPatrol(c);
      }
      block = null;
      flash.geometry.dispose();
      flash.material.dispose();
      k.dispose();
    },
  };
}
