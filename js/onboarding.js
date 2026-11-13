// ---- Onboarding: the first two minutes ----
// Four short steps, each shown in the objective tracker while it is the thing
// to do and gone the moment it is done. Nothing here is modal and nothing
// waits for a click: every step completes by PLAYING (walk, get in, drive
// there, open the board), and X skips the lot at any time.
//
//   walk   move and look around          → done after a few metres on foot
//   car    get into the car by the kerb  → marker on the car, done when seated
//   drive  drive to a named place nearby → marker + GPS line, pays a reward
//   board  open the job board (J)        → done when the panel opens
//
// Pure state: js/career.js supplies the facts each step asks about and draws
// what `view()` describes. The step index is what the save keeps.

export const STEPS = ['walk', 'car', 'drive', 'board'];
export const DRIVE_REWARD = 300;
const WALK_M = 12;             // m on foot before the walking hint has done its job
const ARRIVE_M = 16;           // m from the drive target that counts as there
const TARGET_WAIT = 6;         // s to wait for the world to offer a target

// What each step prints. `keys` is trusted markup (kbd tags), written here and
// nowhere else; every name that comes from the map goes through textContent.
const TEXT = {
  walk: { icon: '👟', title: 'Rozhlédni se',
    keys: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> chůze · <kbd>Shift</kbd> sprint · <kbd>myš</kbd> kamera' },
  car: { icon: '🚗', title: 'Nastup do auta',
    keys: 'Dojdi k autu a stiskni <kbd>E</kbd>' },
  drive: { icon: '📍', title: 'Dojeď ke značce',
    keys: '<kbd>W</kbd> plyn · <kbd>S</kbd> brzda a zpátečka · <kbd>Mezerník</kbd> brzda · <kbd>M</kbd> mapa' },
  board: { icon: '💼', title: 'Najdi si práci',
    keys: 'Stiskni <kbd>J</kbd> a vyber si zakázku' },
};

export class Onboarding {
  constructor(saved = null) {
    this.step = 0;
    this.done = false;
    this.target = null;        // { x, z, name } for the car and drive steps
    this._walked = 0;
    this._wait = 0;
    this._events = [];
    if (saved) this.load(saved);
  }

  load(saved) {
    this.done = !!saved.done;
    const n = Number.isInteger(saved.step) ? saved.step : 0;
    this.step = Math.min(STEPS.length, Math.max(0, n));
    if (this.step >= STEPS.length) this.done = true;
    this.target = null; this._walked = 0; this._wait = 0;
  }

  get name() { return this.done ? null : STEPS[this.step]; }
  /** Does the current step want a world position from the caller? */
  get needsTarget() { return !this.done && !this.target && (this.name === 'car' || this.name === 'drive'); }
  setTarget(t) { if (t && Number.isFinite(t.x) && Number.isFinite(t.z)) this.target = t; }

  /** Skip everything (X). The reward is not paid: skipping is free, not paid. */
  skip() {
    if (this.done) return;
    this.done = true; this.target = null;
  }

  _next(paid = true) {
    const was = this.name;
    this.step++;
    this.target = null; this._wait = 0;
    if (this.step >= STEPS.length) this.done = true;
    this._events.push({ type: 'step', was, reward: paid && was === 'drive' ? DRIVE_REWARD : 0 });
    if (this.done) this._events.push({ type: 'finished' });
  }

  /**
   * ctx = { dt, x, z, onFoot, inCar, walkedM (this step's delta), boardOpen }
   * Returns the events of this step (a reused array: read it, do not keep it).
   */
  update(ctx) {
    const ev = this._events;
    ev.length = 0;
    if (this.done) return ev;
    const name = this.name;
    if (name === 'walk') {
      // getting straight into a car is also a way of having found the keys
      if (ctx.onFoot) this._walked += ctx.walkedM > 0 ? ctx.walkedM : 0;
      if (this._walked >= WALK_M || ctx.inCar) this._next();
    } else if (name === 'car') {
      if (ctx.inCar) this._next();
    } else if (name === 'drive') {
      if (!this.target) {
        // No named place in reach (a rim spawn, a tile still loading): do not
        // hold the introduction hostage to the map, move on without the reward.
        this._wait += ctx.dt;
        if (this._wait > TARGET_WAIT) this._next(false);
      } else if (Math.hypot(this.target.x - ctx.x, this.target.z - ctx.z) < ARRIVE_M) this._next();
    } else if (name === 'board') {
      if (ctx.boardOpen) this._next();
    }
    return ev;
  }

  /** What the tracker should show, or null when there is nothing to say. */
  view() {
    if (this.done) return null;
    const t = TEXT[this.name];
    return { step: this.step + 1, of: STEPS.length, icon: t.icon, title: t.title, keys: t.keys,
      where: this.target?.name ?? null, target: this.target,
      reward: this.name === 'drive' ? DRIVE_REWARD : 0 };
  }

  toJSON() { return { step: this.step, done: this.done }; }
}
