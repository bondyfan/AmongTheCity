// ---- bikefleet.js: every bicycle in the world, in a dozen draw calls ----------
// The riders are people and each is one skinned mesh (js/citizen.js). The
// machines under them are all alike, so they are INSTANCED: one InstancedMesh
// per part (js/bikemodel.js has the list), sized once, for the whole fleet.
// Twenty bicycles are the same number of draw calls as one.
//
// IMMEDIATE MODE. Nothing here remembers a bicycle from one frame to the next.
// The owner (js/cyclists.js) says begin(), then put() once per machine with
// where it is and how its parts stand, then end(); the instance buffers are
// rewritten in that order. There is no slot to leak, and a bicycle that is not
// put() is not drawn. Nothing on that path allocates.
//
// DISTANCE. A bicycle the owner calls `far` keeps its frame (a few hundred
// triangles) and trades its two spoked wheels for dark rings and its cranks
// and lamp housing for nothing: at sixty metres a wheel is eight pixels.
//
// AT NIGHT every bicycle carries a white lamp ahead and a red one behind, and
// throws a small pool of light on the road in front of it. The lamps are
// points a few centimetres across, which at forty metres is less than a pixel,
// so they grow with distance the way a real light's glare does.

import * as THREE from 'three';
import { BIKES, WHEEL_R, bikeGeometry, bikeMaterial } from './bikemodel.js';

const LAMP_ON = 0.3;              // darkness (0..1) past which the lamps are lit
const LAMP_R = 0.034;             // m: the glowing part of a lamp
const POOL_AHEAD = 2.4;           // m in front of the bracket the pool is centred
const CRANK_L = 0.165;            // the length js/bikemodel.js models the cranks at

const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _axis = new THREE.Vector3(), _c = new THREE.Color();
const WHITE = [1.5, 1.42, 1.2], RED = [1.25, 0.06, 0.04];

// (a function of the module's, not a closure made in end(): that runs every frame)
function set(m, c, colour) {
  m.count = c;
  m.visible = c > 0;
  if (!c) return;
  m.instanceMatrix.needsUpdate = true;
  if (colour) m.instanceColor.needsUpdate = true;
}

