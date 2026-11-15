// ---- tramdraw.js: the trams on screen -------------------------------------------
// js/trams.js decides where every tram's nose is (a pure function of the
// timetable, js/tramlines.js); this module stands the bodies there. Each
// section rides on its two bogies, so a 15T's three sections follow the rail
// through a curve and the joints between them never open, and every section of
// every tram is one instance of its type's InstancedMesh (js/trammesh.js):
// four section types, three materials, twelve draws for the whole fleet in
// sight, plus one for all their displays (js/tramsign.js).
//
// Night: the glass is lit from inside (a warm emissive), the head and tail
// lamps are turned up. No per-frame allocation: every matrix and point is
// scratch reused.
//
// FAR: beyond NEAR_D a section is one instance of a single 42-triangle loft
// (js/trammesh.js farGeometry) stretched to its length, two draws for every
// far tram in reach (js/trams.js keeps trams out to 1.5 km), no signs, no
// shadows. At night every drawn tram also carries a few far glows for its
// lamps and windows (js/tramglow.js), which is what is seen of it from afar.

import * as THREE from 'three';
import { TRAM_BODY, consistOf, sectionSpan } from './trambody.js';
import { sectionGeometry, signFrames, farGeometry, SECTION_TYPES, MAT_PAINT, MAT_GLASS, MAT_LAMP } from './trammesh.js';
import { TramGlow } from './tramglow.js';
import { TramSigns, SIGN_NUM_U } from './tramsign.js';
import { pathAtExt } from './tramlines.js';

const MAX_PER_TYPE = 160;
const MAX_FAR = 480;           // far sections (a hundred and sixty 15Ts)
const HEAD = [1.0, 0.93, 0.8], TAIL = [1.0, 0.12, 0.06], WIN = [1.0, 0.72, 0.4];   // glow colours (x brightness below)
const _m = new THREE.Matrix4(), _sm = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _at = { x: 0, z: 0, dx: 0, dz: 0 };
const UP = new THREE.Vector3(0, 1, 0);
const TYPE_INDEX = { A: 0, B: 1, C: 2, T: 3 };
const PARTS = ['front', 'side', 'rear'];      // (hoisted: pose() runs per section per frame)

