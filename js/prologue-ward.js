import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { makeCitizen } from './citizen.js';
import { storyTone } from './audio.js';

// The four seconds the father cannot see: his daughter asleep in a hospital
// bed, a monitor counting her heart. The room is a closed box far below the
// street, so nothing of the city shows and nothing of it shows in the city.
// Bed along z with the pillow at +z; the camera stands by her left foot.
const BEAT = 0.74; // seconds between heartbeats (81 a minute)

// One heartbeat as a monitor draws it, phase 0..1, baseline 0, R peak 1.
function ecg(p) {
  if (p < 0.1) return 0.12 * Math.sin((p / 0.1) * Math.PI);
  if (p < 0.16) return 0;
  if (p < 0.19) return -0.14 * ((p - 0.16) / 0.03);
  if (p < 0.22) return -0.14 + 1.14 * ((p - 0.19) / 0.03);
  if (p < 0.26) return 1 - 1.28 * ((p - 0.22) / 0.04);
  if (p < 0.29) return -0.28 + 0.28 * ((p - 0.26) / 0.03);
  if (p < 0.42) return 0;
  if (p < 0.62) return 0.2 * Math.sin(((p - 0.42) / 0.2) * Math.PI);
  return 0;
}

export function ward(scene, lights, x, y, z) {
  const group = new THREE.Group(),
    k = scenery(group);
  group.name = 'Nemocnice • dětský pokoj';
  group.position.set(x, y, z);
  group.visible = false;
  const wall = 0xd3d2c6,
    dado = 0xa9b3a6,
    steel = 0x9aa5a8,
    linen = 0xcfd3d0;
  // shell
  k.box(0, -0.05, 0, 5, 0.1, 4.4, 0x77837f);
  k.box(0, 2.9, 0, 5, 0.1, 4.4, 0xd5dad6);
  for (const sx of [-2.5, 2.5]) k.box(sx, 1.45, 0, 0.1, 2.9, 4.4, wall);
  for (const sz of [-2.2, 2.2]) k.box(0, 1.45, sz, 5, 2.9, 0.1, wall);
  for (const sz of [-2.14, 2.14]) k.box(0, 0.5, sz, 4.9, 1.0, 0.03, dado);
  k.box(2.44, 0.5, 0, 0.03, 1.0, 4.3, dado);
  k.box(-2.44, 0.5, 0, 0.03, 1.0, 4.3, dado);
  // the window on the far wall: dusk behind half-drawn blinds
  k.box(2.43, 1.62, -0.35, 0.04, 1.36, 1.96, 0x394049);
  k.box(2.41, 1.62, -0.35, 0.02, 1.24, 1.84, 0x51658f, 0, true);
  k.box(2.4, 1.2, -0.35, 0.02, 0.34, 1.84, 0xc98d6b, 0, true);
  for (let i = 0; i < 9; i++) k.box(2.38, 2.2 - i * 0.075, -0.35, 0.03, 0.045, 1.86, 0xd8dcd6);
  k.box(2.36, 0.9, -0.35, 0.16, 0.05, 2.0, linen);
  for (let i = 0; i < 6; i++) k.box(2.33, 1.45, 0.86 + i * 0.07, 0.05, 2.5, 0.06, i % 2 ? 0x7c9aa2 : 0x8caab0);
  // bed: frame, wheels, mattress, rails, pillow
  const top = 0.6;
  k.box(0, 0.36, 0.05, 0.94, 0.06, 2.06, steel);
  for (const sx of [-0.42, 0.42])
    for (const sz of [-0.9, 1.0]) {
      k.box(sx, 0.2, sz, 0.045, 0.3, 0.045, steel);
      k.box(sx, 0.05, sz, 0.09, 0.1, 0.09, 0x33393b, 0, false, 'round');
    }
  k.box(0, top - 0.09, 0.05, 0.88, 0.18, 1.98, linen);
  k.box(0, 0.86, 1.06, 0.94, 0.62, 0.04, 0xb9c6c4);
  k.box(0, 0.7, -0.96, 0.94, 0.34, 0.04, 0xb9c6c4);
  for (const sx of [-0.46, 0.46]) {
    k.box(sx, top + 0.26, 0.35, 0.025, 0.025, 1.1, steel);
    for (const sz of [-0.2, 0.35, 0.9]) k.box(sx, top + 0.13, sz, 0.02, 0.26, 0.02, steel);
  }
  k.box(0, top + 0.05, 0.78, 0.6, 0.11, 0.38, 0xdcdcd6, 0, false, 'round');
  // blanket with a turned-down sheet, raised over her feet
  k.box(0, top + 0.1, -0.02, 0.8, 0.2, 1.12, 0x8fb4c9, 0, false, 'round');
  k.box(0, top + 0.13, -0.5, 0.42, 0.22, 0.34, 0x8fb4c9, 0, false, 'round');
  k.box(0, top + 0.175, 0.46, 0.74, 0.07, 0.17, 0xf3f4ef, 0, false, 'round');
  // a plush bear on the blanket, the one thing in the room that is hers
  k.box(0.27, top + 0.26, 0.3, 0.12, 0.11, 0.16, 0x7a5235, 0, false, 'round');
  k.box(0.27, top + 0.28, 0.43, 0.1, 0.1, 0.1, 0x84593a, 0, false, 'round');
  for (const s of [-1, 1]) k.box(0.27 + s * 0.045, top + 0.33, 0.45, 0.04, 0.04, 0.03, 0x6d472d, 0, false, 'round');
  // monitor on a pole at her right shoulder
  k.box(0.86, 0.02, 1.2, 0.5, 0.04, 0.5, 0x4a5357, 0, false, 'round');
  k.box(0.86, 0.72, 1.2, 0.04, 1.4, 0.04, steel);
  k.box(0.86, 1.46, 1.2, 0.5, 0.38, 0.09, 0x2a3034);
  k.box(0.86, 1.22, 1.17, 0.36, 0.06, 0.1, 0x3b4347);
  for (let i = 0; i < 4; i++) k.box(0.74 + i * 0.08, 1.22, 1.115, 0.03, 0.02, 0.01, [0x6fd08a, 0xf0c15a, 0xe86a5c, 0x7fb6e8][i], 0, true);
  // drip stand, bag and line
  k.box(-0.82, 0.02, 1.25, 0.46, 0.04, 0.46, 0x4a5357, 0, false, 'round');
  k.box(-0.82, 0.98, 1.25, 0.03, 1.92, 0.03, steel);
  k.box(-0.82, 1.93, 1.25, 0.36, 0.02, 0.02, steel);
  k.box(-0.7, 1.72, 1.25, 0.14, 0.26, 0.05, 0xdfeef0, 0, false, 'glass');
  k.box(-0.7, 1.68, 1.25, 0.12, 0.16, 0.04, 0xc7e2e8, 0, false, 'round');
  k.box(-0.7, 1.3, 1.25, 0.008, 0.58, 0.008, 0xe8f0f0);
  k.box(-0.55, 0.9, 0.95, 0.008, 0.008, 0.72, 0xe8f0f0, 0, false, 'solid');
  // bedside table, lamp, a glass and her drawing things
  k.box(-0.95, 0.36, 0.6, 0.42, 0.72, 0.4, 0xd9d6cb);
  k.box(-0.95, 0.5, 0.39, 0.34, 0.2, 0.012, 0xbfbcb0);
  k.box(-0.98, 0.78, 0.66, 0.1, 0.12, 0.1, 0x6b7479);
  k.box(-0.98, 0.93, 0.66, 0.2, 0.17, 0.2, 0xffd9a0, 0, true, 'round');
  k.box(-0.86, 0.79, 0.48, 0.06, 0.12, 0.06, 0xdcecef, 0, false, 'glass');
  for (let i = 0; i < 4; i++) k.box(-1.06 + i * 0.03, 0.735, 0.47, 0.014, 0.014, 0.13, [0xd8483e, 0x3f78c9, 0xe6b83a, 0x4e9a58][i]);
  // the visitor's chair, pulled up and empty
  k.box(-1.35, 0.44, -0.35, 0.44, 0.05, 0.44, 0x56707c);
  k.box(-1.57, 0.74, -0.35, 0.05, 0.56, 0.44, 0x56707c);
  for (const sx of [-1.54, -1.16]) for (const sz of [-0.54, -0.16]) k.box(sx, 0.21, sz, 0.035, 0.42, 0.035, steel);
  // head wall: gas rail, a call button, strip light
  k.box(0.2, 1.36, 2.12, 2.3, 0.13, 0.06, 0xdfe3df);
  for (let i = 0; i < 5; i++) k.box(-0.6 + i * 0.36, 1.36, 2.085, 0.07, 0.07, 0.02, [0xe9e9e4, 0x5aa86b, 0xe9e9e4, 0xd9a13c, 0x4f86c6][i]);
  k.box(0.2, 1.47, 2.1, 1.9, 0.035, 0.05, 0xfff3dc, 0, true);
  k.box(-1.7, 1.55, 2.13, 0.3, 0.3, 0.03, 0xf2f2ec, 0, false, 'round');
  k.finish();
  // her drawing, taped over the bed: two figures, a house and a sun
  const paper = document.createElement('canvas');
  paper.width = 256;
  paper.height = 192;
  const d = paper.getContext('2d');
  d.fillStyle = '#f7f3e6';
  d.fillRect(0, 0, 256, 192);
  d.lineWidth = 5;
  d.lineCap = 'round';
  d.strokeStyle = '#e2a521';
  d.beginPath();
  d.arc(212, 40, 20, 0, 7);
  d.stroke();
  d.strokeStyle = '#c4473a';
  d.strokeRect(24, 86, 70, 62);
  d.beginPath();
  d.moveTo(18, 88);
  d.lineTo(59, 46);
  d.lineTo(100, 88);
  d.stroke();
  for (const [px, s, c] of [
    [140, 1, '#2f62ad'],
    [190, 0.62, '#b0428b'],
  ]) {
    d.strokeStyle = c;
    d.beginPath();
    d.arc(px, 150 - 76 * s, 13 * s, 0, 7);
    d.moveTo(px, 150 - 62 * s);
    d.lineTo(px, 150 - 24 * s);
    d.moveTo(px - 20 * s, 150 - 46 * s);
    d.lineTo(px + 20 * s, 150 - 46 * s);
    d.moveTo(px, 150 - 24 * s);
    d.lineTo(px - 13 * s, 150);
    d.moveTo(px, 150 - 24 * s);
    d.lineTo(px + 13 * s, 150);
    d.stroke();
  }
  d.fillStyle = '#3c3a36';
  d.font = '600 21px system-ui, sans-serif';
  d.fillText('TÁTA A JÁ', 122, 180);
  const drawing = new THREE.CanvasTexture(paper);
  drawing.colorSpace = THREE.SRGBColorSpace;
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.315), new THREE.MeshLambertMaterial({ map: drawing }));
  sheet.position.set(0.95, 1.93, 2.14);
  sheet.rotation.set(0, Math.PI, 0.05);
  group.add(sheet);
  // the monitor's screen
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 220;
  const ctx = canvas.getContext('2d'),
    texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.3), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.set(0.86, 1.47, 1.152);
  screen.rotation.y = Math.PI;
  group.add(screen);
  // the girl: the game's own figure at child size, asleep on her back
  const girl = makeCitizen({ uid: 'kolin-dcera', archetype: 'f30', jacket: 0xdfe6ea, pants: 0xdfe6ea, hair: 0x4a3324 });
  girl.standPose();
  girl.parts.head.scale.setScalar(1.22);
  girl.parts.head.rotation.set(-0.06, 0.22, 0);
  girl.parts.armL.rotation.z = -0.2;
  girl.parts.armR.rotation.z = 0.2;
  girl.group.scale.setScalar(0.64);
  girl.group.rotation.x = Math.PI / 2;
  girl.group.position.set(0, top + 0.1, -0.42);
  group.add(girl.group);
  // The bedside lamp and the monitor's glow borrow the story's two lamps.
  const lamp = lights.a,
    glow = lights.b;
  scene.add(group);
  let time = 0,
    beats = -1;
  function draw() {
    ctx.fillStyle = '#071013';
    ctx.fillRect(0, 0, 320, 220);
    ctx.strokeStyle = '#123138';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < 320; gx += 20) ctx.strokeRect(gx, 0, 20, 220);
    const sweep = (time * 92) % 236;
    for (const [base, amp, colour, rate] of [
      [70, 44, '#55f08a', 1],
      [128, 15, '#59c8ff', 1],
      [178, 12, '#f2d457', 0.31],
    ]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let pen = false;
      for (let px = 0; px < 236; px += 2) {
        const ago = (sweep - px + 236) % 236;
        if (ago > 214) {
          pen = false;
          continue;
        }
        const t = time - ago / 92;
        const phase = (((t / BEAT) * rate) % 1 + 1) % 1;
        const v = base === 70 ? ecg(phase) : base === 128 ? Math.pow(Math.sin(phase * Math.PI), 3) : Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
        const py = base - v * amp;
        if (pen) ctx.lineTo(px + 6, py);
        else ctx.moveTo(px + 6, py);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.font = '600 40px system-ui, sans-serif';
    ctx.fillStyle = '#55f08a';
    ctx.fillText(String(81 + Math.round(Math.sin(time * 0.9) * 2)), 250, 76);
    ctx.fillStyle = '#59c8ff';
    ctx.fillText('93', 250, 136);
    ctx.fillStyle = '#f2d457';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.fillText('19', 256, 188);
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#7fa2a8';
    ctx.fillText('TEP', 250, 36);
    ctx.fillText('SpO2', 250, 100);
    ctx.fillText('DECH', 250, 160);
    texture.needsUpdate = true;
  }
  const look = new THREE.Vector3();
  return {
    get on() {
      return group.visible;
    },
    show(on) {
      group.visible = on;
      lamp.intensity = on ? 5.5 : 0;
      glow.intensity = on ? 1.1 : 0;
      if (on) {
        lamp.color.setHex(0xffc98f);
        lamp.distance = 6.5;
        lamp.decay = 1.6;
        lamp.position.set(x - 0.9, y + 1.12, z + 0.62);
        glow.color.setHex(0x8fe0b4);
        glow.distance = 2.6;
        glow.decay = 2;
        glow.position.set(x + 0.72, y + 1.4, z + 0.95);
        time = 0;
        beats = -1;
      }
    },
    // Advance the monitor; sounds a beep on each heartbeat.
    update(dt, sound = true) {
      if (!group.visible) return;
      time += dt;
      const beat = Math.floor((time - 0.2 * BEAT) / BEAT);
      if (beat > beats) {
        beats = beat;
        if (sound) storyTone(985, 0.085, 0.075);
      }
      girl.parts.chest.scale.z = 1 + 0.035 * Math.sin(time * 1.65);
      draw();
    },
    camera(camera) {
      const t = Math.min(1, time / 4.4),
        ease = t * t * (3 - 2 * t);
      // from over the empty chair, down on her face, the monitor behind her
      camera.position.set(x - 1.5 + 0.24 * ease, y + 1.78 - 0.1 * ease, z - 0.78 + 0.18 * ease);
      look.set(x + 0.16, y + 0.72, z + 0.6);
      camera.lookAt(look);
      camera.near = 0.05;
      camera.fov = 46 - 4 * ease;
      camera.updateProjectionMatrix();
    },
    dispose() {
      girl.dispose();
      for (const m of [sheet, screen]) {
        m.removeFromParent();
        m.geometry.dispose();
        m.material.dispose();
      }
      drawing.dispose();
      texture.dispose();
      k.dispose();
    },
  };
}
