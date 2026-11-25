// ---- airport-lights.js: the runway, approach and taxiway lights after dark ----
// MAIN THREAD. Both airports were paint only and went dark at night, so a
// night landing came down onto nothing. js/airport-lights-plan.js lays the
// lights out (pure: every player gets the same ones from the same data); this
// draws them as camera-facing glows with the street lamps' own shader
// (js/lightpools.js, cloned with its ATC_GROUND path), ONE InstancedMesh for
// the airport being approached. The region of this page has its airports
// (Pardubice and Prague in 'cz', Seychelles International on Mahé); the mesh
// takes the lights of whichever one the camera or the airliner is near, and
// lays them out again when that changes (they are 106 km apart, so never
// both). Never THREE.Light objects: changing the light count recompiles every
// material in the scene.
//
// What runs: nothing by day, nothing far from the airport. Within REACH of
// the runway's middle (the camera, or the airliner flying near it) and from
// dusk on, the mesh is shown; once a frame the few hundred lights whose
// colour depends on the eye or the clock are rewritten (the thresholds and
// the yellow caution zone, which show another colour from the other side,
// the PAPI's white over red, the approach lights that face the approach only,
// the flashers' sweep). Positions are written once and again only when the
// terrain under them has loaded, or (at SEZ and Prague) when the tile's
// taxiways arrive.
//
// Brightness: on from nightK (js/sky.js), held at the same level whatever the
// night exposure is (the rule js/stationkit.js night() uses: a lamp that
// lights itself is turned down by as much as the exposure opens up).

import * as THREE from 'three';
import { EXPOSURE_DAY } from './sky.js';
import * as PLAN from './airport-plan.js';
import { LKPR_PLAN } from './flight-lkpr.js';
import { CHUNK } from './config.js';
import { lkpdLights, sezLights, lkprLights, lightColour, isDynamic } from './airport-lights-plan.js';

const REACH = 16000;           // m from the runway's middle
const MAX = 6144;              // instances (Pardubice about 600, Mahé 700, Prague 3 600)
const ROADS_T = 1;             // s between looks for SEZ's taxiways in the tile
const GROUND_T = 4;            // s between re-reads of the ground while near
// live knobs (window.__atc.airportLights.tune from the console)
// (tuned on a night final for 27, 25 Nov 2026: at 0.4 of the haze the PAPI
// was gone from 1.5 km, at 0.2 the far half of the runway; 0.12 carries the
// whole field without making the town's own lamps look dim beside it)
export const TUNE = {
  size: 0.45,                  // m: a lamp's glow radius close up
  level: 2.2,                  // brightness, as it would be under the day's exposure
  floorPx: 2.0,                // the quad's least radius, px: a white core and a coloured rim
  lift: 0.75,                  // the quad stands this share of its radius over the lamp
  fogK: 0.12,                  // the share of the haze a lamp is seen through
  fall: 1 / 7000,              // brightness 1 / (1 + (d * fall)^2)
};

const half = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
/**
 * The airports of a region: each { id, centre (the main runway's middle),
 * roads (how far round it the tile's taxiways are read, 0 for none), build(roads) }.
 */
export function sitesOf(region, mahe) {
  if (region === 'mahe') {
    const e = mahe?.runway?.ends;
    return e ? [{ id: 'SEZ', centre: half(e['13'], e['31']), roads: 2600, build: (r) => sezLights(mahe, r) }] : [];
  }
  const R = PLAN.RUNWAY, P = LKPR_PLAN.runway;
  return [
    { id: 'LKPD', centre: { x: (R.a[0] + R.b[0]) / 2, z: (R.a[1] + R.b[1]) / 2 }, roads: 0, build: () => lkpdLights(PLAN) },
    { id: 'LKPR', centre: half(P.threshold, P.far), roads: 4000, build: (r) => lkprLights(LKPR_PLAN, r) },
  ];
}

