import * as THREE from 'three';
import { chunkKey, pointInPolygon } from './geo.js';
import { scenery } from './prologue-kit.js';
import { trackNumber } from './prologue-route.js';

// Origins and axes follow the mapped platform stairs. u runs along the
// platforms, v across the tracks. The last flight at each station is in the hall.
const definitions = [
  { x: -38842.1, z: 706.5, angle: 0.61, stops: [-57, -41, -15, 0, 19, 35], hall: 35, name: 'Kolín' },
  { x: 14.9, z: -32.9, angle: 0.02, stops: [-39, -17.5, 0, 24.4], hall: -39, name: 'Pardubice hl. n.' },
];
const width = 1.65,
  run = 13.8,
  depth = 3.8,
  halfHall = 2.3,
  count = 24;
const local = (s, x, z) => ({ u: (x - s.x) * s.c + (z - s.z) * s.s, v: (z - s.z) * s.c - (x - s.x) * s.s });
const worldAt = (s, u, v) => ({ x: s.x + u * s.c - v * s.s, z: s.z + u * s.s + v * s.c });
const flightAt = (s, v) => s.stops.find((stop) => Math.abs(v - stop) <= width);
const topY = (s, v) => s.tops.get(v);
const floorY = (s, u, v) =>
  s.bottom + (topY(s, v) - s.bottom) * Math.min(1, Math.ceil((Math.max(0, u - halfHall) / run) * count) / count);

function architecture(s, scene) {
  const group = new THREE.Group();
  group.name = s.name + ' • podchod';
  group.position.set(s.x, s.bottom, s.z);
  group.rotation.y = -s.angle;
  const k = scenery(group),
    first = s.stops[0] - width,
    last = s.stops.at(-1) + width;
  const mid = (last + first) / 2,
    length = last - first;
  const escalator = s.hall < 0;
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
      if (escalator && v === s.hall) {
        k.box(u, h / 2, v - width / 2, run / count + 0.005, h, width, 0x969992);
        continue;
      }
      k.box(u, h / 2, v, run / count + 0.005, h, width * 2, 0x969992);
      k.box(u - run / count / 2 + 0.035, h + 0.007, v, 0.07, 0.014, width * 2 - 0.12, 0xddc989);
    }
    if (escalator && v === s.hall) {
      const steps = new THREE.InstancedMesh(
        new THREE.BoxGeometry(run / count + 0.01, 0.23, width - 0.12),
        new THREE.MeshStandardMaterial({ color: 0x68747b, metalness: 0.45, roughness: 0.55 }),
        count,
      );
      group.add(steps);
      steps.frustumCulled = false;
      s.escalator = { steps, rise, phase: 0, matrix: new THREE.Matrix4() };
      k.box(
        halfHall + run / 2,
        rise / 2 + 0.6,
        v,
        Math.hypot(run, rise),
        0.14,
        0.12,
        0x34383c,
        Math.atan2(rise, run),
      );
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

// Ground photos, paved polygons and mapped flat footways all cover the same
// stair mouth. Cut them with the same rectangle, keeping the rest of each
// streamed chunk and its existing material/shader (including its ortho map).
function cutMaterial(s, source) {
  let mat = s.materials.get(source);
  if (mat) return mat;
  mat = source.clone();
  if (source.defines) mat.defines = { ...source.defines };
  const previous = source.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.stationTop = s.ceiling;
    shader.vertexShader =
      'varying vec3 stationPoint;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nstationPoint=(modelMatrix*vec4(transformed,1.)).xyz;',
      );
    const axis = 'vec2(' + s.c.toFixed(8) + ',' + s.s.toFixed(8) + ')';
    const check = s.stops.map((v) => 'abs(v-(' + v.toFixed(2) + '))<1.66').join(' || ');
    shader.fragmentShader =
      'varying vec3 stationPoint; uniform float stationTop;\n' +
      shader.fragmentShader.replace(
        'void main() {',
        `void main() {
      vec2 offset=stationPoint.xz-vec2(${s.x.toFixed(2)},${s.z.toFixed(2)});
      float u=dot(offset,${axis}), v=dot(offset,${axis}.yx*vec2(-1.,1.));
      if(stationPoint.y<stationTop && u>2.29 && u<16.11 && (${check})) discard;`,
      );
  };
  mat.customProgramCacheKey = () => source.customProgramCacheKey() + s.name;
  s.materials.set(source, mat);
  source.addEventListener('dispose', () => mat.dispose());
  return mat;
}

