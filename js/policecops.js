// ==========================================================================
// Policecops: the officers who get out of a stopped patrol car.
//
// WHEN. js/police.js parks a unit once it has caught up with a player who has
// stopped (or who was on foot to begin with) and calls deploy(). The driver
// gets out on the left, a partner on the right from two stars up.
//
// WHAT THEY DO, in order, and every step is something the player can see:
//
//   exit    0.6 s beside the door, turning towards you.
//   cover   walk round to the side of the car AWAY from you and stand at the
//           wing or the boot: the car is between you and them. The spot is
//           re-chosen once a second as you move, so they keep the car between.
//   aim     the pistol comes up over 0.35 s (aimPose). Nothing is fired until
//           it has been up for the tier's `react` (0.65 to 1.25 s) plus up to
//           0.4 s more: THE TELEGRAPH. The first time a unit raises its guns
//           the game says so in words ("Policie! Stůj, nebo střelím!").
//   fire    bursts of two or three rounds, then a pause scaled by the tier's
//           rate. Only with a clear line (police.js's building test) and only
//           inside FIRE_R. Every round is a js/copfire.js trace.
//   chase   a player on foot who walks away from the car is followed on foot
//           and shot at on the move (with the moving scatter penalty).
//   back    you drove off, or got too far: they run back, get in, and the
//           unit drives again.
//   seize   below three stars (the tier's `lethal` is false) there is no cover
//           and no pistol at all: they run straight at you, to the driver's
//           door if you sit in a car. A man on foot who keeps moving with one
//           of them on him is brought down (onTackle); hold still for a second
//           with one beside you, or sit in a stopped car with one at the door,
//           and you are under arrest (onArrest).
//   down    run one over and he goes down for good (ragdoll pose, flat on the
//           road), and that is the crime of running down a person.
//   fists   punch one (js/combat.js through js/copfists.js) and he reels, is
//           knocked flat and gets up again, or dies of it: copFistStep owns
//           his body while that lasts, and his duty above waits.
//
// BODIES. Real citizen bodies from js/citizen.js in the Czech police uniform
// (wardrobe.js ROLES.police: navy fatigues, the yellow reflective vest, the
// peaked cap), each with a small pistol in the right hand. They are POOLED:
// at most POOL_N bodies are ever built (a body is a few milliseconds of
// geometry), and an officer who gets back in the car only hides his.
//
// Local, like the whole pursuit. Math.random is fine; tests inject `rnd`.
// ==========================================================================

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { FIRE_R } from './policetune.js';
import { sameLevel } from './levelsep.js';
import { COP_HP, copFistStep, copFistClear } from './copfists.js';

const POOL_N = 10;              // 5 units × 2 officers, the most there can be
const EXIT_T = 0.6;
const WALK_V = 2.4;             // m/s to cover
const RUN_V = 4.6;              // m/s back to the car, or after you
const TURN = 6;                 // 1/s heading smoothing
const AIM_IN = 1 / 0.35;        // aim blend per second
const COVER_DT = 1.0;           // s between cover re-picks
const SIGHT_DT = 0.3;           // s between line tests per officer
const CHASE_START = 24;         // m from the car past which a player on foot is followed
const CHASE_SHOOT = 30;         // m: inside this, with sight, a chasing officer stands and fires
const CHASE_HOLD = 9;           // m an officer on foot keeps off you
const LEASH = 150;              // m from the car past which they give up and go back
const RECALL_V = 7;             // m/s of player car speed that means "he is leaving"
const RECALL_R = 22;            // …once he is this far from the car
const RUNOVER_V = 4;            // m/s of car speed that knocks an officer down
const SEIZE_V = 6.3;            // m/s: after a man they mean to catch (a jog is 5.6)
const SEIZE_R = 1.5;            // m: close enough to lay hands on him
const CUFF_T = 1.0;             // s of him holding still beside an officer
const CUFF_CAR_T = 1.8;         // …or of his car standing with one at the door
const TACKLE_CD = 4;            // s before the same officer brings him down again
const GUN_Y = 1.42;             // m: muzzle height of a raised pistol
const GUN_FWD = 0.55;

const dist = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

