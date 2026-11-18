// ---- scenegraph.js: what three.js walks every frame, and what it may skip ----
//
// MEASURED, November 2026, Václavské náměstí at noon on the medium preset: the
// scene held 29 400 objects and `scene.updateMatrixWorld()`, which
// renderer.render() runs once a frame, took 9.2 ms of a 31 ms frame. It was
// the biggest single item of the frame, larger than the whole shadow pass.
//
// Two things made it walk everything:
//
// 1. The Scene itself had matrixAutoUpdate on. Object3D.updateMatrix() marks
//    its own world matrix dirty every time it runs, so the root recomputed its
//    (identity) matrix every frame and handed `force = true` to every child.
//    Every static matrix in the world was recomputed every frame, including the
//    ones whose owners had carefully frozen them (matrixAutoUpdate = false on
//    every signal mast, every ortho quad, every street lamp).
//
// 2. three walks INVISIBLE subtrees too. About 700 traffic-light junctions of
//    Prague (20 objects each) sit in the scene hidden until the player comes
//    within range, and so do the parked-car, crowd and interior pools. None of
//    them is drawn, all of them were multiplied out.
//
// The policy below fixes both, and nothing else changes: the Scene stays put
// (it is the world origin, nothing ever moves it), and a hidden subtree is
// skipped. When a skipped child would have been forced (its parent moved), it
// is marked dirty instead, so it catches up on the first frame it is shown.
// Nothing is drawn or shadowed while hidden (projectObject and the shadow pass
// both stop at visible === false), and every helper that reads a world matrix
// for game logic (getWorldPosition, localToWorld, worldToLocal) climbs its own
// ancestors with updateWorldMatrix first, so it never reads a stale one.
//
// `freezeStatic(root)` is the third half: a subtree that will never move again
// (a finished chunk) stops recomposing its local matrices from position,
// rotation and scale every frame. Its world matrices are worked out once, on
// the next frame, and then left alone.

import * as THREE from 'three';

let patched = false;

/** Install the policy. Idempotent; call once with the game's scene. */
export function installSceneGraphPolicy(scene) {
  if (!patched) {
    patched = true;
    const proto = THREE.Object3D.prototype;
    // the same body as three r160's Object3D.updateMatrixWorld, plus the
    // hidden-subtree skip. Camera and SkinnedMesh override this method and call
    // super, which resolves to this patched version at call time.
    proto.updateMatrixWorld = function updateMatrixWorld(force) {
      if (this.matrixAutoUpdate) this.updateMatrix();
      if (this.matrixWorldNeedsUpdate || force) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
        this.matrixWorldNeedsUpdate = false;
        force = true;
      }
      const ch = this.children;
      for (let i = 0, l = ch.length; i < l; i++) {
        const c = ch[i];
        // A manually updated child may only get this one forced visit. It
        // cannot consume a deferred update when it becomes visible again.
        if (c.visible === false && c.matrixWorldAutoUpdate) {
          if (force) c.matrixWorldNeedsUpdate = true;
          continue;
        }
        if (c.matrixWorldAutoUpdate === true || force === true) c.updateMatrixWorld(force);
      }
    };
    // A child added under a frozen parent is never forced any more, so it
    // has to ask for its first world matrix itself. (A mesh made with
    // matrixAutoUpdate = false and never updateMatrix()ed used to be rescued
    // by the root's force every frame; now it is rescued once, here.)
    const add = proto.add;
    proto.add = function (...objs) {
      for (let i = 0; i < objs.length; i++) if (objs[i] && objs[i] !== this) objs[i].matrixWorldNeedsUpdate = true;
      return add.apply(this, objs);
    };
  }
  scene.updateMatrix();
  scene.matrixAutoUpdate = false;
  scene.matrixWorldNeedsUpdate = true;
}

/**
 * A subtree that will not move again: compose every local matrix once, stop
 * recomposing it each frame, and have the world matrices worked out on the next
 * frame. Anything added to it later still updates itself (its own
 * matrixAutoUpdate is untouched), and an owner that does move a frozen object
 * calls updateMatrix(), as three expects for matrixAutoUpdate = false.
 * InstancedMesh matrices are per instance and are not touched.
 */
export function freezeStatic(root) {
  if (!root) return root;
  root.traverse((o) => {
    if (o.matrixAutoUpdate) { o.updateMatrix(); o.matrixAutoUpdate = false; }
  });
  root.matrixWorldNeedsUpdate = true;
  return root;
}
