// ---- interiorsim.js: which insides exist right now, and who is in them ----
// 9860 buildings cannot all have geometry. This module is the policy layer that
// decides which ones do, in TWO TIERS, and throws them away behind the player —
// keeping the ones a missile has touched forever (a wrecked building that heals
// itself when you look away is worse than no destruction at all):
//
//   SHELL — within `drawR` (a settings knob, default 160 m), in EVERY mode:
//     just the outer wall with its real window openings, the roof and the brand
//     signage. A few hundred boxes, no rooms, no people. This is what stops a
//     Kaufland visibly changing the moment you walk (or fly) close enough — the
//     box representation is already there from down the street.
//   FULL — within `activateR` on foot: the rooms, stairs, furniture and the
//     occupants, added UNDER the shell by ensureInterior() so the upgrade moves
//     nothing a viewer outside could see.
//
// It also owns the three things that have to be shared across every model:
//   · the debris and dust pools (one InstancedMesh + 120 sprites for the whole
//     city, not per building),
//   · the routing of "am I standing on something / bumping into something" from
//     the walk controller into whichever model is under the player,
//   · the occupants — a few residents per activated building, because a lit
//     window means nothing if there is nobody behind it.
//
// The one piece of coupling worth naming: an ACTIVATED building stops being
// drawn by the chunk mesh — city.js hides it and re-meshes just that chunk's
// building batch, once per scan however many buildings changed — so its boxes
// can take over. The boxes wear the same window atlas the facade did, so the
// swap is a change of representation and not of appearance; and because they
// carry real window openings, you can see into the rooms from the street.

import { chunkKey, pointInPolygon } from './geo.js';
import { groundFor } from './terrain.js';
import { CHUNK, INTERIOR, PLAYER_SCALE } from './config.js';
import { buildingPlan, hasInterior, entranceOf, planToWorld } from './interiors.js';
import { BuildingModel, Debris, Dust } from './destructible.js';
import { buildingWallHex, facadeCells, roofGeometry } from './meshes.js';
import { makeCitizen } from './citizen.js';
import { archetypeAt } from './people.js';
import { sfxAt } from './audio.js';   // safe headless — no-op without an AudioContext

const I = INTERIOR;
const MAX_OCCUPANTS = 90;       // citizens indoors across the whole city
const OCC_SPEED = 1.05, OCC_FLEE = 4.6;
const LEDGE_R = 1.5;            // how far a falling person reaches for an edge
const LEDGE_T = [3.5, 7];       // seconds they can hang before their grip goes
const _w = { x: 0, z: 0 };
const TWO_PI = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// distance from a point to an axis-aligned box (0 when inside)
function bbDist(bb, x, z) {
  const dx = Math.max(bb.minX - x, 0, x - bb.maxX);
  const dz = Math.max(bb.minZ - z, 0, z - bb.maxZ);
  return Math.hypot(dx, dz);
}

export class Interiors {
  constructor(scene, city, world) {
    this.scene = scene;
    this.city = city;
    this.world = world;
    this.enabled = true;                  // settings: "Interiéry budov"
    this.drawR = I.drawR;                 // settings: "Dohlednost budov" — main
                                          // assigns it straight from applySettings
    this.models = new Map();              // building _id → BuildingModel
    this.hidden = new Set();              // _ids the chunk mesh must skip
    this.debris = new Debris(scene, (x, z) => world.heightAt(x, z));
    this.dust = new Dust(scene);
    this.occupants = [];
    this._scanT = 0;
    this._clock = 0;
    /** Where the LOCAL player is, refreshed every frame by update(). Anything
     *  that decides "can anybody see this" must measure from here — never from
     *  the blast, which in multiplayer may have gone off in another town. */
    this.focus = null;
    this._dseq = 0;                       // order buildings were first wrecked in
    this._fx = { debris: this.debris, dust: this.dust };
  }

