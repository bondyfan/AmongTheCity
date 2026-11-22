// ---- Minimal GeoTIFF window reader (zero dependencies) ----
// Mahé's relief (Copernicus DEM GLO-30) and land cover (ESA WorldCover) come
// as Cloud Optimised GeoTIFFs: one 1°×1° float32 tile and one 3°×3° byte tile.
// The island is a few thousand pixels of either, so this reads a WINDOW: only
// the internal tiles (or strips) that intersect it are inflated. A whole
// WorldCover tile would be 36 000² bytes, 1.3 GB, for a 2 200 × 2 900 crop.
//
// Supported, because it is what those two products use: classic (not Big)
// TIFF, either byte order, tiled or stripped, compression none / LZW /
// DEFLATE, predictor 1 / 2 (integer differencing) / 3 (floating point), one
// sample per pixel, 8-bit unsigned or 32-bit float. Anything else throws with
// the tag that was not understood, rather than returning wrong numbers.
//
//   const tif = openTiff(path)          → { width, height, geo: { x0, y0, dx, dy }, nodata, close() }
//   readWindow(tif, col0, row0, w, h)   → Float32Array | Uint8Array, row-major

import { openSync, readSync, closeSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (n <= 0) throw new Error('tiff: short read at ' + pos);
    got += n;
  }
  return b;
}

export function openTiff(path) {
  const fd = openSync(path, 'r');
  const head = readAt(fd, 0, 8);
  const le = head.toString('latin1', 0, 2) === 'II';
  if (!le && head.toString('latin1', 0, 2) !== 'MM') throw new Error('tiff: not a TIFF ' + path);
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(head, 2) !== 42) throw new Error('tiff: BigTIFF or unknown version ' + u16(head, 2));
  const ifd = u32(head, 4);
  const cnt = u16(readAt(fd, ifd, 2), 0);
  const ents = readAt(fd, ifd + 2, cnt * 12);
  const tags = new Map();
  for (let k = 0; k < cnt; k++) {
    const o = k * 12, tag = u16(ents, o), type = u16(ents, o + 2), n = u32(ents, o + 4);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const data = size <= 4 ? ents.subarray(o + 8, o + 12) : readAt(fd, u32(ents, o + 8), size);
    const vals = [];
    if (type === 2) { tags.set(tag, data.toString('latin1', 0, n).replace(/\0+$/, '')); continue; }
    for (let i = 0; i < n; i++) {
      if (type === 3) vals.push(u16(data, i * 2));
      else if (type === 4) vals.push(u32(data, i * 4));
      else if (type === 12) vals.push(le ? data.readDoubleLE(i * 8) : data.readDoubleBE(i * 8));
      else if (type === 1 || type === 7) vals.push(data[i]);
      else if (type === 16) vals.push(Number(le ? data.readBigUInt64LE(i * 8) : data.readBigUInt64BE(i * 8)));
      else throw new Error('tiff: tag ' + tag + ' has field type ' + type);
    }
    tags.set(tag, vals);
  }
  const one = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);
  const tif = {
    fd, le, tags,
    width: one(256), height: one(257),
    bits: one(258, 1), compression: one(259, 1), predictor: one(317, 1),
    spp: one(277, 1), format: one(339, 1),
    tileW: one(322, 0), tileH: one(323, 0),
    offsets: tags.get(324) ?? tags.get(273), counts: tags.get(325) ?? tags.get(279),
    rowsPerStrip: one(278, one(257)),
    nodata: tags.has(42113) ? Number(tags.get(42113)) : null,
    close() { closeSync(fd); },
  };
  if (tif.spp !== 1) throw new Error('tiff: ' + tif.spp + ' samples per pixel');
  if (!((tif.bits === 8 && tif.format === 1) || (tif.bits === 32 && tif.format === 3)))
    throw new Error(`tiff: ${tif.bits}-bit format ${tif.format} is not read here`);
  if (![1, 5, 8, 32946].includes(tif.compression)) throw new Error('tiff: compression ' + tif.compression);
  // Georeference: pixel scale + one tie point (GDAL writes exactly these)
  const sc = tags.get(33550), tp = tags.get(33922);
  if (sc && tp) tif.geo = { x0: tp[3] - tp[0] * sc[0], y0: tp[4] + tp[1] * sc[1], dx: sc[0], dy: -sc[1] };
  return tif;
}

