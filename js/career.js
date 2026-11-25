// ---- Career: something to do, and a reason to come back ----
// The integrator for the gameplay layer. main.js calls seven small hooks and
// knows nothing else about any of this:
//
//   career.choose(choice)            after the menu: read the save (or not)
//   await career.spawn(player, city) in boot(): stand the player at the save's spot
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
//
// THE GAME IS WRITTEN ONLY AT AUTOSAVE POINTS (Frank, 20 Nov 2026: "To se musí
// ukládat jenom jako na autosavy"; js/autosave.js lists them). No timer, no
// save on the way out, none on the death card: autosave(point) is the one
// writer, and a reload goes back to the last point that was reached. The
// campaign, the free roam after it and co-op all follow the same rule.

import * as wallet from './wallet.js';
import { tickets } from './tickets.js';
import * as vitals from './vitals.js';
import * as fuel from './fuel.js';
import * as wanted from './wanted.js';
import { PRICE, kc } from './prices.js';
import { tod, setSoloTime } from './worldclock.js';
import { browserStore, blank } from './savegame.js';
import { isPoint, notice, PART_ONE_END } from './autosave.js';
import { loadMyLook, saveMyLook } from './characters/appearance.js';
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
import { startPoint as pickStart } from './startplace.js';
import { standY, groundReady, motorwaySave } from './savespot.js';
import { storyStart, newTrip, street, stationEntry, stationExit, kolinPlatform, pardubicePlatform } from './prologue-route.js';
import { start as heistStart } from './heist-route.js';
import { retry } from './story-retry.js';
import { region, regionId, arrival } from './regions.js';
import { airportMarks } from './airport-marks.js';

const store = browserStore();

let h = null;                  // main.js's host (see careerHost there)
let state = blank();           // the loaded save, until attach() has applied it
let loadNote = null;           // 'corrupt' | 'newer' | null, said once in play
let startPick = null;          // the menu's START_PLACES id, or null
let solo = true;
let freeroam = false;          // ?devmode: play with no story
let progress = null, onb = null, jobs = null, garage = null;
let statsPanel = null, foodPanel = null, carPanel = null;
let applied = false;           // the save has been put into the live game
let played = 0, slowT = 0, markT = 0, trackT = 0;
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
  // A position belongs to the region it was taken in (js/regions.js): Mahé's
  // metres are not Pardubice's. Another region's spot is dropped, the rest of
  // the career (money, car, stats) comes along.
  if (state.pos && (state.pos.rg ?? 'cz') !== regionId()) state = { ...state, pos: null };
  // the look chosen in the creator lives in localStorage; a save made with one
  // brings it back to a browser that lost it
  if (state.look && !loadMyLook()) saveMyLook(state.look);
  // ?devmode's menu can ask for a free roam (no story at all) or for the
  // campaign outright, even over a save that never had it.
  freeroam = !!choice?.freeroam;
  let story = freeroam ? null : storyStart(solo, startPick, state.prologue, res.reason === 'empty');
  if (!story && choice?.campaign && solo && startPick !== 'praha') story = 'bridge';
  if (story && story !== 'done') {
    state.onb.done = true;
    beginStory();
  }
  loadNote = res.reason === 'corrupt' || res.reason === 'newer' ? res.reason : null;
}

/** A chapter selects the objective. The position is always in the streamed world. */
export const storyTrip = () => state.storyTrip;
export function activeStory() {
  // (the campaign is Czech: on Mahé there is no chapter to play)
  return solo && !freeroam && startPick !== 'praha' && region().czech ? state.prologue : null;
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
  if (stage === 'done') retry.clear();   // part two's films are new to him
  // part one of the campaign is a mission completed: its end is a point, and
  // the one write made while part two is still ahead (only part one holds it)
  if (stage === 'done' && applied) write('mission', partOneRunning());
  if (stage === 'done' && replaying === 'part1') {
    replaying = null;
    toast('Kampaň zopakována', { icon: '🎬', sub: 'Poslední vlak, část 1', ms: 7000 });
  }
}
/** The campaign from its first frame again: a new platform, a full countdown. */
export function restartStory() {
  beginStory();
  return state.storyTrip;
}
const partOneRunning = () => !!state?.prologue && state.prologue !== 'done' && solo && !freeroam && startPick !== 'praha';
const storyRunning = () => partOneRunning() || heistPending();

