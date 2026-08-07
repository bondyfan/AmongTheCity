// ==========================================================================
// Status bar — the one module allowed to write the new HUD
//
// WHAT THIS IS FOR. Money, health, armour, fuel and the death card are five
// numbers that four different modules own and that no module should be
// PRINTING. wallet.js knows what you can afford, vitals.js knows how badly you
// are hurt, fuel.js knows how far the tank goes — and if each of them reached
// into the document to say so we would have four modules that cannot be
// imported under node, four places to get the Czech wrong, and four different
// answers to "how often may this write to the DOM". So the four stay pure and
// this file is the only one that has ever heard of an element.
//
// THE RULE THAT SHAPES EVERY LINE BELOW: TOUCH THE DOM ONLY WHEN A VALUE
// CHANGED. update() is called from stepGame, and stepGame runs SEVERAL times
// per rendered frame — main.js clamps dt to 50 ms and loops — so the naive
// `el.textContent = kc(money())` is not one write a frame, it is three, times
// six elements, on the frame path. This is not a theoretical cost in this
// codebase: main.js's own FPS meter carries the comment "a per-frame
// textContent write is itself a measurable cost in a meter whose whole job is
// not to lie about the cost", and it throttles itself to ~5 Hz to escape it.
// Throttling is the wrong fix for a status bar: a health bar that updates
// 5 times a second visibly lags the hit that caused it. The right fix is to
// remember the last value written to each element and compare an INTEGER
// first. In the steady state — walking down a street, nothing happening — this
// module performs exactly zero DOM operations per step, and when something
// does happen it performs one.
//
// Every cached value is quantised to the resolution the pixel actually has:
// bars to whole percent (a 1 % change of a 160 px bar is 1.6 px), the fuel
// range to whole kilometres, opacities to 1/100. Quantising is what collapses
// the three sub-steps of one rendered frame into a single write, and it is
// also what stops a float that wanders in the last decimal from looking like a
// change forever.
//
// NO ALLOCATION ON THE STEP PATH, which is a hard rule here ("Nothing that
// runs every second may allocate" is a commit title). Two consequences you can
// see in the code: the bar widths come out of PCT[], a 101-entry table of
// '0%'…'100%' built once at module load, so a width write never concatenates;
// and every readout compares its quantised INTEGER before it builds the string
// it would have compared, rather than building "≈ 312 km" every step in order
// to discover it is the same string as last step.
//
// REJECTED: driving the HUD from a rAF loop of its own, so it could write once
// per rendered frame by construction. That is a second clock. The game already
// has one, it already knows when it has stepped, and a HUD on a separate clock
// is a HUD that keeps painting while the world is paused and shows a health
// bar from a frame that was never simulated.
//
// REJECTED: a breathing / pulsing low-health vignette. It is the nicer effect
// and it is a style write on every single frame for as long as the player is
// hurt — which is exactly the situation where the frame budget is already
// under pressure and where a dropped frame costs the player something. A
// static tint that deepens as health falls carries the same information for
// zero writes once it has settled.
//
// DEGRADES TO NOTHING. Everything is behind an element check: import this
// under node with no document and it is inert; run it against an index.html
// that predates the markup and it is inert; call init() before the HUD exists
// and update() re-scans once a second until it turns up. The DOM is touched
// from init() and update() only — banner() and the wallet/vitals callbacks
// record what they want and let the next update() write it, which is at most
// one frame away and keeps every write on one path where the caching rule can
// be enforced in one place.
//
// COOLDOWNS ARE DEADLINES, never countdowns — js/chatter.js's header argues
// this at length and the argument holds here: the money ticker's fade is
// `_tickEnd - _t` against this module's own accumulated clock, so there is no
// per-frame decrement for anybody to forget to call and a ticker that is not
// stepped for ten seconds comes back correctly expired rather than frozen at
// full opacity. The clock is accumulated dt, not wall time, on purpose: the
// tick is there to be READ, and a menu that pauses the game must not eat it.
//
// THE CLASSES THIS MODULE TOGGLES, for whoever writes the stylesheet:
//   .mn-tick   gains `up` on a credit and `down` on a debit (colour only —
//              the opacity envelope is driven here, and a CSS animation on
//              .mn-tick would win over it, which is fine and intended)
//   .vt-ar     gains the project-wide `hidden` when armour is 0
//   #fuel      gains `hidden` off foot, `low` under a tank-eighth, `dry` empty
//   #banner    gets `dead` for the SEJMUT card, `hidden` when cleared
// All five are optional to style: unstyled, the HUD still tells the truth.
// ==========================================================================

