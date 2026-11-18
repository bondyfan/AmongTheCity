// ---- Career: something to do, and a reason to come back ----
// The integrator for the gameplay layer. main.js calls seven small hooks and
// knows nothing else about any of this:
//
//   career.choose(choice)            after the menu: read the save (or not)
//   await career.spawn(player, city) in boot(): stand the player where they left
//   career.attach(host)              in boot(): hand over the live game
//   career.update(dt)                every step
//   career.use()                     E pressed on foot with no car in reach
//   career.throttle(car, gas)        the pedal, which a dry tank does not answer
//   career.footHint(el, car)         the on-foot action hint, for food and B
//
// What lives where:
//   jobs        js/careerjobs.js (board, runner, beacon, fare, pay)
//   ownership   js/garage.js
//   the numbers js/progress.js, js/onboarding.js, js/savegame.js (all pure)
//   screens     js/jobboard.js, js/statspanel.js, js/shoppanel.js, js/tracker.js,
//               js/toasts.js (and js/careertips.js decides when to raise one)
//
// EVERYTHING HERE IS THE LOCAL PLAYER'S. Money, jobs, the owned car, the
// stats and the save are never sent to the server and never read from a peer,
// so co-op is the same game with other people in it.

import * as wallet from './wallet.js';
import * as vitals from './vitals.js';
import * as fuel from './fuel.js';
import * as wanted from './wanted.js';
import { PRICE, kc } from './prices.js';
import { tod, setSoloTime } from './worldclock.js';
import { browserStore, blank } from './savegame.js';
import { Progress } from './progress.js';
import { Onboarding } from './onboarding.js';
import { CareerJobs } from './careerjobs.js';
import { Garage } from './garage.js';
import { foodPlaceAt, nearestStop, FOOD_TYPES } from './jobplaces.js';
import { StatsPanel } from './statspanel.js';
import { FoodPanel, CarPanel, energyOf } from './shoppanel.js';
import { anyPanelOpen } from './panel.js';
import { setObjective } from './tracker.js';
import { toast } from './toasts.js';
import { fmtDist } from './jobmath.js';
import { discover, contextTips, payAwards, food, foodScan } from './careertips.js';
import { startPoint as pickStart, nearestHospital } from './startplace.js';
import { standY, groundReady, motorwaySave } from './savespot.js';

const SAVE_EVERY = 20;         // s between autosaves
// Where main.js stands you up after the death card is the hospital nearest
// to where you fell (config.js HOSPITALS, js/startplace.js nearestHospital,
// the same call main.js makes). Only the save written as you go down needs it.
import { storyStart, newTrip, street, stationEntry, stationExit, kolinPlatform, pardubicePlatform } from './prologue-route.js';

const store = browserStore();

let h = null;                  // main.js's host (see careerHost there)
let state = blank();           // the loaded save, until attach() has applied it
let loadNote = null;           // 'corrupt' | 'newer' | null, said once in play
let startPick = null;          // the menu's START_PLACES id, or null
let solo = true;
let progress = null, onb = null, jobs = null, garage = null;
let statsPanel = null, foodPanel = null, carPanel = null;
let applied = false;           // the save has been put into the live game
let played = 0, saveT = SAVE_EVERY, slowT = 0, markT = 0, trackT = 0;
let lastX = null, lastZ = null, lastSafe = null;
// A save made at the wheel on the D11: where the owned car goes in the save
// (its hard shoulder, js/savespot.js), valid while `ok`.
const carStop = { ok: false, cx: 0, cz: 0, h: 0, px: 0, pz: 0, py: 0, deck: false };
// The saved spot spawn() moved the player to, until standSaved() has found its
// floor: { x, z, y, t } (y NaN for an older save), or null.
let pendingStand = null;
const STAND_WAIT = 20;         // s: then stand on what there is rather than hover
let fuelT = -99, dryToldAt = -99, now = 0;
let unsavedTold = false;       // "nothing is being saved" has been said (once is enough)
const tips = {};
const marks = [];              // the one array both maps read
const pumps = [];              // fuel POIs seen so far: { x, z }
const onbCtx = { dt: 0, x: 0, z: 0, onFoot: false, inCar: false, walkedM: 0, boardOpen: false };