export class BikeFleet {
  // cap: sixteen riders (js/cyclists.js BODY_CAP), as many again riding on as
  // ghosts when a generation rolls in view, and eight wrecks
  constructor(scene, cap = 40) {
    this.scene = scene;
    this.cap = cap;
    const g = bikeGeometry(), mat = bikeMaterial();
    const inst = (geo, material, n, shadow) => {
      const m = new THREE.InstancedMesh(geo, material, n);
      m.count = 0;
      m.visible = false;
      // the instances are all over town and rewritten every frame: a bounding
      // sphere computed once would cull the lot the moment they moved
      m.frustumCulled = false;
      m.castShadow = shadow;
      m.matrixAutoUpdate = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    };
    const tint = (m, n) => {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      return m;
    };
    this.frame = BIKES.map((_, i) => tint(inst(g.frame[i], mat, cap, true), cap));
    this.front = BIKES.map((_, i) => tint(inst(g.front[i], mat, cap, true), cap));
    this.wheel = inst(g.wheel, mat, cap * 2, true);
    this.wheelFar = inst(g.wheelFar, mat, cap * 2, false);
    this.crank = inst(g.crank, mat, cap, false);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lamp = tint(inst(g.lamp, this.lampMat, cap * 2, false), cap * 2);
    this.poolMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false,
    });
    this.pool = inst(g.pool, this.poolMat, cap, false);
    this.pool.renderOrder = 1;
    this._n = { frame: [0, 0, 0, 0], all: 0, wheel: 0, wheelFar: 0, crank: 0, lamp: 0, pool: 0 };
    this._night = 0;
    this.tris = 0;                  // triangles put this frame (for the perf probe)
    // the steering axis of each bike, in its own frame: from the pivot up the head tube
    this._axes = BIKES.map((b) => new THREE.Vector3(0, b.top[1] - b.pivot[1], 0 - (b.top[0] - b.pivot[0])).normalize());
  }

  /** Start a frame. `nightK`: how dark it is, 0..1 (js/sky.js nightKOf). */
  begin(nightK = 0) {
    const n = this._n;
    n.frame[0] = n.frame[1] = n.frame[2] = n.frame[3] = 0;
    n.all = n.wheel = n.wheelFar = n.crank = n.lamp = n.pool = 0;
    this._night = nightK;
    this.tris = 0;
  }

  /**
   * One bicycle. b = {
   *   type            index into js/bikemodel.js BIKES
   *   x, y, z         the ground under its bottom bracket
   *   heading         it faces (-sin h, -cos h), like everything else
   *   pitch, roll     radians: nose up, and leaning to its RIGHT
   *   steer           bars turned to the right, radians
   *   spin, crank     wheel and crank angles, radians, growing as it rolls forward
   *   scale           size against the reference bike
   *   paint           frame colour, sRGB hex
   *   far             the distance variant
   *   camD            metres from the camera (the lamps grow with it)
   *   lit             false: no lamps (a wreck lying in the road)
   * }
   */
  put(b) {
    const t = b.type, n = this._n, k = n.frame[t];
    // (the wheels, cranks and lamps are shared between the four kinds and
    // sized for `cap` bicycles in all: one more would write past their
    // buffers and the renderer would refuse to draw any of them)
    if (n.all >= this.cap) return;
    n.all++;
    const B = BIKES[t], s = b.scale;
    _e.set(b.pitch, b.heading, 0 - b.roll);
    _q.setFromEuler(_e);
    _m0.compose(_v.set(b.x, b.y, b.z), _q, _s.set(s, s, s));
    this.frame[t].setMatrixAt(k, _m0);
    _c.setHex(b.paint);
    this.frame[t].instanceColor.setXYZ(k, _c.r, _c.g, _c.b);
    // the front end: about the pivot, turned round the head tube
    _axis.copy(this._axes[t]);
    _q.setFromAxisAngle(_axis, 0 - b.steer);
    _m1.compose(_v.set(0, B.pivot[1], 0 - B.pivot[0]), _q, _s.set(1, 1, 1));
    _m1.premultiply(_m0);
    this.front[t].setMatrixAt(k, _m1);
    this.front[t].instanceColor.setXYZ(k, _c.r, _c.g, _c.b);
    n.frame[t] = k + 1;
    this.tris += this.frame[t].geometry.userData.tris + this.front[t].geometry.userData.tris;
    // wheels
    const ws = B.wheelR / WHEEL_R, far = b.far === true;
    const wm = far ? this.wheelFar : this.wheel, wk = far ? n.wheelFar : n.wheel;
    _e.set(0 - b.spin, 0, 0);
    _q.setFromEuler(_e);
    _s.set(ws * B.tyre, ws, ws);
    _m2.compose(_v.set(0, B.wheelR, 0 - B.rearF), _q, _s).premultiply(_m0);
    wm.setMatrixAt(wk, _m2);
    _m2.compose(_v.set(0, B.wheelR - B.pivot[1], 0 - (B.frontF - B.pivot[0])), _q, _s).premultiply(_m1);
    wm.setMatrixAt(wk + 1, _m2);
    if (far) n.wheelFar = wk + 2; else n.wheel = wk + 2;
    this.tris += 2 * wm.geometry.userData.tris;
    if (!far) {
      _e.set(0 - b.crank, 0, 0);
      _q.setFromEuler(_e);
      const cs = B.fit.crank / CRANK_L;
      _m2.compose(_v.set(0, B.fit.bbY, 0), _q, _s.set(1, cs, cs)).premultiply(_m0);
      this.crank.setMatrixAt(n.crank++, _m2);
      this.tris += this.crank.geometry.userData.tris;
    }
    if (this._night > LAMP_ON && b.lit !== false) {
      // a point of light, held at a couple of pixels however far off it is
      const r = LAMP_R * s * Math.max(1, (b.camD ?? 0) / 7);
      const lk = n.lamp;
      _v.set(0, B.lampF[1] - B.pivot[1], 0 - (B.lampF[0] - B.pivot[0]) - 0.03).applyMatrix4(_m1);
      _m3.makeScale(r, r, r).setPosition(_v);
      this.lamp.setMatrixAt(lk, _m3);
      this.lamp.instanceColor.setXYZ(lk, WHITE[0], WHITE[1], WHITE[2]);
      _v.set(0, B.lampR[1], 0 - B.lampR[0] + 0.012).applyMatrix4(_m0);
      _m3.makeScale(r * 0.85, r * 0.85, r * 0.85).setPosition(_v);
      this.lamp.setMatrixAt(lk + 1, _m3);
      this.lamp.instanceColor.setXYZ(lk + 1, RED[0], RED[1], RED[2]);
      n.lamp = lk + 2;
      if (!far) {
        // the pool on the road ahead, laid along the slope the bike is on
        const sh = Math.sin(b.heading), ch = Math.cos(b.heading), d = POOL_AHEAD * s;
        _e.set(b.pitch, b.heading, 0);
        _q.setFromEuler(_e);
        _m3.compose(_v.set(b.x - sh * d, b.y + 0.05 + Math.sin(b.pitch) * d, b.z - ch * d), _q, _s.set(0.85 * s, 1, 1.7 * s));
        this.pool.setMatrixAt(n.pool++, _m3);
      }
    }
  }

  /** Finish the frame: hand the buffers to the renderer. */
  end() {
    const n = this._n;
    for (let t = 0; t < BIKES.length; t++) { set(this.frame[t], n.frame[t], true); set(this.front[t], n.frame[t], true); }
    set(this.wheel, n.wheel, false);
    set(this.wheelFar, n.wheelFar, false);
    set(this.crank, n.crank, false);
    set(this.lamp, n.lamp, true);
    set(this.pool, n.pool, false);
    // the pool is added light: as bright as the night is dark
    const k = Math.max(0, (this._night - LAMP_ON) / (1 - LAMP_ON));
    this.poolMat.color.setRGB(0.07 * k, 0.067 * k, 0.055 * k);
  }

  /** How many bicycles the last frame drew. */
  get count() { return this._n.all; }

  dispose() {
    for (const m of [...this.frame, ...this.front, this.wheel, this.wheelFar, this.crank, this.lamp, this.pool]) {
      m.parent?.remove(m);
      m.dispose();                  // the instance buffers; the geometry is shared (js/bikemodel.js)
    }
    this.lampMat.dispose(); this.poolMat.dispose();
  }
}