  // ---- streaming ---------------------------------------------------------
  update(dt, focus, onFoot) {
    this._clock += dt;
    // The listener used to be set from here, on the reasoning that this is the
    // one module handed the focus every frame. It was the wrong owner: turning
    // interiors OFF in the graphics settings also turned distance attenuation
    // off, and every horn, crash and scream in the city then played at full
    // volume wherever it happened. main.js sets it now, unconditionally.
    //
    // The focus is still the only honest answer to "is anyone looking at
    // this building", which weapons.js and _pruneWrecks both need.
    (this.focus ??= { x: 0, z: 0 }).x = focus.x;
    this.focus.z = focus.z;
    this.debris.update(dt);
    this.dust.update(dt);
    // wrecks keep coming down for a few seconds after the hit
    for (const m of this.models.values()) if (m.settle > 0) m.update(dt);
    this._occupantStep(dt);
    // The hitch budget, per FRAME rather than per scan: at most one shell
    // build and one building-batch re-mesh. A single shell can cost ~12 ms
    // of main thread and a re-mesh ~6, and the scan used to land six shells
    // plus every dirty chunk's re-mesh in ONE frame every quarter second —
    // most of the "posekává se to při rychlé jízdě" that wasn't the chunk
    // streamer's own atomic builds.
    this._stepShellQ();
    this._drainChunks(1);
    this._scanT -= dt;
    if (this._scanT > 0) return;
    this._scanT = 1 / Math.max(1, I.buildPerSec) * 2;

    // interiors switched off: keep the wrecks (they are the player's own doing)
    // and shed everything else
    if (!this.enabled) {
      this._shellQ = null; this._shellPending?.clear();
      for (const [id, m] of this.models) if (!m.damaged) this._drop(id);
      this._flushChunks();
      return;
    }

    // candidates: every mapped building whose bbox comes inside the shell
    // radius. The chunk index lists a feature in every cell its bbox touches,
    // so scanning ceil(shellR/CHUNK) cells each way cannot miss one. The shell
    // cap scales with the area the radius covers — a "Daleká" player buys more
    // draw calls, not more per-building cost — and is clamped so the low end
    // still dresses a street and the high end cannot eat the frame.
    const shellR = Math.max(this.drawR, I.activateR);
    // The cap was the reason "Extrémní" felt no farther than "Střední": at 450 m
    // the radius holds ~300+ buildings and the old ceiling of 170 truncated the
    // ring around 250 m. The knob promises a distance, so the cap must scale to
    // what that distance actually contains — the render cost is the player's
    // own choice, made in the settings panel.
    const maxShell = clamp(Math.round((shellR / 40) ** 2 * 2.5), 24, 420);
    const cands = [];
    const seen = new Set();
    const cx = Math.floor(focus.x / CHUNK), cz = Math.floor(focus.z / CHUNK);
    const cr = Math.ceil(shellR / CHUNK);
    for (let dx = -cr; dx <= cr; dx++) for (let dz = -cr; dz <= cr; dz++) {
      const cell = this.city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
      if (!cell) continue;
      for (const f of cell.buildings) {
        if (seen.has(f._id)) continue;
        seen.add(f._id);
        if (!hasInterior(f)) continue;
        const bb = f._bb ??= bboxOf(f.o);
        const d = bbDist(bb, focus.x, focus.z);
        if (d < shellR) cands.push([d, f]);
      }
    }
    cands.sort((a, b) => a[0] - b[0]);

    const keep = new Set();
    const full = new Set();
    // The building whose DOOR you are standing at always wins a FULL slot, cap
    // or no cap, and is built this instant rather than queued: walking up to an
    // entrance and finding it still solid because eight other houses got there
    // first is the one failure the player would read as "you cannot go in".
    // (bbDist to a footprint whose door is within reach is ≤ 7, so the sorted
    // list can stop early instead of probing every candidate on the horizon.)
    if (onFoot) for (const [d, f] of cands) {
      if (d > 8) break;
      const e = entranceOf(f, null, null);
      if (!e || Math.hypot(e.x - focus.x, e.z - focus.z) > 7) continue;
      keep.add(f._id); full.add(f._id);
      this.activate(f);
    }
    // Nearest first through both tiers in one pass: the closest few (on foot)
    // get rooms and people, everything else out to shellR gets the shell.
    // Interior builds stay inline (two per scan, on foot only — walking pace
    // never stacks them); SHELLS are only QUEUED here, and stand up one per
    // frame in _stepShellQ, which is where the hitch budget actually lives.
    let builtFull = 0;
    for (const [d, f] of cands) {
      if (keep.size >= maxShell) break;
      if (keep.has(f._id)) continue;
      keep.add(f._id);
      let m = this.models.get(f._id);
      // ---- a model built on ground we did not have yet -----------------------
      // groundFor answers with a guess while the height map for that tile is in
      // flight, and a model is built ONCE. A building assembled in that window
      // is put together at the wrong height, hidden from the chunk mesh by the
      // very model that is buried, and stays that way for the rest of the
      // session — invisible, and still solid, because collide() works from the
      // footprint and never asks whether the building is hidden.
      //
      // _model() has always re-checked this, and the check was UNREACHABLE on
      // the normal path: the scan only calls _model when there is no model at
      // all. The one thing that did call it was activate(), which is why the
      // building appeared the moment you drove into it — a crash forced the
      // rebuild that the scan never asked for. So the check belongs here, where
      // every model passes every scan.
      //
      // It bites hardest on a building that straddles a tile boundary: the
      // readiness test asks about the FIRST ring point, and the station canopy
      // at Pardubice runs 196 m across the x = 0 seam, so one end can be known
      // ground while the other is still a guess.
      if (m && this._stale(m)) { this._drop(f._id); m = null; }
      if (m) m.lastTouch = this._clock;
      if (onFoot && d < I.activateR && full.size < I.maxActive) {
        full.add(f._id);
        if (!m || !m.interiorBuilt) {
          if (builtFull >= 2) continue;
          this.activate(f);
          builtFull++;
        } else if (!m.populated) this._populate(m);
      } else if (!m) {
        // no model yet: queue it for the per-frame builder. A queued
        // building KEEPS its slot (counts toward maxShell) so the ring's
        // cap holds; the shell stands up within a few frames of here. The
        // pending cap bounds the backlog — anything past it gives its slot
        // back and re-candidates next scan.
        const pend = this._shellPending ??= new Set();
        if (!pend.has(f._id)) {
          if (pend.size >= I.shellPerScan * 2) { keep.delete(f._id); continue; }
          pend.add(f._id);
          (this._shellQ ??= []).push(f);
        }
      }
    }
    // Occupants exist only in the full tier: boarding a car empties the rooms
    // behind you, and a building sliding out past deactivateR sends its people
    // home. The rooms themselves stay — tearing geometry out of a standing
    // building would be visible through its own windows. Wrecks keep their
    // people so a rocket fired from the helicopter still empties the building.
    for (const m of this.models.values()) {
      if (!m.populated || m.damaged || full.has(m.f._id)) continue;
      if (onFoot && bbDist(m.bb, focus.x, focus.z) < I.deactivateR) continue;
      for (let i = this.occupants.length - 1; i >= 0; i--)
        if (this.occupants[i].model === m) this._despawn(i);
      m.populated = false;
    }
    // Shed anything undamaged that has drifted out of reach — the +40 m of
    // hysteresis keeps the boundary from flickering as the player oscillates.
    // Drops are CAPPED per scan like builds: stepping off a train after 3 km
    // used to drop forty models in one scan and re-mesh every chunk they
    // touched in a single frame. Farthest first, so the cap never starves.
    const doomed = [];
    for (const [id, m] of this.models) {
      if (m.damaged || keep.has(id)) continue;
      const d = bbDist(m.bb, focus.x, focus.z);
      if (d > shellR + 40) doomed.push([d, id]);
    }
    doomed.sort((a, b) => b[0] - a[0]);
    for (const [, id] of doomed.slice(0, I.shellPerScan * 2)) this._drop(id);
    // no flush here: the chunks these builds and drops dirtied re-mesh one
    // per frame in _drainChunks — a batch a frame or two out of date is
    // invisible, all of them in this frame was a hitch
  }