let _gunGeo = null, _gunMat = null;
function gunMesh() {
  if (!_gunGeo) {
    // A compact service pistol: slide and grip. Built along the hand bone's −y
    // (down the forearm), so a raised arm points it at the target.
    const slide = new THREE.BoxGeometry(0.032, 0.19, 0.045);
    slide.translate(0, -0.12, 0.03);
    const grip = new THREE.BoxGeometry(0.03, 0.05, 0.11);
    grip.translate(0, -0.05, -0.015);
    const pos = [], idx = [];
    for (const g of [slide, grip]) {
      const base = pos.length / 3;
      const p = g.attributes.position.array;
      for (let i = 0; i < p.length; i++) pos.push(p[i]);
      const ix = g.index.array;
      for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
      g.dispose();
    }
    _gunGeo = new THREE.BufferGeometry();
    _gunGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    _gunGeo.setIndex(idx);
    _gunGeo.computeVertexNormals();
    _gunMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.45, metalness: 0.6 });
  }
  const m = new THREE.Mesh(_gunGeo, _gunMat);
  m.castShadow = true;
  return m;
}

function defaultBody() {
  const c = makeCitizen({ archetype: Math.random() < 0.2 ? 'f30' : 'm30', role: 'police' });
  try { c.parts?.handR?.add(gunMesh()); } catch (e) { /* headless: no gun, no matter */ }
  return c;
}

export class Officers {
  /**
   * { scene, gunfire, groundAt(x, z), los(ax, az, bx, bz), blocked(x, z),
   *   makeBody(), say(text), wanted, rnd }. All optional; a test passes stubs.
   */
  constructor(opts = {}) {
    this.scene = opts.scene ?? null;
    this.gunfire = opts.gunfire ?? null;
    this.groundAt = opts.groundAt ?? null;
    this.los = opts.los ?? null;
    this.blocked = opts.blocked ?? null;
    this.makeBody = opts.makeBody ?? (this.scene ? defaultBody : null);
    this.say = opts.say ?? null;
    this.onArrest = opts.onArrest ?? null;   // fn(officer): hands laid on a still player
    this.onTackle = opts.onTackle ?? null;   // fn(officer): a runner brought down
    this.wanted = opts.wanted ?? null;
    this.rnd = typeof opts.rnd === 'function' ? opts.rnd : Math.random;
    this._t = 0;
    this._rec = [];
    for (let i = 0; i < POOL_N; i++) this._rec.push(this._blank());
    this._bodies = [];            // built bodies not in use
    /** Officers currently out of their cars (read only, rebuilt per update). */
    this.out = [];
    this.stats = { deployed: 0, downs: 0 };
  }

  _blank() {
    return {
      free: true, unit: null, body: null, slot: 0, x: 0, z: 0, y: 0, heading: 0,
      state: '', stAt: 0, aimK: 0, nextShot: 0, burst: 0, walkT: 0, speed: 0,
      cx: 0, cz: 0, coverAt: 0, sightAt: 0, sees: false, cuffT: 0, tackleAt: 0,
      hp: COP_HP, fist: null, gen: 0,
    };
  }

  /** How many officers of unit `u` are out of the car (down ones included). */
  count(u) {
    let n = 0;
    for (const r of this._rec) if (!r.free && r.unit === u) n++;
    return n;
  }

  /** True when every officer of `u` who can still walk is back in the car. */
  allIn(u) {
    for (const r of this._rec) if (!r.free && r.unit === u && r.state !== 'down') return false;
    return true;
  }

  /** True when `u` has officers out and every one of them is down. */
  allDown(u) {
    let any = false;
    for (const r of this._rec) {
      if (r.free || r.unit !== u) continue;
      if (r.state !== 'down') return false;
      any = true;
    }
    return any;
  }

  /** Out of the car: `n` officers from unit `u` (whose `.car` is parked). */
  deploy(u, n) {
    const car = u?.car;
    if (!car || this.count(u) > 0) return 0;
    let made = 0;
    for (let k = 0; k < n; k++) {
      const r = this._rec.find((q) => q.free);
      if (!r) break;
      const h = car.heading ?? 0;
      const fx = -Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
      const side = k === 0 ? -1 : 1;           // driver on the left
      const off = (car.wid ?? 1.8) / 2 + 0.45;
      r.free = false; r.unit = u; r.slot = k;
      r.x = car.x + rx * off * side + fx * 0.35;
      r.z = car.z + rz * off * side + fz * 0.35;
      r.y = this._ground(r.x, r.z, car.y ?? 0);
      r.heading = h; r.state = 'exit'; r.stAt = this._t + EXIT_T + k * 0.25;
      r.aimK = 0; r.nextShot = 0; r.burst = 0; r.speed = 0; r.walkT = this.rnd() * 6;
      r.coverAt = 0; r.sightAt = 0; r.sees = false; r.cuffT = 0; r.tackleAt = 0;
      r.hp = COP_HP; r.fist = null; r.gen++;     // a new man in a pooled record
      r.body = this._takeBody();
      this._pose(r, 0);
      made++;
    }
    this.stats.deployed += made;
    return made;
  }

