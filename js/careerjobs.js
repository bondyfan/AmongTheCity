// ---- Career, the jobs half: from the board to the pay ----
// The glue between the pure job machine (js/jobs.js), the map it works on
// (js/jobplaces.js), the things that show it (board, tracker, beacon, fare,
// map marks, the GPS line) and the things it pays into (wallet, progress).
// js/career.js owns one of these and calls update() every step.
//
// THE DESTINATION IS THE MAP'S OWN WAYPOINT. A job does not draw a route of its
// own: it sets worldMap's flag, and navigation.js, the line on the road, the
// compass and both maps follow as they would for a pin the player dropped. The
// player can still drop their own pin mid-job (to find a pump, say); opening
// the board again points the navigation back at the job.

import * as wallet from './wallet.js';
import * as wanted from './wanted.js';
import * as vitals from './vitals.js';
import { JobRunner, FAIL_TEXT } from './jobs.js';
import { generateJobs, dayKey, placeLabel, hash32, BOARD_CELL } from './jobgen.js';
import { collectPlaces, resolveStop, snapStopToRoute } from './jobplaces.js';
import { courierPay, taxiPay, payEstimate, fmtClock, fmtDist } from './jobmath.js';
import { JobBoard, jobTitle } from './jobboard.js';
import { JobBeacon, JobFare } from './jobworld.js';
import { toast } from './toasts.js';
import { kc } from './prices.js';

const PLACES_R = 6000;        // m of named places gathered round the board
const MIN_OFFERS = 3;         // fewer than this left and the next shift starts
const FULL_BOARD = 6;         // what generateJobs offers when the map allows it

export class CareerJobs {
  constructor(host, progress, onChange) {
    this.h = host;
    this.progress = progress;
    this.onChange = onChange;            // "something worth saving happened"
    this.runner = new JobRunner();
    this.runner.on((type, data, job) => this._event(type, data, job));
    this.board = new JobBoard({
      onAccept: (job) => this.accept(job),
      onAbandon: () => { this.runner.abandon(); this.openBoard(); },
      onOpen: () => { this.boardOpened = true; },
    });
    this.beacon = new JobBeacon(host.scene);
    this.fare = new JobFare(host.scene);
    this.offers = [];
    this.day = dayKey(); this.shift = 0;
    this.done = new Set();
    this.boardOpened = false;            // the introduction's last step asks
    this._key = ''; this._size = -1;
    this._ctx = { dt: 0, x: 0, z: 0, speed: 0, inCar: false, carId: 0, carDamage: 0,
      stars: 0, down: false, navDest: null, routeM: null, etaS: null };
    this._carIds = new WeakMap(); this._carSeq = 0;
    this._wp = null;                     // the waypoint object WE set, if any
    this._guide = null;                  // the introduction's target, while it has one
  }

  // ---- persistence ----
  load(saved) {
    const today = dayKey();
    if (saved?.day === today) {
      this.shift = saved.shift | 0;
      this.done = new Set(saved.done ?? []);
    }
    this.day = today;
    this._pending = saved?.active ?? null;     // restored on the first update
  }
  snapshot() {
    return { day: this.day, shift: this.shift, done: [...this.done], active: this.runner.toJSON() };
  }

  // ---- offers ----
  // Rebuilt only when something that can change them has changed: the day, the
  // shift, the part of town or what has been done. Gathering the places walks
  // every building the city has in memory (a few milliseconds), so a tile
  // arriving is NOT a reason by itself: it only earns a rebuild while the
  // board is short of offers, which is the one case more map can fix.
  refresh(force = false) {
    const p = this.h.player, city = this.h.world?.city;
    if (!p || !city) return;
    const today = dayKey();
    if (today !== this.day) { this.day = today; this.shift = 0; this.done.clear(); }
    const cx = Math.floor(p.pos.x / BOARD_CELL), cz = Math.floor(p.pos.z / BOARD_CELL);
    const key = today + '|' + this.shift + '|' + cx + ',' + cz + '|' + this.done.size;
    const size = (city.venues?.length ?? 0) + (city.buildings?.length ?? 0);
    const grew = size !== this._size && this.offers.length < FULL_BOARD;
    if (!force && key === this._key && !grew) return;
    this._key = key; this._size = size;
    const places = collectPlaces(city, p.pos.x, p.pos.z, PLACES_R);
    const make = () => generateJobs({ places, origin: p.pos, day: today, shift: this.shift,
      done: this.done, resolve: (pl) => resolveStop(city, pl) });
    this.offers = make();
    // a board worked down to its last offers turns over to the next shift
    if (this.offers.length < MIN_OFFERS && places.length > 20) {
      this.shift++;
      this.offers = make();
      // the key carries the shift: restate it, or the next call would see a
      // stale key, rebuild, come up short again and turn the shift once more
      this._key = today + '|' + this.shift + '|' + cx + ',' + cz + '|' + this.done.size;
    }
  }

