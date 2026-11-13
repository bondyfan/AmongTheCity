// ---- Progress: what you have done here, and what that earned ----
// Counters and the achievements that read them. Pure: no DOM, no wallet. The
// caller (js/career.js) reports what happened, and check() answers with the
// achievements that have just come true, once each, so the caller can pay the
// reward and raise the toast. tests/progress.test.mjs pins every trigger.
//
// The stats object is flat numbers plus one string list (the districts), which
// is exactly what js/savegame.js knows how to sanitize: adding a counter here
// needs no change there.

const N = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A fresh stats record. Every counter the game keeps is named here. */
export function blankStats() {
  return {
    driveM: 0, walkM: 0,
    jobsCourier: 0, jobsTaxi: 0, jobsFailed: 0,
    earned: 0,            // Kč from work and rewards (not pockets)
    spent: 0,             // Kč on fuel, food, repairs, cars, fines
    bestPay: 0,           // the fattest single job
    smoothRides: 0,       // taxi rides the fare had no complaint about
    tightRuns: 0,         // deliveries made with under a tenth of the clock left
    meals: 0, refuels: 0, repairs: 0, carsBought: 0,
    districts: [],        // names, in the order they were first entered
  };
}

// Each row: id (stable, it is a save key), what the panel prints, the reward
// in Kč, and a predicate over the stats. Ordered roughly by when a new player
// meets them, which is also the order the panel lists them in.
export const ACHIEVEMENTS = [
  { id: 'kroky', name: 'První kroky', desc: 'Ujdi 300 m pěšky', reward: 100,
    test: (s) => s.walkM >= 300 },
  { id: 'volant', name: 'Za volantem', desc: 'Ujeď 3 km', reward: 150,
    test: (s) => s.driveM >= 3000 },
  { id: 'vyplata', name: 'První výplata', desc: 'Dokonči první zakázku', reward: 200,
    test: (s) => s.jobsCourier + s.jobsTaxi >= 1 },
  { id: 'chut', name: 'Dobrou chuť', desc: 'Najez se v restauraci', reward: 50,
    test: (s) => s.meals >= 1 },
  { id: 'nadrz', name: 'Plná nádrž', desc: 'Natankuj u pumpy', reward: 100,
    test: (s) => s.refuels >= 1 },
  { id: 'znalec', name: 'Místní znalec', desc: 'Objev 4 části města', reward: 300,
    test: (s) => s.districts.length >= 4 },
  { id: 'kuryr', name: 'Spolehlivý kurýr', desc: 'Doruč 5 zásilek', reward: 500,
    test: (s) => s.jobsCourier >= 5 },
  { id: 'taxikar', name: 'Taxikář', desc: 'Odvez 5 zákazníků', reward: 500,
    test: (s) => s.jobsTaxi >= 5 },
  { id: 'maslo', name: 'Jako po másle', desc: 'Odvez zákazníka bez jediného cuknutí', reward: 250,
    test: (s) => s.smoothRides >= 1 },
  { id: 'chvile', name: 'Na poslední chvíli', desc: 'Doruč zásilku s posledními vteřinami', reward: 250,
    test: (s) => s.tightRuns >= 1 },
  { id: 'dalkar', name: 'Dálkař', desc: 'Ujeď 40 km', reward: 600,
    test: (s) => s.driveM >= 40000 },
  { id: 'auto', name: 'Vlastní kola', desc: 'Kup si auto', reward: 1000,
    test: (s) => s.carsBought >= 1 },
  { id: 'dric', name: 'Dříč', desc: 'Dokonči 25 zakázek', reward: 1500,
    test: (s) => s.jobsCourier + s.jobsTaxi >= 25 },
  { id: 'svet', name: 'Světoběžník', desc: 'Objev 12 částí města a obcí', reward: 1200,
    test: (s) => s.districts.length >= 12 },
  { id: 'vydelek', name: 'Sto tisíc', desc: 'Vydělej prací 100 000 Kč', reward: 5000,
    test: (s) => s.earned >= 100000 },
];

export class Progress {
  constructor(stats = null, unlocked = null) {
    this.stats = blankStats();
    this.unlocked = {};
    this.load(stats, unlocked);
  }

  /** Adopt saved numbers. Unknown keys are dropped, missing ones stay zero. */
  load(stats, unlocked) {
    const b = blankStats();
    const s = stats && typeof stats === 'object' ? stats : {};
    for (const k of Object.keys(b)) {
      if (k === 'districts') {
        const seen = new Set();
        b.districts = (Array.isArray(s.districts) ? s.districts : [])
          .filter((d) => typeof d === 'string' && d && !seen.has(d) && seen.add(d));
      } else b[k] = Math.max(0, N(s[k]));
    }
    this.stats = b;
    this.unlocked = {};
    const u = unlocked && typeof unlocked === 'object' ? unlocked : {};
    for (const a of ACHIEVEMENTS) if (N(u[a.id]) > 0) this.unlocked[a.id] = N(u[a.id]);
  }

  addDrive(m) { if (m > 0 && m < 200) this.stats.driveM += m; }   // a teleport is not a drive
  addWalk(m) { if (m > 0 && m < 50) this.stats.walkM += m; }
  addSpent(kc) { if (kc > 0) this.stats.spent += kc; }
  addEarned(kc) { if (kc > 0) this.stats.earned += kc; }
  bump(key, n = 1) { if (key in this.stats && key !== 'districts') this.stats[key] += n; }

  jobDone(kind, pay, info = {}) {
    const s = this.stats;
    if (kind === 'taxi') {
      s.jobsTaxi++;
      if (info.smooth >= 0.995) s.smoothRides++;
    } else {
      s.jobsCourier++;
      if (info.limitS > 0 && info.timeLeftS >= 0 && info.timeLeftS < info.limitS * 0.1) s.tightRuns++;
    }
    if (pay > s.bestPay) s.bestPay = pay;
    this.addEarned(pay);
  }
  jobFailed() { this.stats.jobsFailed++; }

  /** True the first time a name is seen: that is the discovery. */
  enterDistrict(name) {
    if (typeof name !== 'string' || !name) return false;
    if (this.stats.districts.includes(name)) return false;
    this.stats.districts.push(name);
    return true;
  }

  /** Achievements that came true since the last call, each exactly once. */
  check(now = Date.now()) {
    let out = null;
    for (const a of ACHIEVEMENTS) {
      if (this.unlocked[a.id] || !a.test(this.stats)) continue;
      this.unlocked[a.id] = now;
      (out ??= []).push(a);
    }
    return out ?? NONE;
  }

  get jobs() { return this.stats.jobsCourier + this.stats.jobsTaxi; }
}

// check() runs a couple of times a second and nearly always has nothing to
// say: one shared empty answer instead of an array per call.
const NONE = Object.freeze([]);
