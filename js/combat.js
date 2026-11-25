// ==========================================================================
// Combat: the player's fists, and the money that falls out of people
//
// Rebuilt 25 Nov 2026 for Frank ("jak je to v GTA 5... teď když bouchnu
// prostě levým tlačítkem myši, tak ona to tak jako strčí, ale nebouchne to
// jako pěstí"). What changed, and where it lives:
//
//   js/fightmoves.js   the punches as RECORDINGS (jab, cross, hook), their
//                      damage windows measured off the clips, the light chain,
//                      what a blow does to a body, who hits back. Pure.
//   js/combat.js       this file: the player's side. A swing, the stance, the
//                      block, being hit, finding who the fist meets, and the
//                      one door every blow goes through.
//   js/fightpeds.js    the crowd's side: the flinch, the knock-down and getting
//                      up, and the pedestrian who puts their fists up.
//   js/fightpose.js    the player's guard, punches and flinch on the body.
//   js/fightfx.js      a few drops of blood in the air; js/fighthud.js the
//                      health bar over whoever you are fighting;
//                      js/fightsfx.js the sounds; js/pocket.js the money.
//
// ---- THE SWING IS DEADLINES, NEVER A COUNTDOWN ----------------------------
//
// A swing is a move (fightmoves.js MOVES) started at an absolute time on this
// module's own clock. Everything that follows is a comparison against it:
// the damage window [open, shut] of the clip, the moment the next press may
// cut it short (chain), the end. The clock is LOCAL and accumulated from dt,
// clamped to 0.25 s a step, for js/vitals.js's reason: a hidden tab or a
// breakpoint must not come back to a fist that already landed on a world that
// moved on without it. stepGame(dt) runs several times per rendered frame, so
// every comparison is idempotent and a swing spends its ONE victim once
// (`_landed`), however many times it is stepped.
//
// Three presses in rhythm are jab, cross, hook (fightmoves.js nextMove); Q is
// the hook straight away. A press during the tail of a swing is buffered for
// BUFFER_T and starts the next punch the moment the current one may be cut
// (its `chain` time), which is what lets a combo flow instead of stutter. A
// HELD button (a phone's attack button is a held flag) repeats with a short
// rest, so tapping and holding throw at the same rate.
//
// ---- THE STANCE ------------------------------------------------------------
//
// Hitting somebody, being hit or holding block puts the fists up for STANCE_T
// seconds: the guard (the first frame of the recorded jab, fists by the face)
// over the walk, the body turned to the camera (player.aimLock, so the stick
// strafes), the walk capped. Standing still the guard takes the recording's
// legs too (feet apart, knees soft); walking, only the arms. Shift drops it at
// once, so you can still run after somebody.
//
// ---- WHERE THE POSE GOES: js/fightpose.js ---------------------------------
//
// ---- THE ARC IS THE SOFT LOCK ----------------------------------------------
//
// The reach is generous (1.45 to 1.75 m centre to centre, the hook steps in)
// and the arc is +-50 degrees around the camera. That generosity is the aim
// assist; turning the body toward the nearest target instead would fight
// player.aimLock, which drives the heading to the camera for as long as it is
// set, and two systems steering one heading is how a character ends up facing
// neither way. The search runs over every TARGET SOURCE handed in (the crowd,
// and since the wanted-rules session, the driver thrown out of a jacked car),
// each with nearest(x, z, r, want) and hurt(p, blow); the nearest valid body
// across all of them wins. `want` is asked about the cone and the height, so
// somebody standing behind you never shields the man you are swinging at.
//
// ---- EVERYTHING GOES THROUGH hurt() -----------------------------------------
//
// Not one line here writes a pedestrian's state, position or health. A blow
// record goes through the source's hurt(), and the ragdoll, the blood stain,
// the panic, onPedHit and onPedKilled are all on the far side of it. A blow on
// a modelled body carries `ko: true`: when it floors them, pedestrians.js
// hands the body upright to js/fightpeds.js, which plays the fall from a
// recording instead of throwing a ragdoll. The old figure is still thrown.
//
// ---- WHAT IS LOCAL, AND WHAT IS SHARED --------------------------------------
//
// WHO you punch is local, as being run over is (js/pedestrians.js): a hit body
// is released from its slot into this tab's ownership. Shared is the pocket
// (a function of the world seed) and the SIGHT of the swing: onSwing tells
// js/netcity.js, which sends the move to the room so the other players see
// your punches, and `stance` rides in the state blob so they see your guard.
//
// SOUND (js/audio.js sfxAt, the game's volume): fight_swing_*, fight_punch_*,
// fight_punch_heavy, fight_block, fight_grunt_m_* / _f_*, made with ElevenLabs
// by scripts/gen-fight-audio.mjs. A name with no file is one 404 and silence.
// ==========================================================================

