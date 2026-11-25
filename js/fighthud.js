// ---- fighthud.js: the health of whoever you are fighting ------------------
//
// Frank, 25 Nov 2026: "A vidět životy, když jakoby bouchám do jiného člověka."
// A slim bar floats over the head of somebody you hit, or somebody hitting
// you, the moment it happens, follows them while the fight lasts and fades
// out SHOW_T seconds after the last blow. The player's own bar
// (js/statusbar.js, #vitals) is made bigger and brighter while the fists are
// up, so in a fight both numbers that matter are where the eye already is.
//
// DOM, not three.js: a few absolutely positioned divs moved with a transform
// once a frame, and only while one is showing. At most MAX bars; a new foe
// takes the oldest one's. Health is read straight off the body (p.hp of 100,
// js/pedestrians.js PED_HP), so the bar can never disagree with the door.

const MAX = 3;
const SHOW_T = 4;          // s after the last blow
const FADE_T = 0.6;        // …then it fades over this long
const FAR = 45;            // m: past this nobody reads a bar
const HP_MAX = 100;

const CSS = `
#fight-hp { position: fixed; inset: 0; pointer-events: none; z-index: 30; }
#fight-hp .fh { position: absolute; left: 0; top: 0; width: 64px; height: 7px; margin: -3px 0 0 -32px;
  border-radius: 2px; background: rgba(8,10,14,0.62); box-shadow: 0 0 0 1px rgba(255,255,255,0.28), 0 1px 4px rgba(0,0,0,0.6);
  overflow: hidden; opacity: 0; transition: opacity 0.12s linear; will-change: transform, opacity; }
#fight-hp .fh > i { display: block; height: 100%; width: 100%; transform-origin: 0 50%;
  background: linear-gradient(180deg, #ff6b5c, #c23a2e); box-shadow: inset -1px 0 0 rgba(255,255,255,0.7); }
#fight-hp .fh.ok > i { background: linear-gradient(180deg, #8fe07a, #4f9a3f); }
#fight-hp .fh.mid > i { background: linear-gradient(180deg, #f2cf5b, #b8902a); }
#vitals.fight .vt-hp { height: 15px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.55), 0 0 10px rgba(255,90,70,0.45); }
`;

export class FightHud {
  /** doc: the document (null in a headless test: everything becomes a no-op). */
  constructor(doc = (typeof document !== 'undefined' ? document : null)) {
    this.doc = doc;
    this.bars = [];          // { el, fill, p, at, shown }
    this._vitals = null;
    this._fight = false;
    this._v = { x: 0, y: 0, z: 0 };
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);
    this.root = doc.createElement('div');
    this.root.id = 'fight-hp';
    doc.body.appendChild(this.root);
    for (let i = 0; i < MAX; i++) {
      const el = doc.createElement('div'); el.className = 'fh';
      const fill = doc.createElement('i'); el.appendChild(fill);
      this.root.appendChild(el);
      this.bars.push({ el, fill, p: null, at: -Infinity, shown: -1, hp: -1, op: -1 });
    }
  }

  /** Somebody was just hit (or is hitting you): show their bar. */
  foe(p, now) {
    if (!p || !this.bars.length) return;
    let b = this.bars.find((x) => x.p === p);
    if (!b) b = this.bars.reduce((o, x) => (x.at < o.at ? x : o), this.bars[0]);
    b.p = p; b.at = now;
  }

  /** Keep a bar up without a new blow (a brawler squaring up to you). */
  keep(p, now) { const b = this.bars.find((x) => x.p === p); if (b) b.at = now; else this.foe(p, now); }

  /**
   * Once a rendered frame. camera: the three.js camera (its matrices current);
   * now: the fight's clock; fight: true while the player's fists are up.
   */
  update(camera, now, fight = false) {
    if (!this.doc) return;
    if (fight !== this._fight) {
      this._fight = fight;
      this._vitals ??= this.doc.getElementById('vitals');
      this._vitals?.classList.toggle('fight', fight);
    }
    if (!camera) return;
    const W = this.doc.documentElement.clientWidth || 1, H = this.doc.documentElement.clientHeight || 1;
    for (const b of this.bars) {
      const p = b.p;
      let op = 0;
      if (p && p.mesh && p.mesh.parent) {
        const age = now - b.at;
        op = age < SHOW_T ? 1 : age < SHOW_T + FADE_T ? 1 - (age - SHOW_T) / FADE_T : 0;
        if (p.dead && age > 1.2) op = Math.min(op, Math.max(0, 1 - (age - 1.2) / FADE_T));
      }
      if (op <= 0) { if (b.op !== 0) { b.el.style.opacity = '0'; b.op = 0; } if (b.p && now - b.at > SHOW_T + FADE_T) b.p = null; continue; }
      // over the head: feet + the body's own height, a hand above it
      const m = p.mesh.position, k = p.mesh.scale?.y || 1;
      const lying = p.state === 'ko' || p.state === 'dead';
      const v = this._v;
      v.x = m.x; v.y = m.y + (lying ? 0.7 : (p.headTop ?? 1.75) * k + 0.2); v.z = m.z;
      // project: world to clip by hand, so no Vector3 is made a frame
      const e = camera.matrixWorldInverse.elements, q = camera.projectionMatrix.elements;
      const cx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
      const cy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
      const cz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
      if (cz > -0.2 || -cz > FAR) { if (b.op !== 0) { b.el.style.opacity = '0'; b.op = 0; } continue; }
      const px = q[0] * cx + q[4] * cy + q[8] * cz + q[12];
      const py = q[1] * cx + q[5] * cy + q[9] * cz + q[13];
      const pw = q[3] * cx + q[7] * cy + q[11] * cz + q[15];
      const sx = (px / pw * 0.5 + 0.5) * W, sy = (0.5 - py / pw * 0.5) * H;
      b.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const hp = Math.max(0, Math.min(HP_MAX, Number.isFinite(p.hp) ? p.hp : HP_MAX));
      if (hp !== b.hp) {
        b.hp = hp;
        b.fill.style.transform = `scaleX(${(hp / HP_MAX).toFixed(3)})`;
        b.el.classList.toggle('ok', hp > 60);
        b.el.classList.toggle('mid', hp > 30 && hp <= 60);
      }
      const o = Math.round(op * 20) / 20;
      if (o !== b.op) { b.op = o; b.el.style.opacity = String(o); }
    }
  }

  /** The bar a body has right now, or null (tests). */
  barOf(p) { return this.bars.find((x) => x.p === p) ?? null; }
}
