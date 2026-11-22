// ---- stores/world.js: the chain stores round the player, alive ----
// Main thread. The chunk mesh draws a store's shell at every distance
// (js/stores/build.js). This is everything that only exists near the player:
//
//   within SEE metres   the glass in the glazing, the sliding door and the lit
//                       room (js/stores/shellfx.js): three draw calls a store
//   within NEAR metres  the fittings on the floor, the people in the shop and
//                       the things the player can do there
//
// It also answers for the store to the rest of the game: where its floor is
// (city.supportY), what a walker bumps into (city.collide), whether the camera
// is under its roof (main.js), what E does and what the hint line says.
//
// CO-OP: what a store contains and who is in it are functions of the store's
// own key, the shared clock and hashes (layout.js, crowd.js). The cart, the bag
// and the order are the local player's and go nowhere.

import { CHUNK } from '../config.js';
import { landmarkOf } from '../landmarks.js';
import { groundFor } from '../terrain.js';
import { siteOf, inRing, apronOf, apronY } from './site.js';
import { buildShellFx, fxNight, ceilAt } from './shellfx.js';
import { buildFixtures, pushOut } from './fixtures.js';
import { marketLayout } from './layout.js';
import { MarketShop, carrierMesh } from './shopping.js';
import { Cart, Bag, Order } from './cart.js';
import { StorePanel } from './panels.js';
import { isOpen, hoursText } from './chains.js';
import { tenantPanel } from './tenant.js';
import { buildLotPaint } from './lotpaint.js';
import { watchDisplay } from './showlayout.js';

const SEE = 380, NEAR = 130, SCAN_DT = 0.5;
// how the arms hold a trolley's handle: js/gait.js HOLD.push
const PUSH = [0.6, 0.8, 0.02];

/** The kinds of interior, by chain kind: how it is laid out and who runs it for the player. */
const INTERIORS = { market: { layout: marketLayout, Shop: MarketShop }, hyper: { layout: marketLayout, Shop: MarketShop } };
/** Register another kind (js/stores/eating.js does, for the restaurants). */
export function registerInterior(kind, def) { INTERIORS[kind] = def; }
const _crowds = [];
/** Register the people of a store (js/stores/crowd.js): make(rec, layout, deps) -> { update, dispose, atDoor() }. */
export function registerCrowd(make) { _crowds.push(make); }

const bbOf = (o) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of o) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
  return { minX, maxX, minZ, maxZ };
};
const bbDist = (bb, x, z) => Math.hypot(Math.max(bb.minX - x, 0, x - bb.maxX), Math.max(bb.minZ - z, 0, z - bb.maxZ));

export class StoreWorld {
  /**
   * @param deps { wallet, vitals, wanted, toast, storage, hour(): 0..24, time(): shared seconds, makeCitizen,
   *   cars: { add, remove, parked, driving(), riding() } the game's own vehicles (js/stores/showroom.js) }
   */
  constructor(scene, world, deps) {
    this.scene = scene; this.world = world; this.d = deps;
    this.recs = new Map();                 // building _id -> record
    this.list = [];                        // the same, as an array (hot paths)
    this.enabled = true;
    this.cart = new Cart();
    this.bag = new Bag(deps.storage ?? null);
    this.order = new Order();
    this.panel = new StorePanel();
    this.carry = null;                     // the trolley or basket the player has, as a mesh
    this.here = null;                      // the store the player is at
    this._scanT = 0; this._hint = ''; this._x = 0; this._z = 0;
    this.reachT = 0; this.scanning = null;
    this.shows = 0;                        // showrooms among the records (deck() is asked by every wheel)
    this.player = null;
  }

  _shopDeps() {
    return {
      cart: this.cart, bag: this.bag, order: this.order, panel: this.panel, wallet: this.d.wallet, wanted: this.d.wanted,
      vitals: this.d.vitals, toast: this.d.toast, hour: this.d.hour, time: this.d.time, makeCitizen: this.d.makeCitizen,
      cars: this.d.cars,
      player: () => this.player, scene: this.scene, world: this.world,
      onCarrier: (kind, rec) => this._setCarrier(kind, rec),
      onPick: () => { this.carry?.setCount(this.cart.count()); this.reachT = 0.55; },
      onScan: (s) => { this.scanning = s; },
      onPaid: (sum, n) => this.d.onPaid?.(sum, n),
      onAte: (hp, kcal, what) => this.d.onAte?.(hp, kcal, what),
      scanning: () => this.scanning ?? null,
      seatBusy: (rec, i) => !!rec.full?.crowds.some((c) => c.seatBusy?.(i)),
    };
  }