import { pocketOf } from './pocket.js';
import { MOVES, nextMove, reactionFor, inWindow, STANCE_T, playerTakes } from './fightmoves.js';
import { FightPeds } from './fightpeds.js';
import { poseFighter, HURT_T } from './fightpose.js';
import { fightSfx } from './fightsfx.js';

// ---- the swing ----------------------------------------------------------
const BUFFER_T = 0.3;       // a press this long before the swing may be cut is
                            // remembered: mashing the button still combos
const REPEAT_GAP = 0.12;    // extra rest between HELD swings
const MAX_DT = 0.25;        // vitals.js's clamp, for vitals.js's reason
const STUN_T = 0.3;         // a punch in the face: no swing starts for this long

// ---- reach ----------------------------------------------------------------
const ARC_COS = 0.64;                    // cos 50 degrees
// Feet to feet: a kerb is 0.15 m and a storey 3 m, so this separates a walker
// below a bridge deck from one you can reach. A body with no mesh skips it.
const MAX_DY = 1.4;

// what the wallet's ticker says (Czech: it reaches the player's eyes)
const LOOT_LABEL = 'kapsa';

// The crime keys, spelled without diacritics ON PURPOSE: keys crossing into
// the wanted rules, not display text.
const CRIME_FIGHT = 'rvacka';
const CRIME_KILL = 'zabiti';

const NO_CTX = Object.freeze({});

export class Combat {
  /**
   * Every field is optional and may be null:
   *   peds     js/pedestrians.js: nearest(), hurt(), and the fight's handover
   *            (takeOver, handBack, corpse) for js/fightpeds.js
   *   targets  every source a fist can find somebody in, each with nearest()
   *            and hurt(), optionally react(p, rx, move); defaults to [peds]
   *   chatter  held, never called: the reaction path is hurt() -> onPedHit
   *   wallet   earn() is all we use
   *   audio    sfxAt() is all we use
   *   vitals   damage(n, cause) when somebody hits the player back
   *   fx       blood(x, y, z, dx, dz, k): drops in the air (js/fightfx.js)
   *   hud      foe(p, now): the health bar over whoever you hit (js/fighthud.js)
   */
  constructor({ peds, targets, chatter, wallet, audio, vitals, fx, hud } = {}) {
    this.peds = peds ?? null;
    this.targets = (Array.isArray(targets) && targets.length ? targets : [this.peds]).filter((t) => t);
    this.chatter = chatter ?? null;
    this.wallet = wallet ?? null;
    this.audio = audio ?? null;
    this.vitals = vitals ?? null;
    this.fx = fx ?? null;
    this.hud = hud ?? null;
    this.sfx = fightSfx(this.audio);
    // the crowd's half of every fight: reactions, knock-downs, brawlers
    this.crowd = new FightPeds({ peds: this.peds, combat: this, sfx: this.sfx, fx: this.fx, hud: this.hud });

    /** True from the moment a swing starts until it has recovered. */
    this.busy = false;

    this._now = 0;
    this._move = null;       // the move this swing is
    this._t0 = 0;            // when it started
    this._chainAt = 0;       // a buffered press may cut it from here
    this._endAt = 0;
    this._repeatAt = 0;
    this._live = false;
    this._landed = false;
    this._queued = null;     // 'light' | 'heavy' buffered
    this._queueAt = 0;
    this._step = 0;          // where in the light chain the next press is
    this._lastEnd = -Infinity;

    this._stanceUntil = 0;   // the fists are up until then
    this._blocking = false;
    this._hurtAt = -Infinity;
    this._hurtRole = 'hitHead';

    this._player = null;
    this._ready = false;
    this._camYaw = 0;
    this._hasYaw = false;
    this._lockedAim = false;
    this._speed = 0;

    this._crimeFns = [];
    this._swingFns = [];

    // ONE blow record for the life of the process; hurt() must READ it, never
    // keep it (the next punch rewrites it in place).
    this._blow = { dmg: 0, launch: false, ko: false, down: false, vx: 0, vz: 0, vy: 0, spin: 0,
      cause: 'pěst', move: '', by: 'fist', blood: 0 };
    this._want = (p) => this._inArc(p);
    this._pose = () => this._poseStep();
    this._sx = 0; this._sz = 0; this._sy = 0;
    this._dx = 0; this._dz = -1;
    this._reach2 = 0;
    this._poseFrom = null;
    this._body = null;       // the citizen record whose poses we drive
  }