  /**
   * Was this model built on ground that has since turned out to be somewhere
   * else? Cheap enough to ask about every model on every scan — one terrain
   * lookup — and the alternative is a building nobody can see.
   */
  _stale(m) {
    if (!m || m.damaged) return false;         // a wreck is where the wreck is
    const g = groundFor(m.f, this.world?.terrain);
    return Math.abs((m.plan?.ground ?? 0) - g) > 0.05;
  }

  /**
   * Throw away every standing model so the next scans rebuild them — used
   * when a setting changes the RECIPE (facade textures), which is baked into
   * a model at build time. Wrecks are the player's own doing and stay.
   */
  rebuildModels() {
    for (const [id, m] of this.models) if (!m.damaged) this._drop(id);
    this._shellQ = null;
    this._shellPending?.clear();
    this._flushChunks();
  }

  /** Build (or fetch) the SHELL model of one building — the cheap tier. */
  _model(f, force = false) {
    let m = this.models.get(f._id);
    if (m) {
      m.lastTouch = this._clock;
      // A MODEL BUILT ON GROUND WE DID NOT HAVE YET. groundFor() answers 0 while
      // the height map for that tile is still in flight, and a model is built
      // ONCE — so a building that streamed in during that window was assembled
      // at absolute zero and stayed there, 367 m under Březůvky, hidden from the
      // chunk mesh by the very model that was buried. That is a race with tile
      // loading, which is why the building was there on one visit and gone on
      // the next. Ground is cheap to re-ask; when it disagrees, start again.
      const g = groundFor(f, this.world?.terrain);
      if (Math.abs((m.plan?.ground ?? 0) - g) > 0.05) { this._drop(f._id); m = null; }
      else return m;
    }
    // the plan wants the local roads (so the front door faces the street) and
    // the local buildings (so it is not cut into a shared party wall)
    const cell = this.city.chunkIndex.get(chunkKey(f.o[0][0], f.o[0][1]));
    // the SAME ground the chunk mesh extruded this building from — see
    // terrain.groundFor. Two answers here is a building that sinks the moment
    // you walk close enough for its interior to replace the far model.
    // …and do not START one on ground nobody knows. The chunk mesh is drawing
    // this building perfectly well; it can keep doing that for another second.
    // activate() is the exception — a rocket must always open a building up —
    // and it passes force, taking whatever ground there is and relying on the
    // re-check above to correct it once the tile lands.
    const terrain = this.world?.terrain;
    if (!force && terrain?.ready && !terrain.ready(f.o[0][0], f.o[0][1])) return null;
    const plan = buildingPlan(f, cell?.roads, cell?.buildings,
      groundFor(f, terrain));
    // Hand the plan the facade's own wall colour. This is what stops a building
    // visibly changing identity the instant it is promoted from painted quads
    // to solid boxes: the boxes come out the colour the facade already was,
    // with the same window rhythm and the same ground-edge shading.
    plan.wallHex = buildingWallHex(f);
    plan.cells = facadeCells(f);      // the atlas cells its facade is painted from
    plan.facades = this.world?.mats?.facades !== false;   // …and whether to use them
    m = new BuildingModel(this.scene, f, plan, this._fx, { shellOnly: true });
    m.bb = f._bb ??= bboxOf(f.o);
    m.lastTouch = this._clock;
    m.populated = false;
    this.models.set(f._id, m);
    // The outer wall is built NOW, not when something hits it. Two things fall
    // out of that, and both were asked for: the windows become real openings
    // with real panes, so you can see into a building without shooting it; and
    // "before" and "after" are the same geometry, so a rocket changes what the
    // building IS, never what it looks like. The facade quads in the chunk mesh
    // step aside for as long as this model exists.
    m.addShell();
    // ---- only hide what you actually replaced -----------------------------
    // addShell sets `shelled` whether or not it produced anything, and
    // shellPieces emits its walls per STOREY — so a footprint that comes out
    // with none (a canopy, a `building=roof`, anything whose plan degenerates)
    // gets an empty shell, and hiding the building behind it deleted the
    // building. Invisible, and still solid: collide() works from the footprint
    // and never asks whether a building is hidden.
    //
    // That is the whole of "I cannot see it until I crash into it" — the crash
    // ran activate(), which built the interior, which finally put something
    // there to see. Hiding is now conditional on there being a replacement.
    if (!m.alive) {
      m.dispose();
      this.models.delete(f._id);
      return null;                    // the chunk mesh keeps drawing it, correctly
    }
    // …and the roof the chunk mesh would have built, since the shell is about to
    // stop that mesh drawing this building at all.
    m.addRoof(roofGeometry(f, plan.top, plan.wallHex));
    this.hidden.add(f._id);
    this._dirtyChunk(f);
    return m;
  }

