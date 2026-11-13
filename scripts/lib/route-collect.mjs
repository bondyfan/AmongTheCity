// ---- public transport route relations, collected across extracts -------------
// scripts/split-extracts.mjs walks seven regional extracts one after another,
// and a bus line does not respect a regional border: Geofabrik puts the
// relation into EVERY extract it touches, each time with only the member ways
// that extract happens to hold. So a route cannot be finished inside one
// extract. This collector remembers, for the whole run:
//
//   routes   every type=route relation with route=bus|trolleybus|tram: its full
//            tags and its ordered member list (type, ref, role), nothing resolved
//   ways     the geometry of every member way that ANY extract could resolve
//   nodes    the position and tags of every member node, likewise
//   masters  type=route_master relations, which tie the two directions and the
//            short workings of one line together and often carry the colour
//
// and the union over the extracts is the route. Nothing here knows about tiles
// or game metres: coordinates stay WGS84 and the builder (scripts/lib/routes.mjs)
// does the projecting, the ordering and the owning.
//
// MEMORY. A member way is known only when the relation arrives, which is after
// every way of the extract has gone by, and a relation needs three things of a
// way that the splitter's own index does not keep: is it a tunnel or a bridge,
// what class of road or rail is it, and (for a platform) what is it called.
// Those are kept for EVERY way of the extract as one small integer in an array
// that grows in step with the splitter's (ids ascend, so it is a binary
// search), and dropped again when the extract ends.

const MODES = /^(bus|trolleybus|tram)$/;

// flag bits of a member way (the low byte of its meta)
export const WAY_TUNNEL = 1, WAY_BRIDGE = 2, WAY_ROUNDABOUT = 8, WAY_PLATFORM = 16,
  WAY_REVERSED = 64, WAY_AREA = 128;

const yes = (v) => v !== undefined && v !== 'no';

/** A node a route may call at: anything tagged as a stop, by either schema. */
const stopish = (t) => t.public_transport !== undefined || t.highway === 'bus_stop'
  || t.railway === 'tram_stop' || t.amenity === 'bus_station';

export class RouteCollector {
  constructor() {
    this.routes = new Map();
    this.masters = new Map();
    this.ways = new Map();      // id -> { f, c, n?, g: [[lat, lon], ...] }
    this.nodes = new Map();     // id -> { p: [lat, lon], t: tags | null }
    this._classes = [''];       // 'h:tertiary', 'r:tram', ... (index 0: neither)
    this._classIx = new Map([['', 0]]);
    this._reset();
  }

  _reset() {
    this._wid = [];             // way ids of the current extract, ascending
    this._wmeta = [];           // flags | class index << 8, same order
    this._wname = new Map();    // platform ways only
    this._stops = new Map();    // node id -> tags, stop-like nodes only
  }

  /** Every node of the extract that survived the world mask. */
  node(id, tags) { if (tags && stopish(tags)) this._stops.set(id, tags); }

  /** Every way of the extract whose nodes all resolved, in file order. */
  way(id, tags) {
    let f = 0, cls = '';
    if (tags) {
      if (yes(tags.tunnel)) f |= WAY_TUNNEL;
      if (yes(tags.bridge)) f |= WAY_BRIDGE;
      if (tags.junction === 'roundabout' || tags.junction === 'circular') f |= WAY_ROUNDABOUT;
      if (tags.public_transport === 'platform' || tags.highway === 'platform'
        || tags.railway === 'platform') { f |= WAY_PLATFORM; if (tags.name) this._wname.set(id, tags.name); }
      if (tags.oneway === '-1') f |= WAY_REVERSED;
      if (tags.area === 'yes') f |= WAY_AREA;
      cls = tags.highway !== undefined ? 'h:' + tags.highway
        : tags.railway !== undefined ? 'r:' + tags.railway : '';
    }
    let ci = this._classIx.get(cls);
    if (ci === undefined) { ci = this._classes.length; this._classes.push(cls); this._classIx.set(cls, ci); }
    this._wid.push(id);
    this._wmeta.push(f | (ci << 8));
  }

  _meta(id) {
    const a = this._wid;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = a[mid];
      if (v === id) return this._wmeta[mid];
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return 0;
  }

  /**
   * A relation of the extract. `resolve.way(ref)` gives [{lat, lon}, ...] or
   * null, `resolve.node(ref)` gives [lat, lon] or null. Returns true when the
   * relation was a transit route or a route master (and so is nobody else's).
   */
  relation(id, members, tags, resolve) {
    if (!tags) return false;
    if (tags.type === 'route_master') {
      if (!MODES.test(tags.route_master ?? '')) return false;
      if (!this.masters.has(id))
        this.masters.set(id, { id, tags, members: members.filter((m) => m.type === 'relation').map((m) => m.ref) });
      return true;
    }
    if (tags.type !== 'route' || !MODES.test(tags.route ?? '')) return false;
    for (const m of members) {
      if (m.type === 'way') {
        if (this.ways.has(m.ref)) continue;
        const g = resolve.way(m.ref);
        if (!g || g.length < 2) continue;
        const meta = this._meta(m.ref);
        const w = { f: meta & 255, c: this._classes[meta >> 8], g: g.map((q) => [q.lat, q.lon]) };
        const n = this._wname.get(m.ref);
        if (n) w.n = n;
        this.ways.set(m.ref, w);
      } else if (m.type === 'node') {
        if (this.nodes.has(m.ref)) continue;
        const p = resolve.node(m.ref);
        if (!p) continue;
        this.nodes.set(m.ref, { p, t: this._stops.get(m.ref) ?? null });
      }
    }
    // The member list is the same in every extract of one day. Should two
    // extracts disagree (different snapshot days), the fuller one wins: its
    // refs are the ones the way and node tables were filled for.
    const prev = this.routes.get(id);
    if (!prev || members.length > prev.members.length)
      this.routes.set(id, { id, tags, members: members.map((m) => [m.type[0], m.ref, m.role]) });
    return true;
  }

  endExtract() { this._reset(); }

  summary() {
    return `${this.routes.size} routes, ${this.masters.size} route masters, `
      + `${this.ways.size.toLocaleString()} member ways, ${this.nodes.size.toLocaleString()} member nodes`;
  }

  /** Deterministic: everything sorted by OSM id, whatever order the extracts came in. */
  toJSON() {
    const byId = (a, b) => a.id - b.id;
    const table = (map) => {
      const out = {};
      for (const k of [...map.keys()].sort((a, b) => a - b)) out[k] = map.get(k);
      return out;
    };
    return JSON.stringify({
      v: 1,
      routes: [...this.routes.values()].sort(byId),
      masters: [...this.masters.values()].sort(byId),
      ways: table(this.ways),
      nodes: table(this.nodes),
    });
  }
}