  /** True while the fists are up (shared with the room: js/netcity.js). */
  get stance() { return this._ready && (this._now < this._stanceUntil || this._blocking || this._live); }
  /** The move being thrown right now ('jab' | 'cross' | 'hook'), or null. */
  get move() { return this._live ? this._move.key : null; }
  /** The module's own clock, seconds (js/fightpeds.js runs on it). */
  get now() { return this._now; }

  // ---------------------------------------------------------------- frame ----

  /**
   * One physics step. ctx = { player, onFoot, camYaw, input, block, down }.
   * MUST be called every step, on foot or not: it is the only thing that
   * advances the clock and what cancels a swing the moment the player can no
   * longer throw one.
   */
  update(dt, ctx) {
    const c = ctx || NO_CTX;
    const step = Number.isFinite(dt) && dt > 0 ? (dt > MAX_DT ? MAX_DT : dt) : 0;
    this._now += step;

    const player = c.player ?? null;
    if (Number.isFinite(c.camYaw)) { this._camYaw = c.camYaw; this._hasYaw = true; }
    if (player !== this._player) {
      this._cancel();
      this._stanceUntil = 0;
      this._player = player;
      this._poseFrom = null;
      this._body = null;
    }

    const onFoot = c.onFoot !== undefined ? !!c.onFoot : !!player && !player.inCar;
    this._ready = this._able(player, onFoot) && !c.down;
    this._speed = Number.isFinite(player?.speed) ? player.speed : 0;
    this._blocking = this._ready && !!c.block && !this._live;
    if (!this._ready) {
      this._cancel();
      this._queued = null;
      this._stanceUntil = 0;
      this.crowd.update(step, this._now, player, false);
      return;
    }

    if (this._blocking) this._stanceUntil = Math.max(this._stanceUntil, this._now + STANCE_T);
    // Shift is the sprint: wanting to run drops the guard, so a fleeing man can
    // still be chased
    const keys = c.input?.keys;
    if (!this._live && keys && (keys.has?.('ShiftLeft') || keys.has?.('ShiftRight'))) this._stanceUntil = 0;

    if (this._live) {
      const t = this._now - this._t0;
      if (!this._landed && inWindow(this._move, t)) this._resolve(player);
      if (this._now >= this._endAt) this._end(player);
    }

    // a buffered press: as soon as the swing may be cut, or right away if none
    if (this._queued && this._now > this._queueAt) this._queued = null;
    if (this._queued && (!this._live || this._now >= this._chainAt) && this._now >= this._hurtAt + STUN_T) {
      const kind = this._queued;
      this._queued = null;
      // cutting a swing short is the rhythm itself: it ends here, so the next
      // move continues the chain instead of reading as a cold start
      if (this._live) this._end(player);
      this._begin(player, kind);
    } else if (!this._live && c.input && c.input.attackHeld && this._now >= this._repeatAt && this._now >= this._hurtAt + STUN_T) {
      this._begin(player, 'light');
    }

    // the stance: aim and pose hooked while the fists are up
    if (this.stance || this._now < this._hurtAt + HURT_T) this._hook(player);
    else this._unhook(player);

    this.crowd.update(step, this._now, player, true);
  }