  _setCarrier(kind, rec) {
    this.carry?.dispose();
    this.carry = null;
    if (!kind) return;
    this.carry = carrierMesh(kind, rec.chain.trolley ?? rec.chain.sign.bg);
    this.carry.kind = kind;
    this.carry.setCount(this.cart.count());
    this.scene.add(this.carry);
  }

  // ---- streaming ---------------------------------------------------------
  _scan(x, z) {
    const idx = this.world.city.chunkIndex, terrain = this.world.terrain;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), cr = Math.ceil(SEE / CHUNK);
    const seen = new Set();
    if (this.enabled) for (let dx = -cr; dx <= cr; dx++) for (let dz = -cr; dz <= cr; dz++) {
      const key = (cx + dx) + ',' + (cz + dz), cell = idx.get(key);
      // only where the chunk's buildings stand (a far ring of bare ground has no shell to glaze)
      if (!cell?.buildings || !this.world.built.get(key) || this.world._detail?.get(key) === 'ground') continue;
      for (const f of cell.buildings) {
        if (f._home !== key || !f.n || f._lm === '') continue;
        const l = landmarkOf(f);
        if (!l?.store) continue;
        let rec = this.recs.get(f._id);
        // a store stood on ground that has since turned out to be elsewhere is stood again
        if (rec && Math.abs(rec.base - groundFor(f, terrain)) > 0.05) { this._drop(rec); rec = null; }
        if (!rec) {
          if (!terrain.ready(f.o[0][0], f.o[0][1])) continue;
          rec = this._make(f, l.chain, cell);
        }
        seen.add(f._id);
      }
    }
    for (const rec of [...this.list]) {
      rec.dist = bbDist(rec.bb, x, z);
      if (!seen.has(rec.f._id) && (rec.dist > SEE + 60 || !this.enabled)) this._drop(rec);
    }
    // the fittings of whatever is near, one store a scan (a build is a few milliseconds)
    let built = false;
    for (const rec of this.list) {
      if (rec.full && rec.dist > NEAR + 40) this._strip(rec);
      else if (!rec.full && !built && rec.dist < NEAR) { this._furnish(rec); built = true; }
    }
  }
  _make(f, chain, cell) {
    const site = siteOf(f, chain, cell), base = groundFor(f, this.world.terrain);
    const fx = buildShellFx(site, base);
    this.scene.add(fx.group);
    // the bays of its car park, as the parked cars stand in them
    const paint = buildLotPaint(f, (x, z) => this.world.heightAt(x, z));
    if (paint) this.scene.add(paint);
    const rec = { f, chain, site, base, key: site.key, bb: bbOf(f.o), fx, paint, full: null, doorK: 0, dist: 0,
      doorX: site.door.x, doorZ: site.door.z };
    this.recs.set(f._id, rec);
    this.list.push(rec);
    if (chain.kind === 'showroom') this.shows++;
    return rec;
  }
  _furnish(rec) {
    const def = INTERIORS[rec.chain.kind];
    if (!def) return;
    const layout = def.layout(rec.site, rec);
    const fit = buildFixtures(rec.site, layout, rec.fx.group);
    const d = this._shopDeps();
    const shop = new def.Shop(rec, layout, d);
    const crowds = _crowds.map((make) => make(rec, layout, d)).filter(Boolean);
    rec.full = { layout, fit, shop, crowds };
  }
  _strip(rec) {
    if (!rec.full) return;
    if (this.here === rec) this.here = null;
    rec.full.shop.dispose();
    for (const c of rec.full.crowds) c.dispose();
    rec.full.fit.dispose();
    rec.full = null;
  }
  _drop(rec) {
    this._strip(rec);
    rec.fx.dispose();
    if (rec.paint) { rec.paint.removeFromParent(); rec.paint.geometry.dispose(); }
    this.recs.delete(rec.f._id);
    if (rec.chain.kind === 'showroom') this.shows--;
    const i = this.list.indexOf(rec);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** The store whose footprint (x, z) is in, or null. */
  at(x, z) {
    for (const rec of this.list) {
      const b = rec.bb;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (inRing(rec.f.o, x, z)) return rec;
    }
    return null;
  }
  /** Is (x, z) at a store this module runs (in it, or a few metres from its walls)? */
  near(x, z, pad = 8) {
    for (const rec of this.list) if (bbDist(rec.bb, x, z) < pad) return rec;
    return null;
  }

  // ---- once a frame ------------------------------------------------------
  /** env { x, z, player, onFoot, car, nightK } */
  update(dt, env) {
    this.player = env.player;
    this._x = env.x; this._z = env.z;
    fxNight(env.nightK ?? 0);
    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = SCAN_DT; this._scan(env.x, env.z); }
    const hour = this.d.hour(), p = env.player;
    const px = p.pos.x, pz = p.pos.z;
    let here = null, hint = '';
    for (const rec of this.list) {
      if (rec.dist > NEAR + 60) continue;
      rec.dist = bbDist(rec.bb, env.x, env.z);
      const open = isOpen(rec.chain, hour);
      if (open !== rec.open) {
        // shut for the night: the room keeps a quarter of its light
        rec.open = open;
        for (const m of Object.values(rec.fx.mats)) m.userData.closed = !open;
        fxNight(env.nightK ?? 0, true);
      }
      // ---- the sliding door ----
      const dd = Math.hypot(px - rec.doorX, pz - rec.doorZ);
      let want = open && env.onFoot && dd < 4.2 ? 1 : 0;
      // a showroom's gate opens for a car too, and lets one that is inside out after hours
      if (rec.chain.kind === 'showroom' && env.car && dd < 9 && (open || inRing(rec.f.o, env.car.x, env.car.z))) want = 1;
      if (!want && open && rec.full) for (const c of rec.full.crowds) if (c.atDoor?.()) { want = 1; break; }
      if (Math.abs(want - rec.doorK) > 0.001) {
        rec.doorK += (want - rec.doorK) * Math.min(1, dt * 5);
        rec.fx.setDoor(rec.doorK);
      }
      if (!open && env.onFoot && dd < 3.5) hint = 'Zavřeno · otevřeno ' + hoursText(rec.chain);
      if (rec.full) {
        const inside = env.onFoot && inRing(rec.f.o, px, pz);
        for (const c of rec.full.crowds) c.update(dt, { px, pz, inside, hour, open, env });
        rec.full.shop.update(dt, px, pz, inside, env);
        // (a driver is "at" a restaurant from its order post, which stands well off the walls)
        if (rec.dist < (env.onFoot ? 14 : 30) && (!here || rec.dist < here.dist)) here = rec;
      }
    }
    this.here = here;
    if (here && (env.onFoot || here.full.shop.driveHint)) hint = here.full.shop.hint(px, pz, env) || hint;
    this._hint = hint;
    this._carry(p, env);
    this._gesture(p, dt, env);
    watchDisplay(env.car, this.d);         // a display car driven off the premises: js/stores/showlayout.js
  }

  /** The hand that takes a thing off a shelf, and the arm that scans at a self-checkout. */
  _gesture(p, dt, env) {
    const J = p._cit?.parts;
    if (!J?.armR || !env.onFoot) return;
    if (this.reachT > 0) {
      this.reachT -= dt;
      const k = Math.sin(Math.max(0, this.reachT) / 0.55 * Math.PI);
      J.armR.rotation.set(-1.35 * k, 0, 0.1 * k); J.elbowR.rotation.x = 0.35 * k;
    } else if (this.scanning?.self && this.scanning.t < this.scanning.n * this.scanning.per) {
      const w = Math.sin(this.scanning.t / this.scanning.per * Math.PI * 2);
      J.armR.rotation.set(-0.95 - 0.15 * w, 0, 0.15 + 0.45 * w); J.elbowR.rotation.x = 0.9 + 0.25 * w;
    }
  }

  /** The trolley in front of the player, or the basket at their side. */
  _carry(p, env) {
    const c = this.carry;
    if (!c) return;
    // a trolley does not come along in a car, and is not pushed across town
    const rec = this.list.find((r) => r.key === this.cart.store);
    if (!env.onFoot || !rec || rec.dist > 90) {
      if (!this.cart.empty) return;          // (unpaid goods: the door will have dealt with it)
      this.cart.carrier = null; this.cart.store = null;
      this._setCarrier(null);
      return;
    }
    const h = p.heading, fx = -Math.sin(h), fz = -Math.cos(h);
    if (c.kind === 'trolley') {
      c.position.set(p.pos.x + fx * 0.9, p.y, p.pos.z + fz * 0.9);
      c.rotation.y = h;
      const J = p._cit?.parts;
      if (J?.armL) {
        J.armL.rotation.set(PUSH[0], 0, -PUSH[2]); J.armR.rotation.set(PUSH[0], 0, PUSH[2]);
        J.elbowL.rotation.x = PUSH[1]; J.elbowR.rotation.x = PUSH[1];
      }
    } else {
      c.position.set(p.pos.x + fz * -0.34 + fx * 0.08, p.y + 0.62, p.pos.z - fx * -0.34 + fz * 0.08);
      c.rotation.y = h + Math.PI / 2;
    }
  }

  // ---- what the rest of the game asks ------------------------------------
  /** The store floor under (x, z) at or below maxY, or null (city.supportY). */
  floor(x, z, maxY) {
    const rec = this.at(x, z);
    if (rec) {
      const y = rec.base + rec.site.floor + 0.03;
      return y <= maxY ? y : null;
    }
    return this._apron(x, z, maxY, null);
  }
  /** The apron before a door: the ramp the mesh draws (js/stores/site.js apronOf). */
  _apron(x, z, maxY, kind) {
    for (const r of this.list) {
      const dx = x - r.doorX, dz = z - r.doorZ;
      if (dx * dx + dz * dz > 400 || (kind && r.chain.kind !== kind)) continue;
      const s = r.site, terrain = this.world.terrain;
      r.apron ??= apronOf(s, (px, pz) => terrain.heightAt(px, pz) - r.base);
      const ya = apronY(r.apron, dx * s.ux + dz * s.uz, dx * s.nx + dz * s.nz);
      if (ya !== null && r.base + ya <= maxY) return r.base + ya;
    }
    return null;
  }
  /** What a CAR's wheels stand on at a showroom: its floor and the apron out of its gate (js/city.js surfaceY). */
  deck(x, z) {
    if (!this.shows) return null;
    const rec = this.at(x, z);
    if (rec) return rec.chain.kind === 'showroom' ? rec.base + rec.site.floor + 0.03 : null;
    return this._apron(x, z, Infinity, 'showroom');
  }
  /** Under a store's roof (the camera is kept short and low: js/main.js). */
  covered(x, z) { return !!this.at(x, z); }
  lid(x, z) {
    const rec = this.at(x, z);
    if (!rec) return null;
    return rec.base + ceilAt(rec.site, rec.site.local(x, z)[1]) - 0.12;
  }
  /**
   * Would a camera at (x, z) be outside the walls of the store (tx, tz) is in?
   * The chase camera marches its boom in until this is false (js/main.js), so a
   * player sitting by the wall is not looked at from the car park.
   */
  outside(tx, tz, x, z) {
    const rec = this.at(tx, tz);
    if (!rec) return false;
    const o = rec.f.o, m = 0.4;
    return !(inRing(o, x, z) && inRing(o, x + m, z) && inRing(o, x - m, z) && inRing(o, x, z + m) && inRing(o, x, z - m));
  }
  /** The fittings and a shut door, as things a walker cannot pass (city.collide). */
  collide(pos, radius, opts) {
    let pushed = false;
    for (const rec of this.list) {
      const b = rec.bb;
      if (pos.x < b.minX - 2 || pos.x > b.maxX + 2 || pos.z < b.minZ - 2 || pos.z > b.maxZ + 2) continue;
      const lv = opts?.aboveY ?? opts?.y;
      if (lv !== undefined && lv > rec.base + 2.6) continue;        // on the roof
      const site = rec.site;
      let [u, v] = site.local(pos.x, pos.z), moved = false;
      if (rec.doorK < 0.5) {
        // the two leaves, shut: a slab across the doorway
        const [du, dv] = site.local(rec.doorX, rec.doorZ), hw = site.door.w / 2;
        if (u > du - hw - radius && u < du + hw + radius && Math.abs(v - dv + 0.12) < radius + 0.06) {
          v = v > dv - 0.12 ? dv - 0.12 + radius + 0.06 : dv - 0.12 - radius - 0.06;
          moved = true;
        }
      }
      if (rec.full) {
        const r = pushOut(rec.full.fit.colliders, u, v, radius);
        if (r) { u = r[0]; v = r[1]; moved = true; }
      }
      if (moved) { const w = site.world(u, v); pos.x = w[0]; pos.z = w[1]; pushed = true; }
    }
    return pushed;
  }

  /** The hint line's text for this frame ('' when the stores have nothing to say). */
  hint() { return this._hint; }
  /** E. True when a store took it. */
  use(env) {
    const rec = this.here;
    if (!rec?.full || this.panel.isOpen) return false;
    if (!env.onFoot && !rec.full.shop.driveHint) return false;
    const p = this.player;
    return !!rec.full.shop.use(p.pos.x, p.pos.z, env);
  }
  /** A store may pose the player itself (seated at a table). True when it did. */
  posePlayer(dt, player) { return !!this.here?.full?.shop.posePlayer?.(dt, player); }
  /** E at a chain that is only a TENANT of a bigger building: it sells over one screen (js/stores/tenant.js). */
  tenant(name) { return tenantPanel(this, name); }
  /** I: the bag of shopping. */
  openBag() {
    if (this.panel.isOpen) { this.panel.close(); return; }
    this.panel.bag({
      bag: this.bag,
      onEat: (id) => {
        const g = this.bag.eat(id);
        if (!g) return;
        this.d.vitals.heal(g.hp); this.d.vitals.eat(g.kcal);
        this.d.onAte?.(g.hp, g.kcal, g.name);
      },
    });
  }
  dispose() { for (const rec of [...this.list]) this._drop(rec); this._setCarrier(null); }
}
