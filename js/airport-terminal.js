// ---- airport-terminal.js: Terminál Jana Kašpara, the rooms a player walks in ----
// Main thread. The landmark (js/landmarks-letiste.js) is the building as the far
// world sees it; this class is what exists only near the player: the interior set
// (js/airport-interior.js, js/airport-fit.js), the departure boards
// (js/airport-boards.js), the glass leaves of the doors, and the answers the rest
// of the game asks about the rooms (where the floor is, where the ceiling is,
// which room a camera is in, what a walker bumps into).
//
// Built ONCE, when the player is within BUILD_R of the terminal, and only hidden
// beyond HIDE_R, so walking away and back costs nothing. Its founding ground is
// the landmark's own (groundFor, the rule the chunk mesh uses), so the floor it
// lays and the shell it stands in agree to the centimetre.

import * as THREE from 'three';
import { stationKit } from './stationkit.js';
import { CHUNK } from './config.js';
import { landmarkOf } from './landmarks.js';
import { groundFor } from './terrain.js';
import { ctxOf } from './airport-ctx.js';
import { buildInterior } from './airport-interior.js';
import { buildFittings } from './airport-fit.js';
import { makeBoards } from './airport-boards.js';
import { FRAME, AT, H, PARTS, DOORS, GATES, toWorld, toLocal, inBuilding, ceilingAt, zoneAt } from './airport-plan.js';

const BUILD_R = 1600, HIDE_R = 2500;      // metres: build the set inside the first, hide it past the second
const DOOR_R = 3.0;                       // an automatic door opens for anyone this close
const DOOR_SPEED = 5;                     // how fast a leaf slides: its travel 0..1 per 0.2 s
const LEAF_H = H.door - 0.15;             // a glazed leaf stands just under the door's head
const NAME = 'letiste-terminal';
const GLASS = new THREE.MeshLambertMaterial({ color: 0xbfd9de, transparent: true, opacity: 0.22, depthWrite: false });
const STEP = 0.5;                         // seconds between searches for the footprint, and for its ground

/** Which room a plan point is in, for the camera: the porch is its own room. */
function roomOf(x, z) {
  const { u, v } = toLocal(x, z);
  if (!inBuilding(u, v)) return null;
  const p = PARTS.porch;
  if (u > p.u0 && u < p.u1 && v > p.v0 && v < p.v1) return 'porch';
  return zoneAt(u, v);
}

