// ==========================================================================
// fightpeds.js: what a punched pedestrian does about it
//
// js/combat.js lands the blow and hands it to pedestrians.js hurt(); this file
// is everything the body does afterwards, as recordings on the modelled people
// (js/characters/human.js act()):
//
//   flinch   the head snaps back (Hit_Head, Hit_Chest) over whatever they are
//            doing. They stay the crowd's: still walking, now running.
//   ko       knocked flat (Hit_Knockback), a few seconds on the tarmac, up
//            again (LayToIdle), then running or back at you. pedestrians.js
//            has handed the body over upright ('ko'): nothing there moves it.
//   corpse   knocked flat and laid out where they fell: pedestrians.js
//            corpse(), the recording held on the last frame.
//   brawl    the one in two men who puts their fists up (fightmoves.js
//            fightsBack): out of the crowd's hands ('brawl'), squaring up to
//            you, closing to arm's length, throwing jabs and crosses that cost
//            you health (combat.takeHit) unless you block. They give up when
//            they are hurt enough to run, when you walk off, or when you are
//            gone (a car, a door, death), and the crowd takes them back.
//
// The bodies of the old lofted figure (no people bank) have no recordings:
// combat.js throws those as ragdolls, as before, and nothing here touches
// them beyond the flinch it cannot draw.
//
// LOCAL, LIKE EVERY HIT. A body that is hit is this tab's (pedestrians.js
// releases it from its slot), so nothing here has to agree with another
// client. Randomness is Math.random for that reason; the one decision that
// is NOT random is who fights back, which is a function of who they are.
//
// THE CROWD MAY TAKE A BODY BACK AT ANY TIME: the sweep drops a ghost nobody
// can see, a car throws a body lying in the road. Every record checks, every
// step, that its body still exists and is still in the state it left it in,
// and lets go otherwise.
// ==========================================================================

import { MOVES, PED_PUNCH, fightsBack, brawlStep, inWindow, movePose } from './fightmoves.js';

const FLINCH_FADE = 0.12;   // s: the snap eases out instead of stopping dead
const KO_FROM = 0.08;       // s into Hit_Knockback: its first frame is a crouch
const SLIDE_T = 0.35;       // s the body is carried back by the blow…
const SLIDE_V = 1.7;        // …starting at this many m/s
const LIE_T = [2.4, 4.0];   // s on the ground before getting up
const BRAWL_WALK = 1.5;     // m/s squaring up
const BRAWL_BACK = 0.9;     // m/s stepping back out of a clinch
const LEASH = 9;            // m from where the fight started: a brawler does not chase you down the street
const AWAY_R = 8;           // m: further than this the player has walked off
const TURN = 9;             // rad/s a brawler turns to face you

const _pose = {};
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const angTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));   // heading that faces (tx, tz)

export class FightPeds {
  constructor({ peds, combat, sfx, fx, hud } = {}) {
    this.peds = peds ?? null;
    this.combat = combat ?? null;
    this.sfx = sfx ?? null;
    this.fx = fx ?? null;
    this.hud = hud ?? null;
    /** The records of every body a fight is doing something to. */
    this.list = [];
    this._now = 0;
  }

  /** How many pedestrians are fighting the player right now. */
  get brawlers() { let n = 0; for (const r of this.list) if (r.mode === 'brawl') n++; return n; }

  reset() {
    for (const r of this.list) this._release(r, false);
    this.list.length = 0;
  }

  _find(p) { for (const r of this.list) if (r.p === p) return r; return null; }

  _rec(p) {
    let r = this._find(p);
    if (!r) {
      r = { p, mode: 'flinch', t0: this._now, hitAt: -Infinity, hitRole: 'hitHead', dead: false,
        sx: 0, sz: 0, ox: p.x, oz: p.z, lieUntil: 0, swing: null, nextPunch: 0, away: 0, fought: 0,
        punches: 0, fighter: fightsBack(p.pid, p.arch) };
      this.list.push(r);
    }
    return r;
  }

