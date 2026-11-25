// ---- fightpose.js: the player's fists, drawn ------------------------------
//
// player.combatPose is called by js/player.js at the very END of its update,
// after the walk wrote the skeleton (the header of js/player.js says why that
// ordering is the hook). A modelled body (js/characters/human.js) takes the
// recording through act() and closes its fists through fist(); the old lofted
// figure (no people bank) still gets citizen.js's punchPose, so a build
// without the bank fights, just less handsomely.
//
// Split out of js/combat.js (Nov 2026): this file reads the swing state of a
// Combat (its clock, the move and when it started, the block, the flinch) and
// puts the matching recording on the body. It writes nothing back.

import { movePose } from './fightmoves.js';

/** The player's own flinch when a punch lands, seconds. */
export const HURT_T = 0.42;
const _pose = {};

/** Put the swing, the guard, the block or the flinch of Combat `c` on its body. */
export function poseFighter(c) {
  const b = c._body;
  if (!b) return;
  const now = c._now;
  // standing still the guard takes the recording's legs too; walking, the arms
  const legs = c._speed < 0.25 ? 1 : c._speed > 1.2 ? 0 : 1 - (c._speed - 0.25) / 0.95;
  if (typeof b.act === 'function') {
    b.fist?.(1);
    const hurt = now - c._hurtAt;
    if (hurt < HURT_T && b.act(c._hurtRole, hurt * 1.1, 1, 'upper') > 0) return;
    if (c._live) {
      movePose(c._move, now - c._t0, _pose);
      // the hook steps in: it is the whole body's while standing
      b.act(_pose.role, _pose.t, 1, c._move.key === 'hook' ? Math.max(0.6, legs) : legs);
      return;
    }
    if (c._blocking) { b.act('fightHook', 0, 1, legs, 0.1); return; }
    b.act('fightJab', 0, 1, legs, 0.15);
    return;
  }
  // the lofted figure: citizen.js's additive arm poses
  if (c._live && typeof b.punchPose === 'function') {
    const span = c._endAt - c._t0;
    const t01 = span > 0 ? Math.min(1, (now - c._t0) / span) : 1;
    b.punchPose(t01, c._move.hand === 'L' ? 0 : 1);
  }
}