  openBoard() {
    this.refresh();
    const r = this.runner;
    if (r.active) this._point(r.target);       // re-aim the navigation at the job
    this.board.show({ offers: this.offers, active: r.job, stage: r.state,
      doneToday: this.done.size, where: this.h.placeFinder?.town ?? '' });
  }
  toggleBoard() { this.board.isOpen ? this.board.close() : this.openBoard(); }

  accept(job) {
    if (!this.runner.accept(job)) return;
    this.board.close();
  }

  // ---- the waypoint ----
  _point(t) {
    const wm = this.h.worldMap;
    if (!wm) return;
    if (t) { wm.setWaypoint(t.x, t.z); this._wp = wm.waypoint; }
    else if (this._wp && wm.waypoint === this._wp) { wm.setWaypoint(null); this._wp = null; }
    else this._wp = null;
  }

  /** Point navigation and the beacon at somewhere that is not a job (the
   *  introduction's drive). null takes both away again. */
  guide(t, waypoint = true) {
    if (this.runner.active) return;
    this.beacon.set(t, 'goal');
    if (waypoint || !t) this._point(t);
    this._guide = waypoint ? t : null;
  }

  // ---- runner events ----
  _event(type, data, job) {
    const h = this.h, r = this.runner;
    if (type === 'accepted' || type === 'restored') {
      this._point(r.target);
      this.beacon.set(r.target, job.kind);
      if (job.kind === 'taxi' && r.state === 'toPickup') this._standFare(job.from, job, 0);
      toast(jobTitle(job), { icon: job.kind === 'taxi' ? '🚕' : '📦',
        sub: (r.state === 'toDrop' ? 'Doruč: ' : 'Vyzvedni: ') + placeLabel(r.target) });
    } else if (type === 'needCar') {
      toast('Na taxi potřebuješ auto', { icon: '🚕', sub: 'Přijeď pro zákazníka vozem' });
    } else if (type === 'loading') {
      h.hint?.(job.who + ' nastupuje…');
    } else if (type === 'pickup') {
      this.fare.hide();
      this._point(job.to);
      this.beacon.set(job.to, job.kind);
      toast(job.kind === 'taxi' ? job.who + ' je ve voze' : 'Naloženo: ' + job.what,
        { icon: job.kind === 'taxi' ? '🚕' : '📦', sub: 'Cíl: ' + placeLabel(job.to) });
    } else if (type === 'done') {
      const pay = data.pay.total;
      wallet.earn(pay, 'zakázka');
      this.progress.jobDone(job.kind, pay, data);
      this.done.add(job.id);
      let sub;
      if (job.kind === 'taxi') {
        sub = 'jízdné ' + kc(data.pay.fare) + ' · plynulost ' + Math.round(data.smooth * 100) + ' % (+' + kc(data.pay.bonus) + ')';
        this._standFare(job.to, job, 7);
      } else {
        sub = 'trasa ' + kc(data.pay.gross) + ' · čas +' + kc(data.pay.bonus)
          + (data.pay.cut > 0 ? ' · srážky -' + kc(data.pay.cut) : '');
      }
      toast('Zakázka hotová  +' + kc(pay), { icon: '✅', kind: 'good', sub, ms: 6500 });
      this._clear();
    } else if (type === 'failed') {
      if (data.reason !== 'abandon') this.progress.jobFailed();
      toast(FAIL_TEXT[data.reason] ?? 'Zakázka propadla', { icon: '❌', kind: 'warn',
        sub: jobTitle(job) + ' · bez výplaty' });
      this.fare.hide();
      this._clear();
    }
    if (type !== 'timed' && type !== 'loading' && type !== 'needCar') this.onChange?.();
  }

  _clear() {
    this._point(null);
    this.beacon.set(null);
    this._key = '';                       // the board changes: one fewer offer
  }

  // The fare at the kerb, facing the road they are waiting to be picked up from.
  _standFare(pl, job, linger) {
    const wx = pl.wx ?? pl.x, wz = pl.wz ?? pl.z;
    const dx = pl.x - wx, dz = pl.z - wz;
    // heading 0 faces -z in this world (see minimap.js), so face (dx, dz)
    const heading = Math.hypot(dx, dz) > 0.2 ? Math.atan2(-dx, -dz) : 0;
    this.fare.show(wx, wz, heading, this.h.world, hash32(job.id), linger);
  }