import { money, onChange } from './wallet.js';
import { hp, hpMax, armour, down as isDown, onDown, onRevive } from './vitals.js';
import { fuelTypeOf, levelOf, frac, dry } from './fuel.js';
import { kc } from './prices.js';

// ---- budgets -------------------------------------------------------------

// How long a HUD that was not there at init() waits before looking again. The
// only cost of a miss is one getElementById per second, and the only cost of
// never looking again is a permanently blank status bar for anybody who calls
// init() from a module-level line instead of after the boot overlay.
const RESCAN = 1.0;

// The money ticker. HOLD is read time — "+1 660 Kč" is eight glyphs and a
// glance is about a second; FADE is short enough that the tick is gone before
// the next transaction in a petrol station is likely, and long enough not to
// pop. MERGE is the window inside which two changes are treated as ONE
// transaction and summed: a purchase that charges a fee arrives as two calls
// microseconds apart, and showing "-1 500 Kč" for one frame and then
// "-90 Kč" is a flicker that reads as a bug. Past the window the second
// change replaces the first outright and restarts the envelope.
// (The minus is the plain hyphen kc() prints; prices.js argues that choice.)
const TICK_HOLD = 1.35, TICK_FADE = 0.55, TICK_MERGE = 0.35;

// The damage flash. HIT_K converts a fraction of max health into opacity, so a
// 20 % hit lands at 0.44 and a 28 % hit saturates: past that the difference
// between "hurt" and "very hurt" is the health bar's job, not the screen's.
// Bigger hits do not stack — the largest wins — because two rifle rounds in
// the same tenth of a second would otherwise white the screen out.
const HIT_K = 2.2, HIT_MAX = 0.62, HIT_FADE = 0.42;

// The standing tint. Nothing at all until health is under a third — above that
// the player is fine and a red screen is a lie — then linear to LOW_MAX at
// zero. DOWN_RED is what you see while you are on the floor.
const LOW_AT = 0.30, LOW_MAX = 0.34, DOWN_RED = 0.70;

// Tank fraction under which #fuel gets `low`. An eighth is roughly where a
// real reserve light comes on, and it leaves ~60 km on a full-size tank, which
// is enough to find one of the city's pumps rather than being a death sentence
// announced too late.
const RESERVE = 0.125;

// Range estimation. We do NOT copy a consumption constant out of fuel.js: that
// number is fuel.js's to tune and a duplicate here would silently disagree
// with it the first time it moved, leaving a gauge that empties at one rate
// and a range that predicts another. Instead we MEASURE — litres gone per
// metre travelled, over a rolling window — and the constants below are only
// the seed we quote until the first window closes. They are ordinary Czech
// figures: 8.5 l/100 km petrol, 6.0 diesel, 17 kWh/100 km electric.
const SEED = Object.freeze({ benzin: 0.085, nafta: 0.060, elektro: 0.170 });
const SAMPLE_M = 250;      // metres per window — long enough to average a junction
const SAMPLE_K = 0.35;     // how hard a fresh window pulls the estimate
const MOVING = 1.5;        // m/s under which nothing is sampled at all: idling
                           // at a red for a minute must not be charged to the
                           // 40 m you then crawl, which would read as 4 km left

const LABEL = Object.freeze({ benzin: 'Benzín', nafta: 'Nafta', elektro: 'Elektro' });

// '0%' … '100%'. Built once so that writing a bar width — the most frequent
// DOM write this module makes — never concatenates a string on the step path.
const PCT = new Array(101);
for (let i = 0; i <= 100; i++) PCT[i] = i + '%';

// ---- state ---------------------------------------------------------------

let _dom = false;          // document exists and init() has run at least once
let _wired = false;        // wallet/vitals subscriptions are once per process
let _t = 0;                // this module's own accumulated seconds
let _rescanAt = 0;

// elements, all nullable, all re-read by _scan()
let _root = null, _mnVal = null, _mnTick = null;
let _hpFill = null, _arBar = null, _arFill = null;
let _fuelEl = null, _fuFill = null, _fuType = null, _fuRange = null;
let _red = null, _ban = null;

