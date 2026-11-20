import * as THREE from 'three';

// The balaclava Vašek pushed across the table: a black knitted hood on the
// player's head with a slot for the eyes. It hangs on the head socket of a
// modelled human (js/characters/human.js `headS`: the drawn skull, in the
// game's joint frame, face to −z) or on the head joint of the old box person,
// and is put back on when the body is rebuilt (player.reskin).
export function balaclava(player) {
  const wool = new THREE.MeshLambertMaterial({ color: 0x0c0c0e }),
    skin = new THREE.MeshLambertMaterial({ color: 0xc99a7c });
  const hood = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), wool),
    neck = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.8, 1, 14), wool),
    slot = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.26, 0.2), skin);
  const group = new THREE.Group();
  group.add(hood, neck, slot);
  let worn = false,
    owner = null;
  function fit(cit) {
    owner = cit;
    group.removeFromParent();
    const human = !!cit.parts.headS,
      k = (cit.headTop ?? 1.78) / 1.78,
      r = 0.138 * k,
      up = human ? 0.088 * k : cit.eye.y - 0.012 * k; // the middle of the skull above the joint
    (cit.parts.headS ?? cit.parts.head).add(group);
    group.position.set(0, up, human ? -0.012 * k : 0);
    hood.scale.set(r, r * 1.2, r * 1.1);
    neck.scale.setScalar(r);
    neck.position.set(0, -r * 1.05, r * 0.08);
    slot.scale.setScalar(r);
    slot.position.set(0, (human ? 0.03 : 0.012) * k, -r * 0.98);
  }
  return {
    get on() {
      return worn;
    },
    set(next) {
      worn = !!next;
    },
    // every frame: the body may have been rebuilt since the hood went on
    update() {
      const cit = player._cit;
      if (cit && cit !== owner) fit(cit);
      group.visible = worn;
    },
    dispose() {
      group.removeFromParent();
      for (const m of [hood, neck, slot]) m.geometry.dispose();
      wool.dispose();
      skin.dispose();
    },
  };
}