// ---- before the world exists ------------------------------------------------

/** After the menu. A fresh game has had its save cleared by the menu already. */
export function choose(choice) {
  solo = choice?.mode !== 'server';
  startPick = typeof choice?.start === 'string' ? choice.start : null;
  const res = store.load();
  state = res.state;
  const story = storyStart(solo, startPick, state.prologue, res.reason === 'empty');
  if (story && story !== 'done') {
    state.onb.done = true;
    beginStory();
  }
  loadNote = res.reason === 'corrupt' || res.reason === 'newer' ? res.reason : null;
}

/** A chapter selects the objective. The position is always in the streamed world. */
export const storyTrip = () => state.storyTrip;
export function activeStory() {
  return solo && startPick !== 'praha' ? state.prologue : null;
}
// THE CAMPAIGN IS NOT SAVED BEFORE ITS END (Frank, 18 Nov 2026): a missed train
// or a death starts it again from the street in Kolín, and so does closing the
// tab. The chapter lives in memory only; the first write is the one for 'done'.
function beginStory() {
  let previous = null;
  try { previous = Number(localStorage.getItem('atc-last-platform')); } catch {}
  state.prologue = 'bridge';
  state.pos = null;
  state.storyTrip = newTrip(previous);
  try { localStorage.setItem('atc-last-platform', state.storyTrip.platform); } catch {}
}
export function checkpointStory(stage) {
  state.prologue = stage;
  if (stage === 'done' && applied) save();
}
/** The campaign from its first frame again: a new platform, a full countdown. */
export function restartStory() {
  beginStory();
  return state.storyTrip;
}
const storyRunning = () => !!state?.prologue && state.prologue !== 'done' && solo && startPick !== 'praha';

/** Where boot begins, before the world exists: the save's spot when it is in
 *  the city the menu shows, else that city's square (js/startplace.js).
 *  { x, z, heading, place, saved }. A start in the other city drops the
 *  saved position, so spawn() below does not walk the player back to it. */
export function startPoint() {
  const chapter = activeStory();
  if (chapter && chapter !== 'done') {
    const fallback = { bridge: street, station: stationEntry, coach: kolinPlatform, arrival: pardubicePlatform, forecourt: stationExit }[chapter];
    const p = state.pos ?? fallback;
    const place = p.x < -38000 ? { name: 'Kolín', to: 'do Kolína' } : pickStart(null, p).place;
    return { x: p.x, z: p.z, heading: p.h, place, saved: !!state.pos };
  }
  const sp = pickStart(startPick, state.pos);
  if (!sp.saved && state.pos) state = { ...state, pos: null };
  return sp;
}

/** Stand the player where the save left them. The tile under that spot is
 *  fetched first, so the boot warm-up builds the right neighbourhood. */
export async function spawn(player, city) {
  const p = state.pos;
  if (!p) return;
  try {
    await Promise.race([
      Promise.resolve(city.ensureTiles?.(p.x, p.z)),
      new Promise((r) => setTimeout(r, 12000)),
    ]);
  } catch { /* a tile that will not load: the streamer retries in play */ }
  player.pos.x = p.x; player.pos.z = p.z; player.heading = p.h;
  // The height is put down later (standSaved), once the world can say which
  // level is there: here the terrain has not even arrived. Until then the
  // walk controller would take the LOWEST level under a deck (the player
  // starts at y 0, so everything is overhead): the riverbed under Charles
  // Bridge, the D11 under an overpass.
  pendingStand = { x: p.x, z: p.z, y: Number.isFinite(p.y) ? p.y : NaN, t: 0 };
  if (Number.isFinite(p.y)) { player.y = p.y; player.vy = 0; }
}

