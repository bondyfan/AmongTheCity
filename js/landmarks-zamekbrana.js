// ---- landmarks-zamekbrana.js: the gate through the rampart ----
// WORKER SAFE. The only way into the chateau: a long narrow gatehouse standing
// IN the eastern rampart where the two foot walls close like a funnel, with a
// vaulted passage its whole length. The bridge from Příhrádek arrives at its
// outer portal a metre and a half lower than the court it leaves you in, so
// the passage climbs, as the real one does.
//
// The tile ends the road at both of its faces (a covered way is not in it):
// the passage, its paving and the solids either side are the model's own.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { vault, paving, portal } from './landmarks-passage.js';

const PLASTER = 0xe9e3d3, STONE = 0xb5a98f, ROOF = 0x9c4c37, PANE = 0x46525e;
const FRONT = [0.92, 0.39];            // the outer portal looks east-south-east, down the bridge
const W = 3.3, H = 4.0, E = 7.0;       // clear width, crown over the floor, wall top

export function buildZamekBrana(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, FRONT[0], FRONT[1]);
  kit.floodFn = (x, y) => 0.85 - 0.35 * Math.min(1, Math.max(0, y) / 9);
  // the floor at the two mouths, and how far the walls must reach down to it
  const yF = kit.rel(...F.xz(0, hv)), yB = kit.rel(...F.xz(0, -hv));
  const lo = Math.min(0, yF, yB) - 0.5;
  const mouth = (y) => ({ cols: 1, rows: [{ y: 0, h: y + H - lo, w: W, arch: 1, open: true },
    { y: Math.max(y + H, 0) + 1.25 - lo, h: 1.2, w: 1.0, hex: PANE, glow: 0.5 }], seed: 5 });
  const side = { cols: 3, inset: 1.2, rows: [{ y: 4.7 - lo, h: 1.2, w: 0.9, hex: PANE, glow: 0.4 }], seed: 6 };
  kit.set(PLASTER, K.plaster);
  F.box(-hu, hu, -hv, hv, lo, E, { f: mouth(yF), b: mouth(yB), l: side, r: side }, false);
  kit.set(0xcfc8b6, K.plaster);
  vault(kit, F, { uc: 0, w: W, h: H, vL0: -hv, vR0: -hv, vL1: hv, vR1: hv, y0: yB, y1: yF });
  kit.set(0x8f8a80, K.stone);
  paving(kit, F, -W / 2, W / 2, -hv, hv);
  portal(kit, F.sub(0, hv, 0, 0), yF, W, H, STONE, true);
  portal(kit, F.sub(0, -hv, 0, Math.PI), yB, W, H, STONE);
  // a cornice and the tiled roof, hipped at both ends
  kit.set(0xd3ccb9, K.plaster);
  F.box(-hu - 0.18, hu + 0.18, -hv - 0.18, hv + 0.18, E - 0.3, E, null, true, true);
  kit.set(ROOF, K.tile);
  F.roof(-hu, hu, -hv, hv, E, E + 3.3, { alongV: true, hip0: 2.4, hip1: 2.4, over: 0.45 });
}

/** The two walls beside the passage, and the house over it. */
export function zamekBranaSolids(f, l) {
  const { F, hu, hv } = fitFrame(null, f.o, FRONT[0], FRONT[1]);
  const piece = (u0, u1, bot) => ({ ring: F.ring(u0, u1, -hv, hv), holes: null, top: l.top, bot });
  return [piece(-hu, -W / 2, 0), piece(W / 2, hu, 0), piece(-W / 2, W / 2, H)];
}

/** The passage's own axis, back mouth to front mouth, for whoever walks it (js/landmarks-walks.js). */
export function zamekBranaAxis(f) {
  const { F, hv } = fitFrame(null, f.o, FRONT[0], FRONT[1]);
  return [F.xz(0, -hv), F.xz(0, hv)];
}