  /** Everyone of `u` back to the car. */
  recall(u) {
    for (const r of this._rec) {
      if (r.free || r.unit !== u || r.state === 'down' || r.state === 'back') continue;
      r.state = 'back';
    }
  }

  /** Gone this instant (the unit's car is being deleted). */
  dropUnit(u) {
    for (const r of this._rec) if (!r.free && r.unit === u) this._free(r);
  }

  reset() {
    for (const r of this._rec) if (!r.free) this._free(r);
    this.out.length = 0;
  }

  _free(r) {
    copFistClear(r);
    if (r.body) {
      r.body.group.visible = false;
      r.body.standPose?.();
      r.body.group.rotation.set(0, 0, 0);
      this._bodies.push(r.body);
    }
    r.body = null; r.unit = null; r.free = true; r.state = '';
  }

  _takeBody() {
    if (this._bodies.length) {
      const b = this._bodies.pop();
      b.group.visible = true;
      return b;
    }
    if (!this.makeBody) return null;
    let b = null;
    try { b = this.makeBody(); } catch (err) { console.warn('[policecops] body:', err); }
    if (b && this.scene && b.group && !b.group.parent) this.scene.add(b.group);
    return b;
  }

  _ground(x, z, fb) {
    if (!this.groundAt) return fb;
    try {
      const y = this.groundAt(x, z);
      return Number.isFinite(y) ? y : fb;
    } catch (e) { return fb; }
  }

  /**
   * ctx = { t, px, pz, py, pcar, onFoot, pspeed, tier, down }.
   * `t` is police.js's clock (absolute deadlines), `down` whether the player is
   * dead (nobody shoots a body).
   */
  update(dt, ctx) {
    this._t = ctx.t;
    this.out.length = 0;
    const tier = ctx.tier;
    for (const r of this._rec) {
      if (r.free) continue;
      const u = r.unit, car = u?.car;
      if (!car) { this._free(r); continue; }
      this.out.push(r);
      // a man the player's fists put down falls and is laid out by copfists.js
      if (r.fist?.dead) { copFistStep(r, this._t, dt, ctx); continue; }
      if (r.state === 'down') continue;
      this._runOver(r, ctx);
      if (r.state === 'down') { copFistClear(r); continue; }   // the car wins over a fist
      if (r.fist && copFistStep(r, this._t, dt, ctx, (x, z) => this._blocked(x, z))) continue;
      this._step(r, dt, ctx, tier, car);
    }
  }

  _runOver(r, ctx) {
    const c = ctx.pcar;
    if (!c || Math.abs(c.speed ?? 0) < RUNOVER_V) return;
    const h = c.heading ?? 0;
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const dx = r.x - c.x, dz = r.z - c.z;
    const a = dx * fx + dz * fz, b = dx * -fz + dz * fx;
    if (Math.abs(a) > (c.len ?? 4.4) / 2 + 0.35 || Math.abs(b) > (c.wid ?? 1.8) / 2 + 0.3) return;
    if (!sameLevel(c.y, r.y)) return;      // the car is on the deck over him, or under his bridge
    r.state = 'down'; r.aimK = 0;
    this.stats.downs++;
    if (r.body) {
      r.body.ragdollPose?.();
      r.body.group.rotation.set(-Math.PI / 2 * 0.96, h, 0, 'YXZ');
      r.body.group.position.y = r.y + 0.18;
    }
    // run down for good: killing a policeman, three stars (js/wanted.js), and
    // the police are their own witness (js/crimelaw.js `always`)
    try { this.wanted?.add?.('zabiti_policisty'); } catch (e) { /* the HUD is not the street */ }
  }