// Stand the restored player on the saved level, as soon as the chunk cell,
// the height map and the earthworks under the spot are in (js/savespot.js
// groundReady). Until then they are held where the save was taken (or, for an
// old save with no height, kept from falling), so a restore that runs before
// the bridge's tile exists does not drop them into the river under it.
function standSaved(dt) {
  const ps = pendingStand, p = h?.player, world = h?.world;
  if (!ps || !p || !world) return;
  // anything else moved them (a teleport, a car, the death card): not ours now
  if (p.inCar || h.game?.car || vitals.down() || Math.abs(p.pos.x - ps.x) > 0.5 || Math.abs(p.pos.z - ps.z) > 0.5) {
    pendingStand = null;
    return;
  }
  ps.t += dt;
  if (!groundReady(world, ps.x, ps.z) && ps.t < STAND_WAIT) {
    if (Number.isFinite(ps.y)) p.y = ps.y;
    p.vy = 0;
    return;
  }
  p.y = standY(world, ps.x, ps.z, ps.y);
  p.vy = 0; p.grounded = true;
  pendingStand = null;
}

// ---- wiring -------------------------------------------------------------------

export function attach(host) {
  h = host;
  progress = new Progress(state.stats, state.ach);
  onb = new Onboarding(state.onb);
  Object.assign(tips, state.onb.tips);
  played = state.played;
  garage = new Garage(h);
  jobs = new CareerJobs(h, progress, () => { saveT = 0.5; trackT = 0; });
  jobs.load(state.jobs);
  statsPanel = new StatsPanel();
  foodPanel = new FoodPanel({ onBuy: buyFood, money: wallet.money });
  carPanel = new CarPanel({ money: wallet.money,
    onBuy: (car) => {
      if (!garage.buy(car)) return false;
      progress.bump('carsBought');
      // (not "saved" when the storage has already turned out not to keep anything)
      toast('Auto je tvoje', { icon: '🚗', kind: 'good', sub: unsavedTold ? 'Najdeš ho na mapě' : 'Je uložené a najdeš ho na mapě' });
      saveT = 0.5;
      return true;
    },
    onCanister: (car) => {
      if (!garage.canister(car)) return false;
      toast('Palivo doplněno', { icon: '⛽', kind: 'good' });
      saveT = 0.5;
      return true;
    },
    onRepair: (car) => {
      if (!garage.repair(car)) return false;
      progress.bump('repairs');
      toast('Opraveno', { icon: '🔧', kind: 'good' });
      saveT = 0.5;
      return true;
    } });

  const key = (code, fn) => h.input.onKey(code, () => { if (playable()) fn(); });
  key('KeyJ', () => jobs.toggleBoard());
  key('KeyP', () => (statsPanel.isOpen ? statsPanel.close() : openStats()));
  key('KeyB', () => (carPanel.isOpen ? carPanel.close() : openCar()));
  key('KeyX', () => {
    if (onb.done || anyPanelOpen()) return;
    onb.skip();
    jobs.guide(null);
    toast('Úvod přeskočen', { icon: '⏭️', sub: 'J zakázky · P přehled · M mapa' });
  });

  // Money out is a statistic whoever spent it; a fill-up is counted once per
  // stop, not once per koruna the pump bills.
  wallet.onChange((money, delta, what) => {
    if (!applied || what === 'set') return;
    if (delta < 0) progress.addSpent(-delta);
    if (what === 'palivo') {
      if (now - fuelT > 8) progress.bump('refuels');
      fuelT = now;
    }
  });
  // The police settle up at the hospital: a fine per star, then a clean sheet.
  // Paid as far as the wallet goes, because pay() is all-or-nothing and being
  // broke must not be the way to keep the stars AND the money.
  vitals.onRevive(() => {
    const stars = wanted.stars();
    // the save still holds the bill (see onDown below): replace it soon with
    // one taken after the hospital, so a reload does not walk you back there
    saveT = Math.min(saveT, 0.5);
    // main.js has stood the body up at the hospital before reviving it: that
    // is where a reload belongs from now on, whether or not the feet have
    // found the ground by the time the save is taken
    // (no height: the hospital is stood on its own floor, see js/savespot.js)
    if (lastSafe && h?.player) { lastSafe.x = h.player.pos.x; lastSafe.z = h.player.pos.z; lastSafe.y = NaN; }
    if (stars <= 0) return;
    const fine = payFine(stars);
    wanted.clear();
    toast('Pokuta ' + kc(fine), { icon: '🚓', kind: 'warn', sub: 'Hledanost smazána' });
  });
  // Going down writes ONE save, on the spot. save() refuses for as long as the
  // death card is up, so before this the newest save on disk was from before
  // the death, and closing the tab on the card bought the life back for free:
  // no fee, no fine, same street. This one is the game as it will be when you
  // wake (at the hospital, on your feet, the job you fell on failed) with the
  // bill still open, and loading it is what pays (apply, settleOwed).
  vitals.onDown(() => {
    if (!applied || !h || storyRunning()) return;
    const snap = snapshot();
    const px = h.player?.pos?.x ?? lastSafe?.x, pz = h.player?.pos?.z ?? lastSafe?.z;
    const hosp = nearestHospital(px, pz);
    snap.pos = { x: hosp.x, z: hosp.z, h: lastSafe?.h ?? 0 };
    snap.vitals = { hp: vitals.hpMax(), armour: 0, energy: vitals.energy() };
    snap.jobs = { ...snap.jobs, active: null };
    snap.owed = { stars: wanted.stars() };
    snap.wanted = { heat: 0, crime: '' };          // the fine settles it
    if (!store.save(snap) && loadNote !== 'newer') tellUnsaved();
  });

  // boot has warmed the spawn's neighbourhood by now: usually it can stand at once
  standSaved(0);

  const flush = () => save();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

// Keys only act in play, and never under somebody else's modal (the settings
// panel, the map): J behind the map would open a board nobody can see.
function playable() {
  if (!h || h.game.mode !== 'play' || vitals.down()) return false;
  return !document.body.dataset.panelOpen || anyPanelOpen();
}

// What the police take per star, as far as the wallet goes: pay() is
// all-or-nothing, and being broke must not be the way to keep the stars AND
// the money. Returns what was paid.
function payFine(stars) {
  const fine = Math.max(0, Math.min(wallet.money(), stars * PRICE.fine.perStar));
  if (fine > 0) wallet.pay(fine, 'pokuta');
  return fine;
}

// The bill a save written on the death card carries: the same two charges, in
// the same order, as the live game makes four seconds after you fall. The fee
// is atomic like main.js's own (a player who cannot cover the bed wakes up
// owing nothing), then the fine.
function settleOwed(stars) {
  const fee = wallet.pay(PRICE.hospital.fee, 'nemocnice') ? PRICE.hospital.fee : 0;
  const fine = stars > 0 ? payFine(stars) : 0;
  toast('Probouzíš se v nemocnici', { icon: '🏥', kind: 'warn', ms: 8000,
    sub: 'Léčba ' + kc(fee) + (stars > 0 ? ' · pokuta ' + kc(fine) : '') });
  saveT = 0.5;                   // and the settled game replaces the open bill
}

// Said once, when it turns out nothing is being kept: the browser blocks site
// storage, or it is full. Everything else about the game works, which is
// exactly why it has to be said.
function tellUnsaved() {
  if (unsavedTold) return;
  unsavedTold = true;
  toast('Hra se neukládá', { icon: '⚠️', kind: 'warn', ms: 12000,
    sub: 'Prohlížeč nepovolil úložiště. Postup po zavření zmizí.' });
}

// Put the saved game into the live one. Once, on the first step: by then
// boot() has finished and main.js has set its own dawn, which a saved hour has
// to come after.
function apply() {
  applied = true;
  const s = state;
  if (s.savedAt > 0) {
    wallet.setMoney(s.money);
    vitals.restore(s.vitals);
    garage.restore(s.car, solo);
    if (solo && s.tod !== null) setSoloTime(s.tod);
    if (s.pos) h.camReset?.();
    // still wanted for what you did before the reload (the star edge this
    // raises is what sends the police out again)
    if (s.wanted.heat > 0) wanted.add(s.wanted.heat, s.wanted.crime);
    if (s.owed) settleOwed(s.owed.stars);
    else if (activeStory() !== 'forecourt' && !storyRunning()) toast('Vítej zpět', { icon: '💾', sub: kc(s.money) + ' · pokračuješ tam, kde jsi skončil', ms: 7000 });
  }
  if (loadNote === 'corrupt')
    toast('Uložená hra se nedala načíst', { icon: '⚠️', kind: 'warn', sub: 'Začínáš novou. Původní data jsou odložená.', ms: 9000 });
  if (loadNote === 'newer')
    toast('Uložená hra je z novější verze', { icon: '⚠️', kind: 'warn', sub: 'Tahle verze ji nepřepíše. Hraješ bez ukládání.', ms: 9000 });
  // (the newer-version case has just said so in its own words)
  else if (!store.writable()) tellUnsaved();
  if (h.minimap) h.minimap.markers = marks;
  if (h.worldMap) h.worldMap.markers = marks;
  const city = h.world?.city;
  const takePumps = (pois) => { for (const p of pois ?? []) if (p.t === 'fuel' && p.p) pumps.push({ x: p.p[0], z: p.p[1] }); };
  takePumps(city?.pois);
  city?.onTileLoaded?.((t) => takePumps(t.pois));
}

// ---- saving -------------------------------------------------------------------

function snapshot() {
  const car = garage.snapshot();
  // the owned car, driven on the D11 when the save is taken, is saved on its
  // hard shoulder beside where its driver is saved (see update)
  if (car && carStop.ok && h.game.car && h.game.car === garage.car) {
    car.x = carStop.cx; car.z = carStop.cz; car.h = carStop.h;
  }
  return {
    money: wallet.money(),
    prologue: state.prologue,
    storyTrip: state.storyTrip,
    pos: lastSafe,
    tod: solo ? tod() : null,
    played: Math.round(played),
    vitals: { hp: vitals.hp(), armour: vitals.armour(), energy: vitals.energy() },
    car,
    stats: progress.stats, ach: progress.unlocked,
    jobs: jobs.snapshot(),
    onb: { ...onb.toJSON(), tips },
    wanted: { heat: wanted.heat(), crime: wanted.lastCrime() },
    owed: null,
  };
}

/** Write the save now. Never while down (the body is mid-teleport) and never
 *  before the loaded save has been applied (that would overwrite it blank). */
export function save() {
  if (!applied || !h || vitals.down() || storyRunning()) return false;
  return store.save(snapshot());
}

// ---- verbs ----------------------------------------------------------------------

function buyFood(plate) {
  if (vitals.down() || !wallet.pay(plate.price, 'jídlo')) return false;
  vitals.heal(plate.hp);
  vitals.eat(energyOf(plate));
  progress.bump('meals');
  toast(plate.name, { icon: '🍴', kind: 'good', sub: '+' + plate.hp + ' zdraví · sytost doplněna' });
  return true;
}

/** E on foot with no car in reach: the food counter, if this is one. */
export function use() {
  if (!playable() || !h.player) return false;
  const v = foodPlaceAt(h.world?.city, h.player.pos.x, h.player.pos.z);
  if (!v) return false;
  foodPanel.show(v);
  return true;
}

function openCar() {
  const p = h.player;
  const car = garage.carAt(p.pos.x, p.pos.z);
  if (!car) { toast('Postav se k zaparkovanému autu', { icon: '🚗', sub: 'B: koupit auto nebo opravit svoje' }); return; }
  carPanel.show(garage.view(car));
}

function openStats() {
  const c = garage.car;
  statsPanel.show({ progress, played, money: wallet.money(),
    car: c ? PRICE.cars.find((r) => r.kind === c.kind)?.name ?? 'ano' : null });
}

/** The pedal. A dry tank coasts: no drive forward or back, brakes untouched. */
export function throttle(car, gas) {
  if (!car || !fuel.dry(car)) return gas;
  if (gas !== 0 && now - dryToldAt > 12) {
    dryToldAt = now;
    toast('Došlo palivo', { icon: '⛽', kind: 'warn', sub: 'Pumpy jsou na mapě. Pěšky, nebo jiným autem.' });
  }
  // The foot brake is the SAME pedal: vehicles.js tyreStep reads the pedal
  // against the direction of travel (past 0.05 m/s) as CAR.brake and anything
  // else as drive. So that half is passed on, and only the drive half is cut:
  // returning 0 for everything left a dry car at 120 km/h with the handbrake
  // and nothing else.
  const v = car.speed ?? 0;
  return (gas < 0 && v > 0.05) || (gas > 0 && v < -0.05) ? gas : 0;
}

/** main.js's on-foot action hint, after it has had its say. Adds the two verbs
 *  this layer brought: E at a food place, B at a car. */
export function footHint(el, car) {
  if (!h || !applied) return;
  if (car) {
    // B deals in PARKED cars (garage.carAt). A car stopped in traffic can be
    // boarded but not bought from the pavement, so it keeps main.js's own hint.
    if (!h.parked.includes(car)) return;
    el.innerHTML = car === garage.car
      ? '<kbd>E</kbd> nastoupit · <kbd>B</kbd> tvoje auto'
      : '<kbd>E</kbd> nastoupit · <kbd>B</kbd> koupit';
    return;
  }
  if (!food.html) return;
  el.innerHTML = food.html;
  el.classList.remove('hidden');
}

// ---- the step ---------------------------------------------------------------------

export function update(dt) {
  if (!h || !h.player) return;
  if (pendingStand) standSaved(dt);
  if (!applied) apply();
  now += dt;
  played += dt;
  const p = h.player, g = h.game, car = g.car;
  const onFoot = !car && !g.heli && !g.jet && !p.inCar && !h.trains?.riding;
  const x = car ? car.x : p.pos.x, z = car ? car.z : p.pos.z;

  // metres, by what you were doing while you covered them
  let moved = 0;
  if (lastX !== null) {
    moved = Math.hypot(x - lastX, z - lastZ);
    if (car) progress.addDrive(moved);
    else if (onFoot && !h.storyTrain?.()) progress.addWalk(moved);
  }
  lastX = x; lastZ = z;
  // Where a reload should put you: the last place you were on the ground, on
  // foot or at the wheel. Never mid-air, on a train or on the death card.
  if ((onFoot && p.grounded !== false || car) && !vitals.down()) {
    (lastSafe ??= { x: 0, z: 0, h: 0, y: NaN });
    // At the wheel, the spot is beside the driver's door: a reload starts on
    // foot, and standing INSIDE the car you were driving is no way to wake up.
    // Heading 0 faces -z here, so the driver's left is (-cos h, sin h).
    const hd = car ? car.heading : p.heading;
    const off = car ? (car.wid ?? 1.8) / 2 + 1.1 : 0;
    lastSafe.x = x - Math.cos(hd) * off; lastSafe.z = z + Math.sin(hd) * off; lastSafe.h = hd;
    // ...and the LEVEL it was on: a deck, or the road under one (savespot.js)
    const y = car ? car.y : p.y;
    lastSafe.y = Number.isFinite(y) ? y : NaN;
    // On the D11 the door is the median or a running lane at 130: the driver
    // is saved behind the guard rail and the car on its hard shoulder, when
    // both spots are on the car's level (js/savespot.js motorwaySave).
    carStop.ok = false;
    if (car && motorwaySave(h.world, x, z, car.heading, y, carStop)) {
      lastSafe.x = carStop.px; lastSafe.z = carStop.pz; lastSafe.h = carStop.h; lastSafe.y = carStop.py;
    }
  }

  jobs.update(dt);

  // the introduction
  if (!onb.done) {
    const c = onbCtx;
    c.dt = dt; c.x = x; c.z = z; c.onFoot = onFoot; c.inCar = !!car;
    c.walkedM = onFoot ? moved : 0; c.boardOpen = jobs.boardOpened;
    const ev = onb.update(c);
    for (const e of ev) {
      if (e.type === 'step') {
        jobs.guide(null);
        if (e.reward > 0) {
          wallet.earn(e.reward, 'odměna');
          progress.addEarned(e.reward);
          toast('Jsi na místě  +' + kc(e.reward), { icon: '📍', kind: 'good', sub: 'Tady se dá najíst: vystup a stiskni E' });
        }
      } else if (e.type === 'finished') {
        toast('Úvod máš za sebou', { icon: '🎓', kind: 'good', sub: 'P přehled a úspěchy · B koupit auto · M mapa' });
        saveT = 0.5;
      }
    }
  }

  slowT -= dt;
  if (slowT <= 0) { slowT = 0.4; slow(x, z, onFoot, car); }
  markT -= dt;
  if (markT <= 0) { markT = 1; rebuildMarks(x, z); }

  // One card, one owner: a running job outranks the introduction. Rebuilt a
  // few times a second, not per frame: its fastest field is a clock in seconds.
  trackT -= dt;
  if (trackT <= 0) { trackT = 0.15; setObjective(jobs.view() ?? introView(x, z)); }

  saveT -= dt;
  // A save that was due and did not land (the storage is blocked or full) is
  // said out loud. Down and the newer-version refusal are not failures.
  if (saveT <= 0) { saveT = SAVE_EVERY; if (!save() && !vitals.down() && !storyRunning() && loadNote !== 'newer') tellUnsaved(); }
}

// Everything that does not need to run every frame.
function slow(x, z, onFoot, car) {
  discover(progress, h.placeFinder?.town ?? null);
  foodScan(h.world?.city, x, z, onFoot);
  // the introduction's targets come from the world, so they are found here
  if (onb.needsTarget && !jobs.runner.active) {
    if (onb.name === 'car') {
      let best = null, bd = 80;
      for (const c of h.parked) {
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) { onb.setTarget({ x: best.x, z: best.z, name: 'Zaparkované auto opodál' }); jobs.guide(onb.target, false); }
    } else {
      const t = nearestStop(h.world?.city, x, z, FOOD_TYPES, 220, 900);
      if (t) {
        if (t.street && t.street !== t.name) t.name += ', ' + t.street;
        onb.setTarget(t); jobs.guide(t, true);
      }
    }
  }
  // a job borrowed the beacon and has given it back: point at the lesson again
  if (!onb.done && onb.target && !jobs.runner.active && !jobs.beacon.on)
    jobs.guide(onb.target, onb.name === 'drive');
  contextTips(tips, car);
  if (payAwards(progress)) saveT = Math.min(saveT, 1);
}

function introView(x, z) {
  const v = onb.view();
  if (!v) return null;
  const t = v.target;
  return { cls: 'intro', icon: v.icon, title: v.title + '  ' + v.step + '/' + v.of,
    where: v.where ?? '', dist: t ? fmtDist(Math.hypot(t.x - x, t.z - z)) : '',
    time: '', pay: v.reward ? '+' + kc(v.reward) : '',
    keys: v.keys + ' · <kbd>X</kbd> přeskočit úvod' };
}

// The marks both maps draw. One array, emptied and refilled once a second: the
// maps hold it by reference, so nothing is handed over per frame.
function rebuildMarks(x, z) {
  jobs.refresh();
  marks.length = 0;
  for (const p of pumps) if (Math.abs(p.x - x) < 6000 && Math.abs(p.z - z) < 6000)
    marks.push({ x: p.x, z: p.z, kind: 'fuel', rim: false });
  jobs.marks(marks);
  const c = garage.car;
  if (c && h.game.car !== c) marks.push({ x: c.x, z: c.z, kind: 'car', rim: true });
}

/** For the console and a harness: the live pieces. */
export const debug = {
  get progress() { return progress; }, get jobs() { return jobs; },
  get garage() { return garage; }, get onboarding() { return onb; },
  get marks() { return marks; }, get state() { return state; }, store, snapshot, save,
};
