// ---- Minimal .osm.pbf reader (protobuf + zlib, zero dependencies) ----
// The region pipeline used to ask Overpass for one bbox at a time. That worked
// for 72 tiles around Pardubice and falls apart at region scale: the Prague
// corridor is ~250 tiles, Overpass answers a dense Prague bbox with a runtime
// timeout more often than with data, and even a clean run is hours of polite
// 1.8 s waits. Geofabrik publishes the same data as daily .osm.pbf extracts
// (praha 42 MB, stredocesky 171 MB, kralovehradecky 56 MB, pardubicky 52 MB) —
// one download, no rate limit, no server to be unfair to.
//
// The format (https://wiki.openstreetmap.org/wiki/PBF_Format) is a sequence of
// length-prefixed blobs; each OSMData blob inflates to a PrimitiveBlock holding
// up to 8000 entities that share one string table and one coordinate origin.
// Everything here is the subset needed to walk that: varints, packed repeated
// fields, zigzag ints, delta coding. No .proto file, no codegen — the field
// numbers below ARE the schema, and they are frozen by the format spec.
//
// API: readPbf(path, { onNodes, onWay, onRelation }) — callbacks are handed
// plain JS objects, once per entity, in file order (nodes, then ways, then
// relations, as every sorted extract stores them).

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- protobuf --
// One cursor object per message, reused by the field loop. Buffers here are
// Node Buffers (Uint8Array), and every read advances `p`.
class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }

  varint() {                      // LEB128, unsigned, up to 64 bits
    const b = this.b;
    let lo = 0, hi = 0, shift = 0, byte;
    do {
      byte = b[this.p++];
      if (shift < 28) lo |= (byte & 0x7f) << shift;
      else if (shift < 56) hi += (byte & 0x7f) * Math.pow(2, shift - 28);
      shift += 7;
    } while (byte & 0x80);
    // < 2^53 in practice (OSM ids are ~1e10, coords ~1e9), so a double is exact
    return (lo >>> 0) + hi * 0x10000000;
  }

  // zigzag: OSM stores signed deltas as (n << 1) ^ (n >> 63)
  svarint() { const v = this.varint(); return (v % 2) ? -(v + 1) / 2 : v / 2; }

  skip(wire) {
    if (wire === 0) this.varint();
    // `this.p += this.varint()` would read the OLD p before varint() advanced
    // it, landing two bytes short of the next field — the length must be
    // pulled into a local first.
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else if (wire === 1) this.p += 8;
    else throw new Error(`pbf: wire type ${wire}`);
  }

  bytes() { const n = this.varint(), s = this.p; this.p = s + n; return this.b.subarray(s, this.p); }
  string() { const n = this.varint(), s = this.p; this.p = s + n; return this.b.toString('utf8', s, this.p); }
  // a length-delimited submessage as its own Reader, positioned past it here
  sub() { const n = this.varint(), s = this.p; this.p = s + n; return new Reader(this.b, s, this.p); }
}

// Walk `fields` of a message: fn(fieldNumber, wireType, reader). The callback
// MUST consume the field (or return false to let us skip it) — that contract
// keeps every parser below a flat switch with no bookkeeping.
function each(r, fn) {
  while (r.p < r.end) {
    const key = r.varint();
    if (fn(key >>> 3, key & 7, r) === false) r.skip(key & 7);
  }
}

// packed repeated varints → plain array (the JIT keeps these small and dense)
function packed(r, signed) {
  const sub = r.sub(), out = [];
  while (sub.p < sub.end) out.push(signed ? sub.svarint() : sub.varint());
  return out;
}

// ------------------------------------------------------------ block layer --
// PrimitiveBlock coordinates are integers in `granularity` nanodegree units
// offset by lat_offset/lon_offset — the defaults (100, 0, 0) mean 1e-7 degrees,
// which is ~1 cm, but a few extracts do use coarser grids so we read them.
function parsePrimitiveBlock(buf, cb) {
  const st = [];                       // string table, index 0 is always ''
  let granularity = 100, latOff = 0, lonOff = 0;
  const groups = [];
  each(new Reader(buf), (f, w, r) => {
    if (f === 1) { each(r.sub(), (sf, sw, sr) => { if (sf === 1) st.push(sr.string()); else return false; }); }
    else if (f === 2) groups.push(r.sub());
    else if (f === 17) granularity = r.varint();
    else if (f === 19) latOff = r.varint();
    else if (f === 20) lonOff = r.varint();
    else return false;
  });
  const toLat = (v) => (latOff + granularity * v) * 1e-9;
  const toLon = (v) => (lonOff + granularity * v) * 1e-9;

  for (const g of groups) {
    each(g, (f, w, r) => {
      if (f === 1) parseNode(r.sub(), st, toLat, toLon, cb);
      else if (f === 2) parseDense(r.sub(), st, toLat, toLon, cb);
      else if (f === 3) parseWay(r.sub(), st, cb);
      else if (f === 4) parseRelation(r.sub(), st, cb);
      else return false;                // changesets: never present in extracts
    });
  }
}

function tagsOf(keys, vals, st) {
  if (!keys.length) return null;
  const t = {};
  for (let i = 0; i < keys.length; i++) t[st[keys[i]]] = st[vals[i]];
  return t;
}

