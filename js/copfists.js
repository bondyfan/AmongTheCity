// ==========================================================================
// copfists.js: a policeman on foot as somebody a fist can find
//
// Review, 25 Nov 2026: the officers out of a patrol car (js/policecops.js)
// were not among js/combat.js's target sources, so they could not be punched
// and the crimes 'napadeni_policisty' and 'zabiti_policisty' (js/crimelaw.js,
// js/wanted.js) never came from a fist. This file is the two halves of that:
//
//   CopTargets   the target source combat.js asks: nearest() and hurt(), plus
//                the crimes a blow on this source is (`crimes`) and no pocket
//                to rob (`noPocket`: an officer's wallet is not loot).
//   copReact /   what the officer does about it, on his own record, stepped
//   copFistStep  by Officers.update before his duty (cover, seize, fire):
//
//     stun    a jab or a cross: the head snaps back (Hit_Head, Hit_Chest), he
//             stands for half a second facing you, and the hand on your
//             collar lets go (his cuffing clock starts again).
//     ko      the hook, or a blow at KO_HP: flat on his back (Hit_Knockback),
//             a few seconds on the tarmac, up again (LayToIdle), then straight
//             back to it: the arrest below three stars, the pistol from three.
//     dead    no health left: he falls the same way and is laid out for good
//             ('down', the state a run-over officer is in), and his unit is
//             one man short. combat.js reports the killing; nothing here
//             touches the stars (the crime goes through js/crimelaw.js once).
//
// What hitting him does to the chase is not here either: 'napadeni_policisty'
// is two stars at once (the police are their own witness), and two stars is
// officers who run at you to make the arrest, tackle a runner and cuff a man
// who holds still. That is the GTA answer to a punch thrown at a policeman.
//
// The lofted figure (no people bank, headless tests) has no recordings: it is
// tipped flat with ragdollPose for the knock-down and stood up again after.
//
// LOCAL, like the whole pursuit (js/police.js): nothing here is shared.
// ==========================================================================

export const COP_HP = 100;
const STUN_T = 0.5;          // s a punched officer reels before he is on duty again
const KO_FROM = 0.08;        // s into Hit_Knockback (its first frame is a crouch)
const SLIDE_T = 0.35;        // s the blow carries him back…
const SLIDE_V = 1.7;         // …starting at this many m/s
const LIE_T = [2.6, 3.8];    // s on the ground before he gets up
const LOFT_FALL_T = 0.6;     // s the lofted figure takes to go down
const LOFT_UP_T = 0.8;       // …and to get up
const TURN = 9;              // rad/s he turns to face you while reeling

const angTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** What a fist reads off an officer: live getters over his pooled record. */
class CopBody {
  constructor(r) { this.r = r; this.gen = r.gen; this._stub = { position: { x: 0, y: 0, z: 0 }, parent: null }; }
  get gone() { return this.r.free || this.r.gen !== this.gen; }
  get x() { return this.r.x; }
  get z() { return this.r.z; }
  get y() { return this.r.y; }
  get hp() { return this.gone ? 0 : this.r.hp; }
  get dead() { return this.gone || this.r.state === 'down'; }
  /** 'walk' while he is on his feet (combat.js's target test), 'ko' on the
   *  ground or getting up, 'dead' laid out. */
  get state() {
    if (this.dead) return 'dead';
    const f = this.r.fist;
    return f && f.mode !== 'stun' ? 'ko' : 'walk';
  }
  get mesh() {
    if (this.gone) return null;
    const g = this.r.body?.group;
    if (g) return g;
    this._stub.position.x = this.r.x; this._stub.position.y = this.r.y; this._stub.position.z = this.r.z;
    return this._stub;
  }
  get headTop() { return this.r.body?.headTop ?? 1.75; }
  get arch() { return this.r.body?.arch?.key ?? 'm30'; }
  get police() { return true; }
}