  /**
   * A blow landed on p (js/combat.js, after hurt()). rx is 'flinch' | 'down'
   * | 'dead'; (ax, az) is where the punch came from.
   */
  react(p, rx, move, ax, az) {
    if (!p || !p.mesh) return;
    const body = p.cit;
    const can = typeof body?.act === 'function';
    if (!can) return;                          // the lofted figure: thrown or flinched by pedestrians.js
    const r = this._rec(p);
    r.hitAt = this._now;
    r.hitRole = move?.hit ?? 'hitHead';
    if (rx === 'flinch') {
      if (p.state === 'brawl') {
        r.swing = null;                        // a punch in the face stops theirs
        r.nextPunch = Math.max(r.nextPunch, this._now + 0.55);
        return;
      }
      if (p.state === 'walk' && r.mode === 'flinch' && r.fighter && this.peds?.takeOver?.(p, 'brawl')) {
        this._brawl(r);
        p.heading = angTo(p.x, p.z, ax, az);
      }
      return;
    }
    // down or dead: pedestrians.js handed the body over upright ('ko')
    if (p.state !== 'ko') { this._drop(r); return; }
    r.mode = 'fall';
    r.t0 = this._now;
    r.dead = rx === 'dead';
    r.swing = null;
    // face the punch, so the fall goes away from it
    p.heading = angTo(p.x, p.z, ax, az);
    const dx = p.x - ax, dz = p.z - az, d = Math.hypot(dx, dz) || 1;
    r.sx = dx / d; r.sz = dz / d;
  }

  _brawl(r) {
    r.mode = 'brawl';
    r.t0 = this._now;
    r.ox = r.p.x; r.oz = r.p.z;
    r.away = 0; r.fought = 0;
    r.swing = null;
    r.nextPunch = this._now + 0.5 + Math.random() * 0.4;
    r.p.brawl = true;                          // self-defence for the wanted rules
  }