export class AirportLights {
  /** `region` 'cz' or 'mahe'; `mahe` REGIONS.mahe.airport; `sea` the sea level (lamps over water stand on it) or null. */
  constructor(scene, { region, mahe = null, sea = null }) {
    this.scene = scene;
    this.sites = sitesOf(region, mahe);
    this.site = null;           // the one whose lights the mesh holds
    this.sea = sea;
    this.mesh = null;
    this.src = null;
    this.lights = null;         // the plan's lights, once near
    this.dyn = [];              // indices of the ones rewritten every frame
    this.ly = null;             // each lamp's height in the world
    this.tune = TUNE;
    this._roadsT = 0; this._roadsKey = '';
    this._groundT = 0; this._loads = -1;
    this._c = [0, 0, 0];
  }

  /** Take the lamp glows' shader from js/lightpools.js (main.js, once both exist). */
  attach(lightPools) {
    if (this.mesh || !lightPools?.glowMat || !this.sites.length) return;
    this.src = lightPools.glowMat;
    const mat = this.src.clone();
    delete mat.defines.STREET_LENS;
    mat.defines.ATC_GROUND = '';
    Object.assign(mat.uniforms, {
      uVista: { value: 5000 }, uLift: { value: TUNE.lift }, uFogK: { value: TUNE.fogK }, uFall: { value: TUNE.fall },
    });
    mat.uniforms.uRange.value = REACH * 1.2;
    mat.uniforms.uGive.value = 0;
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mat, MAX);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = -787;             // with the lamp glows, before glass and smoke
    m.castShadow = m.receiveShadow = false;
    m.name = 'Letiště • světla dráhy';
    m.onBeforeRender = (renderer) => { mat.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0; };
    const im = m.instanceMatrix.array;
    for (let i = 0; i < MAX; i++) { im[i * 16] = im[i * 16 + 5] = im[i * 16 + 10] = im[i * 16 + 15] = 1; }
    this.mesh = m;
    this.scene.add(m);
  }

  /** How many lights stand at this airport now (0 before it was first near). */
  get count() { return this.lights?.length ?? 0; }

  /**
   * Once a frame, after updateSky. `plane` is the airliner when one is
   * flying ({ x, z }), so a camera that is somewhere else still finds the
   * airport the aircraft is coming down to.
   */
  update(dt, camera, world, sky, viewH, plane = null) {
    const m = this.mesh;
    if (!m) return;
    const nightK = sky?.nightK ?? 0;
    let on = (nightK - 0.08) / 0.3;
    on = on < 0 ? 0 : on > 1 ? 1 : on * on * (3 - 2 * on);
    const p = camera.position, site = on > 0.002 ? this._nearest(p, plane) : null;
    if (!site) { m.visible = false; return; }
    if (site !== this.site) { this.site = site; this.lights = null; this._roadsKey = ''; }
    this._plan(dt, world);
    if (!this.lights?.length) { m.visible = false; return; }
    this._ground(dt, world);

    const u = m.material.uniforms;
    u.uOn.value = on;
    u.uLevel.value = TUNE.level * EXPOSURE_DAY / Math.max(0.1, sky?.exposure ?? EXPOSURE_DAY);
    u.uPx.value = 2 * Math.tan((camera.fov * Math.PI) / 360) / Math.max(1, viewH);
    u.uSize.value = TUNE.size;
    u.uFloorPx.value = TUNE.floorPx;
    u.uVista.value = camera.far * 0.9;
    u.uLift.value = TUNE.lift; u.uFogK.value = TUNE.fogK; u.uFall.value = TUNE.fall;

    // the lights whose colour depends on where the eye is, or on the clock
    const col = m.instanceColor.array, L = this.lights, ly = this.ly, out = this._c;
    const t = performance.now() / 1000;
    for (const i of this.dyn) {
      lightColour(L[i], p.x, p.y, p.z, ly[i], t, out);
      col[i * 3] = out[0]; col[i * 3 + 1] = out[1]; col[i * 3 + 2] = out[2];
    }
    m.instanceColor.needsUpdate = true;
    m.visible = true;
  }

  // the airport within REACH of the camera or the airliner, the nearest if two were
  _nearest(p, plane) {
    let best = null, bd = REACH;
    for (const s of this.sites) {
      let d = Math.hypot(p.x - s.centre.x, p.z - s.centre.z);
      if (plane) d = Math.min(d, Math.hypot(plane.x - s.centre.x, plane.z - s.centre.z));
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** The airport whose lights stand now ('LKPD', 'LKPR', 'SEZ'), or null. */
  get siteId() { return this.site?.id ?? null; }

  // the layout: once where it is all in the plan (Pardubice); where it takes
  // the tile's taxiways, again whenever those change
  _plan(dt, world) {
    const site = this.site;
    if (!site.roads) {
      if (!this.lights) this._take(site.build([]).lights);
      return;
    }
    if (this.lights && (this._roadsT -= dt) > 0) return;
    this._roadsT = ROADS_T;
    const roads = this._tileRoads(world, site);
    const key = roads.length + ':' + roads.reduce((a, r) => a + r.p.length * 7 + r.p[0][0], 0).toFixed(1);
    if (this.lights && key === this._roadsKey) return;
    this._roadsKey = key;
    this._take(site.build(roads).lights);
  }

  // the airport's taxiway lines from the streamed cells round it (the same
  // object may sit in several cells)
  _tileRoads(world, site) {
    const idx = world?.city?.chunkIndex, c = site.centre, R = site.roads;
    if (!idx) return [];
    const seen = new Set(), out = [];
    const cx = Math.floor(c.x / CHUNK), cz = Math.floor(c.z / CHUNK), n = Math.ceil(R / CHUNK);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      for (const r of idx.get((cx + i) + ',' + (cz + j))?.roads ?? []) {
        if (r.t !== 'taxiway' || seen.has(r)) continue;
        const q = r.p?.[0];
        if (!q || Math.hypot(q[0] - c.x, q[1] - c.z) > R) continue;
        seen.add(r); out.push(r);
      }
    }
    // in the tile's own order, whatever order the cells were indexed in
    return out.sort((a, b) => a.p[0][0] - b.p[0][0] || a.p[0][1] - b.p[0][1]);
  }

  _take(lights) {
    const m = this.mesh, n = Math.min(MAX, lights.length);
    this.lights = lights.slice(0, n);
    this.ly = new Float32Array(n);
    this.dyn = [];
    const col = m.instanceColor.array;
    for (let i = 0; i < n; i++) {
      const L = this.lights[i];
      if (isDynamic(L)) this.dyn.push(i);
      else { col[i * 3] = L.c[0]; col[i * 3 + 1] = L.c[1]; col[i * 3 + 2] = L.c[2]; }
    }
    m.count = n;
    this._loads = -1;           // the new lamps need their heights
    this._groundT = 0;
  }

  // each lamp's height: the ground under it (or the sea), and its own height over that
  _ground(dt, world) {
    const T = world?.terrain;
    const loads = T?._loads ?? 0;
    if (loads === this._loads && (this._groundT -= dt) > 0) return;
    this._loads = loads;
    this._groundT = GROUND_T;
    const im = this.mesh.instanceMatrix.array, L = this.lights, ly = this.ly;
    for (let i = 0; i < L.length; i++) {
      let g = T?.heightAt?.(L[i].x, L[i].z) ?? 0;
      if (!Number.isFinite(g)) g = 0;
      if (this.sea !== null && g < this.sea) g = this.sea;
      ly[i] = g + L[i].h;
      im[i * 16 + 12] = L[i].x; im[i * 16 + 13] = ly[i]; im[i * 16 + 14] = L[i].z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.mesh = null;
  }
}
