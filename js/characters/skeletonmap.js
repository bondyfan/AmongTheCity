// ---- skeletonmap.js: which bone of a downloaded rig is the thigh ------------
//
// Every free character bank names its bones its own way: Unreal style
// (`thigh_l`), Mixamo (`mixamorigLeftUpLeg`), 3ds Max Biped (`Bip01 L Thigh`),
// VRM (`leftUpperLeg`). The game only ever asks for twenty-odd SLOTS, and this
// file finds them by name, so the rest of js/characters/ never sees a bone
// name. Pure: no three, no DOM.

/** The slots, in the order every per-slot array in js/characters/ uses. */
export const SLOTS = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'lowerArmL', 'handL',
  'clavicleR', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'toesL',
  'upperLegR', 'lowerLegR', 'footR', 'toesR',
];
export const SLOT = Object.fromEntries(SLOTS.map((s, i) => [s, i]));
export const SLOT_COUNT = SLOTS.length;

// helper bones that carry a limb's name without being the limb
const NOISE = /twist|roll|(^|[ _.\-])ik([ _.\-]|$)|pole|nub|end$|_end|helper|socket|attach|weapon|prop|corrective|adjust/;

// core names (side and digits stripped) per sided slot, best first
const SIDED = {
  clavicle: ['clavicle', 'shoulder', 'collar'],
  upperArm: ['upperarm', 'arm', 'uparm'],
  lowerArm: ['lowerarm', 'forearm'],
  hand: ['hand', 'wrist'],
  upperLeg: ['thigh', 'upleg', 'upperleg'],
  lowerLeg: ['calf', 'leg', 'lowerleg', 'shin'],
  foot: ['foot', 'ankle'],
  toes: ['ball', 'toebase', 'toe', 'toes'],
};

/** { core, side } of one bone name: 'mixamorig:LeftUpLeg' -> { core: 'upleg', side: 'L' }. */
export function parseBoneName(name) {
  let s = String(name).replace(/^(mixamorig\d*[:_]?|bip\d+[ _]?|valvebiped[._]?|def[-_]|j_bip_|b_)/i, '');
  let side = '';
  // camelCase and separators become spaces, so a lone L or R is a token
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._\-:]+/g, ' ').trim();
  const tok = spaced.split(/\s+/);
  const keep = [];
  for (const t of tok) {
    const l = t.toLowerCase();
    if (l === 'l' || l === 'left') side = side || 'L';
    else if (l === 'r' || l === 'right') side = side || 'R';
    else keep.push(l);
  }
  let core = keep.join('');
  if (!side) {
    const m = /^(left|right)(.+)$/.exec(core);
    if (m) { side = m[1] === 'left' ? 'L' : 'R'; core = m[2]; }
  }
  return { core, side, bare: core.replace(/\d+$/, '') };
}

/**
 * bones: [{ name, parent }] with parent an index into the same list (or -1).
 * Returns { slot: boneIndex } for every slot that was found. A rig is usable
 * when `missing(map)` is empty.
 */
export function mapBones(bones) {
  const depth = bones.map(() => 0);
  const d = (i) => { let n = 0; for (let p = bones[i].parent; p >= 0; p = bones[p].parent) n++; return n; };
  for (let i = 0; i < bones.length; i++) depth[i] = d(i);
  const parsed = bones.map((b) => parseBoneName(b.name));
  const out = {};
  const best = (ok) => {
    let at = -1;
    for (let i = 0; i < bones.length; i++) {
      if (NOISE.test(bones[i].name.toLowerCase())) continue;
      if (ok(parsed[i], i) && (at < 0 || depth[i] < depth[at])) at = i;
    }
    return at;
  };
  const put = (slot, i) => { if (i >= 0) out[slot] = i; };

  put('hips', best((p) => !p.side && (p.bare === 'hips' || p.bare === 'pelvis' || p.bare === 'hip')));
  put('head', best((p) => !p.side && p.bare === 'head'));
  put('neck', best((p) => !p.side && p.bare === 'neck'));
  // the spine is a chain: the lowest link bends at the hip, the highest
  // carries the shoulders. A rig with one link gives that one to the chest.
  const chain = [];
  for (let i = 0; i < bones.length; i++) {
    const p = parsed[i];
    if (p.side || NOISE.test(bones[i].name.toLowerCase())) continue;
    if (p.bare === 'spine' || p.bare === 'chest' || p.bare === 'upperchest' || p.bare === 'abdomen' || p.bare === 'torso') chain.push(i);
  }
  chain.sort((a, b) => depth[a] - depth[b]);
  if (chain.length === 1) put('chest', chain[0]);
  else if (chain.length > 1) { put('spine', chain[0]); put('chest', chain[chain.length - 1]); }

  for (const side of ['L', 'R']) {
    for (const key in SIDED) {
      const names = SIDED[key];
      let at = -1;
      for (const n of names) {
        at = best((p) => p.side === side && p.bare === n);
        if (at >= 0) break;
      }
      put(key + side, at);
    }
    // Mixamo calls the collar "Shoulder" and the upper arm "Arm": when both
    // slots landed on one bone the collar is the parent, the arm its child
    const cl = out['clavicle' + side], ua = out['upperArm' + side];
    if (cl != null && ua != null && cl === ua) delete out['clavicle' + side];
  }
  return out;
}

/** The slots a body cannot be animated without and `map` lacks. */
export function missing(map) {
  const need = ['hips', 'chest', 'head', 'upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR',
    'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR'];
  return need.filter((s) => map[s] == null);
}