  // ---- per step ----
  update(dt) {
    const h = this.h, r = this.runner, p = h.player;
    if (this._pending) {
      const s = this._pending; this._pending = null;
      if (!r.restore(s)) toast('Rozdělaná zakázka propadla', { icon: '📦', kind: 'warn' });
    }
    this.beacon.update(dt, h.world, h.sky?.nightK ?? 0);
    this.fare.update(dt);
    if (!r.active) {
      const g = this._guide;
      if (g && !g.snap && this.beacon.on && snapStopToRoute(g, h.navigation, h.world?.city)) { this.beacon.set(g, 'goal'); this._point(g); }
      return;
    }
    const car = h.game.car, nav = h.navigation, c = this._ctx;
    c.dt = dt;
    c.x = car ? car.x : p.pos.x; c.z = car ? car.z : p.pos.z;
    c.speed = car ? (car.vGround ?? Math.abs(car.speed)) : p.speed ?? 0;
    c.inCar = !!car;
    c.carDamage = car ? car.damage ?? 0 : 0;
    if (car) {
      let id = this._carIds.get(car);
      if (!id) this._carIds.set(car, id = ++this._carSeq);
      c.carId = id;
    }
    c.stars = wanted.stars();
    c.down = vitals.down();
    c.navDest = nav?.destination ?? null;
    c.routeM = nav?.route ? nav.remainingM : null;
    c.etaS = nav?.route && !nav.partial ? nav.etaS : null;
    r.update(c);
    const t = r.target;
    if (t && !t.snap && snapStopToRoute(t, nav, h.world?.city)) {
      this._point(t);
      this.beacon.set(t, r.job.kind);
      if (this.fare.visible && r.state !== 'toDrop') this._standFare(t, r.job, 0);
    }
  }

  /** What the objective tracker should show for the running job, or null. */
  view() {
    const r = this.runner, job = r.job;
    if (!job) return null;
    const c = this._ctx, t = r.target;
    const nav = this.h.navigation, nd = nav?.destination;
    const routed = nd && nav.route && Math.abs(nd.x - t.x) < 2 && Math.abs(nd.z - t.z) < 2
      && Number.isFinite(nav.remainingM);
    // never less than the straight line: a route can end short of the marker,
    // and "0 m" beside a compass that says 50 is the card lying
    const air = Math.hypot(t.x - c.x, t.z - c.z);
    const dist = fmtDist(routed ? Math.max(nav.remainingM, air) : air);
    const taxi = job.kind === 'taxi';
    const v = { cls: job.kind, icon: taxi ? '🚕' : '📦', dist, urgent: false, time: '', keys: '' };
    if (r.state !== 'toDrop') {
      v.title = r.state === 'loading' ? job.who + ' nastupuje…'
        : taxi ? 'Nabrat: ' + job.who : 'Vyzvedni: ' + job.what;
      v.where = placeLabel(job.from);
      v.pay = 'až ' + kc(payEstimate(job.kind, job.distM));
      v.keys = taxi ? 'Zastav autem u značky · <kbd>J</kbd> zakázky'
        : 'Zastav u značky, autem nebo pěšky · <kbd>J</kbd> zakázky';
      return v;
    }
    v.title = taxi ? 'Odvez: ' + job.who : 'Doruč: ' + job.what;
    v.where = placeLabel(job.to);
    const left = r.timeLeft;
    if (left !== null) {
      v.time = '⏱ ' + fmtClock(left);
      v.urgent = left < Math.max(20, r.limitS * 0.15);
    }
    if (taxi) {
      v.pay = kc(taxiPay({ routeM: r.routeM, smooth: r.smooth.score }).total);
      v.keys = 'Plynulost ' + Math.round(r.smooth.score * 100) + ' % · zastav u značky';
    } else {
      v.pay = kc(courierPay({ routeM: r.routeM, timeLeftS: left ?? 0, limitS: r.limitS || 1,
        damage: r._dmg, stars: r._stars }).total);
      v.keys = 'Zastav u značky · nehody a policie snižují výplatu';
    }
    return v;
  }

  /** Marks for the maps: the offers while idle, nothing while a job runs (its
   *  target is the waypoint flag already). Appends to `out`. */
  marks(out) {
    if (this.runner.active) return;
    for (const j of this.offers) out.push({ x: j.from.x, z: j.from.z, kind: j.kind, rim: false });
  }
}