export class StationPassages {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.stations = definitions.map((d) => ({
      ...d,
      c: Math.cos(d.angle),
      s: Math.sin(d.angle),
      materials: new WeakMap(),
      ceiling: { value: 0 },
    }));
  }
  nearby(x, z, reach = 95) {
    return this.stations.find((s) => Math.abs(x - s.x) < reach && Math.abs(z - s.z) < reach);
  }
  advanceEscalator(dt, player) {
    const s = this.nearby(player.pos.x, player.pos.z),
      belt = s?.escalator;
    if (!belt) return;
    const { u, v } = local(s, player.pos.x, player.pos.z);
    belt.phase = (belt.phase + (dt * 0.72) / (run / count)) % 1;
    for (let i = 0; i < count; i++) {
      const t = (i + belt.phase) / count;
      belt.matrix.makeTranslation(halfHall + t * run, belt.rise * t - 0.1, s.hall + width / 2);
      belt.steps.setMatrixAt(i, belt.matrix);
    }
    belt.steps.instanceMatrix.needsUpdate = true;
    if (
      !player.inCar &&
      !player.boarding &&
      !player.ragdoll &&
      player.grounded &&
      u > halfHall &&
      u < halfHall + run &&
      v > s.hall + 0.15 &&
      v < s.hall + width &&
      Math.abs(player.y - floorY(s, u, s.hall)) < 0.35
    ) {
      player.pos.x += s.c * dt * 0.72;
      player.pos.z += s.s * dt * 0.72;
    }
  }
  update(x, z) {
    const s = this.nearby(x, z, 400);
    if (!s || s.group || !this.world.terrain.ready(s.x, s.z)) return;
    s.tops = new Map(
      s.stops.map((v) => {
        const p = worldAt(s, halfHall + run, v);
        return [v, this.world.heightAt(p.x, p.z)];
      }),
    );
    s.bottom = Math.min(...s.tops.values()) - depth;
    s.ceiling.value = Math.max(...s.tops.values()) + 1.5;
    s.group = architecture(s, this.scene);
  }
  cut(group, cx, cz, chunk) {
    const s = this.nearby((cx + 0.5) * chunk, (cz + 0.5) * chunk, chunk * 2.5);
    if (!s || !group) return;
    group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.material || o.material.isShaderMaterial) return;
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => cutMaterial(s, m))
        : cutMaterial(s, o.material);
    });
  }
  floor(x, z, limit) {
    const s = this.nearby(x, z);
    if (!s?.group) return null;
    const { u, v } = local(s, x, z),
      flight = flightAt(s, v);
    if (flight !== undefined && u >= halfHall && u <= halfHall + run) return floorY(s, u, flight);
    if (
      Math.abs(u) <= halfHall &&
      v >= s.stops[0] - width &&
      v <= s.stops.at(-1) + width &&
      limit < s.bottom + 3.25
    )
      return s.bottom;
    return null;
  }
  inside(x, z, y) {
    const s = this.nearby(x, z);
    if (!s?.group || y > s.bottom + depth + 3) return false;
    if (this.floor(x, z, y + 0.5) !== null && y < s.bottom + depth - 0.22) return true;
    const buildings = this.world.city.chunkIndex.get(chunkKey(x,z))?.buildings;
    return buildings?.some(b => b.t === 'train_station' && pointInPolygon(x,z,b.o)) ?? false;
  }
  // Under a station canopy (the bus shelter's mapped roof, or a platform
  // canopy that registered itself as extraCover) the camera stays below it.
  covered(x, z) {
    if (!this.nearby(x, z, 140)) return false;
    if (this.extraCover?.(x, z)) return true;
    const buildings = this.world.city.chunkIndex.get(chunkKey(x, z))?.buildings;
    return buildings?.some?.((b) => b.t === 'roof' && pointInPolygon(x, z, b.o)) ?? false;
  }
  // Keep a walker below the surface in the union of corridor and flights.
  // The upper landing is deliberately open onto the ordinary station floor.
  contain(pos, y, r) {
    const s = this.nearby(pos.x, pos.z);
    if (!s?.group || y > s.bottom + depth - 0.35) return false;
    const { u, v } = local(s, pos.x, pos.z);
    if (
      u < -halfHall - 1 ||
      u > halfHall + run + 0.5 ||
      v < s.stops[0] - width - 1 ||
      v > s.stops.at(-1) + width + 1
    )
      return false;
    let best = null,
      d = Infinity;
    const candidate = (a, b, c, e) => {
      const q = Math.max(a, Math.min(b, u)),
        t = Math.max(c, Math.min(e, v)),
        err = (q - u) ** 2 + (t - v) ** 2;
      if (err < d) {
        d = err;
        best = { q, t };
      }
    };
    candidate(-halfHall + r, halfHall - r, s.stops[0] - width + r, s.stops.at(-1) + width - r);
    for (const stop of s.stops) candidate(-halfHall + r, halfHall + run + 0.5, stop - width + r, stop + width - r);
    if (d > 1.2) return false;
    Object.assign(pos, worldAt(s, best.q, best.t));
    return true;
  }
}