/** The officer's own body for a fist, one per deployment of his record. */
export function copBody(r) {
  if (!r) return null;
  if (!r._fistBody || r._fistBody.gen !== r.gen) r._fistBody = new CopBody(r);
  return r._fistBody;
}

export class CopTargets {
  /** officers: the js/policecops.js Officers, or a function returning it (police is built later). */
  constructor(officers) {
    this._src = officers ?? null;
    /** js/combat.js: what a landed blow and a killing one are, on this source. */
    this.crimes = Object.freeze({ fight: 'napadeni_policisty', kill: 'zabiti_policisty' });
    this.noPocket = true;
  }

  get officers() {
    const s = this._src;
    try { return typeof s === 'function' ? s() : s; } catch (e) { return null; }
  }

  /** The nearest officer on his feet within rad that want(body) accepts. */
  nearest(x, z, rad, want = null) {
    const out = this.officers?.out;
    if (!out || !(rad > 0)) return null;
    let best = null, bd = rad * rad;
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      if (!r || r.free || r.state === 'down') continue;
      const p = copBody(r);
      if (want ? !want(p) : p.state !== 'walk') continue;
      const dx = r.x - x, dz = r.z - z, d2 = dx * dx + dz * dz;
      if (d2 <= bd) { bd = d2; best = p; }
    }
    return best;
  }

  /** A blow { dmg, ... }: his health comes off, and at nothing he is dead. */
  hurt(p, blow) {
    const r = p?.r;
    if (!r || p.gone || r.state === 'down' || !blow) return false;
    const dmg = blow.dmg > 0 ? blow.dmg : 0;
    r.hp = (Number.isFinite(r.hp) ? r.hp : COP_HP) - dmg;
    if (!(r.hp > 0)) {
      r.hp = 0;
      r.state = 'down';
      r.aimK = 0;
      const O = this.officers;
      if (O?.stats) O.stats.downs++;
    }
    return true;
  }

  /** combat.js, after hurt(): rx 'flinch' | 'down' | 'dead', the punch from (ax, az). */
  react(p, rx, move, ax, az) {
    const r = p?.r;
    if (!r || p.gone) return;
    copReact(r, rx, move, ax, az, this.officers?._t ?? 0);
  }
}

/** Start what a blow does to officer r at time t (Officers' clock). */
export function copReact(r, rx, move, ax, az, t) {
  r.cuffT = 0;                                 // the hand on your collar lets go
  r.nextShot = 0;                              // and the gun comes up again from nothing
  const role = move?.hit ?? 'hitHead';
  if (rx === 'flinch' && r.state !== 'down') {
    const f = r.fist;
    // a jab while he is still reeling starts the snap again; one on the ground does nothing
    if (f && f.mode !== 'stun') return;
    r.fist = { mode: 'stun', t0: t, role, sx: 0, sz: 0, until: 0, dead: false };
    return;
  }
  // down or dead: face the punch, so the fall goes away from it
  if (Number.isFinite(ax) && Number.isFinite(az)) r.heading = angTo(r.x, r.z, ax, az);
  const dx = r.x - ax, dz = r.z - az, d = Math.hypot(dx, dz) || 1;
  r.fist = { mode: 'fall', t0: t, role, sx: Number.isFinite(dx / d) ? dx / d : 0, sz: Number.isFinite(dz / d) ? dz / d : 0,
    until: 0, dead: rx === 'dead' || r.state === 'down' };
  r.aimK = 0;
}

/**
 * One step of a fist's hold on officer r. Returns true while it owns his body
 * this step (his duty waits); false once he is back on it (r.fist cleared),
 * or laid out for good (r.fist kept on a dead man, so he stays where he fell).
 * ctx: Officers' update ctx ({ px, pz } is the player). blocked(x, z): a wall.
 */