export class AirportTerminal {
  /** @param world the game's world: its city (chunkIndex) and its terrain */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.f = null;          // the footprint, once found (plain data, the landmark's)
    this.base = 0;          // the founding ground the set stands on
    this.lift = 0;          // how far the floor stands over it: clear of the highest ground under the building
    this.group = null;      // the set, once built
    this.kit = null;
    this.boards = null;
    this.doors = [];        // { u, v, w, gate, auto, k, target, leaves }
    this.rows = [];         // the departures the boards show
    this.nightK = -1;
    this.clock = 0;         // seconds since the last search, see STEP
    this.built = false;
    this._buildPending = false;
    this._prepDoors();
  }

  /** True once the interior set exists. */
  get ready() { return this.built; }

  // ---- the footprint and its ground ---------------------------------------
  /** The terminal's footprint, found among the buildings of the chunks round it. */
  _find() {
    const idx = this.world.city?.chunkIndex, terrain = this.world.terrain;
    if (!idx || !terrain) return null;
    const cx = Math.floor(AT[0] / CHUNK), cz = Math.floor(AT[1] / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const cell = idx.get((cx + dx) + ',' + (cz + dz));
      if (!cell?.buildings) continue;
      for (const f of cell.buildings) {
        if (f._lm === '' || landmarkOf(f)?.id !== NAME) continue;
        // a footprint whose height map has not arrived has no ground yet: wait for it
        return terrain.ready(f.o[0][0], f.o[0][1]) ? f : null;
      }
    }
    return null;
  }
  _ground() { return groundFor(this.f, this.world.terrain); }
  /**
   * The founding ground is the shell's, but the ground under a 160 m building
   * is not level: at Pardubice it rises 0.35 m from the south-east corner to
   * the north-west, and a floor laid 12 cm over the founding height had the
   * grass of the airfield showing through its tiles over half the hall. So the
   * whole interior stands on a plinth just over the highest ground under the
   * plan, and everything in it is lifted with it.
   */
  _lift() {
    let hi = -Infinity;
    for (const k in PARTS) {
      const p = PARTS[k];
      for (let u = p.u0; u <= p.u1; u += 2) for (let v = p.v0; v <= p.v1; v += 2) {
        const w = toWorld(u, v);
        hi = Math.max(hi, this.world.heightAt(w.x, w.z));
      }
    }
    return Math.max(0, Math.min(0.6, hi + 0.04 - (this.base + 0.12)));
  }

  // ---- the doors -------------------------------------------------------------
  /** One glazed leaf pair per door of the plan: the gate doors open only on setGate, the rest on proximity. */
  _prepDoors() {
    for (const d of DOORS) {
      const gate = GATES.find((g) => g.door === d.id);
      this.doors.push({ id: d.id, u: d.u, v: d.v, w: d.w, gate: gate ? gate.id : null, auto: !gate, k: 0, target: 0, leaves: null });
    }
  }
  /** The glass leaves of one door: two halves, sliding apart as k goes 0 to 1. */
  _leaves(d) {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(d.w / 2 - 0.05, LEAF_H, 0.06);
    d.leaves = [new THREE.Mesh(geo, GLASS), new THREE.Mesh(geo, GLASS)];
    for (const m of d.leaves) { m.renderOrder = 2; g.add(m); }
    // the leaf stands on the lifted floor and still stops under the shell's lintel
    g.scale.y = (LEAF_H - this.lift) / LEAF_H;
    g.position.y = this.base + this.lift + 0.12 + (LEAF_H - this.lift) / 2;
    g.name = 'door-' + d.id;
    this.group.add(g);
    this._placeLeaves(d);
  }
  _placeLeaves(d) {
    const [a, b] = d.leaves;
    const off = d.w / 4 + d.k * d.w / 2;     // closed: each half is a quarter-width out from the centre
    const p = toWorld(d.u - off, d.v), q = toWorld(d.u + off, d.v);
    a.position.set(p.x, 0, p.z);
    b.position.set(q.x, 0, q.z);
    a.rotation.y = b.rotation.y = -FRAME.theta;
  }

  // ---- lifecycle -----------------------------------------------------------------
  /** Build the set (once), and show or hide it by distance. Call every frame. */
  update(dt, { x, z, nightK = 0 } = {}) {
    this.clock += dt;
    const dist = Math.hypot(x - AT[0], z - AT[1]);
    if (!this.built && dist < BUILD_R && this.clock > STEP) {
      this.clock = 0;
      if (!this.f) this.f = this._find();
      if (this.f && this.world.terrain.ready(this.f.o[0][0], this.f.o[0][1])) {
        this.base = this._ground();
        this._build();
      }
    } else if (this.built && this.clock > STEP) {
      // the founding ground settles as the heights arrive: rebuild if it moved
      this.clock = 0;
      const g = this._ground();
      if (Math.abs(g - this.base) > 0.05) { this._dispose(); this.base = g; this._build(); }
    }
    if (!this.group) return;
    this.group.visible = dist < HIDE_R;
    if (!this.group.visible) return;
    if (Math.abs(nightK - this.nightK) > 0.01) { this.nightK = nightK; this.kit.night(nightK); }
    this._doors(dt, x, z);
  }
  /** Who is near the automatic doors, and how far each leaf has slid. */
  _doors(dt, x, z) {
    const t = Math.min(1, dt * DOOR_SPEED);
    for (const d of this.doors) {
      if (d.auto) {
        const w = toWorld(d.u, d.v);
        d.target = Math.hypot(x - w.x, z - w.z) < DOOR_R ? 1 : 0;
      }
      const before = d.k;
      d.k += (d.target - d.k) * t;
      if (Math.abs(d.k - before) > 1e-4 && d.leaves) this._placeLeaves(d);
    }
  }
  _build() {
    this.group = new THREE.Group();
    this.group.name = 'airport-terminal';
    this.scene.add(this.group);
    this.kit = stationKit(this.group);
    this.lift = this._lift();
    const ctx = ctxOf(this.kit, this.base + this.lift);
    ctx.lift = this.lift;
    buildInterior(ctx);
    buildFittings(ctx);
    this.kit.finish();
    this.boards = makeBoards(this.group, this.base + this.lift);
    this.boards.set(this.rows);
    for (const d of this.doors) this._leaves(d);
    this.built = true;
  }
  _dispose() {
    this.boards?.dispose();
    this.kit?.dispose();
    for (const d of this.doors) {
      if (!d.leaves) continue;
      d.leaves[0].geometry.dispose();
      d.leaves = null;
    }
    this.group?.removeFromParent();
    this.group = null;
    this.kit = null;
    this.boards = null;
    this.built = false;
  }
  dispose() { this._dispose(); this.f = null; }

  // ---- what the rest of the game asks ---------------------------------------------
  /** The terminal's floor under (x, z) at or below maxY, or null (city.supportY). */
  floor(x, z, maxY) {
    if (!this.f) return null;
    const { u, v } = toLocal(x, z);
    if (!inBuilding(u, v)) return null;
    const y = this.base + this.lift + 0.12;
    return y <= maxY ? y : null;
  }
  /** Is (x, z) under the terminal's roof? (The camera is kept short and low: js/main.js.) */
  covered(x, z) {
    const { u, v } = toLocal(x, z);
    return inBuilding(u, v);
  }
  /** The absolute underside of what is overhead at (x, z), or null outside the building. */
  lid(x, z) {
    const { u, v } = toLocal(x, z);
    if (!inBuilding(u, v)) return null;
    return this.base + this.lift + ceilingAt(u, v);
  }
  /** Would a camera at (x, z) be in another room than the one (tx, tz) is in? The boom comes in then. */
  outside(tx, tz, x, z) {
    const a = roomOf(tx, tz);
    if (!a) return false;
    return roomOf(x, z) !== a;
  }
  /**
   * What the closed doors stop a walker with (city.collide). Only walkers pass
   * opts.interior; the rest of the solids are static (js/landmarks-letiste.js).
   * Moves pos out of a closed leaf and returns true when it did.
   */
  collide(pos, r, opts) {
    if (!opts?.interior || !this.built) return false;
    const { u, v } = toLocal(pos.x, pos.z);
    let moved = false, nu = u, nv = v;
    for (const d of this.doors) {
      if (d.k > 0.5) continue;                       // open: nothing there
      if (Math.abs(nu - d.u) > d.w / 2 + r) continue;
      if (Math.abs(nv - d.v) > r + 0.06) continue;
      // push out on the side the walker is on, never through the leaf
      const side = nv >= d.v ? 1 : -1;
      nv = d.v + side * (r + 0.07);
      moved = true;
    }
    if (!moved) return false;
    const w = toWorld(nu, nv);
    pos.x = w.x; pos.z = w.z;
    return true;
  }
  /** Open or shut a gate's door (the gates are '1' and '2'). */
  setGate(id, open) {
    for (const d of this.doors) if (d.gate === String(id)) d.target = open ? 1 : 0;
  }
  /** The departures the boards show: [{ time, no, to, via, gate, status }]. */
  setBoard(rows) {
    this.rows = rows;
    this.boards?.set(rows);
  }
}