// last value WRITTEN to each element. Integers where possible so the compare
// is a compare and not a string equality; the sentinels are values the real
// readouts can never take.
let _lastMoney = NaN, _lastTickTxt = null, _lastTickCls = null, _lastTickOp = -1;
let _lastHp = -1, _lastAr = -1, _lastArOff = null;
let _lastFuOn = null, _lastFuFill = -1, _lastFuType = null, _lastKm = -2;
let _lastFuLow = null, _lastFuDry = null;
let _lastRed = -1;
let _lastBanOn = null, _lastBanTxt = null, _lastBanCls = null;

// money ticker
let _tickSum = 0, _tickAt = -99, _tickEnd = 0, _tickDirty = false;

// damage flash
let _flash = 0, _prevTot = NaN;

// range estimator, per car — a different car is a different engine
let _fuCar = null, _perKm = SEED.benzin, _prevLvl = NaN, _accM = 0, _accL = 0;

// banner
let _banTxt = '', _banCls = '', _banOn = false, _banDirty = false;

// ---- small guards --------------------------------------------------------
// A corrupt number must produce a boring HUD, never an exception on the frame
// path: a NaN width would blank the bar and a throw would take the renderer
// down with it.
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const pct = (v) => Math.round(clamp01(v) * 100);

// ---- init ----------------------------------------------------------------

/**
 * Find the HUD and subscribe to the two modules that speak in events. Safe to
 * call again — main.js may reasonably call it after the boot overlay comes
 * down — and safe to call before the markup exists, in which case update()
 * keeps looking.
 */
export function init() {
  if (typeof document === 'undefined') return;    // headless import, node tests
  _dom = true;
  _scan();
  if (_wired) return;
  _wired = true;
  onChange(_walletChanged);
  onDown(_playerDown);
  onRevive(_playerRevived);
}

// Re-read every element, and forget every cached value ONLY IF one of them
// actually moved. Both halves are load-bearing.
//
// The forgetting is what makes a late HUD work: elements that appear at t = 5 s
// inherit caches which already claim to have written the current health, and
// would sit blank until the player next took damage.
//
// The "only if" is what stops the rescan from becoming the thrash it exists to
// prevent. A page that legitimately has no #fuel (an older index.html, a test
// page) fails the guard in update() every second forever — and a scan that
// cleared the caches unconditionally would then rewrite every element in the
// HUD once a second, for the rest of the session, to no effect whatsoever.
function _scan() {
  _rescanAt = _t + RESCAN;
  const mn = document.getElementById('money');
  const vt = document.getElementById('vitals');
  const root = document.getElementById('status-hud');
  const fuel = document.getElementById('fuel');
  const arBar = vt ? vt.querySelector('.vt-ar') : null;
  const mnVal = mn ? mn.querySelector('.mn-val') : null;
  const mnTick = mn ? mn.querySelector('.mn-tick') : null;
  const hpFill = vt ? vt.querySelector('.vt-hp i') : null;
  const arFill = arBar ? arBar.querySelector('i') : null;
  const fuFill = fuel ? fuel.querySelector('.fu-bar i') : null;
  const fuType = fuel ? fuel.querySelector('.fu-type') : null;
  const fuRange = fuel ? fuel.querySelector('.fu-range') : null;
  const red = document.getElementById('redout');
  const ban = document.getElementById('banner');

  if (root === _root && mnVal === _mnVal && mnTick === _mnTick
    && hpFill === _hpFill && arBar === _arBar && arFill === _arFill
    && fuel === _fuelEl && fuFill === _fuFill && fuType === _fuType
    && fuRange === _fuRange && red === _red && ban === _ban) return;

  _root = root; _mnVal = mnVal; _mnTick = mnTick;
  _hpFill = hpFill; _arBar = arBar; _arFill = arFill;
  _fuelEl = fuel; _fuFill = fuFill; _fuType = fuType; _fuRange = fuRange;
  _red = red; _ban = ban;

  _lastMoney = NaN; _lastTickTxt = null; _lastTickCls = null; _lastTickOp = -1;
  _lastHp = -1; _lastAr = -1; _lastArOff = null;
  _lastFuOn = null; _lastFuFill = -1; _lastFuType = null; _lastKm = -2;
  _lastFuLow = null; _lastFuDry = null;
  _lastRed = -1;
  _lastBanOn = null; _lastBanTxt = null; _lastBanCls = null;
  if (_banOn) _banDirty = true;       // a card raised before the DOM arrived
}

