// ---- lookab.js: the round-11 LOOK switches, for an A/B on a live page -------
// One shared object, read every frame by the modules that changed, so the old
// picture and the new one (and the old post stack and the new one) can be put
// side by side in the same tab, at the same spot, the same minute, with no
// reload and no recompile. Every switch is `true` for the new behaviour and
// that is what ships; nothing in the game ever writes to it.
//
// From the console (the same object hangs off both, whichever is to hand):
//   const ab = __atc.sky.ab;          // or __atc.postfx.ab once post is up
//   ab.light = false;   // sky.js: the old sun/fill pair, grey fill, paler sky
//   ab.air   = false;   // sky.js: haze in one colour (no aerial perspective)
//   ab.curve = false;   // postfx.js: the old tone curve (post path only; the
//                       //   direct path of the low preset bakes it at compile)
//   ab.grade = false;   // postfx.js gradeFor: the old two-look grade
//   // the OLD post stack, pass for pass (dev/postfx-legacy.js):
//   await (await import('/dev/postfx-legacy.js')).install();   // ab.post = false
//   ab.post = true;     // back to the new one (the legacy one stays built)
// and every switch back to true is the shipped frame again.
//
// dev/gputime.js times the two stacks against each other: see its header.

export const LOOK_AB = {
  light: true,
  air: true,
  curve: true,
  grade: true,
  post: true,
  // the legacy PostFX instance, built by dev/postfx-legacy.js install(); main.js
  // draws through it while `post` is false
  legacy: null,
};