export function copFistStep(r, t, dt, ctx, blocked = null) {
  const f = r.fist;
  if (!f) return false;
  const b = r.body, act = typeof b?.act === 'function' && (b.actDur?.('hitBack') ?? 0) > 0;
  const el = t - f.t0;
  if (f.mode === 'stun') {
    if (el >= STUN_T) { r.fist = null; return false; }
    // reeling: no step, the gun down, turning to the man who hit him
    r.speed = 0;
    r.aimK = Math.max(0, r.aimK - dt * 4);
    if (Number.isFinite(ctx?.px) && Number.isFinite(ctx?.pz)) {
      const d = wrap(angTo(r.x, r.z, ctx.px, ctx.pz) - r.heading), s = TURN * dt;
      r.heading += Math.abs(d) <= s ? d : Math.sign(d) * s;
    }
    pose(r, 0);
    if (act) {
      const dur = b.actDur(f.role);
      if (dur > 0 && el < dur) b.act(f.role, el, 1, 'upper');
    }
    return true;
  }
  r.sees = false;                              // on the ground he has nobody in sight
  if (f.mode === 'fall') {
    if (el < SLIDE_T) {
      const v = SLIDE_V * (1 - el / SLIDE_T);
      const nx = r.x + f.sx * v * dt, nz = r.z + f.sz * v * dt;
      if (!blocked?.(nx, nz)) { r.x = nx; r.z = nz; }
    }
    r.speed = 0;
    const dur = act ? b.actDur('hitBack') : LOFT_FALL_T;
    pose(r, 0);
    if (act) {
      const ct = KO_FROM + el;
      if (ct < dur) { b.act('hitBack', ct, 1, 'full', 0.06); return true; }
    } else if (el < dur) return true;
    // on the ground
    if (f.dead) {
      if (act) b.act('hitBack', dur, 1, 'full', 0.06, true);   // held: a body laid out stays laid out
      else flat(r);
      f.mode = 'dead';
      return true;
    }
    f.mode = 'lie';
    f.until = t + LIE_T[0] + Math.random() * (LIE_T[1] - LIE_T[0]);
    if (act) b.act('hitBack', dur, 1, 'full'); else flat(r);
    return true;
  }
  if (f.mode === 'lie') {
    if (act) b.act('hitBack', b.actDur('hitBack'), 1, 'full'); else flat(r);
    if (t >= f.until) { f.mode = 'getup'; f.t0 = t; }
    return true;
  }
  if (f.mode === 'getup') {
    const dur = act ? b.actDur('getUp') : LOFT_UP_T;
    if (el < dur) {
      if (act) { pose(r, 0); b.act('getUp', el, 1, 'full', 0.15); } else flat(r);
      return true;
    }
    // on his feet: back on duty; police.js's _step picks cover, chase or the arrest
    if (!act) upright(r);
    r.fist = null;
    if (r.state !== 'back') r.state = 'cover';
    r.coverAt = 0;
    return false;
  }
  // 'dead': laid out where he fell
  return true;
}

/** Undo what a fist did to the body, for a record going back to the pool. */
export function copFistClear(r) {
  if (!r) return;
  r.fist = null;
  r.body?.actStop?.();
}

// the walk at a standstill where he stands (the act layer goes over it)
function pose(r, speed) {
  const g = r.body?.group;
  if (!g) return;
  g.position.set(r.x, r.y, r.z);
  g.rotation.y = r.heading;
  r.body.walk?.(r.walkT ?? 0, 0, 0, speed);
}

// the lofted figure on its back, the way a run-over officer lies
function flat(r) {
  const b = r.body;
  if (!b?.group) return;
  b.ragdollPose?.();
  b.group.rotation.set(-Math.PI / 2 * 0.96, r.heading, 0, 'YXZ');
  b.group.position.set(r.x, r.y + 0.18, r.z);
}

function upright(r) {
  const b = r.body;
  if (!b?.group) return;
  b.standPose?.();
  b.group.rotation.set(0, r.heading, 0);
  b.group.position.set(r.x, r.y, r.z);
}