function parseNode(r, st, toLat, toLon, cb) {   // the rare non-dense encoding
  let id = 0, lat = 0, lon = 0, keys = [], vals = [];
  each(r, (f, w, rr) => {
    if (f === 1) id = rr.svarint();
    else if (f === 2) keys = packed(rr, false);
    else if (f === 3) vals = packed(rr, false);
    else if (f === 8) lat = rr.svarint();
    else if (f === 9) lon = rr.svarint();
    else return false;
  });
  cb.onNode?.(id, toLat(lat), toLon(lon), tagsOf(keys, vals, st));
}

// DenseNodes: ids and coordinates are delta-coded across the whole group, and
// tags are ONE flat int stream — key,val,key,val,0 per node — so a node with no
// tags costs a single zero byte. This is where ~90 % of an extract's bytes are.
function parseDense(r, st, toLat, toLon, cb) {
  let ids = [], lats = [], lons = [], kv = [];
  each(r, (f, w, rr) => {
    if (f === 1) ids = packed(rr, true);
    else if (f === 8) lats = packed(rr, true);
    else if (f === 9) lons = packed(rr, true);
    else if (f === 10) kv = packed(rr, false);
    else return false;                  // 5 = DenseInfo (version/timestamp/uid)
  });
  let id = 0, lat = 0, lon = 0, k = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]; lat += lats[i]; lon += lons[i];
    let tags = null;
    if (k < kv.length) {
      while (kv[k] !== 0) { (tags ??= {})[st[kv[k]]] = st[kv[k + 1]]; k += 2; }
      k++;                              // step over the terminating 0
    }
    cb.onNode?.(id, toLat(lat), toLon(lon), tags);
  }
}

function parseWay(r, st, cb) {
  let id = 0, keys = [], vals = [], refs = null;
  each(r, (f, w, rr) => {
    if (f === 1) id = rr.varint();
    else if (f === 2) keys = packed(rr, false);
    else if (f === 3) vals = packed(rr, false);
    else if (f === 8) { refs = packed(rr, true); let a = 0; for (let i = 0; i < refs.length; i++) refs[i] = (a += refs[i]); }
    else return false;
  });
  if (refs) cb.onWay?.(id, refs, tagsOf(keys, vals, st));
}

function parseRelation(r, st, cb) {
  let id = 0, keys = [], vals = [], roles = [], memids = null, types = [];
  each(r, (f, w, rr) => {
    if (f === 1) id = rr.varint();
    else if (f === 2) keys = packed(rr, false);
    else if (f === 3) vals = packed(rr, false);
    else if (f === 8) roles = packed(rr, false);
    else if (f === 9) { memids = packed(rr, true); let a = 0; for (let i = 0; i < memids.length; i++) memids[i] = (a += memids[i]); }
    else if (f === 10) types = packed(rr, false);
    else return false;
  });
  if (!memids) return;
  const members = memids.map((ref, i) => ({
    ref, type: types[i] === 0 ? 'node' : types[i] === 1 ? 'way' : 'relation', role: st[roles[i]] ?? '',
  }));
  cb.onRelation?.(id, members, tagsOf(keys, vals, st));
}

// -------------------------------------------------------------- file layer --
// Blobs are read with plain readSync into a reused buffer: the biggest extract
// is 171 MB and a whole-file read would be fine, but streaming keeps the peak
// RSS free for the node index the caller is building, which is the part that
// actually gets big.
export function readPbf(path, cb) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  const len4 = Buffer.allocUnsafe(4);
  let head = Buffer.allocUnsafe(1 << 16), body = Buffer.allocUnsafe(1 << 22);
  let pos = 0, blobs = 0;
  try {
    while (pos < size) {
      if (readSync(fd, len4, 0, 4, pos) < 4) break;
      const hLen = len4.readUInt32BE(0);
      pos += 4;
      if (hLen > head.length) head = Buffer.allocUnsafe(hLen);
      readSync(fd, head, 0, hLen, pos);
      pos += hLen;

      let type = '', dataSize = 0;
      each(new Reader(head, 0, hLen), (f, w, r) => {
        if (f === 1) type = r.string();
        else if (f === 3) dataSize = r.varint();
        else return false;
      });
      if (dataSize > body.length) body = Buffer.allocUnsafe(dataSize);
      readSync(fd, body, 0, dataSize, pos);
      pos += dataSize;

      // Blob: either stored raw (field 1) or deflated (field 3). Geofabrik
      // ships zlib; the others (lzma/lz4/zstd) would need a codec we do not
      // want as a dependency, so they fail loudly rather than silently empty.
      let raw = null;
      each(new Reader(body, 0, dataSize), (f, w, r) => {
        if (f === 1) raw = Buffer.from(r.bytes());
        else if (f === 3) raw = inflateSync(r.bytes());
        else if (f === 4 || f === 6 || f === 7) throw new Error('pbf: unsupported blob compression (only raw/zlib)');
        else return false;
      });
      if (type === 'OSMData' && raw) { parsePrimitiveBlock(raw, cb); cb.onBlob?.(++blobs, pos, size); }
    }
  } finally { closeSync(fd); }
  return blobs;
}