  /**
   * Throw one attack: 'light' (left click) or 'heavy' (Q, the hook). Returns
   * true when a swing started on the spot. A press during a swing is buffered
   * and starts the next punch as soon as this one may be cut; a press before
   * update() has ever run is buffered too (the first press of the session is
   * not eaten by the boot frame). A press the player demonstrably cannot throw
   * (at the wheel, mid-door, dead) is refused and remembered by nobody.
   */
  strike(kind = 'light') {
    const k = kind === 'heavy' ? 'heavy' : 'light';
    if (this._live) {
      // a press right at the start of a swing is a double-tap, not a combo
      if (this._now - this._t0 > 0.06) this._queue(k);
      return false;
    }
    if (!this._player) { this._queue(k); return false; }
    if (!this._ready || this._blocking) return false;
    if (this._now < this._hurtAt + STUN_T) { this._queue(k); return false; }
    this._begin(this._player, k);
    return true;
  }

  _queue(k) { this._queued = k; this._queueAt = this._now + BUFFER_T; }

  /** fn(kind, x, z, victim): 'rvacka' on a landed blow, 'zabiti' when one
   *  kills. Exactly one crime per blow: the kill supersedes the fight. */
  onCrime(fn) {
    if (typeof fn === 'function' && this._crimeFns.indexOf(fn) < 0) this._crimeFns.push(fn);
  }

  /** fn(moveKey): every swing the player starts (js/netcity.js shows it to the room). */
  onSwing(fn) {
    if (typeof fn === 'function' && this._swingFns.indexOf(fn) < 0) this._swingFns.push(fn);
  }

  /** New game or a hard reset: drops the swing, the stance and the fights,
   *  KEEPS the listeners (main.js subscribes once at boot). */
  reset() {
    this._cancel();
    this._queued = null;
    this._queueAt = 0;
    this._repeatAt = 0;
    this._step = 0;
    this._lastEnd = -Infinity;
    this._stanceUntil = 0;
    this._hurtAt = -Infinity;
    this.crowd.reset();
  }

  /**
   * A punch thrown AT the player (a pedestrian fighting back). Returns
   * { dmg, blocked } or null when the player cannot be hit by a fist right
   * now. A block facing the punch takes most of it.
   */
  takeHit(dmg, ax, az, heavy = false) {
    const pl = this._player;
    if (!pl || !this._ready || !pl.pos) return null;
    const fx = -Math.sin(pl.heading || 0), fz = -Math.cos(pl.heading || 0);
    const dx = ax - pl.pos.x, dz = az - pl.pos.z, d = Math.hypot(dx, dz) || 1;
    const r = playerTakes(dmg, this._blocking, (fx * dx + fz * dz) / d);
    if (r.dmg > 0) this.vitals?.damage?.(r.dmg, 'pěst');
    this._stanceUntil = Math.max(this._stanceUntil, this._now + STANCE_T);
    if (r.blocked) {
      this.sfx.block(pl.pos.x, pl.pos.z);
    } else {
      this._hurtAt = this._now;
      this._hurtRole = heavy ? 'hitChest' : 'hitHead';
      // a punch in the face stops one that has not landed yet
      if (this._live && !this._landed) this._cancel();
      this.sfx.punch(heavy, pl.pos.x, pl.pos.z);
      this.sfx.grunt(true, pl.pos.x, pl.pos.z, 0.7);
      const y = (Number.isFinite(pl.y) ? pl.y : 0) + 1.5;
      this.fx?.blood?.(pl.pos.x, y, pl.pos.z, -dx / d, -dz / d, heavy ? 1 : 0.5);
    }
    return r;
  }