  _step(r, dt, ctx, tier, car) {
    const t = this._t;
    const px = ctx.px, pz = ctx.pz;
    const dP = dist(px - r.x, pz - r.z);
    const dCarP = dist(px - car.x, pz - car.z);
    const pcar = ctx.pcar;

    // ---- leaving? -------------------------------------------------------
    if (r.state !== 'back' && r.state !== 'exit') {
      const leaving = (pcar && Math.abs(pcar.speed ?? 0) > RECALL_V && dCarP > RECALL_R)
        || dCarP > LEASH || ctx.down || !tier || (!ctx.onFoot && !pcar);
      if (leaving) r.state = 'back';
    }

    let goX = r.x, goZ = r.z, v = 0;
    let wantAim = false;
    if (r.state === 'exit') {
      if (t >= r.stAt) r.state = 'cover';
    } else if (r.state === 'back') {
      const h = car.heading ?? 0;
      const fx = -Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
      const side = r.slot === 0 ? -1 : 1, off = (car.wid ?? 1.8) / 2 + 0.45;
      goX = car.x + rx * off * side + fx * 0.35; goZ = car.z + rz * off * side + fz * 0.35;
      v = RUN_V;
      if (dist(goX - r.x, goZ - r.z) < 0.6) { this._free(r); return; }
    } else if (tier && tier.lethal === false) {
      // ---- they want him alive: straight at him, hands free ----
      r.state = 'seize';
      let tx = px, tz = pz;
      if (pcar) {
        // the driver's door: left of the nose, right of dir(h) being (cos h, -sin h)
        const h = pcar.heading ?? 0, off = (pcar.wid ?? 1.8) / 2 + 0.75;
        tx = pcar.x - Math.cos(h) * off; tz = pcar.z + Math.sin(h) * off;
      }
      // the partner comes up beside the first man, not through him
      if (r.slot) { const a = Math.atan2(tx - r.x, tz - r.z) + Math.PI / 2; tx += Math.sin(a) * 0.8; tz += Math.cos(a) * 0.8; }
      const dT = dist(tx - r.x, tz - r.z);
      // (the last metres at a walk only if he is standing: a man walking away
      // is still caught up with)
      if (dT > SEIZE_R * 0.6) {
        goX = tx; goZ = tz;
        v = dT > 4 ? SEIZE_V : Math.min(SEIZE_V, Math.max(WALK_V, pcar ? 0 : (ctx.pspeed || 0) + 1.6));
      }
      const still = pcar ? Math.abs(pcar.speed ?? 0) < 1.5 : (ctx.lying || ctx.pspeed < 1.2);
      if (dT < SEIZE_R && !ctx.down) {
        if (!still && !pcar && this.onTackle && t >= r.tackleAt) { r.tackleAt = t + TACKLE_CD; this.onTackle(r); }
        r.cuffT = still ? r.cuffT + dt : Math.max(0, r.cuffT - dt * 2);
        if (r.cuffT >= (pcar ? CUFF_CAR_T : CUFF_T)) { r.cuffT = 0; this.onArrest?.(r); }
      } else r.cuffT = Math.max(0, r.cuffT - dt);
      const u = r.unit;
      if (u && !u.warned && dP < 30) { u.warned = true; this.say?.(pcar ? 'Policie! Vystupte z vozu!' : 'Policie! Stůjte!'); }
    } else {
      // cover, or on foot after you
      if (ctx.onFoot && dCarP > CHASE_START) r.state = 'chase';
      else if (r.state === 'chase' && dCarP < CHASE_START - 6) r.state = 'cover';
      if (r.state === 'chase') {
        // Run to get in range, then STOP and shoot: a policeman firing on the
        // run hits nothing and looks like it. Out of range the gun stays down.
        if (r.sees && dP < CHASE_SHOOT) v = 0;
        else if (dP > CHASE_HOLD) { goX = px; goZ = pz; v = dP > CHASE_SHOOT + 10 ? RUN_V : WALK_V; }
      } else {
        if (t >= r.coverAt) { r.coverAt = t + COVER_DT; this._cover(r, car, px, pz); }
        goX = r.cx; goZ = r.cz;
        if (dist(goX - r.x, goZ - r.z) > 0.3) v = WALK_V;
      }
      wantAim = !!tier && !ctx.down && dP < FIRE_R + 10 && !(r.state === 'chase' && v >= RUN_V);
    }

    // ---- feet ----------------------------------------------------------
    const mx = goX - r.x, mz = goZ - r.z, md = dist(mx, mz);
    let moved = 0;
    if (v > 0 && md > 0.05) {
      const step = Math.min(md, v * dt);
      const nx = r.x + mx / md * step, nz = r.z + mz / md * step;
      if (!this._blocked(nx, nz)) { r.x = nx; r.z = nz; moved = step; }
    }
    r.speed = dt > 0 ? moved / dt : 0;
    r.walkT += moved * 1.6;
    r.y = this._ground(r.x, r.z, r.y);

    // ---- facing: towards you while aiming, else where the feet go ---------
    let want = r.heading;
    if (wantAim || r.state === 'exit') want = Math.atan2(-(px - r.x), -(pz - r.z));
    else if (moved > 0) want = Math.atan2(-mx, -mz);
    r.heading = angWrap(r.heading + angWrap(want - r.heading) * Math.min(1, TURN * dt));

    // ---- sight and the gun ----------------------------------------------
    // (an officer running you down has you in sight as much as one aiming)
    const look = wantAim || r.state === 'seize';
    if (!look) r.sees = false;
    else if (t >= r.sightAt) {
      r.sightAt = t + SIGHT_DT;
      r.sees = !this.los || this.los(r.x, r.z, px, pz, dP);
    }
    const aimNow = wantAim && r.sees;
    r.aimK += (aimNow ? AIM_IN : -AIM_IN) * dt;
    if (r.aimK < 0) r.aimK = 0; else if (r.aimK > 1) r.aimK = 1;
    if (!aimNow) { if (r.aimK <= 0) r.nextShot = 0; }
    else if (r.aimK >= 0.95) {
      if (r.nextShot === 0) {
        // THE TELEGRAPH: the gun is up and has been seen before anything flies
        r.nextShot = t + tier.react + this.rnd() * 0.4;
        r.burst = 2 + (this.rnd() < 0.4 ? 1 : 0);
        const u = r.unit;
        if (u && !u.warned) { u.warned = true; this.say?.('Policie! Stůj, nebo střelím!'); }
      } else if (t >= r.nextShot && dP < FIRE_R) this._fire(r, ctx, tier);
    }
    this._pose(r, dt);
  }