// PART TWO (js/heist.js) follows the saved end of part one and is played in
// one sitting like it: nothing is written while it runs, and the next write is
// the one that says it is over. A save that ends at Vašek's table therefore
// opens on his street at half past four in the morning.
export function heistPending() {
  return !!state && solo && !freeroam && startPick !== 'praha' && region().czech && state.prologue === 'done' && state.heist !== 'done';
}
export function completeHeist() {
  retry.clear();
  // THE BRIEFCASE IS PAID ONCE (Frank, 22 Nov 2026: the money was never added
  // to the wallet; and whoever plays the part again gets nothing a second
  // time, and is told so). A save that finished part two before this existed
  // has never been paid, so its first replay pays.
  const pay = heistReward();
  if (pay) {
    wallet.earn(pay, 'kufřík');
    state.heistPaid = true;
    toast('+ ' + kc(pay), { icon: '💼', kind: 'good', sub: 'Peníze z kufříku jsou tvoje', ms: 8000 });
  } else {
    toast('Kampaň zopakována', { icon: '🎬', sub: 'Odměnu ' + kc(PRICE.story.briefcase) + ' už máš, podruhé se nevyplácí', ms: 9000 });
  }
  state.heist = 'done';
  replaying = null;
  if (applied) autosave('mission');      // part two is a mission completed too
}
/** What finishing part two would pay now: the briefcase, or 0 once it has been paid. */
export function heistReward() {
  return state.heistPaid ? 0 : PRICE.story.briefcase;
}
/** The last line of part two's end card: what he gets, or that he does not. */
export function heistRewardNote() {
  return heistReward()
    ? 'Poslední vlak · v kufříku ' + kc(PRICE.story.briefcase)
    : 'Opakování · odměnu ' + kc(PRICE.story.briefcase) + ' už máš, podruhé se nevyplácí';
}

// ---- playing a finished campaign again (js/campaignmenu.js) -----------------
// A replay lives in memory like the campaign itself: the chapter is put back
// to its start, nothing is written while it runs, and its end writes the same
// 'done' the save already held. Closing the tab in the middle changes nothing.
let replaying = null;          // 'part1' | 'part2' while a finished part is played again
export const replayOf = () => replaying;
/** The campaigns there are, for the settings tab. */
// (a part being replayed is still a finished one: its card must not say otherwise)
export function campaigns() {
  const able = !!state && solo && startPick !== 'praha' && applied;
  const busy = partOneRunning() || heistPending();
  return {
    able, busy, replaying,
    list: [
      { id: 'part1', title: 'Poslední vlak · část 1', sub: 'Z Kolína posledním vlakem za Vaškem',
        done: state?.prologue === 'done' || replaying === 'part1', reward: 0, paid: false },
      { id: 'part2', title: 'Poslední vlak · část 2', sub: 'Auto pod Kunětickou horou',
        done: state?.heist === 'done' || replaying === 'part2', reward: PRICE.story.briefcase, paid: !!state?.heistPaid },
    ],
  };
}
/** May this part be started again now? Only a finished one, and never over a running one. */
export function canReplay(part) {
  const c = campaigns();
  return c.able && !c.busy && !!c.list.find((p) => p.id === part)?.done;
}
/**
 * Put the campaign back to the start of `part`. Returns where it begins
 * ({ x, z, h? }), or null when it may not be replayed. main.js moves the
 * player there and starts the part the way it starts after a failure.
 */