  // ---------------------------------------------------------------- swing ----

  _able(player, onFoot) {
    if (!player || !onFoot) return false;
    if (player.inCar || player.boarding || player.exiting) return false;
    return !!player.pos;
  }

  _begin(player, kind) {
    const { move, step } = nextMove(kind, this._step, this._now - this._lastEnd);
    this._step = step;
    this._move = move;
    this._live = true;
    this.busy = true;
    this._landed = false;
    this._t0 = this._now;
    this._chainAt = this._now + move.chain / move.speed;
    this._endAt = this._now + move.end / move.speed;
    this._repeatAt = this._endAt + REPEAT_GAP;
    this._stanceUntil = Math.max(this._stanceUntil, this._endAt + STANCE_T);
    // turn into it: the heading is written outright as well as aimLock, so a
    // punch goes where the camera points even on a frame before aimLock lands
    if (this._hasYaw) player.heading = this._camYaw;
    this._hook(player);
    this.sfx.swing(move.key === 'hook', player.pos.x, player.pos.z);
    for (let i = 0; i < this._swingFns.length; i++) {
      try { this._swingFns[i](move.key); } catch (e) { console.warn('[combat] onSwing:', e); }
    }
  }

  // The swing is over. The pose is applied one last time at its end before the
  // stance takes over, so a lofted figure's arm comes home.
  _end(player) {
    this._poseStep();
    this._live = false;
    this.busy = false;
    this._lastEnd = this._now;
  }

  // Cheap on the common path. A cancelled swing still gets its closing pose:
  // the cases that reach here are death and boarding, and an arm left splayed
  // by an interrupted punch would stay splayed. The buffered press is NOT
  // touched: that is intent, and update() is the one place intent is dropped.
  _cancel() {
    if (!this._live && !this._lockedAim) return;
    if (this._live) { this._endAt = this._now; this._poseStep(); this._live = false; this._lastEnd = this._now; this._landed = true; }
    this.busy = false;
    this._unhook(this._player);
  }

  // ----------------------------------------------------------------- pose ----

  // js/player.js keeps its citizen on `_cit`; a test may hand the poses on the
  // player itself. Resolved once per player object.
  _hook(player) {
    if (!player) return;
    if (this._poseFrom !== player) {
      this._poseFrom = player;
      this._body = typeof player.punchPose === 'function' || typeof player.act === 'function'
        ? player
        : (player._cit ?? player.cit ?? player.citizen ?? null);
    }
    player.combatPose = this._pose;
    player.aimLock = true;
    this._lockedAim = true;
  }

  _unhook(player) {
    if (player && player.combatPose === this._pose) player.combatPose = null;
    if (this._lockedAim) {
      this._lockedAim = false;
      if (player) player.aimLock = false;
    }
  }

  // Called by js/player.js AFTER the walk wrote the whole skeleton.
  _poseStep() { poseFighter(this); }

  // ------------------------------------------------------------- the blow ----