  _fire(r, ctx, tier) {
    const g = this.gunfire;
    const h = r.heading;
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const sx = r.x + fx * GUN_FWD - fz * 0.12, sz = r.z + fz * GUN_FWD + fx * 0.12;
    const sy = r.y + GUN_Y;
    let tgt = null;
    if (ctx.onFoot) { _foot.x = ctx.px; _foot.z = ctx.pz; _foot.y = ctx.py; _foot.speed = ctx.pspeed; tgt = _foot; }
    else if (ctx.pcar) { _carT.car = ctx.pcar; _carT.speed = Math.abs(ctx.pcar.speed ?? 0); tgt = _carT; }
    if (g && tgt) g.shoot(sx, sy, sz, tgt, r.speed > 0.3, tier.acc, tier.dmg);
    r.burst--;
    if (r.burst > 0) r.nextShot = this._t + 0.3 + this.rnd() * 0.2;
    else {
      r.burst = 2 + (this.rnd() < 0.4 ? 1 : 0);
      r.nextShot = this._t + (1.0 + this.rnd() * 0.9) / tier.rate;
    }
  }

  // The car between you and him: the flank or the end of the car that faces
  // away from you, the driver at the front, the partner at the back.
  _cover(r, car, px, pz) {
    const h = car.heading ?? 0;
    const fx = -Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    let nx = car.x - px, nz = car.z - pz;
    const L = dist(nx, nz) || 1; nx /= L; nz /= L;
    const along = nx * fx + nz * fz, across = nx * rx + nz * rz;
    const hl = (car.len ?? 4.4) / 2, hw = (car.wid ?? 1.8) / 2;
    const k = r.slot === 0 ? 1 : -1;
    if (Math.abs(across) >= Math.abs(along) * 0.8) {
      const s = across >= 0 ? 1 : -1;
      r.cx = car.x + rx * s * (hw + 0.8) + fx * k * (hl * 0.55);
      r.cz = car.z + rz * s * (hw + 0.8) + fz * k * (hl * 0.55);
    } else {
      const s = along >= 0 ? 1 : -1;
      r.cx = car.x + fx * s * (hl + 0.8) + rx * k * (hw * 0.6);
      r.cz = car.z + fz * s * (hl + 0.8) + rz * k * (hw * 0.6);
    }
    if (this._blocked(r.cx, r.cz)) { r.cx = r.x; r.cz = r.z; }
  }

  _blocked(x, z) {
    if (!this.blocked) return false;
    try { return !!this.blocked(x, z); } catch (e) { return false; }
  }

  _pose(r, dt) {
    const b = r.body;
    if (!b) return;
    b.group.position.set(r.x, r.y, r.z);
    b.group.rotation.y = r.heading;
    const run = r.speed > 3 ? 1 : 0;
    b.walk?.(r.walkT, Math.min(1.3, r.speed / 1.4), run, r.speed);
    if (r.aimK > 0) b.aimPose?.(r.aimK, 0);
  }

  dispose() {
    this.reset();
    for (const b of this._bodies) b.dispose?.();
    this._bodies.length = 0;
  }
}

const _foot = { foot: true, x: 0, y: 0, z: 0, speed: 0 };
const _carT = { foot: false, car: null, speed: 0 };

export default Officers;