export class TramDraw {
  constructor(scene) {
    this.scene = scene;
    this.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12, envMapIntensity: 0.9 });
    this.glass = new THREE.MeshStandardMaterial({ color: 0x1b2329, roughness: 0.06, metalness: 0.75, envMapIntensity: 1.6,
      emissive: 0xffc982, emissiveIntensity: 0 });
    this.lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mats = [];
    mats[MAT_PAINT] = this.paint; mats[MAT_GLASS] = this.glass; mats[MAT_LAMP] = this.lamp;
    this.meshes = SECTION_TYPES.map((t) => {
      const im = new THREE.InstancedMesh(sectionGeometry(t), mats, MAX_PER_TYPE);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = false;          // the instances are spread over a kilometre; see the header
      im.name = 'tram-' + t;
      scene.add(im);
      return im;
    });
    this.signs = new TramSigns();
    scene.add(this.signs.mesh);
    // the display frames of each body, as local matrices of their section
    this._signs = {};
    for (const body of Object.keys(TRAM_BODY)) {
      const f = signFrames(body), out = {};
      for (const part of ['front', 'side', 'rear']) {
        const s = f[part];
        _e.set(s.rx, s.ry, 0, 'YXZ');
        _q.setFromEuler(_e);
        out[part] = { sec: s.sec, m: new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), _q.clone(), new THREE.Vector3(s.w, s.h, 1)) };
      }
      this._signs[body] = out;
    }
    // the far body: one loft for every section, scaled to it
    const far = new THREE.InstancedMesh(farGeometry(), mats, MAX_FAR);
    far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    far.count = 0;
    far.castShadow = false; far.receiveShadow = false;
    far.frustumCulled = false;
    far.name = 'tram-far';
    scene.add(far);
    this.far = far;
    this._nFar = 0;
    // per body and section: the far loft's place in the section frame (centred
    // between front and back, stretched to the length)
    this._farL = {};
    for (const body of Object.keys(TRAM_BODY)) {
      this._farL[body] = TRAM_BODY[body].sections.map((sec) => {
        const sp = sectionSpan(body, sec);
        return new THREE.Matrix4().makeTranslation(0, 0, (sp.front + sp.back) / 2).multiply(new THREE.Matrix4().makeScale(TRAM_BODY[body].wid / 2.46, TRAM_BODY[body].roof / 3.2, sp.back - sp.front));
      });
    }
    this.glow = new TramGlow(scene);
    this._n = new Int32Array(SECTION_TYPES.length);
    // the bogie points of the consist being posed: x, y, z per bogie
    this._bog = new Float32Array(3 * 8);
    this.visible = true;
  }

  begin() {
    this._n.fill(0);
    this._nFar = 0;
    this.signs.begin();
    this._glow = this.glow.on;
    if (this._glow) this.glow.begin();
  }

  /**
   * Stand one tram: `s` the arc of its nose on `line`, `yAt(line, a)` the rail
   * panel height at arc a. Writes every section and display; returns the
   * number of sections drawn.
   */
  pose(line, kind, s, yAt, row, far = false) {
    const P = line.P, bog = this._bog;
    let drawn = 0;
    if (this._glow) this._lights(line, kind, s, yAt);
    for (const car of consistOf(kind)) {
      const B = TRAM_BODY[car.body];
      const nb = B.bogies.length;
      for (let b = 0; b < nb; b++) {
        const a = s - car.off - B.bogies[b];
        pathAtExt(P, a, _at);
        bog[b * 3] = _at.x; bog[b * 3 + 1] = yAt(line, a); bog[b * 3 + 2] = _at.z;
      }
      const signs = this._signs[car.body];
      for (let k = 0; k < B.sections.length; k++) {
        const sec = B.sections[k];
        const ti = TYPE_INDEX[sec.type], im = far ? this.far : this.meshes[ti];
        if (far ? this._nFar >= MAX_FAR : this._n[ti] >= MAX_PER_TYPE) continue;
        const i0 = sec.b0 * 3, i1 = sec.b1 * 3;
        // forward is from the rear bogie to the front one; local +z points back
        _z.set(bog[i1] - bog[i0], bog[i1 + 1] - bog[i0 + 1], bog[i1 + 2] - bog[i0 + 2]);
        if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
        _z.normalize();
        _x.crossVectors(UP, _z).normalize();
        _y.crossVectors(_z, _x);
        _m.makeBasis(_x, _y, _z);
        _m.setPosition((bog[i0] + bog[i1]) / 2, (bog[i0 + 1] + bog[i1 + 1]) / 2, (bog[i0 + 2] + bog[i1 + 2]) / 2);
        drawn++;
        if (far) {
          _sm.multiplyMatrices(_m, this._farL[car.body][k]);
          _sm.toArray(im.instanceMatrix.array, this._nFar * 16);
          this._nFar++;
          continue;
        }
        _m.toArray(im.instanceMatrix.array, this._n[ti] * 16);
        this._n[ti]++;
        // the displays this section carries
        if (row >= 0) {
          for (const part of PARTS) {
            const sg = signs[part];
            if (sg.sec !== k) continue;
            // the tail display of the leading car of a pair is against the coupler: not shown
            if (part === 'rear' && car.off === 0 && consistOf(kind).length > 1) continue;
            if (part !== 'rear' && car.off > 0) continue;
            _sm.multiplyMatrices(_m, sg.m);
            this.signs.push(_sm, row, part === 'rear' ? SIGN_NUM_U : 1);
          }
        }
      }
    }
    return drawn;
  }

  // the far glows of one tram: head lamps at the nose, tail lamps at the
  // tail, and a warm point at window height in the middle of each car
  _lights(line, kind, s, yAt) {
    const P = line.P, g = this.glow;
    const cars = consistOf(kind);
    for (let c = 0; c < cars.length; c++) {
      const car = cars[c], B = TRAM_BODY[car.body];
      const nose = s - car.off, tail = nose - B.len;
      if (c === 0) {
        pathAtExt(P, nose, _at);
        const y = yAt(line, nose) + 0.75, rx = -_at.dz * 0.85, rz = _at.dx * 0.85;
        g.point(_at.x + rx, y, _at.z + rz, HEAD[0] * 1.6, HEAD[1] * 1.6, HEAD[2] * 1.6);
        g.point(_at.x - rx, y, _at.z - rz, HEAD[0] * 1.6, HEAD[1] * 1.6, HEAD[2] * 1.6);
      }
      if (c === cars.length - 1) {
        pathAtExt(P, tail, _at);
        const y = yAt(line, tail) + 0.8, rx = -_at.dz * 0.85, rz = _at.dx * 0.85;
        g.point(_at.x + rx, y, _at.z + rz, TAIL[0] * 0.7, TAIL[1] * 0.7, TAIL[2] * 0.7);
        g.point(_at.x - rx, y, _at.z - rz, TAIL[0] * 0.7, TAIL[1] * 0.7, TAIL[2] * 0.7);
      }
      // (one window point per ten metres or so of car)
      const nw = Math.max(1, Math.round(B.len / 10));
      for (let w = 0; w < nw; w++) {
        const a = nose - B.len * (w + 0.5) / nw;
        pathAtExt(P, a, _at);
        g.point(_at.x, yAt(line, a) + 1.75, _at.z, WIN[0] * 0.55, WIN[1] * 0.55, WIN[2] * 0.55);
      }
    }
  }

  end(nightK) {
    this.far.count = this.visible ? this._nFar : 0;
    this.far.instanceMatrix.needsUpdate = true;
    if (this._glow || this.glow.n) { if (!this._glow) this.glow.n = 0; this.glow.end(); }
    for (let i = 0; i < this.meshes.length; i++) {
      const im = this.meshes[i];
      im.count = this.visible ? this._n[i] : 0;
      im.instanceMatrix.needsUpdate = true;
    }
    this.signs.end(nightK);
    if (!this.visible) this.signs.mesh.count = 0;
    // lit from inside after dusk; the lamps burn by day too (dipped), brighter at night
    const k = nightK < 0 ? 0 : nightK > 1 ? 1 : nightK;
    // (the night exposure opens nearly three times, js/sky.js: a little goes a
    // long way. At 0.06 the glow clipped to the cream of a T3's body and its
    // windows vanished into the paint; at 0.03 they stay warm amber glass)
    this.glass.emissiveIntensity = 0.03 * k;
    const l = 0.75 + 1.6 * k;
    if (Math.abs(this.lamp.color.r - l) > 0.01) this.lamp.color.setScalar(l);
  }

  dispose() {
    for (const im of this.meshes) { this.scene.remove(im); im.geometry.dispose(); }
    this.scene.remove(this.signs.mesh);
  }
}