// TIFF LZW: MSB-first codes, 9..12 bits, the "early change" every writer uses
function lzw(src, outLen) {
  const out = new Uint8Array(outLen);
  let op = 0, bitPos = 0, width = 9;
  const dictS = new Int32Array(4096), dictL = new Int32Array(4096);   // start in `out`, length
  let next = 258, prev = -1;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = src[(bitPos + i) >> 3];
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  const lit = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lit[i] = i;
  while ((bitPos + width) <= src.length * 8) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    const start = op;
    if (code < 256) { if (op < outLen) out[op++] = code; }
    else if (code < next && dictL[code] > 0) {
      const s = dictS[code], l = dictL[code];
      for (let i = 0; i < l && op < outLen; i++) out[op++] = out[s + i];
    } else if (prev >= 0) {   // KwKwK: the previous string plus its own first byte
      const s = prev < 256 ? -1 : dictS[prev], l = prev < 256 ? 1 : dictL[prev];
      const first = prev < 256 ? prev : out[s];
      for (let i = 0; i < l && op < outLen; i++) out[op++] = prev < 256 ? prev : out[s + i];
      if (op < outLen) out[op++] = first;
    }
    if (prev >= 0 && next < 4096) {
      const ps = prev < 256 ? -1 : dictS[prev], pl = prev < 256 ? 1 : dictL[prev];
      // the new entry is prev's string followed by this one's first byte; both
      // already sit contiguously in `out` just before `start`
      dictS[next] = start - pl; dictL[next] = pl + 1;
      void ps;
      next++;
    }
    if (next + 1 >= (1 << width) && width < 12) width++;
    prev = code;
  }
  return out;
}

function decodeBlock(tif, i, bw, bh) {
  const bps = tif.bits / 8, len = bw * bh * bps;
  const raw = readAt(tif.fd, tif.offsets[i], tif.counts[i]);
  let buf = tif.compression === 1 ? raw : tif.compression === 5 ? lzw(raw, len) : inflateSync(raw);
  if (buf.length < len) { const b = Buffer.alloc(len); b.set(buf); buf = b; }
  buf = Uint8Array.prototype.slice.call(buf, 0, len);
  if (tif.predictor === 2) {
    if (bps !== 1) throw new Error('tiff: predictor 2 on ' + tif.bits + '-bit data');
    for (let r = 0; r < bh; r++) for (let c = 1; c < bw; c++) buf[r * bw + c] = (buf[r * bw + c] + buf[r * bw + c - 1]) & 255;
  } else if (tif.predictor === 3) {
    // floating point: each row is byte-differenced, then its bytes are planes
    // (all most significant bytes first), always in big-endian significance
    const row = new Uint8Array(bw * bps);
    for (let r = 0; r < bh; r++) {
      const o = r * bw * bps;
      for (let k = 1; k < bw * bps; k++) buf[o + k] = (buf[o + k] + buf[o + k - 1]) & 255;
      for (let c = 0; c < bw; c++) for (let b = 0; b < bps; b++) row[c * bps + (bps - 1 - b)] = buf[o + b * bw + c];
      buf.set(row, o);   // now little-endian per sample
    }
    return new Float32Array(buf.buffer, buf.byteOffset, bw * bh);
  } else if (tif.predictor !== 1) throw new Error('tiff: predictor ' + tif.predictor);
  if (bps === 1) return buf;
  // float32 without predictor 3: the file's own byte order
  const f = new Float32Array(bw * bh), dv = new DataView(buf.buffer, buf.byteOffset, len);
  for (let k = 0; k < bw * bh; k++) f[k] = dv.getFloat32(k * 4, tif.le);
  return f;
}

export function readWindow(tif, col0, row0, w, h) {
  const out = tif.bits === 8 ? new Uint8Array(w * h) : new Float32Array(w * h);
  if (tif.nodata !== null && tif.bits === 32) out.fill(tif.nodata);
  const tiled = tif.tileW > 0;
  const bw = tiled ? tif.tileW : tif.width, bh = tiled ? tif.tileH : tif.rowsPerStrip;
  const across = tiled ? Math.ceil(tif.width / bw) : 1;
  const c0 = Math.max(0, col0), r0 = Math.max(0, row0);
  const c1 = Math.min(tif.width, col0 + w), r1 = Math.min(tif.height, row0 + h);
  for (let by = Math.floor(r0 / bh); by * bh < r1; by++) {
    for (let bx = Math.floor(c0 / bw); bx * bw < c1; bx++) {
      const blk = decodeBlock(tif, by * across + bx, bw, bh);
      for (let y = Math.max(r0, by * bh); y < Math.min(r1, (by + 1) * bh); y++) {
        for (let x = Math.max(c0, bx * bw); x < Math.min(c1, (bx + 1) * bw); x++)
          out[(y - row0) * w + (x - col0)] = blk[(y - by * bh) * bw + (x - bx * bw)];
      }
    }
  }
  return out;
}
