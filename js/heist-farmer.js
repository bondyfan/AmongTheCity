import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { seatAnchor } from './vehicles.js';
import { SIT_DROP, seatX } from './seating.js';
import { unlock } from './carlocks.js';
import { storyRecording } from './audio.js';
import { farm } from './heist-route.js';
import { chunkKey } from './geo.js';

// Jarda and his van (Frank, 20 Nov 2026: a farmer in Brozany who smokes weed,
// plays reggae, talks astrology and drives the player to the forest himself).
// The van is a real car of the game with Jarda in its driver's seat, so E puts
// the player in the passenger seat by the game's own rules; nobody simulates
// it, so this file writes its pose along a path, the way the story train goes.

// A polyline with its corners cut (Chaikin), then walked by distance.
export function track(points, rounds = 3) {
  let p = points.map(([x, z]) => ({ x, z }));
  for (let r = 0; r < rounds; r++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  const at = [0];
  for (let i = 1; i < p.length; i++) at.push(at[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  const length = at[at.length - 1];
  function point(s) {
    s = Math.max(0, Math.min(length, s));
    let lo = 0, hi = at.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at[mid] <= s) lo = mid;
      else hi = mid;
    }
    const k = (s - at[lo]) / Math.max(1e-6, at[hi] - at[lo]);
    return { x: p[lo].x + (p[hi].x - p[lo].x) * k, z: p[lo].z + (p[hi].z - p[lo].z) * k };
  }
  return {
    length,
    point,
    // the heading of travel at s, read over a car's length
    heading(s) {
      const a = point(s - 1.6), b = point(s + 2.4);
      return Math.atan2(-(b.x - a.x), -(b.z - a.z));
    },
  };
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(235,235,225,0.55)');
  grad.addColorStop(1, 'rgba(235,235,225,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function farmerVan(host, scene, world, player) {
  const van = host.addCar('van', farm.van.x, farm.van.z, farm.van.h, 0x6d7f4c);
  van._lockDraw = 1; // shut until he is behind the wheel: nobody else drives Jarda's van
  van.story = true;
  van._litT = Infinity; // side lights on in the yard: it is still night
  const man = makeCitizen({ uid: 'jarda', avatar: 'm16', archetype: 'man', jacket: 0x8a6a2c, pants: 0x3c4a34, seed: 4207 });
  const right = { x: Math.cos(van.heading), z: -Math.sin(van.heading) },
    fwd = { x: -Math.sin(van.heading), z: -Math.cos(van.heading) };
  const stand = { x: van.x - right.x * 1.55 + fwd.x * 0.7, z: van.z - right.z * 1.55 + fwd.z * 0.7 };
  man.group.position.set(stand.x, world.heightAt(stand.x, stand.z), stand.z);
  man.group.rotation.y = van.heading - Math.PI / 2;
  scene.add(man.group);
  // the joint: a small ember in his right hand
  const ember = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.07), new THREE.MeshBasicMaterial({ color: 0xff8a3a, fog: false }));
  ember.position.set(0, -0.05, -0.06);
  man.parts.handR?.add(ember);
  const tex = smokeTexture();
  const puffs = Array.from({ length: 7 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
    s.userData.age = 9;
    s.visible = false;
    scene.add(s);
    return s;
  });
  let nextPuff = 1.2;
  const music = storyRecording('reggae', { loop: true, level: 0 }),
    hens = storyRecording('hens', { loop: true, level: 0 });
  let stage = 'wait', // wait → seated → ride → stopped → leave → gone
    path = null,
    lane = 0, // metres to the right of the path: his side of the road
    s = 0,
    speed = 0,
    t = 0,
    hop = null, // a skipped ride: the picture is black while the forest road arrives
    hopped = false;
  function seat() {
    man.sitPose(1, 1);
    van.seats ??= [];
    van.seats[0] = man;
    const p = seatAnchor(van, 0);
    van.mesh.add(man.group);
    man.group.position.set(seatX(p.x), p.y - SIT_DROP, p.z);
    man.group.rotation.y = 0;
    ember.visible = false;
  }
  function drive(dt) {
    // slow for what is coming: a bend, and the end of the road
    const h = path.heading(s),
      bend = Math.abs(wrap(path.heading(s + 11) - h)) + Math.abs(wrap(path.heading(s + 5) - h));
    const want = Math.min(11.5 - Math.min(8.3, bend * 9), Math.sqrt(2 * 1.5 * Math.max(0, path.length - s)) + 0.15);
    speed += Math.max(-2.8 * dt, Math.min(1.3 * dt, want - speed));
    speed = Math.max(0, speed);
    s = Math.min(path.length, s + speed * dt);
    // he does not hold a line: the van wanders a little inside its lane
    // on the road he keeps (roughly) to the right; the farm's own track is one lane wide
    const onRoad = stage === 'leave' || (s > 262 && s < path.length - 30);
    lane += Math.max(-0.6 * dt, Math.min(0.6 * dt, (onRoad ? 1.45 : 0) - lane));
    const p = path.point(s),
      sway = lane + 0.32 * Math.sin(t * 0.55) * Math.min(1, speed / 6),
      turn = wrap(path.heading(s + 3) - h);
    van.heading = h + 0.03 * Math.cos(t * 0.55) * Math.min(1, speed / 6);
    van.x = p.x + Math.cos(h) * sway;
    van.z = p.z - Math.sin(h) * sway;
    van.speed = speed;
    van.steer = Math.max(-0.5, Math.min(0.5, turn * 1.6));
    van.y = world.surfaceY?.(van.x, van.z, van.y)?.y ?? world.heightAt(van.x, van.z);
    van._grounded = true;
  }
  return {
    van,
    man,
    get stage() {
      return stage;
    },
    get speed() {
      return speed;
    },
    stand,
    // "Tak nasedat": he gets in behind the wheel and waits for his passenger
    board() {
      if (stage !== 'wait') return;
      stage = 'seated';
      seat();
      unlock(van);
    },
    go() {
      if (stage !== 'seated') return;
      stage = 'ride';
      path = track(farm.ride);
      s = 0;
    },
    get hopped() {
      return hopped;
    },
    // T after a failed mission (js/story-retry.js): the ride is ridden. The
    // picture goes black, the road by the forest (another tile) is fetched,
    // and the van is put a few lengths short of where it stops.
    skipRide(hud) {
      if (stage !== 'ride' || hopped) return false;
      hopped = true;
      hop = { t: 0, hud };
      hud.veil(true);
      return true;
    },
    // set down by the forest: round on the verge and back the way he came
    leave() {
      if (stage !== 'stopped') return;
      stage = 'leave';
      const h = van.heading,
        r = { x: Math.cos(h), z: -Math.sin(h) },
        f = { x: -Math.sin(h), z: -Math.cos(h) },
        c = { x: van.x - r.x * 5.6, z: van.z - r.z * 5.6 },
        pts = [];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI;
        pts.push([c.x + 5.6 * (r.x * Math.cos(a) + f.x * Math.sin(a)), c.z + 5.6 * (r.z * Math.cos(a) + f.z * Math.sin(a))]);
      }
      const back = farm.ride.slice(-6, -1).reverse();
      path = track([...pts, ...back], 2);
      s = 0;
      speed = 0;
    },
    // `inside`: the player is in the passenger seat; `talking`: somebody speaks
    update(dt, { inside = false, talking = false, facing = null } = {}) {
      t += dt;
      if (stage === 'gone') return;
      if (hop) {
        const [ex, ez] = farm.ride.at(-1);
        hop.t += dt;
        if (!hop.asked && hop.t > 0.5) {
          hop.asked = true;
          world.city?.ensureTiles?.(ex, ez)?.catch?.(() => {});
          world.terrain?.ensure?.(ex, ez);
        } else if (hop.asked && !hop.moved && (world.terrain.ready(ex, ez) || hop.t > 30)) {
          hop.moved = true;
          hop.t = 0;
          if (stage === 'ride') {
            s = Math.max(s, path.length - 14);
            speed = Math.min(speed, 5);
          }
        } else if (hop.moved && ((hop.t > 1.4 && world.built.has(chunkKey(van.x, van.z))) || hop.t > 30)) {
          hop.hud.veil(false);
          hop = null;
        }
      }
      if (stage === 'wait') {
        man.group.position.y = world.heightAt(stand.x, stand.z);
        if (facing) man.group.rotation.y = Math.atan2(stand.x - facing.x, stand.z - facing.z);
        man.standPose();
        // the hand with the joint comes up to his mouth now and then
        const up = 0.5 + 0.5 * Math.sin(t * 0.9);
        man.parts.armR.rotation.x += 0.35 + 0.75 * up;
        man.parts.elbowR.rotation.x += 0.5 + 1.2 * up;
      } else if (stage === 'stopped') {
        // (a skipped ride may stop before the ground here has arrived)
        van.y = world.surfaceY?.(van.x, van.z, van.y)?.y ?? world.heightAt(van.x, van.z);
      } else if (stage === 'ride' || stage === 'leave') {
        drive(dt);
        if (s >= path.length - 0.05 && speed < 0.2) {
          speed = van.speed = 0;
          if (stage === 'ride') stage = 'stopped';
          else {
            stage = 'gone';
            music.stop(0.5);
            hens.stop(0.5);
            if (van.seats?.[0] === man) van.seats[0] = null;
            van.mesh.remove(man.group);
            man.group.visible = false;
            host.removeCar(van);
          }
        }
      }
      // the smoke he breathes out, while he stands in the yard
      if (stage === 'wait' && (nextPuff -= dt) <= 0) {
        nextPuff = 2.6 + Math.random() * 2.2;
        const free = puffs.find((p) => p.userData.age > 4);
        if (free) {
          free.userData.age = 0;
          free.position.set(stand.x + (Math.random() - 0.5) * 0.1, man.group.position.y + 1.62, stand.z + (Math.random() - 0.5) * 0.1);
          free.visible = true;
        }
      }
      for (const p of puffs) {
        if (!p.visible) continue;
        const a = (p.userData.age += dt);
        p.position.y += 0.22 * dt;
        p.position.x += 0.06 * dt;
        p.scale.setScalar(0.18 + a * 0.3);
        p.material.opacity = Math.max(0, 0.5 - a * 0.13);
        if (a > 4) p.visible = false;
      }
      // the radio: loud at the open van, a bed under the talk when he rides in it
      const d = Math.hypot(player.pos.x - van.x, player.pos.z - van.z),
        outside = Math.max(0, 1 - d / 60) ** 2 * 0.75;
      music.set(stage === 'gone' ? 0 : inside ? (talking ? 0.3 : 0.55) : outside * (talking ? 0.6 : 1));
      const dy = Math.hypot(player.pos.x - farm.yard.x, player.pos.z - farm.yard.z);
      hens.set(inside ? 0 : Math.max(0, 1 - dy / 45) * 0.55);
    },
    dispose() {
      hop?.hud.veil(false);
      music.stop();
      hens.stop();
      ember.geometry.dispose();
      ember.material.dispose();
      for (const p of puffs) {
        scene.remove(p);
        p.material.dispose();
      }
      tex.dispose();
      if (stage !== 'gone') {
        if (van.seats?.[0] === man) van.seats[0] = null;
        man.group.removeFromParent();
        host.removeCar(van);
      }
      man.dispose();
    },
  };
}