  /** Build (or upgrade to) the FULL interior of one building. Ignores the
   *  enable flag — a missile hit must always produce an inside to look into.
   *  The upgrade only ADDS pieces under the standing shell, so from the street
   *  nothing appears to happen. */
  activate(f) {
    const m = this._model(f, true);
    m.ensureInterior();
    if (!m.populated) this._populate(m);
    return m;
  }

  _drop(id) {
    const m = this.models.get(id);
    if (!m) return;
    for (let i = this.occupants.length - 1; i >= 0; i--)
      if (this.occupants[i].model === m) this._despawn(i);
    this.hidden.delete(id);
    this._dirtyChunk(m.f);
    m.dispose();
    this.models.delete(id);
  }

  // Chunk building batches are re-meshed at most once per scan, however many
  // buildings changed hands in between — walking down a terrace would otherwise
  // rebuild the same batch eight times in a second.
  _dirtyChunk(f) { (this._dirty ??= new Set()).add(f._home); }
  _flushChunks() {
    if (!this._dirty || !this._dirty.size) return;
    for (const key of this._dirty) this.world._rebuildBuildings?.(key);
    this._dirty.clear();
  }

  // Shells stand up ONE per frame, from the queue the scan filled — that is
  // still up to 60/s where churn at 130 km/h needs about 4. Pop past stale
  // entries (model already built, drifted out of range) until one actually
  // builds. _model may still answer null (ground not loaded); the pending
  // mark is cleared either way, so the next scan simply re-queues it.
  _stepShellQ() {
    const q = this._shellQ;
    if (!q?.length || !this.enabled) return;
    const shellR = Math.max(this.drawR, I.activateR);
    while (q.length) {
      const f = q.shift();
      this._shellPending.delete(f._id);
      if (this.models.has(f._id)) continue;
      if (this.focus && bbDist(f._bb ??= bboxOf(f.o), this.focus.x, this.focus.z) > shellR) continue;
      this._model(f);
      break;
    }
  }

