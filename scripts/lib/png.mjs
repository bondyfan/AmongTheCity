// ---- just enough PNG to read a photograph of the ground -------------------
// The pipeline already hand-decodes ČÚZK's BSQ float rasters rather than take a
// dependency for it, and this is the same trade: one screenful of code against
// an npm install that a fresh clone would have to do before the world could be
// rebuilt. Node brings the hard part (zlib) already.
//
// Scope is deliberately narrow — what the ČÚZK WMS actually serves for
// FORMAT=image/png: 8 bits per channel, colour type 2 (RGB) or 6 (RGBA), no
// interlacing, no palette. Anything else throws rather than guessing, because a
// silently misread photograph would classify a city as a meadow.

import { inflateSync } from 'node:zlib';

const PAETH = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** @returns {{ w: number, h: number, rgb: Uint8Array }} three bytes per pixel */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tag = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} unsupported`);
  if (type !== 2 && type !== 6) throw new Error(`PNG colour type ${type} unsupported`);
  if (interlace) throw new Error('interlaced PNG unsupported');
  const bpp = type === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 3);
  // Un-filter in place, one scanline at a time, each referring to the one above
  const line = new Uint8Array(stride), prev = new Uint8Array(stride);
  let r = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[r++];
    raw.copy(line, 0, r, r + stride);
    r += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      line[i] = (line[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1)
        : f === 4 ? PAETH(a, b, c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 3;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
    }
    prev.set(line);
  }
  return { w, h, rgb: out };
}