  /**
   * One step. `player` is the player record, `able` false when the player
   * cannot be fought (in a car, dead): brawlers give up.
   */
  update(dt, now, player, able) {
    this._now = now;
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i], p = r.p;
      // the crowd took the body back (swept, thrown, disposed)
      if (!this._alive(p)) { list.splice(i, 1); continue; }
      let keep = true;
      switch (r.mode) {
        case 'flinch': keep = this._flinch(r); break;
        case 'brawl': keep = this._brawlStep(r, dt, player, able); break;
        case 'fall': keep = this._fall(r, dt); break;
        case 'lie': keep = this._lie(r); break;
        case 'getup': keep = this._getUp(r); break;
        default: keep = false;
      }
      if (!keep) list.splice(i, 1);
    }
  }

  // the recorded snap over whatever the body is doing; true while it runs
  _hitOverlay(r, mask = 'upper') {
    const t = this._now - r.hitAt;
    const body = r.p.cit;
    const dur = body.actDur(r.hitRole);
    if (!(dur > 0) || t >= dur) return false;
    const w = t > dur - FLINCH_FADE ? smooth((dur - t) / FLINCH_FADE) : 1;
    body.act(r.hitRole, t, w, mask);
    return true;
  }

  _flinch(r) {
    if (r.p.state !== 'walk') return false;
    return this._hitOverlay(r);
  }

  _fall(r, dt) {
    const p = r.p, body = p.cit;
    if (p.state !== 'ko') return false;
    const t = this._now - r.t0;
    const dur = body.actDur('hitBack');
    if (t < SLIDE_T) {
      const v = SLIDE_V * (1 - t / SLIDE_T);
      p.x += r.sx * v * dt; p.z += r.sz * v * dt;
    }
    const ct = KO_FROM + t;
    if (ct < dur) { body.act('hitBack', ct, 1, 'full', 0.06); body.fist?.(0); return true; }
    // on the ground
    this.sfx?.fall?.(p.x, p.z);
    const back = 0.72 * (p.mesh.scale?.x || 1);
    const hx = p.x + Math.sin(p.heading) * back, hz = p.z + Math.cos(p.heading) * back;
    if (r.dead) {
      body.act('hitBack', dur, 1, 'full', 0.06, true);      // held: a body laid out stays laid out
      this.peds?.corpse?.(p, hx, hz);
      return false;
    }
    this.peds?.bloodAt?.(hx, hz, 0.4);
    r.mode = 'lie';
    r.lieUntil = this._now + LIE_T[0] + Math.random() * (LIE_T[1] - LIE_T[0]);
    body.act('hitBack', dur, 1, 'full');
    return true;
  }

  _lie(r) {
    const p = r.p, body = p.cit;
    if (p.state !== 'ko') return false;
    body.act('hitBack', body.actDur('hitBack'), 1, 'full');
    if (this._now >= r.lieUntil) { r.mode = 'getup'; r.t0 = this._now; }
    return true;
  }

  _getUp(r) {
    const p = r.p, body = p.cit;
    if (p.state !== 'ko') return false;
    const t = this._now - r.t0, dur = body.actDur('getUp');
    if (t < dur) { body.act('getUp', t, 1, 'full', 0.15); return true; }
    // on their feet: back at you, or away
    if (r.fighter && p.hp > 30 && this.peds?.takeOver?.(p, 'brawl')) { this._brawl(r); return true; }
    this.peds?.handBack?.(p, true);
    return false;
  }

  _brawlStep(r, dt, player, able) {
    const p = r.p, body = p.cit;
    if (p.state !== 'brawl') { p.brawl = false; return false; }
    r.fought += dt;
    const px = player?.pos?.x, pz = player?.pos?.z;
    const gone = !able || !Number.isFinite(px) || !Number.isFinite(pz);
    const dx = gone ? 0 : px - p.x, dz = gone ? 0 : pz - p.z;
    const dist = Math.hypot(dx, dz);
    if (!gone && dist > AWAY_R) r.away += dt; else r.away = 0;
    const ready = !r.swing && this._now >= r.nextPunch;
    const what = brawlStep({ dist, hp: p.hp, ready, away: r.away, fought: r.fought, calm: this._now - r.hitAt, gone });
    if (what === 'quit' || what === 'flee') {
      p.brawl = false;
      this.peds?.handBack?.(p, what === 'flee');
      return false;
    }
    // face the player, quickly but not instantly
    if (!gone) {
      let d = angTo(p.x, p.z, px, pz) - p.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const s = TURN * dt;
      p.heading += Math.abs(d) <= s ? d : Math.sign(d) * s;
    }
    // feet: close in, hold, or step back out of a clinch, on a leash
    let v = 0;
    if (!r.swing) {
      if (what === 'approach') v = BRAWL_WALK;
      else if (what === 'back') v = -BRAWL_BACK;
    }
    if (v !== 0 && dist > 1e-3) {
      const nx = p.x + (dx / dist) * v * dt, nz = p.z + (dz / dist) * v * dt;
      if (Math.hypot(nx - r.ox, nz - r.oz) < LEASH) { p.x = nx; p.z = nz; } else v = 0;
    }
    this.hud?.keep?.(p, this._now);            // their health stays in view while they fight
    p.speed = Math.abs(v);
    p.walkT = (p.walkT ?? 0) + Math.abs(v) * dt * 1.6;
    p.animate(p.walkT, Math.min(1.3, Math.abs(v) / 1.4), 0, Math.abs(v));
    body.fist?.(1);
    const legs = Math.abs(v) > 0.2 ? 0 : 1;

    // their punch
    if (what === 'punch' && !r.swing) {
      const move = (r.punches++ & 1) ? MOVES.cross : MOVES.jab;
      r.swing = { move, t0: this._now, landed: false };
      this.sfx?.swing?.(false, p.x, p.z);
    }
    if (this._hitOverlay(r, legs)) return true;
    if (r.swing) {
      const sw = r.swing, m = sw.move, sp = PED_PUNCH[m.key]?.speed ?? 1;
      const t = (this._now - sw.t0) * sp / m.speed;     // the move's own clock at the ped's speed
      if (!sw.landed && inWindow(m, t)) {
        // does it meet the player? reach and a rough facing
        const fx = -Math.sin(p.heading), fz = -Math.cos(p.heading);
        if (!gone && dist <= PED_PUNCH.reach && (dist < 1e-3 || (fx * dx + fz * dz) / dist >= PED_PUNCH.arcCos)) {
          sw.landed = true;
          this.combat?.takeHit?.(PED_PUNCH[m.key]?.dmg ?? 7, p.x, p.z, false);
        }
      }
      movePose(m, t, _pose);
      if (t * m.speed >= m.end) {
        r.swing = null;
        r.nextPunch = this._now + PED_PUNCH.gap[0] + Math.random() * (PED_PUNCH.gap[1] - PED_PUNCH.gap[0]);
      } else {
        body.act(_pose.role, _pose.t, 1, legs);
        return true;
      }
    }
    body.act('fightJab', 0, 1, legs, 0.15);     // the guard
    return true;
  }

  // still in the crowd's body list: the sweep removes a body from it before
  // it disposes it, and nothing else ever puts one back
  _alive(p) {
    if (!p || !p.mesh) return false;
    const list = this.peds?.peds;
    return Array.isArray(list) ? list.includes(p) : true;
  }

  _drop(r) {
    const i = this.list.indexOf(r);
    if (i >= 0) this.list.splice(i, 1);
  }

  // a reset: everybody the fight holds goes back to the crowd standing
  _release(r) {
    const p = r.p;
    if (!this._alive(p)) return;
    p.brawl = false;
    if (p.state === 'brawl' || (p.state === 'ko' && !p.dead)) { p.cit?.actStop?.(); this.peds?.handBack?.(p, false); }
  }
}