  // …and the chunks those builds and drops dirtied re-mesh at the same
  // cadence. damage() still flushes everything at once — a rocket hit must
  // show this frame, and rockets are rare.
  _drainChunks(n) {
    if (!this._dirty?.size) return;
    for (const key of this._dirty) {
      if (n-- <= 0) break;
      this._dirty.delete(key);
      this.world._rebuildBuildings?.(key);
    }
  }

  // ---- damage -----------------------------------------------------------
  /**
   * damage(f, x, y, z, r, power) — a blast inside/against building `f`.
   * First hit promotes the building out of the chunk mesh so its own boxes can
   * be holed; every hit afterwards is just another blast on the same model.
   */
  damage(f, x, y, z, r, power = 1) {
    const m = this.activate(f);          // already carries its shell
    this._flushChunks();                 // …and the facade is already stood down
    if (m.dseq === undefined) m.dseq = ++this._dseq;   // the order it was wrecked in
    const lost = m.blast(x, y, z, r, power);
    this._panic(x, z, r * 4.5);
    this._pruneWrecks();
    return lost;
  }

  // Wrecks are kept for the session, but not without limit. Past the cap the
  // ones that go back are the ones wrecked EARLIEST — and never one anybody
  // could be looking at.
  //
  // Both halves of that used to be wrong in a way only multiplayer exposes.
  // The order was `lastTouch`, which is set by the streaming scan and therefore
  // means "how recently was I near it" — purely local. The distance test
  // measured from the BLAST, so a peer's rocket in Chrudim would evaluate every
  // wreck against Chrudim and cheerfully restore the block of flats the local
  // player was standing in front of. Two clients thus healed different
  // buildings and the city drifted apart even when every hit was delivered.
  // Damage order is the same on every client that saw the same hits, and the
  // distance is measured from OUR player, where visibility actually lives.
  _pruneWrecks() {
    const wrecks = [];
    for (const [id, m] of this.models) if (m.damaged) wrecks.push([id, m]);
    let over = wrecks.length - I.maxDamaged;
    if (over <= 0) return;
    wrecks.sort((a, b) => (a[1].dseq ?? 0) - (b[1].dseq ?? 0));
    const f = this.focus;
    const guard = Math.max(this.drawR, I.activateR) + 60;   // out past the shell ring
    // Two per call: each restore re-meshes a chunk's whole building batch, and a
    // snapshot replay applying forty hits at once would otherwise do forty of
    // them in one frame. Going a wreck or two over the cap for a moment is
    // cheaper than that hitch.
    let done = 0;
    for (const [id, m] of wrecks) {
      if (over <= 0 || done >= 2) break;
      if (f && bbDist(m.bb, f.x, f.z) < guard) continue;  // in view — leave it wrecked
      this.hidden.delete(id);
      this.world.unhideBuilding?.(m.f);
      this._drop(id);
      over--; done++;
    }
  }

  // ---- queries for the walk controller ---------------------------------
  /** The activated model whose footprint contains (x,z), or null. */
  modelAt(x, z) {
    for (const m of this.models.values()) {
      if (bbDist(m.bb, x, z) > 0) continue;
      if (!pointInPolygon(x, z, m.plan.ring)) continue;
      const holes = m.plan.holes;
      if (holes && holes.some((h) => h.length >= 3 && pointInPolygon(x, z, h))) continue;
      return m;
    }
    return null;
  }