// ---- the frame -----------------------------------------------------------

/**
 * ctx: { car, onFoot } — `car` is the car the player is DRIVING, or null.
 * Only `car` is read; `onFoot` is in the signature because it is in the
 * contract and because "no car" and "on foot" stop being the same thing the
 * day somebody sits in a passenger seat.
 */
export function update(dt = 0, ctx = null) {
  if (!_dom) return;
  // Clamp defensively even though main.js already clamps to 50 ms: a tab that
  // was hidden hands the first step back a large dt through some paths, and a
  // three-second dt would retire the money ticker before it was ever drawn.
  const d = dt > 0 && dt < 0.25 ? dt : dt >= 0.25 ? 0.25 : 0;
  _t += d;

  if ((!_root || !_ban || !_red || !_fuelEl) && _t >= _rescanAt) _scan();

  _money();
  _vitals();
  _fuelGauge(d, ctx ? ctx.car : null);
  _redout(d);
  if (_banDirty) _applyBanner();
}

// ---- money ---------------------------------------------------------------

// wallet.js is the authority on the number; we ask it every step rather than
// caching what the event handed us, because setMoney() (a restore, or dev)
// is allowed to move the balance without a delta worth ticking.
function _money() {
  if (_mnVal) {
    const m = Math.round(fin(money(), 0));
    if (m !== _lastMoney) { _lastMoney = m; _mnVal.textContent = kc(m); }
  }
  if (!_mnTick) return;

  if (_tickDirty) {
    _tickDirty = false;
    if (_tickSum === 0) {
      // paid and refunded inside the merge window — there is nothing to say,
      // and "+0 Kč" is worse than silence
      _tickEnd = 0;
    } else {
      // kc() already carries the minus sign for a debt, so only the credit
      // needs a sign glued on. Built here and nowhere else: this runs on a
      // wallet EVENT, not on the step path.
      const txt = _tickSum > 0 ? '+' + kc(_tickSum) : kc(_tickSum);
      const cls = _tickSum > 0 ? 'up' : 'down';
      if (txt !== _lastTickTxt) { _lastTickTxt = txt; _mnTick.textContent = txt; }
      if (cls !== _lastTickCls) {
        _lastTickCls = cls;
        _mnTick.classList.toggle('up', cls === 'up');
        _mnTick.classList.toggle('down', cls === 'down');
      }
    }
  }

  // A deadline, not a countdown. The second of two changes simply moves the
  // deadline and rewrites the text: there is no running animation to cancel,
  // so two coins landing together cannot fight over the element.
  const left = _tickEnd - _t;
  const op = left <= 0 ? 0 : left >= TICK_FADE ? 1 : left / TICK_FADE;
  const oi = pct(op);
  if (oi !== _lastTickOp) {
    _lastTickOp = oi;
    _mnTick.style.opacity = oi / 100;
    // drop the text once it is invisible: an offscreen-reader would otherwise
    // keep announcing a transaction that finished ten minutes ago
    if (oi === 0 && _lastTickTxt !== '') { _lastTickTxt = ''; _mnTick.textContent = ''; }
  }
}

// Fires from wallet.js, which may be anywhere — a shop, a repair bill, a
// collision with a lamp post. It records and returns; the write happens on the
// next update(), at most one frame later, so that every DOM write in this
// module goes through the one cached path.
function _walletChanged(_m, delta, _what) {
  const d = fin(delta, 0);
  if (d === 0) return;
  // `_what` is deliberately not shown. The tick is a glance — "did that cost
  // me anything?" — and a reason glued onto it makes it a receipt, which is a
  // different screen and belongs somewhere a player can read it twice.
  _tickSum = _t - _tickAt < TICK_MERGE ? _tickSum + d : d;
  _tickAt = _t;
  _tickEnd = _t + TICK_HOLD + TICK_FADE;
  _tickDirty = true;
}

// ---- health and armour ---------------------------------------------------