export function beginReplay(part) {
  if (!canReplay(part)) return null;
  replaying = part;
  freeroam = false;            // (?devmode's free roam: the story is on for this)
  retry.mark();                // he has seen its films: T skips them
  if (part === 'part1') { beginStory(); return startPoint(); }
  state.heist = null;          // part two is pending again; the save still says done
  return { ...PART_ONE_END };
}

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
  if (heistPending()) {
    const p = heistStart;
    return { x: p.x, z: p.z, heading: p.h, place: pickStart(null, p).place, saved: true };
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
  jobs = new CareerJobs(h, progress, () => { trackT = 0; });
  jobs.load(state.jobs);
  statsPanel = new StatsPanel();
  foodPanel = new FoodPanel({ onBuy: buyFood, money: wallet.money });
  carPanel = new CarPanel({ money: wallet.money,
    onBuy: (car) => {
      if (!garage.buy(car)) return false;
      progress.bump('carsBought');
      // (kept by the next autosave point, not now: nothing is written in between)
      toast('Auto je tvoje', { icon: '🚗', kind: 'good', sub: 'Najdeš ho na mapě' });
      return true;
    },
    onCanister: (car) => {
      if (!garage.canister(car)) return false;
      toast('Palivo doplněno', { icon: '⛽', kind: 'good' });
      return true;
    },
    onRepair: (car) => {
      if (!garage.repair(car)) return false;
      progress.bump('repairs');
      toast('Opraveno', { icon: '🔧', kind: 'good' });
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
    // main.js has stood the body up at the hospital before reviving it: that
    // is where the next autosave point finds you, whether or not the feet have
    // found the ground by then
    // (no height: the hospital is stood on its own floor, see js/savespot.js)
    if (lastSafe && h?.player) { lastSafe.x = h.player.pos.x; lastSafe.z = h.player.pos.z; lastSafe.y = NaN; }
    // under the first star there is nothing to fine, but the residue goes
    // too: as in GTA, you wake up with a clean sheet (the pending calls were
    // hung up at the death itself, js/crimelaw.js)
    if (stars <= 0) { if (wanted.heat() > 0) wanted.clear(); return; }
    const fine = payFine(stars);
    wanted.clear();
    toast('Pokuta ' + kc(fine), { icon: '🚓', kind: 'warn', sub: 'Hledanost smazána' });
  });
  // Going down writes nothing, and neither does closing the tab (there is no
  // pagehide or visibilitychange writer any more): both leave the save as the
  // last autosave point wrote it. A save from an older build can still carry
  // an unpaid hospital bill (`owed`), and loading that one pays it.

  // boot has warmed the spawn's neighbourhood by now: usually it can stand at once
  standSaved(0);
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
    tickets.restore(s.tickets);
    vitals.restore(s.vitals);
    garage.restore(s.car, solo);
    if (solo && s.tod !== null) setSoloTime(s.tod);
    if (s.pos) h.camReset?.();
    // still wanted for what you did before the reload (the star edge this
    // raises is what sends the police out again)
    if (s.wanted.heat > 0) wanted.add(s.wanted.heat, s.wanted.crime);
    if (s.owed) settleOwed(s.owed.stars);
    else if (activeStory() !== 'forecourt' && !arrival() && !storyRunning()) toast('Vítej zpět', { icon: '💾', sub: kc(s.money) + ' · pokračuješ od posledního uložení', ms: 7000 });
  }
  // Arrived from another region (js/regions.js): the game as it was the moment
  // you left beats the last save (the ticket is paid), but it is NOT written,
  // saves stay autosave-only. The flight's landing hour too, alone only.
  const came = arrival();
  if (came?.carry?.live) applyLive(came.carry.live);
  const landTod = came?.carry?.flight?.tod;
  if (solo && Number.isFinite(landTod)) setSoloTime(((landTod % 1) + 1) % 1);
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

// ---- crossing to another region (js/regions.js) ------------------------------
// What a reload would otherwise roll back to the last autosave: money, health,
// the stars on you, and the menu's choice (co-op or alone) so the other side
// boots straight into play. main.js hands this to regions.setCarryHook.
export function live() {
  return {
    money: wallet.money(),
    vitals: { hp: vitals.hp(), armour: vitals.armour(), energy: vitals.energy() },
    wanted: { heat: wanted.heat(), crime: wanted.lastCrime() },
    choice: { mode: solo ? 'single' : 'server', start: startPick, freeroam },
  };
}
function applyLive(l) {
  if (Number.isFinite(l.money)) wallet.setMoney(l.money);
  if (l.vitals) vitals.restore(l.vitals);
  wanted.clear();
  if (l.wanted?.heat > 0) wanted.add(l.wanted.heat, l.wanted.crime);
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
    tickets: tickets.snapshot(),
    prologue: state.prologue,
    heist: state.heist ?? null,
    heistPaid: !!state.heistPaid,
    storyTrip: state.storyTrip,
    pos: lastSafe && regionId() !== 'cz' ? { ...lastSafe, rg: regionId() } : lastSafe,
    tod: solo ? tod() : null,
    played: Math.round(played),
    vitals: { hp: vitals.hp(), armour: vitals.armour(), energy: vitals.energy() },
    car,
    stats: progress.stats, ach: progress.unlocked,
    jobs: jobs.snapshot(),
    onb: { ...onb.toJSON(), tips },
    wanted: { heat: wanted.heat(), crime: wanted.lastCrime() },
    owed: null,
    look: loadMyLook(),
  };
}