  /** Highest interior surface at or below maxY, or −Infinity. */
  supportY(x, z, maxY) {
    let best = -Infinity;
    for (const m of this.models.values()) {
      if (bbDist(m.bb, x, z) > 1) continue;
      const y = m.supportY(x, z, maxY);
      if (y > best) best = y;
    }
    return best;
  }

  /** Is (x,y,z) inside interior geometry? (chase-camera clearance) */
  occupied(x, y, z, pad) {
    for (const m of this.models.values()) {
      if (bbDist(m.bb, x, z) > (pad ?? 0) + 1) continue;
      if (m.occupied(x, y, z, pad)) return true;
    }
    return false;
  }

  /** Push a {x,z} out of every interior box overlapping [yLo,yHi]. */
  pushOut(pos, radius, yLo, yHi) {
    let moved = false;
    for (const m of this.models.values()) {
      if (bbDist(m.bb, pos.x, pos.z) > radius + 2) continue;
      moved = m.pushOut(pos, radius, yLo, yHi) || moved;
    }
    return moved;
  }

  /** Is this building's collision handled by pieces rather than a footprint? */
  isActive(f) { return this.models.has(f._id); }

  /** HUD: "Bytový dům" / "Nákupní centrum — Palác Pardubice". */
  labelAt(x, z) {
    const m = this.modelAt(x, z);
    if (!m) return null;
    const p = m.plan;
    return p.name ? `${p.label} — ${p.name}` : p.label;
  }