function _vitals() {
  const max = Math.max(1, fin(hpMax(), 100));
  // Armour is scaled against hpMax as well, and that is a decision rather than
  // an assumption about vitals.js's internals: the two bars sit one above the
  // other, and two stacked bars on different scales lie about each other —
  // half a short armour bar would read as more protection than half a long
  // health bar. vitals.js happens to cap armour at the same 100 today; the
  // clamp is what keeps this honest on the day it does not.
  if (_hpFill) {
    const p = pct(fin(hp(), 0) / max);
    if (p !== _lastHp) { _lastHp = p; _hpFill.style.width = PCT[p]; }
  }
  const a = fin(armour(), 0);
  if (_arFill) {
    const p = pct(a / max);
    if (p !== _lastAr) { _lastAr = p; _arFill.style.width = PCT[p]; }
  }
  if (_arBar) {
    const off = !(a > 0);
    if (off !== _lastArOff) { _lastArOff = off; _arBar.classList.toggle('hidden', off); }
  }
}

// ---- fuel ----------------------------------------------------------------

function _fuelGauge(dt, car) {
  if (!_fuelEl) return;
  const on = !!car;
  if (on !== _lastFuOn) { _lastFuOn = on; _fuelEl.classList.toggle('hidden', !on); }
  if (!on) { _fuCar = null; return; }

  // fuel.js is forgiving about an unknown kind, but normalise anyway: this
  // value indexes two tables and a bad key must land on petrol, not undefined.
  const t0 = fuelTypeOf(car.kind);
  const type = t0 === 'nafta' || t0 === 'elektro' ? t0 : 'benzin';
  // Each of these is asked ONCE per step and passed down. Four readouts that
  // each called frac() and dry() for themselves would be eight calls into
  // fuel.js three times a rendered frame, to answer the same two questions.
  const lvl = fin(levelOf(car), 0);
  const f = clamp01(fin(frac(car), 0));
  const empty = f <= 0 || lvl <= 0 || dry(car);

  if (car !== _fuCar) {
    // A new car is a new engine: the measured consumption of the last one says
    // nothing about this one, and carrying it over would quote a Tesla's range
    // out of a truck's tank for the first quarter kilometre.
    _fuCar = car; _perKm = SEED[type]; _accM = 0; _accL = 0; _prevLvl = lvl;
    _lastKm = -2;
  }

  if (_fuFill) {
    const p = pct(f);
    if (p !== _lastFuFill) { _lastFuFill = p; _fuFill.style.width = PCT[p]; }
  }
  if (_fuType) {
    const l = LABEL[type];
    if (l !== _lastFuType) { _lastFuType = l; _fuType.textContent = l; }
  }

  // ---- the rolling consumption measurement ----
  // Only while actually moving, and only when the level went DOWN: a refill
  // arrives as a negative burn and would otherwise be measured as infinite
  // range. Both accumulators are plain numbers, so this costs no allocation.
  const sp = Math.abs(fin(car.speed, 0));
  if (dt > 0 && sp > MOVING) {
    const used = _prevLvl - lvl;
    if (used > 0 && Number.isFinite(used)) { _accM += sp * dt; _accL += used; }
  }
  _prevLvl = lvl;
  if (_accM >= SAMPLE_M && _accL > 0) {
    const per = (_accL / _accM) * 1000;
    if (per > 0 && Number.isFinite(per)) _perKm += (per - _perKm) * SAMPLE_K;
    _accM = 0; _accL = 0;
  }

  if (_fuRange) {
    const per = _perKm > 1e-6 && Number.isFinite(_perKm) ? _perKm : SEED[type];
    // −1 is the "empty" state, so the integer compare below covers the text
    // swap too and the string is built only when the kilometre actually turns.
    // Both spaces in the range are U+00A0: Czech does not break a number off
    // its unit, and this gauge is narrow enough that it otherwise would.
    const km = empty ? -1 : Math.min(999, Math.max(0, Math.round(lvl / per)));
    if (km !== _lastKm) {
      _lastKm = km;
      _fuRange.textContent = km < 0
        ? (type === 'elektro' ? 'Vybitá' : 'Prázdná')
        : '≈ ' + km + ' km';
    }
  }

  const low = f < RESERVE;
  if (low !== _lastFuLow) { _lastFuLow = low; _fuelEl.classList.toggle('low', low); }
  if (empty !== _lastFuDry) { _lastFuDry = empty; _fuelEl.classList.toggle('dry', empty); }
}