  // Find one victim and put them through the door. Called on every step the
  // window is open for until it finds somebody.
  _resolve(player) {
    const move = this._move;
    this._sx = player.pos.x;
    this._sz = player.pos.z;
    this._sy = Number.isFinite(player.y) ? player.y : 0;
    // dir(yaw) = (-sin yaw, -cos yaw), ARCHITECTURE.md's convention; the live
    // camYaw, so the arc tracks the camera exactly as aimLock tracks the body
    const yaw = this._hasYaw ? this._camYaw : (player.heading || 0);
    this._dx = -Math.sin(yaw);
    this._dz = -Math.cos(yaw);
    this._reach2 = move.reach * move.reach;

    let best = null, bsrc = null, bd = Infinity;
    for (let i = 0; i < this.targets.length; i++) {
      const src = this.targets[i];
      if (!src || typeof src.nearest !== 'function' || typeof src.hurt !== 'function') continue;
      const p = src.nearest(this._sx, this._sz, move.reach, this._want);
      if (!p) continue;
      const d = (p.x - this._sx) ** 2 + (p.z - this._sz) ** 2;
      if (d < bd) { bd = d; best = p; bsrc = src; }
    }
    if (!best) return;                        // nobody yet; the window is still open

    this._landed = true;
    const p = best;
    const hp0 = Number.isFinite(p.hp) ? p.hp : 100;
    const rx = reactionFor(move, hp0);
    // a modelled body falls from a recording; the old figure is thrown
    const human = typeof p.cit?.act === 'function' && (p.cit.actDur?.('hitBack') ?? 0) > 0;
    const b = this._blow;
    b.dmg = move.dmg;
    b.move = move.key;
    b.blood = move.blood;
    b.ko = human;
    b.down = rx !== 'flinch';
    b.launch = !human && rx !== 'flinch';
    const push = b.launch ? 5.6 : 1.2;
    b.vx = this._dx * push;
    b.vz = this._dz * push;
    b.vy = b.launch ? 3.0 : 0;
    b.spin = b.launch ? 4.5 : 0;
    b.cause = 'pěst';
    b.by = 'fist';

    const wasDead = p.dead === true;
    const x = p.x, z = p.z;                   // read BEFORE hurt() moves them
    bsrc.hurt(p, b);
    const killed = !wasDead && (p.dead === true || !(p.hp > 0));

    this.sfx.punch(move.key === 'hook', x, z);
    this.sfx.grunt(!(typeof p.arch === 'string' && p.arch[0] === 'f'), x, z, killed ? 1 : 0.8);
    const gy = Number.isFinite(p.mesh?.position?.y) ? p.mesh.position.y : this._sy;
    this.fx?.blood?.(x, gy + (move.key === 'hook' ? 1.15 : 1.5), z, this._dx, this._dz, move.blood > 0 ? 1 : 0.5);
    this.hud?.foe?.(p, this._now);

    // the pocket, once, stamped on the body (a Set would pin every corpse)
    if (killed && !p._robbed) {
      p._robbed = 1;
      const kc = pocketOf(p.pid);
      if (kc > 0) this.wallet?.earn?.(kc, LOOT_LABEL);
    }
    this._crime(killed ? CRIME_KILL : CRIME_FIGHT, x, z, p);

    // what the body does about it: the crowd's own, or the source's
    if (bsrc === this.peds) this.crowd.react(p, killed ? 'dead' : rx, move, this._sx, this._sz);
    else bsrc.react?.(p, killed ? 'dead' : rx, move);
  }

  // The `want` predicate: "nearest" means "nearest one I can actually hit".
  // Testing the arc AFTERWARDS would let one pedestrian behind the player
  // shield everybody in front of them.
  _inArc(p) {
    if (!p || p.dead) return false;
    // 'held' is the mugging grip, 'brawl' somebody fighting you; the rest are
    // on the ground or in the air
    const st = p.state;
    if (st !== 'walk' && st !== 'held' && st !== 'brawl') return false;
    const dx = p.x - this._sx, dz = p.z - this._sz;
    const d2 = dx * dx + dz * dz;
    if (!(d2 <= this._reach2)) return false;  // !(<=) also refuses a NaN position
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      if ((dx * this._dx + dz * this._dz) / d < ARC_COS) return false;
    }
    const my = p.mesh?.position?.y;
    if (Number.isFinite(my) && Math.abs(my - this._sy) > MAX_DY) return false;
    return true;
  }

  // -------------------------------------------------------------- crimes ----

  _crime(kind, x, z, victim) {
    const list = this._crimeFns;
    for (let i = 0; i < list.length; i++) {
      // a listener that throws must not take the fist with it (js/vitals.js:
      // one TypeError inside stepGame froze the game on its last frame)
      try { list[i](kind, x, z, victim); } catch (e) { console.warn('[combat] onCrime:', e); }
    }
  }
}

export { MOVES, pocketOf };
export default Combat;
