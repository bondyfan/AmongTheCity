import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { trackNumber } from './prologue-route.js';
import { HALF as halfHall, WIDTH as width, STEPS as count } from './station-layout.js';

// Kolín's underpass as the campaign was built round it: one corridor, a flight
// of steps east at every stop, the last one up into the hall. s.stops, s.hall
// and s.tops (landing height by stop) come from js/station-passages.js.
const run = 13.8;
const topY = (s, v) => s.tops.get(v);

export function kolinPassage(s, scene) {
  const group = new THREE.Group();
  group.name = s.name + ' • podchod';
  group.position.set(s.x, s.bottom, s.z);
  group.rotation.y = -s.angle;
  const k = scenery(group),
    first = s.stops[0] - width,
    last = s.stops.at(-1) + width;
  const mid = (last + first) / 2,
    length = last - first;
  k.box(0, -0.1, mid, halfHall * 2, 0.2, length, 0xa6a494);
  k.box(0, 2.95, mid, halfHall * 2 + 0.12, 0.2, length, 0xbebfbc);
  k.box(-halfHall, 1.5, mid, 0.14, 3.0, length, 0xc4c8bf);
  for (const end of [first, last]) k.box(0, 1.5, end, halfHall * 2, 3.0, 0.12, 0xb9c2bf);
  let prev = first;
  for (const v of s.stops) {
    if (v - width > prev) k.box(halfHall, 1.48, (prev + v - width) / 2, 0.14, 2.96, v - width - prev, 0xbac4c4);
    prev = v + width;
    const rise = topY(s, v) - s.bottom;
    for (let i = 0; i < count; i++) {
      const u = halfHall + ((i + 0.5) * run) / count,
        h = ((i + 1) * rise) / count;
      k.box(u, h / 2, v, run / count + 0.005, h, width * 2, 0x969992);
      k.box(u - run / count / 2 + 0.035, h + 0.007, v, 0.07, 0.014, width * 2 - 0.12, 0xddc989);
    }
    for (const side of [-1, 1]) {
      k.box(halfHall + run / 2, rise / 2, v + side * width, run, rise + 0.8, 0.13, 0xc2c8c7);
      k.box(halfHall + run / 2, rise + 0.45, v + side * width, run, 0.12, 0.15, 0x606c73);
    }
    const platform = {0:2,'-15':3,'-41':4,'-57':5,19:'1A'}[v];
    const label = v === s.hall ? 'Východ • Hala' : s.name === 'Kolín' ? 'Nástupiště '+platform : 'Nástupiště';
    if(s.name==='Kolín' && trackNumber[platform]){
      for(const u of [-12,27]){
        k.box(u,rise+1.42,v+1.9,.09,2.84,.10,0x6f7c7f);
        k.box(u,rise+2.58,v+1.90,2.61,.58,.09,0x273e55);
        for(const side of [-1,1])k.sign(u,rise+2.58,v+1.9+side*.055,2.56,.52,
          ['Nást. '+platform+'   •   kolej '+trackNumber[platform]],side<0?Math.PI:0,'#16457e');
      }
    }
    k.sign(halfHall - 0.14, 2.26, v, 2.4, 0.4, [label + ' →'], -Math.PI / 2);
    k.sign(
      halfHall + run + 0.04,
      rise + 2.45,
      v,
      3.3,
      0.45,
      [v === s.hall ? '↓  Nástupiště' : '↓  Podchod • Východ'],
      Math.PI / 2,
    );
  }
  for (let v = first + 2; v < last; v += 6) k.box(0, 2.81, v, 2.3, 0.06, 0.24, 0xffedd4, 0, true);
  const hall = s.hall,
    hallY = topY(s, hall) - s.bottom,
    face = hall > 0 ? 0 : Math.PI;
  k.sign(19, hallY + 2.9, hall + (hall > 0 ? 3 : -3), 7, 0.85, [s.name], face);
  k.sign(20, hallY + 2.05, hall + (hall > 0 ? 3 : -3), 4.8, 0.55, ['Odjezdy   •   Nástupiště ↓'], face);
  for (const u of [-7, 32]) {
    k.box(u, hallY + 0.45, hall, 3.3, 0.16, 0.6, 0x896f52);
    k.box(u, hallY + 0.78, hall + 0.27, 3.3, 0.66, 0.1, 0x896f52);
  }
  k.finish();
  scene.add(group);
  return group;
}