/**
 * An autosave point has been reached (js/autosave.js POINTS: 'mission' now,
 * 'sleep' once there is a flat): write the game as it is this frame and say
 * "Uloženo". The ONLY writer of the save. Refused (false, nothing written)
 * for a point that is not one, while down (the body is mid-teleport), before
 * the loaded save has been applied (that would overwrite it blank) and while
 * a campaign part runs (its end is the point: checkpointStory, completeHeist).
 */
export function autosave(point) {
  return write(point, storyRunning());
}
// `held`: a story still running holds the write back. The end of part one
// passes only partOneRunning(), because part two is pending from that frame on.
function write(point, held) {
  if (!isPoint(point) || !applied || !h || vitals.down() || held) return false;
  // where you stand NOW: a mission's end may have just put you somewhere
  // (part one stands you at Vašek's door), and update() has not seen it yet
  markSafe(true);
  const ok = store.save({ ...snapshot(), point });
  if (ok) {
    const n = notice(point);
    toast(n.text, { icon: n.icon, sub: n.sub, ms: n.ms });
  } else if (loadNote !== 'newer') tellUnsaved();
  return ok;
}

/**
 * Arrested: the game goes back to what was last written to disk. Money, body
 * and the job board are read back, the player stands where the save stood
 * them, and the record is clean. Returns the saved spot, or null when there is
 * nothing to go back to (then nothing was touched).
 */
export function reloadLast() {
  if (!applied || !h || storyRunning()) return null;
  const s = store.load().state;
  if (!(s?.savedAt > 0) || !s.pos || (s.pos.rg ?? 'cz') !== regionId()) return null;
  wallet.setMoney(s.money);
  tickets.restore(s.tickets);
  vitals.restore(s.vitals);
  try { jobs.load(s.jobs); } catch { /* an older save's board: keep the live one */ }
  wanted.clear();
  const p = h.player;
  p.pos.x = s.pos.x; p.pos.z = s.pos.z;
  if (Number.isFinite(s.pos.h)) p.heading = s.pos.h;
  pendingStand = { x: s.pos.x, z: s.pos.z, y: Number.isFinite(s.pos.y) ? s.pos.y : NaN, t: 0 };
  if (Number.isFinite(s.pos.y)) { p.y = s.pos.y; p.vy = 0; }
  lastSafe = { ...s.pos };
  lastX = lastZ = null;
  return s.pos;
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
  if (!playable() || !h.player || heistPending()) return false;
  // a chain store with shelves and tills of its own sells its own way (js/stores/)
  if (h.world?.stores?.near(h.player.pos.x, h.player.pos.z)) return false;
  const v = foodPlaceAt(h.world?.city, h.player.pos.x, h.player.pos.z);
  if (!v) return false;
  // a chain that is a tenant of a bigger building sells its own goods at its own prices
  if (h.world?.stores?.tenant(v.name)) return true;
  foodPanel.show(v);
  return true;
}

function openCar() {
  const p = h.player;
  const car = garage.carAt(p.pos.x, p.pos.z);
  if (car?.story) return;
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
    if (!h.parked.includes(car) || car.story) return;   // (a car of the story is not for sale)
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
  markSafe(false);

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

}

// Where the next autosave point should put you: the last place you were on
// the ground, on foot or at the wheel. Never mid-air, on a train or on the
// death card. `now` is an autosave point taking the spot this very frame,
// feet on the ground or not (a mission's end has just stood you there).
function markSafe(now) {
  const p = h.player, g = h.game, car = g.car;
  const onFoot = !car && !g.heli && !g.jet && !p.inCar && !h.trains?.riding;
  if (!((onFoot && (now || p.grounded !== false)) || car) || vitals.down()) return;
  const x = car ? car.x : p.pos.x, z = car ? car.z : p.pos.z;
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

// Everything that does not need to run every frame.
function slow(x, z, onFoot, car) {
  discover(progress, h.placeFinder?.town ?? null);
  // (part two's villa is a restaurant on the map; a chain store sells its own way, js/stores/)
  foodScan(h.world?.city, x, z, onFoot && !heistPending() && !h.world?.stores?.near(x, z));
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
  payAwards(progress);
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
  // the airports the flight leaves from (js/airport-marks.js)
  for (const m of airportMarks()) marks.push(m);
  const c = garage.car;
  if (c && h.game.car !== c) marks.push({ x: c.x, z: c.z, kind: 'car', rim: true });
}

/** For the console and a harness: the live pieces. */
export const debug = {
  get progress() { return progress; }, get jobs() { return jobs; },
  get garage() { return garage; }, get onboarding() { return onb; },
  get marks() { return marks; }, get state() { return state; }, store, snapshot, autosave,
};