  /** The nearest doorway to (x,z) among activated buildings, for the hint. */
  nearestEntrance(x, z, maxD) {
    let best = null, bd = maxD ?? 6;
    for (const m of this.models.values()) {
      const e = m.plan.entrance;
      if (!e) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  // ---- occupants --------------------------------------------------------
  // A handful of residents per building, walking between the rooms of their
  // own floor. They are the same box people who walk the pavements, so the
  // scale, palette and stride all match for free.
  _populate(m) {
    // A building wrecked by a PEER can be kilometres away — damage() activates
    // it wherever it is, and the full activation would otherwise spend the
    // global occupant budget on residents nobody will ever see, starving the
    // street the local player is actually standing in. `populated` deliberately
    // stays false here, so walking up to that building later still fills it.
    const f = this.focus;
    if (f && bbDist(m.bb, f.x, f.z) > Math.max(this.drawR, I.activateR) + 40) return;
    m.populated = true;      // set even for the empty cases — never retried
    const plan = m.plan;
    let n = Math.min(plan.occupants, MAX_OCCUPANTS - this.occupants.length);
    if (n <= 0 || plan.use === 'garage' || plan.use === 'parking') return;
    for (let i = 0; i < n; i++) {
      const fi = (Math.random() * plan.storeys) | 0;
      const room = pickRoom(plan, fi);
      if (!room) continue;
      // Indoors gets the five bodies too — a bank full of identical thirty-
      // year-old men was the same clone-army problem as the pavement, and the
      // people in here are LOCAL to this client anyway (see this file's header),
      // so a plain Math.random draw is correct rather than a shortcut.
      const c = makeCitizen({ archetype: archetypeAt(Math.random()).key });
      c.group.scale.setScalar(PLAYER_SCALE);
      this.scene.add(c.group);
      const spot = roomPoint(plan, room);
      const o = {
        model: m, mesh: c.group, animate: c.walk, dispose: c.dispose, fi,
        x: spot.x, z: spot.z, y: plan.floors[fi].y,
        vy: 0, heading: Math.random() * TWO_PI, walkT: Math.random() * 10,
        tx: spot.x, tz: spot.z, wait: Math.random() * 3,
        flee: 0, speed: OCC_SPEED * (0.85 + Math.random() * 0.4),
        hang: null,
      };
      c.group.position.set(o.x, o.y, o.z);
      this.occupants.push(o);
    }
  }

  _despawn(i) {
    const o = this.occupants[i];
    // citizen.js's own dispose(), not remove-and-traverse. The old version
    // worked by accident and stopped being safe to rely on the day the model
    // changed: it walked the subtree calling geometry.dispose(), which was
    // harmless only because every geometry a citizen used was shared and had
    // its dispose() neutered. A citizen now owns ONE real buffer — the merged
    // body cluster — so the traverse happened to free the right thing and
    // no-op on the rest, which is exactly the kind of correctness nobody can
    // maintain. netcity.js:493 argues the same case for the network path.
    o.dispose ? o.dispose() : this.scene.remove(o.mesh);
    this.occupants.splice(i, 1);
  }

  // Panic: everyone within reach of a blast drops what they are doing and runs
  // for the stairs. They evacuate rather than die — this is a demolition
  // sandbox, not a body count.
  _panic(x, z, r) {
    // the crowd, then one or two individual voices out of it a beat later —
    // simultaneous screams read as one sample, staggered ones read as people
    sfxAt?.('crowd_panic', 0.8, x, z, 320, 2.5);
    for (let n = 1 + ((Math.random() * 2) | 0), i = 0; i < n; i++)
      setTimeout(() => sfxAt?.(Math.random() < 0.5 ? 'scream_female' : 'scream_male',
        0.75, x, z, 260, 0.25), Math.random() * 600);
    for (const o of this.occupants) {
      const d = Math.hypot(o.x - x, o.z - z);
      if (d > r) continue;
      if (o.hang) { o.hang.t = Math.min(o.hang.t, 0.6); o.hang.climb = false; continue; }
      o.flee = 9 + Math.random() * 5;
      o.speed = 1.25 + Math.random() * 0.6;      // everybody runs at their own pace
      // Ground floor makes for the street; anyone upstairs makes for the
      // staircase, because that is the only way down that exists. A third of
      // them scatter first — a crowd that all picks the same door and walks
      // there in a neat line is not a panic.
      const plan = o.model.plan, core = plan.core, e = plan.entrance;
      const scatter = Math.random() < 0.34;
      if (scatter) {
        const a = Math.atan2(o.z - z, o.x - x) + (Math.random() - 0.5);
        o.tx = o.x + Math.cos(a) * 14; o.tz = o.z + Math.sin(a) * 14;
      } else if (o.fi > 0 && core) {
        planToWorld(plan.fr, (core.land.u0 + core.land.u1) / 2,
          (core.land.v0 + core.land.v1) / 2, _w);
        o.tx = _w.x; o.tz = _w.z;
      } else if (e) {
        o.tx = e.x + e.nx * 5; o.tz = e.z + e.nz * 5;
      }
    }
    // and the street outside empties too
    this.onPanic?.(x, z, r);
  }

  _occupantStep(dt) {
    for (let i = this.occupants.length - 1; i >= 0; i--) {
      const o = this.occupants[i];
      if (!this.models.has(o.model.f._id)) { this._despawn(i); continue; }
      const plan = o.model.plan;

      // ---- hanging off a broken floor ------------------------------------
      // The single best thing a blown-open building can show you: somebody who
      // was standing where the floor used to be, now holding the edge of it.
      // They dangle with their hands at the lip, kick, and either haul
      // themselves back up (the timer runs out over a surface) or lose it.
      if (o.hang) {
        o.hang.t -= dt;
        o.x += (o.hang.x - o.x) * Math.min(1, dt * 6);
        o.z += (o.hang.z - o.z) * Math.min(1, dt * 6);
        o.y += (o.hang.y - 1.55 - o.y) * Math.min(1, dt * 6);
        o.heading = o.hang.heading;
        o.walkT += dt * 5.5;                       // legs kicking in the air
        o.mesh.position.set(o.x, o.y, o.z);
        o.mesh.rotation.y = o.heading;
        o.animate(o.walkT, 0.9);
        if (o.hang.t <= 0) {
          if (o.hang.climb) {                      // made it — back on the deck
            o.y = o.hang.y; o.vy = 0; o.hang = null;
            o.flee = Math.max(o.flee, 5);
          } else {                                 // grip gone
            o.hang = null; o.vy = -1;
            // scream only when something DID this to them — a slip in an
            // intact building screaming every few seconds was the "chodci
            // pořád ječej" bug
            if (o.model.damaged)
              sfxAt?.(Math.random() < 0.5 ? 'scream_female' : 'scream_male', 0.9, o.x, o.z, 240, 1.2);
          }
        }
        continue;
      }

      if (o.flee > 0 && (o.flee -= dt) <= 0) { this._despawn(i); continue; }
      let dx = o.tx - o.x, dz = o.tz - o.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.55) {
        if (o.flee > 0) { this._despawn(i); continue; }   // reached the stairs
        if ((o.wait -= dt) <= 0) {
          const room = pickRoom(plan, o.fi);
          if (room) {
            const spot = roomPoint(plan, room);
            o.tx = spot.x; o.tz = spot.z;
          }
          o.wait = 1.5 + Math.random() * 5;
        }
      } else {
        const sp = (o.flee > 0 ? OCC_FLEE * o.speed : o.speed) * dt;
        const nx2 = o.x + (dx / d) * sp, nz2 = o.z + (dz / d) * sp;
        // an intact building's lift shaft and stair well are HOLES — nobody
        // strolls into one. A step whose floor is >0.6 m down is refused and
        // the walker re-targets; panicked people are allowed to be careless.
        if (o.flee <= 0 && !o.model.damaged) {
          const ns = o.model.supportY(nx2, nz2, o.y + 0.4);
          if (ns < o.y - 0.6) {
            const room = pickRoom(o.model.plan, o.fi);
            if (room) { const spot = roomPoint(o.model.plan, room); o.tx = spot.x; o.tz = spot.z; }
            continue;
          }
        }
        o.x = nx2; o.z = nz2;
        o.walkT += sp * 1.6;
        const want = Math.atan2(-dx / d, -dz / d);
        let td = want - o.heading;
        td = ((td + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
        o.heading += td * Math.min(1, dt * 7);
        _w.x = o.x; _w.z = o.z;
        o.model.pushOut(_w, 0.3, o.y + 0.3, o.y + 1.7);
        o.x = _w.x; o.z = _w.z;
      }

      // the floor can be blown out from under them
      const sup = o.model.supportY(o.x, o.z, o.y + 0.4);
      if (sup > -Infinity && o.y <= sup + 0.05 && o.vy <= 0) { o.y = sup; o.vy = 0; }
      else {
        if (o.vy === 0 && o.y > 2) {
          // the frame they lose the floor: grab for whatever is still there
          const ledge = this._findLedge(o);
          if (ledge) { o.hang = ledge; continue; }
          if (o.model.damaged)
            sfxAt?.(Math.random() < 0.5 ? 'scream_female' : 'scream_male', 0.85, o.x, o.z, 240, 1.2);
        }
        o.vy -= 16 * dt;
        o.y += o.vy * dt;
        const gy = Math.max(sup === -Infinity ? -9e9 : sup, this.world.heightAt(o.x, o.z));
        if (o.y <= gy) { o.y = gy; o.vy = 0; o.flee = Math.max(o.flee, 4); }
      }
      o.mesh.position.set(o.x, o.y, o.z);
      o.mesh.rotation.y = o.heading;
      o.animate(o.walkT, o.flee > 0 ? 1.3 : 0.7);
    }
  }

  // Look for a surviving lip within arm's reach, at roughly the level the
  // person was standing on. Eight probes on a circle is plenty — a floor edge
  // is a straight line, so if any of them finds deck, so would the hands.
  _findLedge(o) {
    const y0 = o.y;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TWO_PI;
      const px = o.x + Math.cos(a) * LEDGE_R, pz = o.z + Math.sin(a) * LEDGE_R;
      const s = o.model.supportY(px, pz, y0 + 0.5);
      if (s > y0 - 0.6 && s <= y0 + 0.5) {
        return {
          x: px - Math.cos(a) * 0.42, z: pz - Math.sin(a) * 0.42, y: s,
          heading: Math.atan2(-Math.cos(a), -Math.sin(a)),   // facing the wall
          t: LEDGE_T[0] + Math.random() * (LEDGE_T[1] - LEDGE_T[0]),
          climb: Math.random() < 0.55,
        };
      }
    }
    return null;
  }

  dispose() {
    for (const id of [...this.models.keys()]) this._drop(id);
  }
}

// ---- small helpers -------------------------------------------------------
function bboxOf(ring) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

// rooms people actually stand in — a void is a hole and a shopfront is glass
const NO_STAND = new Set(['void', 'corridor']);
function pickRoom(plan, fi) {
  const rooms = plan.floors[fi]?.rooms;
  if (!rooms || !rooms.length) return null;
  for (let tries = 0; tries < 8; tries++) {
    const r = rooms[(Math.random() * rooms.length) | 0];
    if (NO_STAND.has(r.kind)) continue;
    if ((r.u1 - r.u0) < 1.6 || (r.v1 - r.v0) < 1.6) continue;
    return r;
  }
  return rooms.find((r) => !NO_STAND.has(r.kind)) ?? null;
}
function roomPoint(plan, room) {
  const u = room.u0 + (room.u1 - room.u0) * (0.25 + Math.random() * 0.5);
  const v = room.v0 + (room.v1 - room.v0) * (0.25 + Math.random() * 0.5);
  return planToWorld(plan.fr, u, v, { x: 0, z: 0 });
}
