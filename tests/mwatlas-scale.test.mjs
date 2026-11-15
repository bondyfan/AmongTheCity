// The motorway sign atlas at half size on the low preset (js/mwatlas.js
// setMotorwayAtlasScale): same faces at the same uvs, a quarter of the bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { MW_ATLAS_W, MW_ATLAS_H } from '../js/mwfaces.js';

register(new URL('./three-alias.mjs', import.meta.url));
const { setMotorwayAtlasScale, motorwayAtlasBytes, paintMotorwayAtlas } = await import('../js/mwatlas.js');

// A 2D context that accepts every call and records the transforms.
function fakeCanvas(w, h) {
  const calls = [];
  const g = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
      if (k === 'setTransform') return (...a) => calls.push(a);
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { width: w, height: h, calls, getContext: () => g };
}
const fakeMat = (painted) => {
  const cv = fakeCanvas(MW_ATLAS_W, MW_ATLAS_H);
  let disposed = 0;
  const tex = { needsUpdate: false, dispose() { disposed++; } };
  return { cv, tex, disposed: () => disposed, mat: { userData: { atlas: { cv, tex, painted, scale: 1 } } } };
};

test('the low preset atlas is a quarter of the bytes', () => {
  assert.ok(motorwayAtlasBytes(1) > 19e6 && motorwayAtlasBytes(1) < 20e6);
  assert.ok(Math.abs(motorwayAtlasBytes(0.5) * 4 - motorwayAtlasBytes(1)) < 4);
});

test('before the first sign is drawn only the empty canvas is resized', () => {
  const f = fakeMat(false);
  assert.equal(setMotorwayAtlasScale(f.mat, 0.5), true);
  assert.equal(f.cv.width, MW_ATLAS_W / 2);
  assert.equal(f.cv.height, MW_ATLAS_H / 2);
  assert.equal(f.disposed(), 0);
  assert.equal(f.cv.calls.length, 0, 'nothing painted yet');
  // a repeat is a no-op, and back to full size restores the canvas
  assert.equal(setMotorwayAtlasScale(f.mat, 0.5), false);
  assert.equal(setMotorwayAtlasScale(f.mat, 1), true);
  assert.equal(f.cv.width, MW_ATLAS_W);
});

test('after it, the atlas is repainted through a scale and re-uploaded', () => {
  const f = fakeMat(true);
  assert.equal(setMotorwayAtlasScale(f.mat, 0.5), true);
  assert.equal(f.disposed(), 1);
  assert.equal(f.tex.needsUpdate, true);
  // painted in atlas pixels through a half scale, so mwUV fractions still hit the same faces
  assert.deepEqual(f.cv.calls[0], [0.5, 0, 0, 0.5, 0, 0]);
  assert.deepEqual(f.cv.calls.at(-1), [1, 0, 0, 1, 0, 0]);
});

test('a material without an atlas (node, the worker) is left alone', () => {
  assert.equal(setMotorwayAtlasScale({ userData: {} }, 0.5), false);
  assert.equal(setMotorwayAtlasScale(undefined, 0.5), false);
  const cv = fakeCanvas(MW_ATLAS_W, MW_ATLAS_H);
  assert.ok(Number.isFinite(paintMotorwayAtlas(cv)));
});
