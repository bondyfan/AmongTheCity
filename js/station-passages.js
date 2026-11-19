import { chunkKey, pointInPolygon } from './geo.js';
import { definitions, prepare, local, worldAt, landing, floorAt, deckAt, nearestOnDeck, nearestInside, fencedOut, inRect, DEPTH } from './station-layout.js';
import { makeBelts } from './station-belts.js';
import { kolinPassage } from './station-kolin.js';
import { pardubiceStation } from './pardubice-station.js';

// The underpasses of Kolín and Pardubice: what is drawn, what is walked on,
// what holds a walker in, and the holes the stair mouths leave in the ground.
// The plan of each station is plain data in js/station-layout.js.
const builders = { 'Kolín': kolinPassage, 'Pardubice hl. n.': pardubiceStation };

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
    const n = (value) => value.toFixed(2);
    const check = s.flights
      .map(({ span: r }) => `(u>${n(r.u0 - 0.01)} && u<${n(r.u1 + 0.01)} && v>${n(r.v0 - 0.01)} && v<${n(r.v1 + 0.01)})`)
      .join(' || ');
    const box = s.under;
    shader.fragmentShader =
      'varying vec3 stationPoint; uniform float stationTop;\n' +
      shader.fragmentShader.replace(
        'void main() {',
        `void main() {
      vec2 offset=stationPoint.xz-vec2(${s.x.toFixed(2)},${s.z.toFixed(2)});
      float u=dot(offset,${axis}), v=dot(offset,${axis}.yx*vec2(-1.,1.));
      if(stationPoint.y<stationTop && u>${n(box.u0 - 1)} && u<${n(box.u1 + 1)} && v>${n(box.v0 - 1)} && v<${n(box.v1 + 1)} && (${check})) discard;`,
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
    this.stations = definitions.map((d) => ({ ...prepare(d), materials: new WeakMap(), ceiling: { value: 0 } }));
  }
  nearby(x, z, reach = 95) {
    return this.stations.find((s) => {
      const { u, v } = local(s, x, z);
      return u > s.box.u0 - reach && u < s.box.u1 + reach && v > s.box.v0 - reach && v < s.box.v1 + reach;
    });
  }
  advanceEscalator(dt, player) {
    this.nearby(player.pos.x, player.pos.z)?.belts?.advance(dt, player);
  }
  // `night` is the sky's 0..1 darkness, for whatever the station lights.
  update(x, z, night = 0) {
    const s = this.nearby(x, z, 400);
    if (!s) return;
    if (!s.group) {
      if (!this.world.terrain.ready(s.x, s.z)) return;
      for (const f of s.flights) {
        const top = landing(f, s.beyond),
          p = worldAt(s, top.u, top.v);
        f.top = this.world.heightAt(p.x, p.z, this.world.terrain.heightAt(p.x, p.z) + 1);
      }
      const tops = s.flights.map((f) => f.top);
      s.tops = new Map(s.flights.map((f) => [f.c, f.top]));
      s.bottom = Math.min(...tops) - DEPTH;
      s.ceiling.value = Math.max(...tops) + 1.5;
      if (s.deck) {
        s.deck.y = this.world.terrain.heightAt(s.x, s.z) + s.deck.rise;
        for (const f of s.ramps) {
          const p = worldAt(s, ...(f.axis === 'u' ? [f.a, f.c] : [f.c, f.a]));
          f.base = this.world.heightAt(p.x, p.z, this.world.terrain.heightAt(p.x, p.z) + 1);
          f.top = s.deck.y;
        }
      }
      s.group = builders[s.name](s, this.scene, this.world);
      s.belts = makeBelts(s, s.group);
    }
    s.dress?.update(night, x, z);
  }
  cut(group, cx, cz, chunk) {
    const s = this.nearby((cx + 0.5) * chunk, (cz + 0.5) * chunk, chunk * 1.5);
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
    const { u, v } = local(s, x, z);
    return floorAt(s, u, v, limit) ?? deckAt(s, u, v, limit);
  }
  inside(x, z, y) {
    const s = this.nearby(x, z);
    if (!s?.group) return false;
    const { u, v } = local(s, x, z);
    // up on the footbridge, between its glass walls
    if (s.deck && y > s.bottom + DEPTH + 3) return deckAt(s, u, v, y + 0.5) !== null && y > s.deck.y - 4;
    if (y > s.bottom + DEPTH + 3) return false;
    if (floorAt(s, u, v, y + 0.5) !== null && y < s.bottom + DEPTH - 0.22) return true;
    const buildings = this.world.city.chunkIndex.get(chunkKey(x,z))?.buildings;
    return buildings?.some(b => b.t === 'train_station' && pointInPolygon(x,z,b.o)) ?? false;
  }
  // Under a station canopy (a mapped roof, one the station built itself, or a
  // platform canopy that registered itself as extraCover) the camera stays low.
  covered(x, z) {
    const s = this.nearby(x, z, 140);
    if (!s) return false;
    if (this.extraCover?.(x, z)) return true;
    if (s.dress?.cover) {
      const { u, v } = local(s, x, z);
      if (s.dress.cover(u, v)) return true;
    }
    const buildings = this.world.city.chunkIndex.get(chunkKey(x, z))?.buildings;
    return buildings?.some?.((b) => b.t === 'roof' && pointInPolygon(x, z, b.o)) ?? false;
  }
  // The underside of whatever the station has built over (x, z), or null: the
  // camera is kept below it (js/main.js), so it never looks through a canopy.
  lid(x, z) {
    const s = this.nearby(x, z, 140);
    if (!s) return null;
    const { u, v } = local(s, x, z),
      own = s.dress?.lid?.(u, v) ?? null;
    if (own !== null) return own;
    const roof = this.world.city.chunkIndex.get(chunkKey(x, z))?.buildings?.find?.((b) => b.t === 'roof' && pointInPolygon(x, z, b.o));
    return roof ? this.world.terrain.heightAt(x, z) + (roof.h ?? 4.3) - 0.25 : null;
  }
  // Keep a walker below the surface in the union of rooms and flights.
  // The upper landing is deliberately open onto the ordinary station floor.
  contain(pos, y, r) {
    const s = this.nearby(pos.x, pos.z);
    if (!s?.group) return false;
    const { u, v } = local(s, pos.x, pos.z);
    if (s.deck && y > s.bottom + DEPTH + 1) {
      // on the bridge or high on one of its ramps: the glass keeps him on it
      const on = inRect(s.box, u, v, 2) ? nearestOnDeck(s, u, v, r) : null;
      if (!on || on.d > 1.2 || on.d < 1e-6 || Math.abs(y - on.y) > 0.9 || on.y - on.base < 1.2) return false;
      Object.assign(pos, worldAt(s, on.u, on.v));
      return true;
    }
    if (!inRect(s.under, u, v, 1)) return false;
    if (s.walled) {
      const out = fencedOut(s, u, v, y, r);
      if (out) {
        Object.assign(pos, worldAt(s, out.u, out.v));
        return true;
      }
    }
    if (y > s.bottom + DEPTH - 0.35) return false;
    const best = nearestInside(s, u, v, r);
    if (!best || best.d > 1.2) return false;
    Object.assign(pos, worldAt(s, best.u, best.v));
    return true;
  }
}