// ---- the red-out ---------------------------------------------------------

// There is no onDamage in the vitals contract, and there does not need to be:
// health plus armour only ever falls under damage, so a drop between two steps
// IS a hit and its size is the drop. Summing the two rather than watching
// health alone is deliberate — armour soaking a round still flashes, because
// the player was still shot.
//
// The one thing this cannot see is a hit that lands in the same step as a
// pickup big enough to cover it: buy a vest and take a bullet inside the same
// 16 ms and the total went up, so there is no flash. Splitting the two into
// separate channels does not fix it (the vest and the bullet are both armour),
// only an event from vitals.js would, and the contract does not have one. A
// missed flash on a coincidence measured in milliseconds is a fair price for
// this module not needing a hook that four other modules would then have to
// keep alive.
function _redout(dt) {
  if (!_red) return;
  const max = Math.max(1, fin(hpMax(), 100));
  const h = fin(hp(), 0);
  const tot = h + fin(armour(), 0);
  if (!Number.isFinite(_prevTot)) _prevTot = tot;
  const lost = _prevTot - tot;
  _prevTot = tot;
  if (lost > 0) {
    const k = Math.min(HIT_MAX, (lost / max) * HIT_K);
    if (k > _flash) _flash = k;      // the biggest hit wins; hits do not stack
  }
  if (_flash > 0) {
    _flash -= dt / HIT_FADE;         // linear: a flash, not a lingering stain
    if (_flash < 0) _flash = 0;
  }

  const hf = clamp01(h / max);
  const floor = isDown() ? DOWN_RED : hf >= LOW_AT ? 0 : (1 - hf / LOW_AT) * LOW_MAX;
  const o = pct(_flash > floor ? _flash : floor);
  if (o !== _lastRed) {
    _lastRed = o;
    // Opacity only — no display toggle. A fully transparent element is not
    // painted, so the resting state costs nothing, and toggling display would
    // trade that for a forced layout on every hit.
    _red.style.opacity = o / 100;
  }
}

// ---- the banner ----------------------------------------------------------

/**
 * Raise a card over the middle of the screen. `cls` is the stylesheet's hook —
 * 'dead' is the SEJMUT card. Records only; update() writes it.
 */
export function banner(text, cls = '') {
  _banTxt = text == null ? '' : String(text);
  _banCls = cls || '';
  _banOn = true;
  _banDirty = true;
}

/** Take it down. Idempotent. */
export function hideBanner() {
  if (!_banOn && _lastBanOn === false) return;
  _banOn = false;
  _banDirty = true;
}

function _applyBanner() {
  if (!_ban) return;               // no element yet — stay dirty, try next scan
  _banDirty = false;
  if (!_banOn) {
    if (_lastBanOn === false) return;
    _lastBanOn = false; _lastBanTxt = ''; _lastBanCls = '';
    _ban.className = 'hidden';
    _ban.textContent = '';
    return;
  }
  // The same card raised twice is not raised twice: re-showing SEJMUT while
  // SEJMUT is already up would restart the entry animation under the player
  // for no reason, and cost the reflow below.
  if (_lastBanOn === true && _banTxt === _lastBanTxt && _banCls === _lastBanCls) return;
  // Hide, force one layout, show. That is what restarts a CSS entry animation
  // for a DIFFERENT card arriving while the last one is still on screen — the
  // element goes out of the render tree and comes back, which is the only
  // restart that works regardless of how the stylesheet animates it. One
  // forced layout per BANNER, which is an event and never a frame; the
  // alternative (clearing and re-adding the animation name) needs the same
  // reflow and needs to know the animation's name.
  _ban.className = 'hidden';
  void _ban.offsetWidth;
  _ban.textContent = _banTxt;
  _ban.className = _banCls;
  _lastBanOn = true; _lastBanTxt = _banTxt; _lastBanCls = _banCls;
}

// vitals.js owns what being down costs; the card only says so. The money it
// cost you arrives on its own as a wallet change and shows up in the ticker,
// which is why there is no fee printed here — one number, one owner.
function _playerDown() { banner('SEJMUT', 'dead'); }
function _playerRevived() { hideBanner(); }

export default { init, update, banner, hideBanner };
