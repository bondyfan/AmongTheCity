// ---- Vehicles: the cars + arcade drive physics (v6: real sheet metal) ----
// Cars are the city's second citizens: traffic.js marches a swarm of them
// along the road graph (setting x/z/heading/speed directly) and the player
// steals one and drives it through driveStep(). Geometry is built ONCE per
// kind and materials are cached per paint color, so traffic can churn cars
// at the despawn ring without allocating anything that matters.
//
// v6 keeps v5's SILHOUETTES and replaces everything that was hung on them. The
// KIND table below still describes each body as a side profile through a
// handful of stations, and a greenhouse over it; the cabin, the seats and the
// first-person eye are still derived from exactly those numbers. But the hull
// that used to be lofted straight through the nine stations with 8-point rings
// (about 900 faceted triangles, in matte Lambert) is now built by three
// sibling modules:
//
//   carbody.js    splines the stations into a smooth surface with a proper
//                 cross-section, cuts round wheel arches into it, and can drape
//                 any flat outline onto it (that is how glass, lamps, grilles
//                 and shut lines are made: flush, and any shape)
//   cardetail.js  the per-kind drawings: what makes an Octavia an Octavia
//   carwheels.js  tyre, rim, spokes and brake disc as ONE mesh a corner
//   carpaint.js   clearcoat paint, reflective glass, one vertex-coloured PBR
//                 material for all the fixed-colour trim, gated lamps, and the
//                 instanced contact shadows
//
// A near car is about 6.5k triangles in 11 draw calls (it was 900 in 16 to
// 18); past 60 m it swaps to a 1k-triangle variant in 4. Brands still ride the
// tiny cached CanvasTextures (the Škoda roundel, BMW quadrants, the Mercedes
// star, the Tesla T) plus a deterministic Czech "5E" plate hashed from
// kind+paint. Legacy kind names (sedan/hatch/kombi/suv) still resolve through
// ALIAS, and the machinery underneath is untouched: the
// a = accel·(1 − v/vmax)^1.3 power curve, the tyre model, two-circle car-car
// collision, and the offroad shake.
//
// Convention (ARCHITECTURE.md): heading 0 faces −z (north); a mesh authored
// facing −z with mesh.rotation.y = heading moves along
// (dirX, dirZ) = (−sin h, −cos h); the right-hand side is (cos h, −sin h).
// ctl.steer > 0 means steer RIGHT, which in this frame DECREASES heading.

import * as THREE from 'three';
import { CAR, CAR_COLORS } from './config.js';
import { detailMat, headMat, tailMat, brakeMat, carNight, makeContactShadows } from './carpaint.js';
import { buildCar } from './cardetail.js';
import { ATLAS, mergedBodies } from './carmerge.js';
import { BODY_U } from './carbodymat.js';
import { dressCar, bindCar, setCarState, carMergeOn } from './carmesh.js';
import { hookScene, setCarInstancing, carInstancingOn, carInstanceStats } from './carinstances.js';
import { attachTrailer, updateTrailer, updateBlink } from './semitrailer.js';   // round 8: the articulated lorry, indicators
import { crash, sfxAt, skidChirp, skidBark } from './audio.js';   // no-ops headless — safe for node --check/tests

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ---- outbound one-shot events (F20) --------------------------------------
// Ramming a wall knocks pieces off the facade — locally, through
// world.damageBuilding(), and until now ONLY locally: the peer watching you
// demolish a shopfront saw an intact shopfront. The wall damage has to travel.
//
// It travels through a SINK, not through an import of the net layer. vehicles.js
// is the physics of a single-player game that happens to have multiplayer
// bolted on: it must keep working — and keep importing — with no netcity.js in
// the build at all (tests, single player, `node --check`). So the net layer
// installs itself here and unsets itself on dispose; with nothing installed
// the events evaporate, which is exactly what single player wants. Whoever
// installs the sink forwards to netcity's queueEvent().
//
// THE RATE LIMIT IS THE POINT, not decoration. Every event we emit becomes a
// demolition on every other client in the room. A modified client (or an
// honest one wedged nose-first against a wall) that emitted per frame would be
// a denial of service on everyone else's frame budget, and no receiver can
// tell "he really is crashing a lot" from an attack. So the cap lives at the
// SOURCE too, as a token bucket: EV_BURST back-to-back events (a genuine
// multi-car pile-up), then EV_RATE per second sustained. Dropped events are
// dropped silently — the local damage already happened, the remote copy of one
// facade chip is worth nothing.
const EV_BURST = 4;      // tokens
const EV_RATE = 2;       // tokens/s refill
let _evSink = null;
let _evTokens = EV_BURST;
let _evT = 0;            // ms timestamp of the last refill

// setVehicleEventSink(fn | null) — fn(type, data). Install once from main.js
// when a net session starts, pass null when it ends.
export function setVehicleEventSink(fn) {
  _evSink = typeof fn === 'function' ? fn : null;
}
function emitVehicleEvent(type, data) {
  if (!_evSink) return false;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (_evT) _evTokens = Math.min(EV_BURST, _evTokens + (now - _evT) / 1000 * EV_RATE);
  _evT = now;
  if (_evTokens < 1) return false;
  _evTokens -= 1;
  try { _evSink(type, data); } catch {}   // a broken sink must not stop the car
  return true;
}

// ---- shared materials -------------------------------------------------------
// The paint, the glass, the one vertex-coloured detail material and the lamps
// all live in carpaint.js now (PBR, and a per-vertex gate on the lamps). What
// stays here is the handle main.js has always driven at dusk: one assignment
// to lampMats.head / .tail still lights every car in the city, and
// lampMats.night(k) tells the same shaders how dark it is (the projectors, the
// tail clusters and the fallback sky follow it). The one-draw body material
// (js/carbodymat.js) reads the same three objects through getters, so the
// handle still reaches every car whichever way it is drawn.
// chrome for the CABIN only (the interior is Lambert and unlit by design)
const chromeMat = new THREE.MeshLambertMaterial({ color: 0xd4dae2 });
export const lampMats = { head: headMat, tail: tailMat, brake: brakeMat, night: carNight };
export { carNight };

// ---- brand badges: tiny CanvasTextures drawn once, cached forever ----
// A 13 cm plane on the nose is only ever seen from a few meters, so 128 px is
// plenty. Each brand draws with plain 2D paths (no assets, no fetches) once,
// and is copied into the decal atlas of every kind and colour that wears it
// (decalTexFor below). The body shader's depth rung floats the decal off the
// paint it sits a centimetre in front of.
const _badgeCv = new Map();
function drawBadge(brand) {
  let cached = _badgeCv.get(brand);
  if (cached) return cached;
  const cv = document.createElement('canvas');
  // 256 device pixels, still AUTHORED in the original 128 grid: the canvas is
  // scaled once so every path below reads the way it was written, at twice the
  // resolution. Škoda needed it — the winged arrow is a mark made of thin
  // strokes, and at 128 its feathers fell on half-pixels and blurred together.
  cv.width = cv.height = 256;
  const x = cv.getContext('2d'), c = 64;
  x.scale(2, 2);
  const disc = (r, col) => { x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.fillStyle = col; x.fill(); };
  const ring = (r, w, col) => { x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.lineWidth = w; x.strokeStyle = col; x.stroke(); };
  if (brand === 'skoda') {
    // The okřídlený šíp — and it is a SILHOUETTE, not line art. One solid wing
    // fills the upper two thirds: a lobe on the right, three feathers fanning
    // up-LEFT, the feathers being slits CUT INTO the mass. It sits on an arrow
    // crossing the lower third pointing RIGHT, barbed head at one end,
    // fletched tail at the other. Two earlier passes drew the mark as strokes
    // — a pair of swooshes, then a shaft with ribs and a hollow eye — and
    // strokes are the one thing that cannot survive here: the badge is 27 px
    // on screen at five metres, and an 8-unit stroke is 1.2 of those pixels.
    // The ink has to be ~40 % of the field, the way the real badge is, or the
    // roundel reads as an empty green dot.
    // The field is lighter than the flat-art #0E3A2F on purpose: this is a
    // Lambert material multiplied by scene light, and the official green goes
    // to black at the brightness a bonnet actually sits at.
    const green = '#12563e';
    disc(62, '#0a100d');             // dark rim — holds an edge against white paint
    disc(55.5, green);
    ring(58, 5.5, '#cfd6d9');        // chrome, ~4 % of the diameter like the real one
    x.fillStyle = '#f4f7f5';
    x.beginPath();
    x.moveTo(84.6, 87.3);                                   // shaft top, under the lobe
    x.bezierCurveTo(86.0, 83.6, 103.3, 42.3, 69.3, 14.2);   // the lobe's right flank, to the crest
    x.quadraticCurveTo(58.9, 17.7, 48.1, 16.6);             // feather 1, outer edge
    x.bezierCurveTo(49.2, 17.5, 61.0, 27.2, 66.6, 39.1);    // feather 1, underside
    x.lineTo(64.9, 39.6);                                   // slit 1
    x.bezierCurveTo(61.9, 36.2, 50.7, 24.0, 40.1, 20.0);    // feather 2, top
    x.quadraticCurveTo(33.9, 27.6, 25.3, 32.4);             // feather 2, outer edge
    x.bezierCurveTo(30.2, 34.9, 43.2, 42.7, 48.2, 48.7);    // feather 2, underside
    x.lineTo(46.8, 49.5);                                   // slit 2
    x.bezierCurveTo(37.7, 42.6, 21.6, 39.0, 20.8, 38.8);    // feather 3, top
    x.quadraticCurveTo(19.5, 48.9, 14.4, 57.7);             // feather 3, outer edge
    x.bezierCurveTo(39.3, 62.7, 46.1, 74.3, 47.2, 87.3);    // the underside, onto the shaft
    x.lineTo(42.5, 87.3);
    x.lineTo(34.4, 83.8); x.lineTo(17.9, 83.5);             // the fletched tail
    x.quadraticCurveTo(24.3, 90.2, 28.0, 98.7);
    x.lineTo(34.4, 98.7); x.lineTo(42.5, 95.1);
    x.lineTo(89.7, 95.1);                                   // shaft, bottom edge
    x.lineTo(91.1, 98.9);                                   // lower barb
    x.quadraticCurveTo(97.6, 92.5, 106.5, 91.2);            // the point
    x.quadraticCurveTo(97.6, 89.9, 91.1, 83.5);             // upper barb
    x.closePath(); x.fill();
    // the real slits are 1.7 units wide; a mip chain closes them and the wing
    // becomes a paddle, so re-open them to something that survives
    x.strokeStyle = green; x.lineWidth = 2.5; x.lineCap = 'round';
    x.beginPath(); x.moveTo(65.5, 39.3); x.quadraticCurveTo(57, 29, 44.5, 18.3); x.stroke();
    x.beginPath(); x.moveTo(47.5, 49.0); x.quadraticCurveTo(37, 42, 22.5, 35.5); x.stroke();
  } else if (brand === 'bmw') {
    disc(60, '#111417');
    const q = ['#e8edf2', '#2e6cb5'];   // alternating quadrants, boundaries at 12/3/6/9
    for (let i = 0; i < 4; i++) {
      x.beginPath(); x.moveTo(c, c);
      x.arc(c, c, 42, -Math.PI / 2 + i * Math.PI / 2, -Math.PI / 2 + (i + 1) * Math.PI / 2);
      x.closePath(); x.fillStyle = q[i & 1]; x.fill();
    }
    ring(50, 4, '#3c4248');
  } else if (brand === 'mb') {
    // three thin spokes at 120° in a silver ring — the star reads even at 8 px
    disc(60, '#22262b'); ring(52, 7, '#d7dde4');
    x.fillStyle = '#d7dde4';
    for (const a of [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6]) {
      const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2);
      x.beginPath();
      x.moveTo(c + Math.cos(a) * 50, c + Math.sin(a) * 50);
      x.lineTo(c + px * 9, c + py * 9); x.lineTo(c - px * 9, c - py * 9);
      x.closePath(); x.fill();
    }
    disc(8, '#d7dde4');
  } else if (brand === 'tesla') {
    // the T on transparent ground: curved top bar + tapering blade
    x.fillStyle = '#d8dde3';
    x.beginPath(); x.moveTo(18, 36); x.quadraticCurveTo(64, 20, 110, 36);
    x.lineTo(102, 50); x.quadraticCurveTo(64, 36, 26, 50); x.closePath(); x.fill();
    x.beginPath(); x.moveTo(52, 40); x.quadraticCurveTo(64, 46, 76, 40);
    x.lineTo(68, 112); x.lineTo(60, 112); x.closePath(); x.fill();
  } else {
    // 'plain': the fleet-van roundel — VW-ish monogram, deliberately generic
    disc(60, '#2b2f34'); ring(52, 6, '#c9cfd6');
    x.strokeStyle = '#c9cfd6'; x.lineWidth = 7; x.lineJoin = 'miter';
    x.beginPath(); x.moveTo(42, 32); x.lineTo(64, 62); x.lineTo(86, 32); x.stroke();
    x.beginPath(); x.moveTo(32, 62); x.lineTo(46, 96); x.lineTo(64, 70); x.lineTo(82, 96); x.lineTo(96, 62); x.stroke();
  }
  _badgeCv.set(brand, cv);
  return cv;
}

// ---- license plates: white EU plate, Pardubice's "5E" series ----
// The registration hashes off kind+paint so it is DETERMINISTIC — the same
// blue Octavia always wears the same number, front and rear, without storing
// anything per car. The cache is bounded by |kinds| × |color pools|.
function drawPlate(kind, hex) {
  let h = hex >>> 0;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 0x01000193) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  const d = (s) => (h >>> s) % 10;
  const text = `5E${1 + (h % 9)} ${d(3)}${d(7)}${d(11)}${d(15)}`;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 56;
  const x = cv.getContext('2d');
  x.fillStyle = '#f2f4f6'; x.fillRect(0, 0, 256, 56);
  x.strokeStyle = '#22262b'; x.lineWidth = 6; x.strokeRect(0, 0, 256, 56);
  x.fillStyle = '#20449c'; x.fillRect(3, 3, 30, 50);   // the EU band
  x.fillStyle = '#f5d02c'; x.font = 'bold 13px sans-serif'; x.textAlign = 'center';
  x.fillText('CZ', 18, 46);
  x.fillStyle = '#171a1e'; x.font = 'bold 40px sans-serif';
  x.fillText(text, 145, 42);
  return cv;
}

// ---- the decal atlas: plate and badge on one canvas per kind and colour -----
// The body is one draw (carmerge.js), so its two decals share one texture: the
// badge in the top 128 rows, the plate in the bottom 56 (carmerge.js ATLAS has
// the layout). Bounded like the plates always were, by kinds x colour pools.
const _decals = new Map();
function decalTexFor(kind, hex) {
  const key = kind + '|' + hex;
  let t = _decals.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = ATLAS.w; cv.height = ATLAS.h;
  const x = cv.getContext('2d');
  const brand = KIND[kind]?.brand;
  if (brand) x.drawImage(drawBadge(brand), 0, 0, ATLAS.w, ATLAS.h - 64);
  x.drawImage(drawPlate(kind, hex), 0, ATLAS.h - 56, 256, 56);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _decals.set(key, t);
  return t;
}

// ---- per-kind silhouette + engine specs ----
// hull: the lower body's side profile. sts = stations [z, yLo, yHi, w]
// front→rear (w is a fraction of wid/2). yA/yB place the arch line and the
// doorline, sh tucks the shoulders in, bw tucks the rocker under. The PROFILE
// is the identity: the Octavia's belt climbs into a liftback deck, the Fabia
// chops off high and early, the BMW sits 4 cm lower than anything Czech, the
// Mercedes stretches 20 cm statelier, the Tesla droops its grille-less nose.
//
// green: the greenhouse. sts = [z, yBase, yRoof]; baseW/topW are its half
// widths at the belt and at the roof (the tumblehome), and the segment list
// says which stretches of the side are glass ('g') and which are pillar
// ('p'). Truck and bus have no greenhouse: their glass is drawn straight onto
// the slab-sided hull.
//
// THESE NUMBERS ARE THE SKELETON, NOT THE SKIN. The cabin (cabinSpec,
// seatAnchor, eyeAnchor) is cut from them exactly as written, so they must
// not drift. The exterior is carbody.js's smooth surface THROUGH them, and
// cardetail.js may restyle a nose or a tail for the outside only (its STYLE
// table), always outward of what is written here so the interior still fits.
//
// Engine: accel is the PEAK m/s² fed into a = accel·(1 − v/vmax)^1.3 — 0–100:
// octavia ~5.7 s, fabia ~6.6, bmw ~4.3, mercedes ~4.6, tesla ~3.2, van ~14.5,
// truck ~20 s to 80, bus ~17 to 80. grip is the lateral damping the drift
// model starts from; mass is tonnes-ish and only its RATIOS matter. Physics
// reads len/wid off the car, so a bus really is a wall on wheels.
const KIND = {
  // Škoda Octavia IV liftback — the Czech default car: slim high grille slit,
  // long bonnet, and the one long roofline that rakes shallow (~22°) all the
  // way into the tail deck. C-pillar is a paint sail panel, like the real one.
  octavia: {
    len: 4.7, wid: 1.81, wheelR: 0.32, axle: 1.45,
    accel: 7.0, vmax: 64, grip: 7.6, mass: 1.45,
    brand: 'skoda',
    badgeF: { size: 0.13, y: 0.50, dz: -0.02 }, badgeR: { size: 0.11, y: 0.64, dz: 0.02 },
    plateF: 0.40, plateR: 0.44,
    hull: { sh: 0.84, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.35, 0.30, 0.52, 0.66], [-2.24, 0.22, 0.66, 0.84], [-1.95, 0.18, 0.74, 0.93],
      [-1.10, 0.16, 0.84, 0.99], [-0.65, 0.16, 0.88, 1.00], [0.60, 0.16, 0.90, 1.00],
      [1.55, 0.16, 0.93, 0.97], [2.10, 0.20, 0.90, 0.89], [2.35, 0.26, 0.82, 0.78]] },
    green: { baseW: 0.88, topW: 0.68, sts: [
      [-0.72, 0.87, 0.90], [-0.02, 0.88, 1.44], [0.30, 0.885, 1.44],
      [0.44, 0.885, 1.435], [1.30, 0.90, 1.40], [2.06, 0.90, 0.94]],
      segs: ['gp', 'pg', 'pp', 'pg', 'gp'] },
  },
  // Škoda Fabia IV hatchback — 60 cm shorter, belt lower, and the greenhouse
  // pinches shut a hand's width from the tail: the upright hatch cut
  fabia: {
    len: 4.1, wid: 1.74, wheelR: 0.31, axle: 1.28,
    accel: 6.5, vmax: 56, grip: 7.9, mass: 1.15,
    brand: 'skoda',
    badgeF: { size: 0.13, y: 0.49, dz: -0.02 }, badgeR: { size: 0.11, y: 0.62, dz: 0.02 },
    plateF: 0.40, plateR: 0.44,
    hull: { sh: 0.84, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.05, 0.30, 0.52, 0.68], [-1.95, 0.22, 0.64, 0.85], [-1.70, 0.18, 0.72, 0.93],
      [-0.95, 0.16, 0.80, 0.99], [-0.50, 0.16, 0.84, 1.00], [0.55, 0.16, 0.86, 1.00],
      [1.30, 0.16, 0.88, 0.97], [1.85, 0.20, 0.86, 0.92], [2.05, 0.28, 0.80, 0.84]] },
    green: { baseW: 0.88, topW: 0.70, sts: [
      [-0.58, 0.83, 0.86], [0.05, 0.84, 1.42], [0.32, 0.845, 1.42],
      [0.46, 0.845, 1.415], [1.35, 0.85, 1.40], [1.88, 0.84, 0.92]],
      segs: ['gp', 'pg', 'pp', 'pg', 'gp'] },
  },
  // BMW 3-series G20 — the whole hull rides ~4 cm lower, the cabin is pushed
  // rearward behind a long bonnet, and the boot deck runs on past the glass:
  // a true three-box sedan next to the two Czech shapes. Roundel lies nearly
  // flat on the bonnet lip, the way BMW actually mounts it.
  bmw: {
    len: 4.7, wid: 1.86, wheelR: 0.33, axle: 1.44,
    accel: 9.0, vmax: 69, grip: 8.6, mass: 1.7,
    driveRear: 0.95,          // rear-wheel drive: the throttle lives in the rear circle
    brand: 'bmw',
    badgeF: { size: 0.12, y: 0.675, dz: 0.29, rx: -1.33 }, badgeR: { size: 0.10, y: 0.62, dz: 0.02 },
    plateF: 0.38, plateR: 0.42,
    hull: { sh: 0.82, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.35, 0.28, 0.50, 0.68], [-2.22, 0.20, 0.62, 0.86], [-1.90, 0.17, 0.70, 0.94],
      [-1.05, 0.15, 0.80, 0.99], [-0.45, 0.15, 0.84, 1.00], [0.70, 0.15, 0.86, 1.00],
      [1.55, 0.15, 0.88, 0.97], [2.12, 0.19, 0.84, 0.90], [2.35, 0.26, 0.76, 0.80]] },
    green: { baseW: 0.86, topW: 0.66, sts: [
      [-0.40, 0.83, 0.86], [0.25, 0.84, 1.38], [0.55, 0.845, 1.38],
      [0.68, 0.845, 1.375], [1.28, 0.85, 1.36], [1.95, 0.85, 0.90]],
      segs: ['gp', 'pg', 'pp', 'pg', 'gp'] },
  },
  // Mercedes E W214 — 20 cm statelier again: longest bonnet, tallest belt,
  // chrome louvres with the star riding proud of them
  mercedes: {
    len: 4.9, wid: 1.86, wheelR: 0.33, axle: 1.52,
    accel: 8.5, vmax: 67, grip: 8.2, mass: 1.9,
    driveRear: 0.9,           // rear-wheel drive, a softer foot than the BMW's
    brand: 'mb',
    badgeF: { size: 0.20, y: 0.53, dz: -0.035 }, badgeR: { size: 0.10, y: 0.68, dz: 0.02 },
    plateF: 0.37, plateR: 0.44,
    hull: { sh: 0.84, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.45, 0.29, 0.52, 0.67], [-2.32, 0.21, 0.65, 0.85], [-2.00, 0.17, 0.73, 0.94],
      [-1.10, 0.16, 0.82, 0.99], [-0.55, 0.16, 0.87, 1.00], [0.65, 0.16, 0.89, 1.00],
      [1.60, 0.16, 0.91, 0.97], [2.20, 0.20, 0.87, 0.90], [2.45, 0.27, 0.79, 0.80]] },
    green: { baseW: 0.87, topW: 0.68, sts: [
      [-0.55, 0.86, 0.89], [0.10, 0.87, 1.43], [0.42, 0.875, 1.43],
      [0.56, 0.875, 1.425], [1.42, 0.88, 1.40], [2.08, 0.87, 0.92]],
      segs: ['gp', 'pg', 'pp', 'pg', 'gp'] },
  },
  // Tesla Model 3 — smooth body-color nose (NO grille anywhere), windscreen
  // base far forward, and every greenhouse TOP face glass: one unbroken
  // canopy from cowl to bootlid, ending in the full-width tail light bar
  tesla: {
    len: 4.7, wid: 1.85, wheelR: 0.33, axle: 1.44,
    accel: 12.0, vmax: 72, grip: 9.6, mass: 1.9,
    brand: 'tesla',
    badgeF: { size: 0.13, y: 0.52, dz: 0.065, rx: -0.83 }, badgeR: { size: 0.11, y: 0.56, dz: 0.02 },
    plateF: 0.37, plateR: 0.42,
    hull: { sh: 0.84, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.35, 0.30, 0.46, 0.62], [-2.22, 0.20, 0.58, 0.84], [-1.90, 0.16, 0.68, 0.94],
      [-1.15, 0.15, 0.78, 0.99], [-0.70, 0.15, 0.83, 1.00], [0.60, 0.15, 0.86, 1.00],
      [1.55, 0.15, 0.88, 0.97], [2.10, 0.19, 0.85, 0.90], [2.35, 0.25, 0.78, 0.80]] },
    green: { baseW: 0.90, topW: 0.72, sts: [
      [-0.95, 0.80, 0.83], [-0.10, 0.83, 1.41], [0.42, 0.835, 1.435],
      [0.56, 0.835, 1.43], [1.30, 0.84, 1.36], [2.02, 0.85, 0.90]],
      segs: ['gp', 'gg', 'gp', 'gg', 'gp'] },
  },
  // panel van — a blunt tall single volume: short bonnet stub, cab glass over
  // the front doors only, then blind panel to the upright rear doors
  van: {
    len: 4.8, wid: 1.9, wheelR: 0.36, axle: 1.62,
    accel: 4.6, vmax: 130 / 3.6, grip: 6.2, mass: 2.6,
    brand: 'plain',
    badgeF: { size: 0.16, y: 0.60, dz: -0.04 }, badgeR: { size: 0.12, y: 0.80, dz: 0.02 },
    plateF: 0.41, plateR: 0.50,
    hull: { sh: 0.88, bw: 0.92, yA: 0.34, yB: 0.80, sts: [
      [-2.40, 0.34, 0.82, 0.80], [-2.26, 0.26, 0.92, 0.92], [-2.00, 0.22, 1.00, 0.98],
      [-1.60, 0.20, 1.04, 1.00], [1.80, 0.20, 1.06, 1.00], [2.28, 0.24, 1.05, 0.98],
      [2.40, 0.28, 1.02, 0.95]] },
    green: { baseW: 0.94, topW: 0.82, sts: [
      [-1.62, 1.02, 1.06], [-0.90, 1.04, 1.94], [0.10, 1.05, 1.97], [2.32, 1.04, 1.93]],
      segs: ['gp', 'pg', 'pp'], capEnd: 'p' },
  },
  // cab-over truck — the hull is only the tall short cab (flat face, glass
  // boxes for the screen); the fleet-white cargo box rides the chassis rails
  truck: {
    len: 7.6, wid: 2.3, wheelR: 0.42, wheelW: 0.36, axle: 2.9,
    cargo: { w: 2.24, h: 2.05, l: 4.9, y: 0.90, z: 1.20 },
    accel: 3.2, vmax: 95 / 3.6, grip: 5.6, mass: 10,
    brand: 'plain',
    badgeF: { size: 0.18, y: 1.55, dz: -0.015 },
    plateF: 0.60, plateR: 0.98, plateRz: 3.67,
    hull: { sh: 0.90, bw: 0.94, yA: 0.34, yB: 0.80, sts: [
      [-3.80, 0.38, 2.30, 0.92], [-3.62, 0.30, 2.48, 0.98],
      [-2.40, 0.30, 2.52, 1.00], [-1.55, 0.30, 2.46, 0.97]] },
  },
  // Round 8, the D11: the tractor of an articulated lorry (tahač s návěsem).
  // These numbers are the TRACTOR's (the cab is the box truck's, 6.2 m of it
  // with the chassis); js/semitrailer.js hangs a 13.6 m trailer on the fifth
  // wheel and makes the car 16.5 m long for everybody else (physics, the
  // follow model, the shadow). Not in CAR_KINDS: it is motorway traffic.
  semi: {
    len: 6.2, wid: 2.5, wheelR: 0.50, wheelW: 0.40, axle: 1.85,
    trailer: true,
    accel: 2.4, vmax: 90 / 3.6, grip: 5.0, mass: 30,
    brand: 'plain',
    badgeF: { size: 0.18, y: 1.55, dz: -0.015 },
    plateF: 0.60,
    hull: { sh: 0.90, bw: 0.94, yA: 0.34, yB: 0.80, sts: [
      [-3.10, 0.38, 2.30, 0.92], [-2.92, 0.30, 2.48, 0.98],
      [-1.70, 0.30, 2.52, 1.00], [-0.85, 0.30, 2.46, 0.97]] },
  },
  // SOR NS 12 city bus — one 11 m low-floor volume: near-flat face with a
  // one-piece raked windscreen and destination box, a full-length glazing
  // band framed by the white DPMP livery strips, two curbside door recesses,
  // and the A/C pod on the roof. No badge: the livery IS the identity.
  bus: {
    len: 11.0, wid: 2.5, wheelR: 0.45, wheelW: 0.36, axle: 3.4,
    accel: 3.0, vmax: 105 / 3.6, grip: 5.2, mass: 13,
    plateF: 0.55, plateR: 0.60,
    hull: { sh: 0.90, bw: 0.94, yA: 0.34, yB: 0.80, sts: [
      [-5.50, 0.30, 2.80, 0.90], [-5.30, 0.24, 2.92, 0.98], [-4.60, 0.22, 2.95, 1.00],
      [4.60, 0.22, 2.95, 1.00], [5.30, 0.24, 2.92, 0.98], [5.50, 0.30, 2.75, 0.92]] },
  },
  // Škoda 32Tr (SOR TNS 12) trolleybus, the solo twelve-metre car DPMP runs:
  // low floor, three kerbside doors, traction gear in a long roof fairing and
  // the two pole bases behind it. The poles themselves are js/trolleypoles.js
  // (they move). Not in CAR_KINDS: it runs on its lines, nobody buys one.
  trolleybus: {
    len: 12.2, wid: 2.55, wheelR: 0.47, wheelW: 0.36, axle: 3.7,
    accel: 3.4, vmax: 70 / 3.6, grip: 5.2, mass: 14,
    plateF: 0.52, plateR: 0.60,
    hull: { sh: 0.90, bw: 0.94, yA: 0.34, yB: 0.80, sts: [
      [-6.10, 0.30, 2.78, 0.90], [-5.90, 0.24, 2.94, 0.98], [-5.20, 0.22, 2.98, 1.00],
      [5.20, 0.22, 2.98, 1.00], [5.90, 0.24, 2.94, 0.98], [6.10, 0.30, 2.78, 0.92]] },
  },
};
// spawn code rolls from this — traffic.js picks BY NAME from its own pools
// (indexing broke the day the roster was renamed, so never rely on order)
export const CAR_KINDS = ['octavia', 'fabia', 'bmw', 'mercedes', 'tesla', 'van', 'truck', 'bus'];
// Legacy kind names — main.js's spawn list and pre-v4 saves still say sedan/
// hatch/kombi/suv. They resolve to the closest modern silhouette at every
// door into this module, so an old save gets an Octavia, not a crash.
const ALIAS = { sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' };
const kindOf = (k) => KIND[k] ?? KIND[ALIAS[k]] ?? KIND.octavia;

// ---- normalizeKind(k) → a kind string geomFor() is ALLOWED to see ---------
// kindOf() above is forgiving about the SPEC it hands back, but geomFor()
// caches by the STRING: an unknown name gets a fresh copy of the Octavia
// geometry filed under that name, and nothing ever evicts it. That is fine for
// our own spawn code, which only ever says names from CAR_KINDS. It is not
// fine for the net layer, where `kind` is a field a remote client typed: ten
// invented names a second at 10 Hz is a memory leak aimed at everybody else in
// the room. So anything that arrives from outside this program launders its
// kind through here first, and an unknown one comes back as a plain Octavia.
export function normalizeKind(k) {
  const s = typeof k === 'string' ? (ALIAS[k] ?? k) : '';
  return KIND[s] ? s : 'octavia';
}

// ---- carLabel / carSubtitle: what a Czech driver calls the thing ---------
// The roster keys are silhouette names for the mesh builder; the HUD needs
// the name on the boot lid. Kept beside KIND deliberately — whoever adds a
// kind trips over the missing label within the same screenful.
// Names describe what the GEOMETRY actually is, not how the key is spelled:
// the `bmw` hull is a three-box G20 sedan, the `bus` is the SOR NS 12 whose
// livery is already painted on. Subtitles stay on body style and drive
// layout — the two things the mesh and the physics agree on — instead of an
// engine trim the accel curve would immediately contradict (this Octavia
// pulls 0–100 in 5.7 s, which no badge on a real one would justify).
const CAR_LABELS = {
  octavia:  ['Škoda Octavia', 'liftback · předokolka'],
  fabia:    ['Škoda Fabia', 'hatchback · předokolka'],
  bmw:      ['BMW řady 3', 'sedan G20 · zadokolka'],
  mercedes: ['Mercedes-Benz třídy E', 'sedan W214 · zadokolka'],
  tesla:    ['Tesla Model 3 Performance', 'elektro · pohon všech kol'],
  van:      ['Dodávka', 'skříňová · do 3,5 t'],
  truck:    ['Nákladní vůz', 'trambus · skříňová nástavba'],
  semi:     ['Kamion', 'tahač s návěsem · 40 t'],
  bus:      ['SOR NS 12', 'nízkopodlažní · DPMP'],
  trolleybus: ['Škoda 32Tr', 'trolejbus · nízkopodlažní · DPMP'],
};
// Accepts a kind string OR a whole car object: seatAnchor() next door takes
// the car, and one confused argument would otherwise print "Vozidlo" forever
// with nothing to debug. Unknown kinds fall back rather than throw — the HUD
// flashing a generic name beats a boarding handler dying mid-animation.
const _labelPair = (k) => {
  const s = typeof k === 'string' ? k : k?.kind;
  return CAR_LABELS[s] ?? CAR_LABELS[ALIAS[s]] ?? null;
};
export const carLabel = (kind) => _labelPair(kind)?.[0] ?? 'Vozidlo';
export const carSubtitle = (kind) => _labelPair(kind)?.[1] ?? '';

// Per-kind paint bias, weighted by repetition — teslas ship white/black/red
// (the colors the order page makes cheap), German metal wears dark metallics,
// škodas take anything from the config pool, vans and trucks run fleet white,
// the bus wears DPMP red. Math.random is fine: paint is a runtime-only choice.
const KIND_COLORS = {
  bmw: [0x15171b, 0x22262c, 0x2c3138, 0x1f3048, 0x36393f, 0x101214, 0x43464c, 0x8a9096],
  mercedes: [0x191b1f, 0x24272c, 0x2e3238, 0x23304a, 0x3a3d43, 0x0f1113, 0xb9bec6],
  tesla: [0xe9eae5, 0xe9eae5, 0xe9eae5, 0x17191d, 0x17191d, 0xa61c26, 0xa61c26, 0x8a9096, 0x2f4f72],
  van: [0xd8d5ce, 0xd8d5ce, 0xd8d5ce, 0xc4c9cf, 0xbcbfba, 0x3a63a8],
  truck: [0xd8d5ce, 0xbcbfba, 0x8a9096, 0x476b46, 0x3a63a8],
  semi: [0xd8d5ce, 0xd8d5ce, 0xb5271f, 0x3a63a8, 0x2c3138, 0x476b46, 0xc9a227, 0x8a9096],
  bus: [0xb5271f, 0xb5271f, 0xb5271f, 0xd8d5ce, 0x9a2822],
  trolleybus: [0xb5271f, 0xb5271f, 0x9a2822],
};
export function pickCarColor(kind) {
  const pool = KIND_COLORS[ALIAS[kind] ?? kind] ?? CAR_COLORS;
  return pool[(Math.random() * pool.length) | 0];
}
export { CAR_COLORS };   // re-export so callers can grab the fallback pool here too

// ---- collision tunables ----
const HIT_RANGE2 = 144;   // 12 m center-distance gate — covers even bus vs bus nose-to-nose

// ---- v13: the tyres get a say --------------------------------------------
// "Ať se to fakt víc smýká, ať je to fakt jako v nějakém GTAčku."
//
// What was here was a kinematic bicycle: heading changed instantly with the
// wheel, and a scalar `_lat` was spawned from the heading change and then
// exponentially damped. That model has no memory. The car cannot be pointed one
// way and travelling another for any length of time, so a slide was a brief
// smear rather than a state you hold, and countersteer did nothing recognisable
// because there was no rotation to catch — unwinding the wheel simply stopped
// creating new `_lat`.
//
// The replacement is the standard two-track-collapsed-to-one bicycle with REAL
// lateral tyre forces and yaw rate as an actual state:
//
//   · slip angle per axle, α = atan(lateral contact velocity / |forward|)
//   · force from a simplified Pacejka curve, sin(C·atan(B·α)) — it PEAKS at
//     about 13° and then falls away to ~0.6 of peak, and that falling tail is
//     the whole reason a drift can be held. A saturating curve that merely
//     flattens (tanh) grips forever and slides like porridge.
//   · yaw acceleration from the two forces' moments about the CoG, so the car
//     has rotational inertia: it takes time to swing out and time to come back,
//     which is exactly what countersteering catches.
//   · load transfer, so braking loads the nose (turn-in) and throttle unloads
//     it (push), and a friction circle on the rear, so power breaks it loose.
//
// Everything is done in SPECIFIC force (m/s², i.e. force/mass) so the KIND
// table's `mass` keeps meaning what its comment says — a ratio for collisions
// only — and cannot silently change how anything crashes.
const SUB_DT = 1 / 120;   // the tyre model's own clock; see the substep loop
const WHEELBASE = 0.6;    // × len — unchanged from the old model, so turn radii carry over
const CG_FRONT = 0.45;    // CoG sits this fraction of the wheelbase behind the front axle…
const CG_H = 0.55;        // …and this high, which is what makes load transfer transfer
// Yaw radius of gyration² as a multiple of a·b. Bigger is heavier: the car
// takes longer to start rotating AND longer to stop. 1.45 was chosen to settle
// the car down after the first play-test and turned out to be most of why the
// next one came back "tuhé, pomalu zatáčí pořád jako všude" — inertia is felt
// as lag long before it is felt as stability.
const KZ2 = 1.15;
// Cornering stiffness, measured rather than picked: at B = 7 a 0.58 g corner
// (20 m/s round 70 m, which is a brisk but perfectly ordinary main-road bend)
// came out at 8.6° of front slip and 3.0 m/s of contact-patch scrub — enough to
// squeal and lay rubber through a corner nobody would call a drift. Real
// passenger tyres reach peak grip nearer 8° than 13°, so B goes up and the peak
// comes in: α_peak = tan(π/2C)/B.
const PAC_B = 11.0;       // tyre stiffness: how fast force builds with slip angle
// C is the post-peak tail, and it is the single knob that decides whether a
// slide is a moment or a career. At 1.55 grip fell to 0.6 of peak once the tyre
// let go, so any corner taken with commitment kept going — "jako na ledě". At
// 1.35 it only falls to about 0.85, which still allows a real slide but lets
// the tyre climb back out of one on its own.
const PAC_C = 1.35;       // shape — peak near 11.5°, then away to 0.85 of peak
// KIND.grip ÷ this = the tyre's friction coefficient. 1.55 for an Octavia is
// well past a real road tyre, and deliberately so: steerSpeedK was opened up to
// let the driver ask for a 57 m corner at 108 km/h instead of an 81 m one, and
// grip has to be there to answer or the extra lock is just a licence to slide —
// which is the complaint this whole pass exists to fix. The two numbers are a
// pair; move one and re-measure the other.
const MU_REF = 4.9;
const MU_MIN = 0.55, MU_MAX = 2.0;
const MU_OFF = 0.42;      // grip a fully offroad tyre loses — a meadow is not tarmac
// Real road cars are deliberately set up to understeer: the rear axle is given
// more grip than the front so that a driver who arrives too fast runs wide —
// which he can see and lift for — instead of spinning, which he cannot. The
// first cut of this model was neutral, and neutral in a game with a keyboard
// for a steering wheel reads as loose.
const REAR_BIAS = 1.06;   // × rear grip against the front's
// Split by pedal, because a car is: the drive goes mostly to the back of the
// friction circle and the brakes mostly to the front. One shared number gave
// power-on oversteer so mild it read as understeer, and front brakes so weak a
// panic stop never bit.
const DRIVE_REAR = 0.60;  // share of THROTTLE the rear circle carries
const SPIN_LOW = 1.5;     // rear-drive torque surplus in first gear (× delivered)…
const SPIN_CAP = 0.86;      // …and never more than this share of the rear circle
const SPIN_V = 20;        // …gone by this many m/s (72 km/h)
const BRAKE_FRONT = 0.65; // …and of the BRAKES the front does
const HB_MU = 0.30;       // handbrake: what is left of the rear tyre's grip…
const HB_LAT = 0.35;      // …and of the circle it has to spend on cornering
const HB_SCRUB = 1.3;     // × CAR.brake, the drag of two locked wheels
const SLIP_V = 2.2;       // m/s floor under the slip-angle denominator
const KIN_V = 7.0;        // …below which the kinematic constraint is blended back in
const KIN_K = 14;         // and how hard it pulls
const STEER_ON = 9;       // rad/s the wheel winds toward lock at a standstill…
const STEER_SLOW = 0.022; // …divided by (1 + this × m/s): 0.19 s at 108 km/h
const STEER_BACK = 16;    // unwinding and countersteer: as fast as you like
const R_MAX = 3.6;        // rad/s — a car spinning faster than this is a bug
const LAT_MAX = 45;        // m/s of sideways, likewise
const G = 9.81;
// What the slide signals mean to everyone else. SLIP_REF is the contact-patch
// sliding speed that counts as a full-blooded drift: 9 m/s sideways is a tail
// right out. Audio and the skid marks both normalise against it, so they cannot
// disagree about when a skid started.
const SLIP_REF = 9;
// Where the tyre's grip peaks, in radians of slip angle — the derivative of the
// Pacejka curve puts it at tan(π/2C)/B. It is the line between CORNERING and
// SLIDING, and measuring against it is the whole difference between a skid
// detector and a speed detector: raw contact-patch velocity called a brisk bend
// a drift, because a front tyre working perfectly well at 30 m/s is still
// scrubbing three metres a second sideways. Only the excess over the peak is a
// slide, and that is what the audio and the marks are given.
const A_PEAK = Math.tan(Math.PI / (2 * PAC_C)) / PAC_B;
// …and loose ground saturates far earlier: on gravel or a wet meadow the
// surface itself shears long before the rubber does, which is exactly why a
// field can be ploughed into ruts at speeds that would not mark tarmac.
const A_PEAK_OFF = 0.55;  // × how much of the peak angle a full-offroad tyre keeps
// 3.0 m/s of scrub, not 1.9: measured, a 0.58 g main-road bend runs 2.4 m/s of
// front scrub, and rubber on the road through every fast corner is not a skid
// mark, it is wallpaper. Exported because skidmarks.js gates on exactly this
// number and the two must not be able to disagree about when a skid started.
export const SLIP_MARK = 1.2;   // m/s of EXCESS scrub that starts leaving rubber
const CHIRP_ON = 0.10;    // slip01 rising through this chirps once — SKID.on's twin
const CHIRP_CD = 0.55;    // s before it may chirp again

/** Simplified Pacejka: normalised lateral force for a slip angle in radians. */
function pacejka(alpha) {
  return Math.sin(PAC_C * Math.atan(PAC_B * alpha));
}

/**
 * One tyre-model substep. Body axes: F = forward (−sin h, −cos h), R = right
 * (cos h, −sin h); positive steer points the front wheel toward R and turns the
 * nose toward R, which is heading DECREASING — the sign convention the old
 * model used and every consumer of car.heading still assumes.
 *
 * Kinematics of a rotating frame give a_long = v̇x + vy·r and a_lat = v̇y − vx·r,
 * so the applied specific forces come back out of the integration as the two
 * terms below. Getting that pair backwards is the classic way to build a car
 * that accelerates out of corners for free.
 */
function tyreStep(car, K, gas, hb, dt) {
  const L = car.len * WHEELBASE;
  const a = L * CG_FRONT, b = L - a;
  const kz2 = KZ2 * a * b;
  let vx = car.speed, vy = car._lat ?? 0, r = car.yaw ?? 0;
  const d = car.steer, sd = Math.sin(d), cd = Math.cos(d);

  // ---- longitudinal: unchanged law, now expressed as an acceleration ----
  // a = accel·(1 − v/vmax)^1.3 off the throttle curve, CAR.brake on the pedal,
  // and drag + rolling resistance ONLY while coasting — that last rule is what
  // makes vmax really be vmax at full throttle, so it survives verbatim.
  let ax = 0, coast = 0;
  if (gas > 0.01) {
    if (vx < -0.05) ax = CAR.brake * gas;              // still rolling back: this is the brake
    else ax = K.accel * Math.pow(Math.max(0, 1 - vx / K.vmax), 1.3) * gas;
  } else if (gas < -0.01) {
    ax = vx > 0.05 ? CAR.brake * gas : K.accel * 0.7 * gas;
  } else {
    coast = (CAR.drag * Math.abs(vx) + CAR.roll) * (vx >= 0 ? -1 : 1);
  }

  // ---- what each axle is standing on ----
  let mu = K.grip / MU_REF;
  mu = (mu < MU_MIN ? MU_MIN : mu > MU_MAX ? MU_MAX : mu)
    * (1 - MU_OFF * (car.offroad ?? 0));
  // Load transfer: accelerating tips weight onto the rear, braking onto the
  // nose. nf + nr = 1 by construction, so this only ever MOVES grip.
  let nf = (b / L) - (CG_H / L) * (ax / G);
  nf = nf < 0.12 ? 0.12 : nf > 0.88 ? 0.88 : nf;
  let capF = mu * G * nf, capR = mu * G * (1 - nf) * REAR_BIAS;

  // Friction circle: rubber spent going forwards is rubber not available for
  // going sideways. This single term is where power-on oversteer comes from —
  // flooring it mid-corner eats the rear's circle and the tail leaves.
  // The drive share is per KIND where the car says so: the BMW and the
  // Mercedes are rear-wheel drive ("zadokolka" on their own badges), and a
  // rear-drive car is the one whose tail a heavy right foot can swing out of a
  // tight corner. The Škodas keep the old shared number on purpose: they are
  // the car most people drive, and a keyboard throttle is always fully open.
  const rearShare = ax >= 0 ? (K.driveRear ?? DRIVE_REAR) : 1 - BRAKE_FRONT;
  // …and a rear-drive engine in a low gear can ask the rear tyres for more
  // than they can give. The delivered acceleration above is what the car
  // gets; the TORQUE behind it is what the tyres must carry, and in first and
  // second that is more than the circle holds, so the tail lets go. It fades
  // out by SPIN_V because in the high gears the same foot simply cannot.
  //
  // The surplus is CAPPED (SPIN_CAP) rather than allowed to eat the whole
  // circle, and that cap is the line between a power slide and a spin. Let
  // through, a BMW turning right at a junction at 25 km/h with W held (which
  // is how everybody drives on a keyboard) went round 190°: the rear passed
  // the Pacejka peak and the falling tail did the rest. Capped, the tail steps
  // out a few degrees, smokes, and comes back when the wheel straightens.
  let uR = Math.min(0.98, Math.abs(ax) * rearShare / Math.max(0.5, capR));
  if (ax > 0 && K.driveRear) {
    const uSpin = uR * (1 + SPIN_LOW * Math.max(0, 1 - vx / SPIN_V));
    uR = Math.max(uR, Math.min(SPIN_CAP, uSpin));
  }
  let latR = Math.sqrt(1 - uR * uR);
  const uF = Math.min(0.98, Math.abs(ax) * (1 - rearShare) / Math.max(0.5, capF));
  const latF = Math.sqrt(1 - uF * uF);
  if (hb) {
    // The rear axle stops being a tyre and becomes a skid. Both terms, not one:
    // less grip AND none of it spare for cornering is what swings the tail.
    capR *= HB_MU; latR *= HB_LAT;
    const scrub = CAR.brake * HB_SCRUB * dt;
    vx = Math.abs(vx) <= scrub ? 0 : vx - Math.sign(vx) * scrub;
  }

  // ---- slip angles and the forces they make ----
  // The denominator is floored: at a standstill α is 0/0, and the whole model
  // hands over to the kinematic pull below long before the floor distorts it.
  const vxs = Math.max(Math.abs(vx), SLIP_V);
  const vlf = vy - a * r;                 // lateral velocity of each axle, body frame
  const vlr = vy + b * r;
  const wlf = -vx * sd + vlf * cd;        // …and of the front tyre in ITS own frame
  const fw = -capF * latF * pacejka(Math.atan(wlf / vxs));   // front, wheel-lateral axis
  const fr = -capR * latR * pacejka(Math.atan(vlr / vxs));   // rear, along R
  const ff = fw * cd;                     // the front's component along R
  // −fw·sd is cornering drag: a steered tyre pushing sideways also pushes back.
  const aLong = ax + coast - fw * sd;
  const aLat = ff + fr;
  const rdot = (-a * ff + b * fr) / kz2;

  vx += (aLong - vy * r) * dt;
  vy += (aLat + vx * r) * dt;
  r += rdot * dt;
  // What the body FEELS, for the springs (bodyStep): the tyre forces, which
  // is the acceleration of the car in its own frame. A coasting car's drag is
  // included, the rotating-frame terms are not, because a passenger is thrown
  // by the forces and not by the bookkeeping of a turning coordinate system.
  car._aLat = aLat;
  car._aLong = aLong;

  // ---- the low-speed kinematic constraint ----
  // Below walking-into-jogging pace real tyres do not slip at all: they roll,
  // and the geometry alone decides the yaw rate. The force model cannot know
  // that (its forces vanish with speed, so a car would park like a boat), so
  // the kinematic answer is blended back in as a soft pull that dies at KIN_V.
  // GROUND speed, not the forward component: a car sliding sideways at 25
  // m/s has almost no vx, and judging it by vx alone treated a broadside as a
  // car at parking pace and stopped it dead in a metre and a half.
  const kin = 1 - Math.sqrt(vx * vx + vy * vy) / KIN_V;
  if (kin > 0) {
    const g2 = Math.min(1, KIN_K * kin * dt);
    r += (-Math.tan(d) * vx / L - r) * g2;
    vy -= vy * g2;
  }

  if (ax > 0 && vx > K.vmax) vx = K.vmax;
  if (ax < 0 && vx < -CAR.vrev) vx = -CAR.vrev;
  if (coast !== 0 && Math.abs(vx) < 0.02) vx = 0;   // coast to a real stop, not an asymptote
  // rolling resistance has nothing to push against at a standstill, and a
  // parked car must not sit with its nose dipped by it forever
  if (vx === 0 && ax === 0) car._aLong = 0;
  car.speed = vx;
  car._lat = vy < -LAT_MAX ? -LAT_MAX : vy > LAT_MAX ? LAT_MAX : vy;
  car.yaw = r < -R_MAX ? -R_MAX : r > R_MAX ? R_MAX : r;

  car.heading += car.yaw * dt;
  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);
  const rx = Math.cos(h), rz = -Math.sin(h);
  car.x += (fx * car.speed + rx * car._lat) * dt;
  car.z += (fz * car.speed + rz * car._lat) * dt;
}

// ---- geometry ---------------------------------------------------------------
// The exterior is built by cardetail.js (which drives carbody.js and
// carwheels.js): a smooth lofted hull with cut wheel arches, glass and lamps
// draped onto it, and a coarse distance variant of the same recipe. What is
// left in this file is the part of the geometry the CABIN is made of, and the
// one definition of where the cabin sits inside the shell.

// How far aft of the windscreen base the hull deck survives as a SCUTTLE
// strip. greenHull() emits no front cap, so at the windscreen base there is an
// open slot the height of the first greenhouse ring (3 cm on an Octavia)
// running the full width of the screen. It has always been there and never
// showed, because a ray through it landed on the deck behind. Open the deck
// flush with the screen base and that slot becomes a hairline view into the
// cabin from outside — measured, every single one of the 355 leaking rays on
// an Octavia entered exactly there. 0.12 m of surviving deck catches all of
// them, and from the driver's seat it reads as the cowl vent panel a real car
// has in precisely that spot.
const CAB_SCUTTLE = 0.12;

// THE one definition of the cabin opening. Both the hull (which must not lid
// it over) and cabinSpec() (which furnishes it) read it from here, so the hole
// and the interior can never drift apart. null for the cab-over kinds, which
// have no greenhouse loft — their eye already sits inside the hull volume.
//   z0/z1   the cabin in z: windscreen base to the last station before the
//           backlight, i.e. the greenhouse minus its two raked ends
//   deckZ0  where the deck actually stops (see CAB_SCUTTLE)
//   xIn     the beltline trim line. Outboard of it the deck SURVIVES as the
//           door top, which is what keeps the door cavity — crease bars,
//           handle stubs, the unlined inside of the door skin — sealed off.
//   xOut    the greenhouse's base half width, which the door top runs out to
//           MEET. The glasshouse is lofted a few centimetres wider and lower
//           than the deck it stands on (0.80 vs 0.76 m on an Octavia), so
//           there is a beltline seam the deck never reached under. Well inside
//           K.wid, so the silhouette does not move.
function cabinCut(K) {
  const g = K.green;
  if (!g) return null;
  const z0 = g.sts[0][0], z1 = g.sts[g.sts.length - 2][0];
  return {
    z0, z1, deckZ0: Math.min(z0 + CAB_SCUTTLE, (z0 + z1) / 2),
    xIn: spanMin(z0, z1, (z) => hullHalfAt(K, z, g.sts[0][1])) - 0.04,
    xOut: g.baseW * K.wid / 2,
  };
}

// Everything of one material merges into ONE BufferGeometry, so a whole car
// is ~10 draw calls no matter how many mirrors and lamps dress it. Only
// position+normal survive the merge — none of these materials carries a map.
function mergeGeoms(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// small-part helpers: push transformed boxes/cylinders into a material soup
const B = (arr, w, h, l, x, y, z, ry = 0, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  arr.push(g);
};
// mirrored pair; sweep yaws each box so its OUTER end trails rearward on the
// nose (wrap-around lamps) — pass a negative sweep on the tail for the same
// wrap in the other direction
const pairB = (arr, w, h, l, x, y, z, sweep = 0, rx = 0) => {
  B(arr, w, h, l, -x, y, z, sweep, rx);
  B(arr, w, h, l, x, y, z, -sweep, rx);
};

function widthAt(sts, z, half) {
  if (z <= sts[0][0]) return sts[0][3] * half;
  for (let i = 0; i < sts.length - 1; i++) {
    const a = sts[i], b = sts[i + 1];
    if (z <= b[0]) {
      const t = (z - a[0]) / (b[0] - a[0] || 1);
      return (a[3] + (b[3] - a[3]) * t) * half;
    }
  }
  return sts[sts.length - 1][3] * half;
}

// shared plane geometries for the flat decals (badges by size, plates fixed)
const _planes = new Map();
function planeGeoFor(w, h) {
  const k = w + 'x' + h;
  let g = _planes.get(k);
  if (!g) _planes.set(k, g = new THREE.PlaneGeometry(w, h));
  return g;
}

// one geometry set per kind, built lazily and shared by every car forever:
// the near car, its distance variant, the two handed wheels and the decals
const _geo = new Map();
function geomFor(kind) {
  kind = ALIAS[kind] ?? kind;            // cache under the modern name only
  let g = _geo.get(kind);
  if (g) return g;
  const key = KIND[kind] ? kind : 'octavia';
  const K = KIND[key];
  const car = buildCar(key, K, cabinCut(K));
  const S = car.shape;
  _geo.set(kind, g = {
    K, zN: S.z0, zT: S.z1, shape: S, near: car.near, far: car.far, wheel: car.wheel, wx: car.wx,
    plates: plateGeo(K, S), badges: badgeGeo(K, S, car.style),
  });
  return g;
}

// ---- bodySurface(kind) → where the outside of a kind's body is -------------
// For whoever bolts something onto a car from outside this file (the police
// livery in traffic.js, the ambulance band): the flank is a curve with real
// wheel openings in it, so "the hull is w·half wide at this station" is no
// longer something a caller can transcribe. halfAt(z, y) is the half width at a
// height, topAt(z, x) the roof or bonnet height, archTop(z) the top of a wheel
// opening at that z (0 where there is none). Local frame, nose at −z.
export function bodySurface(kind) {
  const S = geomFor(kind).shape;
  return {
    z0: S.z0, z1: S.z1, halfAt: S.halfAt, topAt: S.topAt,
    archTop(z) {
      let y = 0;
      for (const a of S.arches) {
        const d = z - a;
        if (Math.abs(d) < S.R) y = Math.max(y, S.wheelR + Math.sqrt(S.R * S.R - d * d));
      }
      return y;
    },
  };
}

// ---- decals: plates and badges, one merged mesh each -----------------------
// A plate or a badge is a textured quad standing a centimetre off the panel
// it belongs to, leaning with that panel: the body module is asked where the
// face is at the decal's height and which way it looks. Front and rear share
// one geometry (and therefore one draw call) because they share a material.
const _dq = new THREE.Quaternion(), _de = new THREE.Euler(), _dm = new THREE.Matrix4();
const _dv = new THREE.Vector3(), _d1 = new THREE.Vector3(1, 1, 1);
function decalQuad(w, h, x, y, z, ny, nz, rear, lift) {
  const g = new THREE.PlaneGeometry(w, h);
  // YXZ: yaw the quad onto its end of the car, then lean it back with the panel
  const a = rear ? Math.atan2(-ny, nz) : Math.atan2(-ny, -nz);
  _de.set(a, rear ? 0 : Math.PI, 0, 'YXZ');
  _dq.setFromEuler(_de);
  _dv.set(x, y + ny * lift, z + nz * lift);
  g.applyMatrix4(_dm.compose(_dv, _dq, _d1));
  return g;
}
function mergeDecals(list) {
  if (!list.length) return null;
  const n = list.length * 6;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const src of list) {
    const g = src.toNonIndexed();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    o += 6;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
function plateGeo(K, S) {
  const list = [];
  for (const rear of [false, true]) {
    const y = rear ? K.plateR : K.plateF;
    if (y === undefined) continue;
    if (rear && K.plateRz !== undefined) { list.push(decalQuad(0.52, 0.11, 0, y, K.plateRz, 0, 1, true, 0.012)); continue; }
    const p = S.facePoint(y, rear);
    if (!p) continue;
    // a plate hangs close to upright whatever the bumper under it is doing
    const lean = clamp(p.ny, -0.25, 0.35), nz = (rear ? 1 : -1) * Math.sqrt(1 - lean * lean);
    list.push(decalQuad(0.52, 0.11, 0, y, p.z, lean, nz, rear, 0.013));
  }
  return mergeDecals(list);
}
function badgeGeo(K, S, style) {
  if (!K.brand) return null;
  const list = [];
  for (const rear of [false, true]) {
    const spec = rear ? K.badgeR : K.badgeF;
    if (!spec) continue;
    const y = (rear ? style.badgeRy : style.badgeFy) ?? spec.y;
    const p = S.facePoint(y, rear);
    if (p) list.push(decalQuad(spec.size, spec.size, 0, y, p.z, p.ny, p.nz, rear, 0.011));
  }
  return mergeDecals(list);
}

// Build every kind in the gaps of the boot instead of on the frame its first
// car drives into view (about 30 ms a kind). Browser only: a headless import
// builds nothing until somebody asks for a mesh.
if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
  let i = 0;
  const next = () => {
    if (i >= CAR_KINDS.length) return;
    const g = geomFor(CAR_KINDS[i++]);
    if (carMergeOn()) mergedBodies(g);   // the one-draw bodies too (js/carmerge.js)
    window.setTimeout(next, 40);
  };
  window.setTimeout(next, 600);
}

// ---- makeCarMesh(colorHex[, kind]) → { group, wheels } ----
// group origin sits at ground level under the car's center. Everything but
// the wheels lives in an inner "body" group so suspension roll/pitch tilts
// the shell while the wheels stay planted. wheels = [FL, FR, RL, RR] (front
// = −z); front wheels use YXZ euler order so steering yaw and rolling spin
// compose.
//
// Budget (js/carmesh.js has the table). A near car is ONE draw call: paint,
// glass, trim, lamps, brake element, plates and badges are one geometry under
// one material, and the brake light is a material swap. Its four wheels and
// its distance dress (beyond LOD_FAR, wheels baked in) are members of the
// instanced pools of js/carinstances.js: one draw per kind and side for every
// wheel on the street, one per kind for every distant car in the city. The
// old eleven-part car is still here behind ?carmerge=0, for an A/B.
export function makeCarMesh(colorHex, kind = 'octavia') {
  kind = ALIAS[kind] ?? kind;
  const g = geomFor(kind), K = g.K;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const near = new THREE.Group(), far = new THREE.Group();
  near.matrixAutoUpdate = far.matrixAutoUpdate = false;
  far.visible = false;
  body.add(near, far);
  // long kinds tuck the axles inside the overhangs (a bus pivots mid-body,
  // not at the bumpers) — K.axle overrides the wheels-at-the-corners default
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const side = i & 1 ? 1 : -1;
    const w = new THREE.Mesh(g.wheel[i & 1], detailMat);
    w.rotation.order = 'YXZ';
    w.castShadow = true; w.receiveShadow = true;
    // each axle takes its track from the body AT that axle, so the tyre sits
    // just inside its own arch lip instead of 5 cm proud of a tapering nose
    w.position.set(side * g.wx[i < 2 ? 0 : 1], K.wheelR, (i < 2 ? -1 : 1) * ax);
    group.add(w);
    wheels.push(w);
  }
  const dress = dressCar({ g, K, kind, hex: colorHex, decal: decalTexFor(kind, colorHex), near, far, wheels });
  // dentCar crumples these: the merged body is one mesh, every draped layer
  // in it, so a pushed-in nose takes its grille and headlamps with it
  group.userData.hulls = dress.hulls;
  group.userData.body = body;
  group.userData.wheelR = K.wheelR;
  group.userData.lod = { near, far, wheels, far_: false };
  group.userData.brake = dress.brake;
  group.userData.carState = dress.state;
  bindCar(group, dress);
  return { group, wheels };
}

// Swap a car between its near and its distance dress. Exported for the co-op
// ghosts, which own their meshes and are not in Vehicles.cars.
export function setCarLod(group, isFar) {
  const l = group?.userData?.lod;
  if (!l || l.far_ === isFar) return;
  l.far_ = isFar;
  l.near.visible = !isFar;
  l.far.visible = isFar;
  for (const w of l.wheels) w.visible = !isFar;
}
const LOD_FAR = 62, LOD_NEAR = 54;       // m, with hysteresis so a car on the line does not flicker

// ---- A/B from the console ----------------------------------------------------
//   atcCars.instancing(false)   wheels and distance dress draw one by one again
//   atcCars.instancing(true)    back into the pools (the default)
//   atcCars.city(0)             no skyline in the paint (1 is the default)
//   atcCars.stats()             { pools, members, drawn, on, merged }
// ?carmerge=0 in the URL builds every car as the old eleven-part model, and
// ?carinst=0 starts with the pools off: a cold A/B in one browser.
if (typeof window !== 'undefined') {
  window.atcCars = {
    instancing(on = true) { setCarInstancing(on); return this.stats(); },
    city(k = 1) { BODY_U.uCity.value = +k; return BODY_U.uCity.value; },
    stats(scene) {
      return { ...carInstanceStats(scene ?? window.__atc?.scene), on: carInstancingOn(), merged: carMergeOn() };
    },
  };
}

// ---- Vehicles: owns every car mesh in the scene, animates the dressing ----
export class Vehicles {
  constructor(scene) {
    this.scene = scene;
    this.cars = new Set();
    // the instanced wheel and distance-dress pools fill in this scene's
    // onBeforeRender (js/carinstances.js); hooked here so it is there before
    // the first car, whichever way that car reaches the scene
    hookScene(scene);
    // CO-OP GHOSTS. A peer's car is a proxy js/netvehicles.js owns: it is not
    // in this.cars (nothing here may write its pose), so it never got the two
    // things that are decided per frame for every other car in view: the
    // distance dress and the contact shadow. A remote Octavia 300 m off was
    // 6,500 triangles in eleven draws, and it floated. The ghost fleet sets
    // this to itself and update() visits its cars after its own.
    this.ghosts = null;
    this._nb = 0;
    this._ghostCar = (mesh, x, y, z, kind) => {
      const lod = mesh.userData.lod, fo = this.focus, force = this.forceLod;
      if (lod) {
        let isFar = lod.far_;
        if (force) isFar = force === 'far';
        else if (fo) {
          const dx = x - fo.x, dz = z - fo.z;
          isFar = dx * dx + dz * dz > (isFar ? LOD_NEAR * LOD_NEAR : LOD_FAR * LOD_FAR);
        }
        if (isFar !== lod.far_) setCarLod(mesh, isFar);
      }
      const blobs = this._blobs;
      if (blobs && mesh.visible && this._nb < blobs.userData.capacity) {
        const K = KIND[kind] ?? KIND.octavia;
        _bp.set(x, y + 0.035, z);
        _bs.set(K.wid * 1.42, 1, K.len * 1.16);
        blobs.setMatrixAt(this._nb++, _bm.compose(_bp, mesh.quaternion, _bs));
      }
    };
  }

  // kind: any of CAR_KINDS, or a legacy alias (resolved — car.kind stores the
  // modern name so saves round-trip forward). Fields beyond the contract
  // shape (y and the _underscored ones) are internal: y is the bridge-deck
  // height, _rammedT is the "just got hit" timer traffic.js watches, the
  // rest is suspension/drift state.
  add(kind, x, z, heading, color) {
    kind = ALIAS[kind] ?? kind;
    if (color === undefined) color = pickCarColor(kind);
    const K = KIND[kind] ?? KIND.octavia;
    const { group, wheels } = makeCarMesh(color, kind);
    // A car is born ON THE ROAD, not at sea level. Only cars the traffic AI
    // owns get a pose written every frame; a PARKED car and one dropped in by
    // the dev spawner are placed once and then simply sit there — so if they
    // are not put on the ground here, they never are. In Pardubice that is
    // 221 m underground, which reads exactly like "the spawn button does
    // nothing".
    const y0 = this.world?.surfaceY ? this.world.surfaceY(x, z).y : 0;
    // Shadow flags are set per part in makeCarMesh (paint, glass and wheels
    // cast; everything receives so a bridge's shade falls across the bonnet).
    // The soft blob under the car is what keeps it on the ground where the sun
    // shadow does not reach: one InstancedMesh for the whole fleet, made the
    // first time a car exists so a headless Vehicles never builds a texture.
    if (!this._blobs && this.scene?.add) {
      this.scene.add(this._blobs = makeContactShadows(256));
    }
    const car = { mesh: group, wheels, x, z, heading, speed: 0, steer: 0,
      kind, color, len: K.len, wid: K.wid, ai: null,
      y: y0, _lat: 0, _pv: 0, _acc: 0, _roll: 0, _pitch: 0, _rammedT: 0,
      offroad: 0, _bumpT: 0 };
    if (K.trailer) attachTrailer(car);   // (a semi: 16.5 m with its trailer, js/semitrailer.js)
    group.position.set(x, y0, z);
    group.rotation.y = heading;
    // Drawn after the street-light quads of the direct path (js/lightpools.js,
    // renderOrder 0.5 in the opaque pass): a car covers the light under it
    // instead of having its tyres painted by it. Opaque parts only, so glass
    // and lamp halos keep their place among the transparents.
    group.traverse(drawAfterLight);
    this.scene.add(group);
    this.cars.add(car);
    return car;
  }

  remove(car) {
    this.cars.delete(car);
    this.scene.remove(car.mesh);         // geometry + materials are shared: keep them
    // …except the sheet metal a crash made this car's own (dentCar clones it)
    for (const h of car.mesh.userData?.hulls ?? []) if (h.userData.owned) h.geometry.dispose();
  }

  // Sync meshes from car state, spin wheels, settle the suspension tilt.
  // Works the same for AI cars (traffic writes x/z/heading/speed) and the
  // player's (driveStep writes them) — pitch is derived from the measured
  // speed delta, so braking AI cars dip their nose too.
  update(dt) {
    if (dt <= 0) return;
    const k = Math.min(1, 8 * dt);
    // contact shadows: grow the instance buffer if the city outgrew it
    let blobs = this._blobs, nb = 0;
    const want = this.cars.size + (this.ghosts?.count ?? 0);
    if (!blobs && want && this.ghosts?.count && this.scene?.add) {
      // a session whose only cars so far are other people's
      this.scene.add(blobs = this._blobs = makeContactShadows(256));
    }
    if (blobs && want > blobs.userData.capacity) {
      this.scene.remove(blobs);
      blobs.dispose();
      blobs.geometry.dispose();          // its own quad and material; the
      blobs.material.dispose();          // blob texture is shared and stays
      this.scene.add(blobs = this._blobs = makeContactShadows(Math.max(want + 64, blobs.userData.capacity * 2)));
    }
    const fo = this.focus, force = this.forceLod;
    for (const car of this.cars) {
      const m = car.mesh;
      // ---- level of detail ----
      // Past LOD_FAR a car is its distance dress: four draw calls, a thousand
      // triangles, wheels baked in. Measured against the focus (the player),
      // which the camera is never more than a few metres from.
      if (m.userData.lod) {
        let isFar = m.userData.lod.far_;
        if (force) isFar = force === 'far';
        else if (fo) {
          const dx = car.x - fo.x, dz = car.z - fo.z, d2 = dx * dx + dz * dz;
          isFar = d2 > (isFar ? LOD_NEAR * LOD_NEAR : LOD_FAR * LOD_FAR);
        }
        if (isFar !== m.userData.lod.far_) setCarLod(m, isFar);
      }
      // A car nobody drives is placed ONCE and then just sits there — but at
      // boot it is placed before its height map has arrived, so it is placed at
      // sea level and stays there. Parked cars therefore settle onto the road
      // the first frame the ground under them is actually known. One flag, one
      // check, and only until it lands: the AI's cars have a pose written every
      // frame and the player's go through driveStep, so neither needs this.
      if (!car._grounded && !car.ai && this.world?.terrain) {
        if (this.world.terrain.ready(car.x, car.z)) {
          car.y = this.world.surfaceY(car.x, car.z, car.y).y;
          car._grounded = true;
        }
      }
      // ---- the AI's cars lie along the hill too ----
      // traffic.js writes a pose every frame and has never had an opinion about
      // ATTITUDE, so a van climbing out of the Dřevnice valley drove up a 15 %
      // grade perfectly level while the player's own car beside it pitched
      // correctly. Four terrain samples each — and only for the ones close
      // enough to read, because at 250 m a 9° pitch is two pixels.
      if (car.ai && this.world?.terrain) {
        const dx = this.focus ? car.x - this.focus.x : 0;
        const dz = this.focus ? car.z - this.focus.z : 0;
        if (!this.focus || dx * dx + dz * dz < TILT_R2) {
          const T = this.world.terrain;
          const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
          const hl = car.len * 0.5, hw = car.wid * 0.5;
          const gp = Math.atan2(
            T.heightAt(car.x + fx * hl, car.z + fz * hl)
            - T.heightAt(car.x - fx * hl, car.z - fz * hl), car.len);
          const gr = Math.atan2(
            T.heightAt(car.x - fz * hw, car.z + fx * hw)
            - T.heightAt(car.x + fz * hw, car.z - fx * hw), car.wid);
          const kt = Math.min(1, dt * 5);
          car._gp = (car._gp ?? 0) + (clamp(gp, -0.5, 0.5) - (car._gp ?? 0)) * kt;
          car._gr = (car._gr ?? 0) + (clamp(gr, -0.4, 0.4) - (car._gr ?? 0)) * kt;
        }
        // …and they can be HEARD. nearbyTrafficHum carries the mass of the
        // traffic as one bed; a car going past you is not mass, it is an event,
        // and an event has a position. sfxAt's own per-name cooldown keeps a
        // busy junction from becoming a machine gun.
        if (this.focus && Math.abs(car.speed) > 8) {
          car._passCd = (car._passCd ?? Math.random() * PASS_CD) - dt;
          if (car._passCd <= 0 && dx * dx + dz * dz < PASS_R2) {
            car._passCd = PASS_CD + Math.random() * PASS_CD;
            sfxAt('traffic_pass', 0.55, car.x, car.z, PASS_MAX, 0.45);
          }
        }
      }
      m.position.set(car.x, car.y, car.z);
      // YXZ, the aircraft order: yaw outermost, then pitch about the car's own
      // lateral axis, then roll about its nose. Plain XYZ would pitch about
      // world X, which tilts a car driving east sideways. With pitch and roll
      // at zero the two orders are identical, so nothing that only writes
      // heading (the traffic AI, the net layer) notices.
      m.rotation.order = 'YXZ';
      m.rotation.set(car._gp ?? 0, car.heading, car._gr ?? 0);
      const spin = car.speed * dt / m.userData.wheelR;
      for (let i = 0; i < 4; i++) {
        const w = car.wheels[i];
        // forward (−z) travel spins the axle negative; wrap so the angle
        // never drifts into float-precision territory on long drives
        w.rotation.x = (w.rotation.x - spin) % (Math.PI * 2);
        if (i < 2) w.rotation.y = -car.steer;   // steer right → yaw right (−y)
      }
      // suspension: lean OUT of turns, squat on throttle, dive on the brakes
      const acc = (car.speed - car._pv) / Math.max(dt, 1e-4);
      car._pv = car.speed;
      car._acc += (acc - car._acc) * Math.min(1, 6 * dt);   // smooth the jitter
      // The player's car rides real springs (bodyStep, fed by the tyre
      // forces); everyone else's keeps the cheap lean, and a car the player
      // has just left eases from the one into the other.
      const sprung = !!car._bLive;      // (read before it is cleared: the lamps want it below)
      if (car._bLive) {
        car._roll = car._bRoll; car._pitch = car._bPitch;
        car._bLive = false;
      } else {
        car._roll += (clamp(car.steer * car.speed * 0.004, -0.05, 0.05) - car._roll) * k;
        car._pitch += (clamp(car._acc * 0.008, -0.05, 0.05) - car._pitch) * k;
        if (car._heave) car._heave *= 1 - k;
      }
      // OFFROAD shake: the body judders and rocks with speed over rough
      // ground. Three incommensurate sines beat against each other so the
      // bounce never settles into a metronome; amplitude follows both how far
      // off the tarmac the car is (eased in driveStep) and how fast it goes.
      let bumpY = 0, bumpP = 0, bumpR = 0;
      if ((car.offroad ?? 0) > 0.05) {
        car._bumpT += Math.abs(car.speed) * dt;
        const t = car._bumpT, a = car.offroad * Math.min(1, Math.abs(car.speed) / 7);
        bumpY = (Math.sin(t * 3.1) * 0.5 + Math.sin(t * 7.7) * 0.35 + Math.sin(t * 13.9) * 0.15) * 0.05 * a;
        bumpP = Math.sin(t * 5.3) * 0.028 * a;
        bumpR = Math.sin(t * 4.1 + 1.7) * 0.024 * a;
      }
      m.position.y = car.y + bumpY;
      // ---- smoke ----
      // Three plumes off the shared dust pool (main wires vehicles.dust):
      //   · a totaled-ish car (damage > 0.75) pours dark engine smoke,
      //   · every combustion car near the focus breathes faint exhaust
      //     (teslas have no pipe and stay clean),
      //   · and a car that is SLIDING boils rubber off its rear tyres.
      if (this.dust) {
        // ---- tyre smoke ----
        // Only the player's car ever has a slip signal (driveStep is called
        // from exactly one site; the traffic is rail-followed), so this cannot
        // fire for the fleet — which is just as well, because the pool is
        // capped at DESTRUCTION.dustMax = 170 and shared with rocket smoke,
        // blast plumes and collapsing floors. On its own clock at ~11 puffs a
        // second with a 1.1 s life, a drift holds about a dozen sprites: it
        // reads as smoke and it cannot starve a demolition.
        if ((car.slip01 ?? 0) > 0.22) {
          car._tsT = (car._tsT ?? 0) - dt;
          if (car._tsT <= 0) {
            car._tsT = 0.09;
            const k = car.slip01;
            const fx4 = -Math.sin(car.heading), fz4 = -Math.cos(car.heading);
            const rx4 = -fz4, rz4 = fx4;
            const soft = (car.offroad ?? 0) > 0.45;
            for (const sgn of [1, -1]) {
              this.dust.puff(
                car.x - fx4 * car.len * 0.32 + rx4 * sgn * car.wid * 0.48, car.y + 0.16,
                car.z - fz4 * car.len * 0.32 + rz4 * sgn * car.wid * 0.48,
                0.18, 0.9 + k * 1.1, 1.1, 0.28 + 0.3 * k,
                // burnt rubber is grey-blue; a slide on dirt throws dust
                soft ? 0xa2907a : 0xb9bcc2,
                -fx4 * 1.6 + rx4 * sgn * 0.7, 0.7 + k, -fz4 * 1.6 + rz4 * sgn * 0.7);
            }
          }
        } else car._tsT = 0;
        // ---- landing ----
        // suspension() sets _thump on the frame the wheels come back down. All
        // four corners shove dust, the tyres bark, and a really hard arrival
        // (the springs bottoming out) adds the crunch of the floorpan.
        if (car._thump) {
          const t = car._thump; car._thump = 0;
          const fx3 = -Math.sin(car.heading), fz3 = -Math.cos(car.heading);
          const rx3 = -fz3, rz3 = fx3;
          for (const [a, b2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            this.dust.puff(
              car.x + fx3 * a * car.len * 0.36 + rx3 * b2 * car.wid * 0.5, car.y + 0.12,
              car.z + fz3 * a * car.len * 0.36 + rz3 * b2 * car.wid * 0.5,
              0.2 + t * 0.3, 1.0 + t, 0.9, 0.4, 0xa9a196,
              rx3 * b2 * 1.4, 0.9 + t, rz3 * b2 * 1.4);
          }
          sfxAt('tyre_touchdown', 0.35 + t * 0.5, car.x, car.z, 90);
          if (t > 0.7) crash(t * 0.45);
        }
        car._smokeT = (car._smokeT ?? 0) - dt;
        if (car._smokeT <= 0) {
          const fx2 = -Math.sin(car.heading), fz2 = -Math.cos(car.heading);
          const dmg2 = car.damage ?? 0;
          const near = !this.focus
            || Math.hypot(car.x - this.focus.x, car.z - this.focus.z) < 55;
          if (dmg2 > 0.75 && near) {
            car._smokeT = 0.14;
            this.dust.puff(car.x + fx2 * car.len * 0.32, car.y + 0.75, car.z + fz2 * car.len * 0.32,
              0.35, 2.4 + dmg2, 1.6, 0.5, dmg2 >= 1 ? 0x23221f : 0x4a4642,
              (Math.random() - 0.5), 1.3, (Math.random() - 0.5));
          } else if (near && car.kind !== 'tesla' && Math.abs(car.speed) > 0.4) {
            car._smokeT = 0.5 + Math.random() * 0.3;
            // out of the tailpipe: low, behind, drifting with the car's wake
            this.dust.puff(car.x - fx2 * car.len * 0.48, car.y + 0.28, car.z - fz2 * car.len * 0.48,
              0.14, 0.75, 1.0, 0.15, 0x9a9894,
              -fx2 * 0.8, 0.35, -fz2 * 0.8);
          } else car._smokeT = 0.3;
        }
      }
      // ---- brake lights ----
      // The same smoothed deceleration that dips the nose. On the merged body
      // the brake element is part of the one draw and lights by a material
      // swap (js/carmesh.js setCarState); userData.brake is then a plain
      // { visible } that the trailer (js/semitrailer.js) reads like before.
      const bl = m.userData.brake;
      let braking = false;
      if (bl) {
        // (against the direction of travel: pulling away in reverse is a
        // negative acceleration too, and it is not braking)
        braking = (car.speed < 0 ? -car._acc : car._acc) < -2.4 && Math.abs(car.speed) > 0.5;
        if (bl.visible !== braking) bl.visible = braking;
      }
      // ---- lamps on or off ----
      // A car with somebody in it burns its lamps (the running lights by day,
      // the full set after dark); a parked one is dark, the way a street of
      // parked cars is at night. Somebody: the traffic AI, a police or rescue
      // crew, the player's springs this frame, or plain movement. The hold
      // keeps a car stopped at a light, or just left by the player, from
      // blinking out for a frame.
      if (m.userData.carState) {
        if (car.ai || car.police || car.rescue || sprung || car._litT === Infinity
          || Math.abs(car.speed) > 0.3) car._litT = Math.max(car._litT ?? 0, 2);
        else if (car._litT > 0) car._litT -= dt;
        setCarState(m, car._litT > 0, braking);
      }
      // ---- contact shadow ----
      // Rides the car's own matrix (so it lies along the hill with the car),
      // except in the air, where it stays on the ground the car left and fades.
      // (not for a car the co-op layer has hidden: a parked car a peer has
      // claimed is drawn as his ghost, and its blob would stay behind alone)
      if (blobs && m.visible && nb < blobs.userData.capacity) {
        const air = (car.air ?? 0) > 0 ? Math.max(0, car.y - (car._surf ?? car.y)) : 0;
        const sh = Math.max(0, 1 - air * 0.5);
        _bp.set(car.x, car.y - air + 0.035, car.z);
        _bs.set(car.wid * 1.42 * sh, 1, car.len * 1.16 * sh);
        blobs.setMatrixAt(nb++, _bm.compose(_bp, m.quaternion, _bs));
      }
      const b = m.userData.body;
      // crash damage shows: the shell sags and takes a permanent list — cheap,
      // and it reads as "that car has had a day" from any distance
      const dmgK = Math.min(1, car.damage ?? 0);
      // …and the springs compress under a landing, then push back out
      b.position.y = -0.055 * dmgK - 0.14 * (car._sag ?? 0) + (car._heave ?? 0);
      b.rotation.z = car._roll + bumpR + (car._crushR ?? 0);  // +z roll lifts the right flank
      b.rotation.x = car._pitch;         // +x pitch lifts the nose
      if (car._tr) updateTrailer(car, dt);
      if (car.blink || car._bl) updateBlink(car);
    }
    if (this.ghosts?.eachCar) {
      this._nb = nb;
      this.ghosts.eachCar(this._ghostCar);
      nb = this._nb;
    }
    if (blobs) {
      blobs.count = nb;
      blobs.instanceMatrix.needsUpdate = true;
    }
  }
}
const _bp = new THREE.Vector3(), _bs = new THREE.Vector3(), _bm = new THREE.Matrix4();
function drawAfterLight(o) {
  if (o.isMesh && o.material && !o.material.transparent && o.renderOrder === 0) o.renderOrder = 1;
}

// ---- driveStep(car, ctl, dt, world, others): the player's arcade physics ----
// ctl = { gas: −1..1, steer: −1..1, brake: 0|1 (handbrake) }; others is an
// iterable of other cars for car-car collision (may contain `car` — skipped;
// omit it and the step degrades gracefully to walls-only, v2 behavior).
const _pt = { x: 0, z: 0 };
let _hitX = 0, _hitZ = 0;   // last building-contact point this step
// ---- crumple: BeamNG-style permanent sheet-metal deformation ------------
// The hulls are lofted BufferGeometries, so a crash can deform them the honest
// way: push every vertex near the impact point INWARD along the impact normal,
// with a smooth falloff and per-vertex noise so the dent has the crinkled read
// of bent steel rather than a scooped dish. Geometry is SHARED per kind, so the
// first dent on a car clones its hulls (that car pays ~1 ms once and owns its
// shape forever); later dents accumulate in the same clone. Normals recompute
// so the dent actually shades as a dent.
const _lv = new THREE.Vector3();
export function dentCar(car, wx, wy, wz, nx, nz, depth) {
  const hulls = car.mesh?.userData.hulls;
  if (!hulls || depth <= 0.01) return;
  // world impact → the body group's local frame (undo yaw + position)
  const h = car.heading, ch = Math.cos(h), sh = Math.sin(h);
  const dx = wx - car.x, dz = wz - car.z;
  const lx = ch * dx - sh * dz, lz = sh * dx + ch * dz;
  const ly = Math.max(0.15, Math.min(1.4, wy - car.y));
  const nL = Math.hypot(nx, nz) || 1;                        // callers pass unnormalized
  nx /= nL; nz /= nL;
  const lnx = ch * nx - sh * nz, lnz = sh * nx + ch * nz;   // push direction, local
  const R = 0.65 + depth * 1.6;                              // dent radius grows with the hit
  for (const mesh of hulls) {
    if (!mesh?.geometry) continue;
    if (!mesh.userData.owned) {                              // first dent: own the sheet metal
      mesh.geometry = mesh.geometry.clone();
      mesh.userData.owned = true;
    }
    const pos = mesh.geometry.attributes.position;
    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz2 = pos.getZ(i);
      const d = Math.hypot(px - lx, (py - ly) * 1.4, pz2 - lz);
      if (d >= R) continue;
      const t = 1 - d / R;
      // smoothstep falloff × depth, plus crinkle noise off the vertex POSITION.
      // It used to hash the vertex index, which was fine while every triangle
      // owned its corners. The hull is indexed now and the glass, the trim and
      // the lamps are separate meshes laid on it: two vertices that sit at the
      // same spot must take the same push, or a dent tears the windscreen off
      // the pillar it is draped over. And the wave is LONG (about half a
      // metre): a draped layer rides 3 to 7 mm off the paint, so at the old
      // 8 cm wavelength two stacked vertices still took pushes up to 2 cm
      // apart and a hit nose came out as shards of grille and paint.
      const k = t * t * (3 - 2 * t) * depth;
      const n = (Math.sin(px * 13.1 + py * 9.7 + pz2 * 11.3) * 0.5 + 0.5) * 0.35 + 0.65;
      pos.setXYZ(i,
        px + lnx * k * n,
        py - k * 0.22 * n,                                   // metal folds DOWN a little too
        pz2 + lnz * k * n);
      touched = true;
    }
    if (touched) {
      pos.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
  }
}

// ---- v14: collisions that bounce, and a body that has weight -----------------
// "Udělej to ovládání auta trošku lepší, jako v GTA San Andreas, s fyzikou."
//
// The wall pass used to SCALE the velocity (speed × 0.4, slide × 0.3) on every
// step that any corner touched masonry. Scaling is not a collision response:
// the velocity still points into the wall, so with the throttle held the car
// re-hit the same wall every frame, ground to a halt against it, took a fresh
// crunch and a fresh slice of damage each time (a 40 km/h tap measured 0.85 of
// a write-off) and a 30° glance at 70 km/h stopped dead instead of scraping off.
//
// What replaced it is an ordinary rigid-body impulse at the contact point:
// the push the world applied gives the normal, the contact offset gives the
// lever, and the impulse removes the closing velocity of THAT POINT (so a hit
// on one corner spins the car, a square hit on both does not), hands a little
// of it back as bounce, and lets the friction of the scrape take at most a
// fixed share of the tangential motion. Everything stays in specific units
// (mass 1) exactly like the tyre model, with the same yaw inertia.
const COL_STEP = 0.4;     // m of travel between collision passes: no tunnelling
const COL_MAX = 8;        // …and at most this many passes per call
const E_HI = 0.34;        // restitution of a gentle knock…
const E_LO = 0.1;         // …and of a 70 km/h one, where the crumple zone eats it
const E_REST = 1.0;       // m/s of closing below which contact just rests (no jitter)
const WALL_MU = 0.32;     // friction of metal scraping along a wall
const HIT_DMG_V = 2;      // m/s of closing speed before anything is bent

/** Bounce left in a hit closing at `vn` m/s. Hard hits are plastic. */
function restitution(vn) {
  if (vn < E_REST) return 0;
  const k = clamp((vn - 2) / 18, 0, 1);
  return E_HI + (E_LO - E_HI) * k;
}

/** Yaw radius of gyration², the tyre model's own number. */
function yawInertia(car) {
  const L = car.len * WHEELBASE, a = L * CG_FRONT;
  return KZ2 * a * (L - a);
}

/**
 * Keep the hardest hit of this driveStep call on the car, for whoever wants to
 * know what just happened (js/ejection.js decides from it whether the driver
 * stays in his seat). impactCos is 1 for the nose going square into the thing,
 * 0 for a broadside, negative for reversing into it. The velocity is the car's
 * ground velocity BEFORE the impulse, which is the speed an unbelted body keeps.
 */
function noteImpact(car, vn, nx, nz, vwx, vwz, what) {
  if (vn <= (car.impactV ?? 0)) return;
  car.impactV = vn;
  car.impactCos = Math.sin(car.heading) * nx + Math.cos(car.heading) * nz;
  car.impactVx = vwx; car.impactVz = vwz;
  car.impactWith = what;
}

// ---- CAR-CAR: two-circle bodies, impulse at the contact ----
// Each car ≈ two discs riding its long axis (front/rear, r ≈ wid·0.62):
// the cheapest shape that lets glancing hits slide off and T-bones connect
// at the door instead of a phantom bbox corner. Runs BEFORE the wall pass
// so a shoved player still ends the frame outside the architecture.
function carCarPass(car, others, world) {
  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);
  const rx = Math.cos(h), rz = -Math.sin(h);
  const rA = car.wid * 0.62, dA = Math.max(0, car.len / 2 - rA);
  const mA = kindOf(car.kind).mass;
  const I = yawInertia(car);
  for (const o of others) {
    if (o === car) continue;           // the iterable may contain ourselves
    const cdx = car.x - o.x, cdz = car.z - o.z;
    if (cdx * cdx + cdz * cdz > HIT_RANGE2) continue;   // 12 m gate
    const ofx = -Math.sin(o.heading), ofz = -Math.cos(o.heading);
    const rB = o.wid * 0.62, dB = Math.max(0, o.len / 2 - rB);
    const mB = kindOf(o.kind).mass;
    const wA = mB / (mA + mB), wB = mA / (mA + mB);     // light party moves more
    for (let ci = -1; ci <= 1; ci += 2) for (let cj = -1; cj <= 1; cj += 2) {
      const aox = fx * dA * ci, aoz = fz * dA * ci;     // our disc, their disc
      const box = ofx * dB * cj, boz = ofz * dB * cj;
      let nx = (car.x + aox) - (o.x + box), nz = (car.z + aoz) - (o.z + boz);
      const d2 = nx * nx + nz * nz, rr = rA + rB;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-6;
      nx /= d; nz /= d;                // contact normal, other → us
      const pen = rr - d;
      car.x += nx * pen * wA; car.z += nz * pen * wA;   // separate both bodies
      o.x -= nx * pen * wB; o.z -= nz * pen * wB;
      // the contact point on our side, as a lever from our centre
      const ax = aox - nx * rA, az = aoz - nz * rA;
      const r = car.yaw ?? 0, lat = car._lat ?? 0;
      const vwx = fx * car.speed + rx * lat, vwz = fz * car.speed + rz * lat;
      const cvx = vwx + r * az - ofx * o.speed;
      const cvz = vwz - r * ax - ofz * o.speed;
      const vn = cvx * nx + cvz * nz;  // < 0 while closing
      if (vn < 0) {
        const closing = -vn;
        // Momentum, not a scrub factor. The old 0.55 of the closing speed left
        // the two still closing after the "impact", so the next step hit again
        // and the cars ground into each other rather than knocking apart. A
        // truck barely feels a hatch, a hatch very much feels a truck: that is
        // the two inverse masses, and the lever term is what makes a hit on the
        // rear quarter swing the tail.
        const e = restitution(closing);
        const qn = nx * az - nz * ax;
        const invA = (1 + qn * qn / I) / mA, invB = 1 / mB;
        const j = (1 + e) * closing / (invA + invB);
        const dvx = nx * j / mA, dvz = nz * j / mA;
        car.speed += dvx * fx + dvz * fz;
        car._lat = lat + dvx * rx + dvz * rz;
        car.yaw = clamp(r + qn * j / (mA * I), -R_MAX, R_MAX);
        // the other car only carries a scalar speed: project its shove onto
        // its own forward, clamp against absurd launches, and twist it a touch
        o.speed = clamp(o.speed - (nx * ofx + nz * ofz) * j / mB, -55, 55);
        o.heading += clamp((boz * -nx - box * -nz) * j / mB * 0.02, -0.04, 0.04);
        noteImpact(car, closing, nx, nz, vwx, vwz, 'car');
        // BeamNG-lite bookkeeping: both parties take damage by closing
        // speed, the hit crunches audibly, and a hard one sheds trim
        if (closing > HIT_DMG_V) {
          const sev = Math.min(1, closing / 18);
          car.damage = Math.min(1.2, (car.damage ?? 0) + sev * 0.45);
          o.damage = Math.min(1.2, (o.damage ?? 0) + sev * 0.45);
          crash(sev);
          const mx = (car.x + o.x) / 2, mz = (car.z + o.z) / 2;
          dentCar(car, mx, car.y + 0.55, mz, -nx, -nz, sev * 0.3);
          dentCar(o, mx, o.y + 0.55, mz, nx, nz, sev * 0.3);
          if (closing > 6) world.crashDebris?.(
            (car.x + o.x) / 2, car.y, (car.z + o.z) / 2, car.color,
            Math.min(8, 2 + closing | 0), closing * 0.5);
          if (sev > 0.4) car._crushR = ((car._crushR ?? 0) + (Math.random() - 0.5) * 0.05);
        }
      }
      o._rammedT = 2.5;                // tell the traffic AI it just got hit
    }
  }
}

// A LAMP MAST GOES OVER BEFORE IT IS A WALL. Asked first, because
// world.collide() below now treats a standing mast as solid, and a column
// you hit at fifty should end up in the gutter, not stop the car dead like
// masonry. Below the felling speed nothing happens here and the mast wins
// the ordinary way, which is what parking against one should feel like.
function polePass(car, world) {
  if (!world.poles?.strike) return;
  const vx = -Math.sin(car.heading) * car.speed, vz = -Math.cos(car.heading) * car.speed;
  const nose = car.len / 2;
  const felled = world.poles.strike(
    car.x - Math.sin(car.heading) * nose, car.z - Math.cos(car.heading) * nose,
    vx, vz, car.wid / 2 + 0.4) ?? 0;
  if (felled) {
    // it costs the car something, but nothing like a wall: a lamp column is
    // a thin steel tube and the car walks away with a dent
    car.speed *= 0.86;
    car.damage = Math.min(1.2, (car.damage ?? 0) + 0.05 * felled);
  }
}

// 4-corner sampling against buildings + water (6 points on truck/bus, since a
// long flank must not thread itself through a building corner): every pushed
// point drags the whole car out with it, and their summed push is the contact
// normal. Points are pulled slightly inboard so brushing a wall reads as paint
// contact, not a force field.
const _wallOpts = { y: 0 };
function wallPass(car, world) {
  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);
  const rx = Math.cos(h), rz = -Math.sin(h);
  const hl = car.len / 2 - 0.2, hw = car.wid / 2 - 0.1;
  const nPts = car.len > 5.5 ? 6 : 4;
  // Every corner is asked from the SAME pose before anything moves. Moving
  // the car after each one (the old way) meant the first corner's push lifted
  // the second clear of the wall, so a square hit read as a one-corner hit and
  // span the car on a dead-straight run into a flat wall.
  let n = 0, snx = 0, snz = 0, sax = 0, saz = 0, sw = 0, deep = 0;
  for (let i = 0; i < nPts; i++) {
    const of = i < 2 ? hl : i < 4 ? -hl : 0, os = i & 1 ? hw : -hw;
    const wox = fx * of + rx * os, woz = fz * of + rz * os;
    _pt.x = car.x + wox; _pt.z = car.z + woz;
    const ox = _pt.x, oz = _pt.z;
    _wallOpts.y = (car.y ?? 0) + 0.3;      // the car's level: motorway barriers (js/mwsolid.js) need it
    if (world.collide(_pt, 0.5, _wallOpts)) {
      const px = _pt.x - ox, pz = _pt.z - oz;
      const pl = Math.sqrt(px * px + pz * pz);
      snx += px; snz += pz; n++;
      sax += wox * pl; saz += woz * pl; sw += pl;   // deeper corners carry the lever
      if (pl > deep) { deep = pl; _hitX = ox; _hitZ = oz; }   // where metal met masonry
    }
  }
  if (!n) return;
  const nl = Math.sqrt(snx * snx + snz * snz);
  if (nl < 1e-6 || sw < 1e-9) return;
  const nx = snx / nl, nz = snz / nl;            // out of the wall, into the car
  // out by the deepest corner's push along that normal, all of the car at once
  let depth = 0;
  for (let i = 0; i < nPts; i++) {
    const of = i < 2 ? hl : i < 4 ? -hl : 0, os = i & 1 ? hw : -hw;
    _pt.x = car.x + fx * of + rx * os; _pt.z = car.z + fz * of + rz * os;
    const ox = _pt.x, oz = _pt.z;
    if (world.collide(_pt, 0.5, _wallOpts)) depth = Math.max(depth, (_pt.x - ox) * nx + (_pt.z - oz) * nz);
  }
  car.x += nx * depth; car.z += nz * depth;
  const ax = sax / sw, az = saz / sw;            // lever: centre → contact
  const I = yawInertia(car);
  const r = car.yaw ?? 0, lat = car._lat ?? 0;
  const vwx = fx * car.speed + rx * lat, vwz = fz * car.speed + rz * lat;
  // the contact point's velocity: the centre's plus the spin's (dp/dt = r·(pz, −px))
  const cvx = vwx + r * az, cvz = vwz - r * ax;
  const vn = cvx * nx + cvz * nz;
  if (vn >= 0) return;                           // separating: the push was the contact
  const impact = -vn;
  const e = restitution(impact);
  const qn = nx * az - nz * ax;
  const jn = impact * (1 + e) / (1 + qn * qn / I);
  // the scrape: friction takes the sliding of the contact point, up to μ·jn
  const tx = -nz, tz = nx;
  const qt = tx * az - tz * ax;
  const vt = cvx * tx + cvz * tz;
  const jmax = WALL_MU * jn;
  const jt = clamp(-vt / (1 + qt * qt / I), -jmax, jmax);
  const Jx = nx * jn + tx * jt, Jz = nz * jn + tz * jt;
  const nvx = vwx + Jx, nvz = vwz + Jz;
  car.speed = nvx * fx + nvz * fz;
  car._lat = nvx * rx + nvz * rz;
  car.yaw = clamp(r + (Jx * az - Jz * ax) / I, -R_MAX, R_MAX);
  noteImpact(car, impact, nx, nz, vwx, vwz, 'wall');
  // CLOSING speed of the contact, not longitudinal speed: a car that arrives
  // at a wall sideways out of a drift used to hit it for free, because
  // car.speed reads near zero in a broadside. It still cannot, and a car that
  // merely scrapes along a wall now pays for the scrape and not for its speed.
  if (impact > HIT_DMG_V) {
    // the wall wins, the car pays: severity by impact speed. CRASH sound,
    // permanent damage, a spray of body-colour trim, and above ~50 km/h
    // the BUILDING pays too: a small localized blast (a fraction of a
    // rocket) knocks a few pieces off the facade where the nose went in.
    const sev = Math.min(1, impact / 20);
    car.damage = Math.min(1.2, (car.damage ?? 0) + sev * 0.55);
    crash(sev);
    // the push normal points OUT of the wall = into the car: dent along it
    dentCar(car, _hitX, car.y + 0.55, _hitZ, nx, nz, sev * 0.34);
    world.crashDebris?.(_hitX, car.y, _hitZ, car.color,
      Math.min(10, 2 + impact * 0.5 | 0), impact * 0.45);
    if (sev > 0.4) car._crushR = ((car._crushR ?? 0) + (Math.random() - 0.5) * 0.07);
    car._chipCd = Math.max(0, (car._chipCd ?? 0));
    if (impact > 14 && car._chipCd <= 0 && world.damageBuilding) {
      car._chipCd = 1.5;
      const hy = car.y + 1.0, rad = 2.0 + sev * 1.2;
      world.damageBuilding(null, _hitX, hy, _hitZ, rad);
      // …and the same hole on everyone else's copy of that facade. Same
      // {x,y,z,r} shape city.applyHit() takes, so the receiver has nothing to
      // translate. Rounded to 10 cm: this is a 2–3 m blast sphere, the extra
      // digits are pure bandwidth. Rate-limited inside emitVehicleEvent:
      // per-car _chipCd (1.5 s) is not a global cap and never was.
      emitVehicleEvent('vhit', {
        x: +_hitX.toFixed(1), y: +hy.toFixed(1), z: +_hitZ.toFixed(1),
        r: +rad.toFixed(2),
      });
    }
  }
}

// ---- the body on its springs ----
// The shell used to lean by `steer × speed × 0.004`, a guess with a clamp at
// 2.9°, and pitch off a differentiated speed. It now rides two damped springs
// driven by the accelerations the tyres actually produced, so the weight shows
// where it really goes: the nose dives when the brakes bite and lifts back
// with a little overshoot when they let go, the shell leans out of a corner in
// proportion to the g it is pulling and rocks back through a quick S-bend.
// Mesh only: none of this touches the tyre model, car.y or the ground
// attitude (_gp/_gr), so nothing that drives or collides can see it.
const ROLL_K = 0.0072;    // rad of roll per m/s² of cornering: ~4° at 1 g, GTA-soft
const PITCH_K = 0.0052;   // rad of pitch per m/s² along the car: ~3° in a panic stop
const ROLL_MAX = 0.12, PITCH_MAX = 0.075;
const BODY_W = 8.5;       // rad/s, the sprung body's natural frequency (≈1.35 Hz)
const BODY_Z = 0.42;      // damping ratio: one visible overshoot, then settled
const HEAVE_W = 14;       // rad/s up and down (≈2.2 Hz): a kerb is a quick jolt
const HEAVE_Z = 0.38;
const HEAVE_SOAK = 0.85;  // share of a surface step the springs take (the tyre the rest)
const HEAVE_MAX = 0.11;   // m either way before the bump stops
function bodyStep(car, dt) {
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  const tR = clamp(ROLL_K * (car._aLat ?? 0), -ROLL_MAX, ROLL_MAX);
  const tP = clamp(PITCH_K * (car._aLong ?? 0), -PITCH_MAX, PITCH_MAX);
  let r = car._bRoll ?? 0, rv = car._bRollV ?? 0;
  let p = car._bPitch ?? 0, pv = car._bPitchV ?? 0;
  let y = car._heave ?? 0, yv = car._heaveV ?? 0;
  const w2 = BODY_W * BODY_W, c = 2 * BODY_Z * BODY_W;
  const hw2 = HEAVE_W * HEAVE_W, hc = 2 * HEAVE_Z * HEAVE_W;
  for (let i = 0; i < n; i++) {
    rv += (w2 * (tR - r) - c * rv) * h; r += rv * h;
    pv += (w2 * (tP - p) - c * pv) * h; p += pv * h;
    yv += (-hw2 * y - hc * yv) * h; y += yv * h;
  }
  car._bRoll = clamp(r, -ROLL_MAX * 1.4, ROLL_MAX * 1.4); car._bRollV = rv;
  car._bPitch = clamp(p, -PITCH_MAX * 1.4, PITCH_MAX * 1.4); car._bPitchV = pv;
  car._heave = clamp(y, -HEAVE_MAX, HEAVE_MAX); car._heaveV = clamp(yv, -3, 3);
  car._bLive = true;               // vehicles.update: this car's shell is sprung
}

export function driveStep(car, ctl, dt, world, others) {
  // crash damage starves the drivetrain: a wreck at damage ≥ 1 no longer
  // pulls at all, and everything in between loses proportionate punch
  const dmg = Math.min(1, car.damage ?? 0);
  if (dmg >= 1) ctl = { ...ctl, gas: Math.min(0, ctl.gas ?? 0) };
  dt = Math.min(dt, 1 / 20);             // tab-return dt spikes must not teleport us
  const K = kindOf(car.kind);            // alias-safe: an old save may still say 'sedan'

  // steering lock falls with speed (falloff runs on km/h — the config K was
  // tuned so full lock at 130 km/h is a sane sweep, not a spin): parking-lot
  // tight at walking pace, highway-stable flat out. car.steer chases the
  // target so the wheel visibly winds over instead of snapping.
  const lock = CAR.steerMax / (1 + CAR.steerSpeedK * Math.abs(car.speed) * 3.6);
  // ---- how fast the wheel may be WOUND ON ----
  // The only steering input this game can receive is a key going down, so the
  // target jumps to full lock in one frame; at a flat 9/s the wheel followed it
  // in about 0.15 s at any speed. Measured, a keyboard stab at 108 km/h then
  // spiked the front slip angle hard enough to reach slip01 0.67 — past the
  // squeal and skid-mark gates — so merely turning at speed sounded and looked
  // like a drift. That is the "jako na ledě" complaint, and it was the input
  // model rather than the tyres.
  //
  // Winding ON therefore slows with speed, the way a real pair of hands does.
  // Coming BACK does not: a driver catching a slide gets the wheel straight as
  // fast as he likes, and countersteer has to stay instant or the slide that IS
  // deliberate becomes uncatchable.
  const tgt = clamp(ctl.steer ?? 0, -1, 1) * lock;
  const winding = Math.abs(tgt) > Math.abs(car.steer) && tgt * car.steer >= 0;
  const rate = winding ? STEER_ON / (1 + Math.abs(car.speed) * STEER_SLOW) : STEER_BACK;
  car.steer += (tgt - car.steer) * Math.min(1, rate * dt);

  // ---- the tyre model, on its own clock ----
  // dt arrives as anything up to 1/20 (the clamp above, and stepGame will hand
  // us twenty of those in one tick after a hidden tab). A tyre model integrated
  // at 20 Hz is a tyre model that oscillates and then spins the car, so it runs
  // at SUB_DT regardless of what the frame is doing. Everything in tyreStep is
  // arithmetic on scalars.
  const gas = clamp(ctl.gas ?? 0, -1, 1);
  const hb = !!ctl.brake;
  car.impactV = 0; car.impactCos = 0; car.impactWith = null;
  // ---- …and the collisions on theirs ----
  // One wall pass after a 1/20 s step at 130 km/h is 1.8 m of travel, and a
  // 30 cm wall (a garden wall, a parapet) is simply not there at either end of
  // it: measured, the car came out the far side. So the step is cut into
  // pieces no longer than COL_STEP and the tyres, the other cars, the masts and
  // the walls each get a say after every piece. At 60 fps in town that is one
  // or two passes; it only multiplies when the frame is long or the car fast.
  const vg0 = Math.sqrt(car.speed * car.speed + (car._lat ?? 0) * (car._lat ?? 0)) + K.accel * dt;
  const nCol = Math.min(COL_MAX, Math.max(1, Math.ceil(vg0 * dt / COL_STEP)));
  const cdt = dt / nCol;
  const nSub = Math.max(1, Math.ceil(cdt / SUB_DT));
  const sdt = cdt / nSub;
  for (let c = 0; c < nCol; c++) {
    for (let i = 0; i < nSub; i++) tyreStep(car, K, gas, hb, sdt);
    if (others) carCarPass(car, others, world);
    polePass(car, world);
    wallPass(car, world);
  }
  bodyStep(car, dt);
  if ((car._chipCd ?? 0) > 0) car._chipCd -= dt;

  // ---- what the rest of the game is told about the slide ----
  // GROUND speed, not car.speed. car.speed is longitudinal by contract and a
  // dozen consumers depend on that, but a car crossing a junction sideways at
  // 25 m/s reports almost none of it — which would mean a frozen speedometer, a
  // harmless wall, a pedestrian who survives being run over and silent tyres.
  // The old model made real slides rare enough to hide all four; this one does
  // not, so the honest number is published alongside.
  const vy = car._lat ?? 0;
  car.vGround = Math.sqrt(car.speed * car.speed + vy * vy);
  // Contact-patch scrub per axle, in m/s. Zero through a clean corner — in the
  // kinematic limit BOTH of these cancel exactly — so it is a true slide
  // detector rather than a cornering detector.
  const L2 = car.len * WHEELBASE;
  const yr = car.yaw ?? 0;
  const sdd = Math.sin(car.steer), cdd = Math.cos(car.steer);
  // Locked wheels scrub along the road as well as across it: the handbrake
  // drags the rear, and a panic stop drags everything. Without this a straight
  // handbrake stop would leave no mark and make no noise, which is most of what
  // the manoeuvre is for.
  const lockR = hb ? Math.abs(car.speed) : 0;
  // 0.22, not more: at 0.32 a straight-line panic stop from 108 km/h saturated
  // slip01 outright, so an emergency brake was indistinguishable from a full
  // sideways drift in both the mix and the marks it left.
  const lockAll = (gas < -0.6 && Math.abs(car.speed) > 5) ? Math.abs(car.speed) * 0.22 : 0;
  const vxs = Math.max(Math.abs(car.speed), SLIP_V);
  const aPk = A_PEAK * (1 - (1 - A_PEAK_OFF) * (car.offroad ?? 0));
  const aF = Math.atan((-car.speed * sdd + (vy - L2 * CG_FRONT * yr) * cdd) / vxs);
  const aR = Math.atan((vy + L2 * (1 - CG_FRONT) * yr) / vxs);
  // Only the slip angle IN EXCESS of the tyre's peak counts, converted back
  // into m/s of scrub so the number still means something physical downstream.
  const vAbs = Math.sqrt(car.speed * car.speed + vy * vy);
  const sF = Math.tan(Math.max(0, Math.abs(aF) - aPk)) * vAbs;
  const sR = Math.tan(Math.max(0, Math.abs(aR) - aPk)) * vAbs;
  car.slipF = Math.sqrt(sF * sF + lockAll * lockAll);
  car.slipR = Math.sqrt(sR * sR + lockR * lockR + lockAll * lockAll);
  const slipMax = Math.max(car.slipF, car.slipR);
  car.slip01 = Math.min(1, slipMax / SLIP_REF);
  // The chirp of letting go, and the bark of the lever. A loop faded up from
  // zero has no attack and the bite of a slide is entirely in its first moment.
  car._skidCd = Math.max(0, (car._skidCd ?? 0) - dt);
  if (car.slip01 > CHIRP_ON && (car._slipPrev ?? 0) <= CHIRP_ON && !car._skidCd) {
    car._skidCd = CHIRP_CD;
    skidChirp(0.5 + 0.5 * car.slip01);
  }
  if (hb && !car._hbPrev && Math.abs(car.speed) > 4) skidBark(Math.min(1, car.speed / 22));
  car._slipPrev = car.slip01;
  car._hbPrev = hb;


  // ---- what the tyres are touching ----
  // surfaceY puts the wheels ON the rendered deck (LAYER_Y.road above the
  // ground plane — riding heightAt() sank the tyres 20 cm into every bridge).
  // Off the tarmac the car is OFFROAD: grass and dirt cap the speed around
  // 40 km/h through heavy drag, and vehicles.update() reads car.offroad to
  // shake the body. The transition eases over ~0.3 s so a kerb-hop doesn't
  // snap the suspension.
  if (world.surfaceY) {
    const s = world.surfaceY(car.x, car.z, car.y);
    // (car.offroad ?? 0) on BOTH sides. add() seeds the field, but a car built
    // by hand — the tests do exactly this — arrives without it, and `undefined
    // += …` is NaN. That NaN used to be harmless: every reader compared it
    // (`> 0.05`, always false) and comparisons swallow NaN silently. The tyre
    // model MULTIPLIES by it, so the same latent bug now poisons grip, then
    // yaw, then position, and the car vanishes to NaN on its first frame.
    car.offroad = (car.offroad ?? 0)
      + ((s.road ? 0 : 1) - (car.offroad ?? 0)) * Math.min(1, dt * 3.5);
    suspension(car, s.y, dt, world);
    if (car.offroad > 0.05 && Math.abs(car.speed) > 0.5) {
      // Rolling resistance of a field, not of glue — solved, not guessed: an
      // Octavia's curve gives a = 7·(1 − v/64)^1.3, which at 25 m/s (90 km/h)
      // is 3.7 m/s². For the meadow to top out THERE, drag at 25 m/s must
      // equal 3.7: 0.3 + 625·q = 3.7 → q = 0.0054. (0.055 was the mud everyone
      // complained about; 0.0107 measured out at 60 km/h.) The ground still
      // argues — through the body judder in update(), which grows with speed.
      const k = car.offroad;
      const v = Math.abs(car.speed);
      const drag = (0.3 + v * v * 0.0054) * k;
      car.speed -= Math.sign(car.speed) * Math.min(v, drag * dt);
    }
  } else {
    suspension(car, world.heightAt(car.x, car.z), dt, world);
  }
}

const TILT_R2 = 250 * 250;   // m² — past this an AI car's attitude is invisible
const PASS_R2 = 55 * 55;     // …and past this its pass-by is inaudible anyway
const PASS_MAX = 80;         // m — where sfxAt fades the pass-by to nothing
const PASS_CD = 5;           // s between one car's own pass-bys

// ---- suspension(car, surf, dt, world): the wheels stop being glued down -----
// Until this existed, `car.y = surfaceY(x, z)` — the car was a decal on the
// terrain. It could not leave the ground, so a crest was a shrug and a drop-off
// was a slide, and on a 10 % grade the body stayed dead level while the world
// tilted underneath it.
//
// The model is the smallest honest one: a single vertical degree of freedom
// plus an attitude read off the ground under the wheelbase.
//
//   · GROUNDED, the car's vertical speed is not free — it IS whatever rate the
//     ground is lifting the wheels, which is (slope × speed). Carrying that
//     number is the entire trick: at a crest the ground stops climbing but the
//     car's +vy does not vanish, so it keeps going up. That is a jump, and it
//     falls out of the physics rather than being special-cased.
//   · AIRBORNE, only gravity acts. Touchdown is y falling back through the
//     surface; the overshoot velocity is the impact.
//
// The launch slope is sampled over the REAR half of the car (back axle →
// centre), not the whole wheelbase. On a ramp lip the front wheels are already
// over the edge while the rear is still climbing — averaging the two would read
// "flat" at the exact instant a real car is being thrown into the air.
const GRAV = 9.81;
const AIR_EPS = 0.05;      // m of clearance before we call it flying
const VY_MAX = 9;          // m/s of launch — past this it is data, not a ramp
const JUMP_V = 4;          // m/s ground speed below which nothing takes off
const STEP_FLOOR = 0.4;    // m of surface change a STANDING car may be handed
const STEP_SLOPE = 2;      // …plus this × the distance it actually travelled
function suspension(car, surf, dt, world) {
  const y0 = car.y ?? surf;
  const at = world.surfaceY
    ? (x, z) => world.surfaceY(x, z, car.y).y
    : (x, z) => world.heightAt(x, z);

  // A height map arriving (or a respawn) moves the ground by tens of metres
  // between two frames, and dropping the car down that hole would be a bug
  // wearing physics as a disguise. What separates it from a real drop-off is
  // that terrain can only change as fast as the car DRIVES INTO it: a 200 %
  // grade — steeper than anything DMR 5G resolves at 20 m spacing — is 2 m of
  // fall per metre travelled. Anything past that budget is a data change, so
  // re-seat rather than fall. A standing car gets a small allowance for a kerb
  // or a bridge deck appearing under it and nothing more.
  // …and the distance travelled is the GROUND distance: a car sliding sideways
  // over a kerb covers metres that car.speed does not report, and under-
  // budgeting here trips the re-seat branch mid-drift, which hard-resets y,
  // _vy, air and the whole attitude in the middle of a slide.
  const budget = STEP_FLOOR + STEP_SLOPE * (car.vGround ?? Math.abs(car.speed)) * dt;
  const dSurf = surf - (car._surf ?? surf);
  const jumped = Math.abs(dSurf) > budget;
  car._surf = surf;
  if (jumped) {
    car.y = surf; car._vy = 0; car.air = 0; car._sag = 0;
    car._gp = 0; car._gr = 0;
    car._heave = 0; car._heaveV = 0; car._wVy = 0;
    return;
  }

  const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
  const rx = -fz, rz = fx;                       // right of forward, x east / z south
  const hl = car.len * 0.5, hw = car.wid * 0.5;
  const yF = at(car.x + fx * hl, car.z + fz * hl);
  const yB = at(car.x - fx * hl, car.z - fz * hl);

  let vy = (car._vy ?? 0) - GRAV * dt;
  let y = y0 + vy * dt;
  const flying = y > surf + AIR_EPS;
  if (flying) {
    car.air = (car.air ?? 0) + dt;
  } else {
    // touchdown, or simply still rolling
    const impact = Math.max(0, -vy);
    if ((car.air ?? 0) > 0.12 && impact > 2) {
      // The springs eat it: a visible squat that decays, and a number the
      // caller can turn into a thump and a puff of dust.
      car._sag = Math.min(1, impact / 9);
      car._thump = Math.min(1, impact / 9);
    }
    car.air = 0;
    y = surf;
    // ---- the springs soak the road ----
    // The wheels follow the surface exactly (that is what car.y is), but the
    // body on top of them is driven by the wheels' vertical ACCELERATION, not
    // their position: a steady climb moves wheels and body together and bends
    // no spring, while a kerb is a sudden change of vertical speed that kicks
    // the shell, which then springs back (bodyStep). Feeding position instead
    // sank the body 15 cm into every long hill.
    if (dt > 0) {
      const wVy = dSurf / dt;
      car._heaveV = (car._heaveV ?? 0) - (wVy - (car._wVy ?? wVy)) * HEAVE_SOAK;
      car._wVy = wVy;
    }
    // The wheels are down, so the ground writes the vertical speed. Below a
    // walking pace nothing may launch — otherwise terrain noise makes a parked
    // car hover a centimetre off its own driveway.
    const climb = ((surf - yB) / hl) * car.speed;
    vy = Math.abs(car.speed) < JUMP_V ? Math.min(0, climb)
      : Math.max(-VY_MAX, Math.min(VY_MAX, climb));
  }
  car.y = y;
  car._vy = vy;
  car._sag = Math.max(0, (car._sag ?? 0) - dt * 3.5);

  // ---- attitude ----
  // On the ground the body lies along the hill. In the air it follows its own
  // trajectory, which is what makes a drop-off read as a drop-off: nose down on
  // the way to the landing, exactly as the user asked for.
  const gp = flying
    ? Math.atan2(vy, Math.max(6, Math.abs(car.speed)))
    : Math.atan2(yF - yB, car.len);
  const gr = flying ? (car._gr ?? 0) * 0.94
    : Math.atan2(at(car.x + rx * hw, car.z + rz * hw)
               - at(car.x - rx * hw, car.z - rz * hw), car.wid);
  // Faster in the air than on the ground: a launch has to look sudden, while a
  // road that is merely bumpy should not make the body strobe.
  const k = Math.min(1, dt * (flying ? 7 : 4));
  car._gp = (car._gp ?? 0) + (clamp(gp, -0.7, 0.7) - (car._gp ?? 0)) * k;
  car._gr = (car._gr ?? 0) + (clamp(gr, -0.5, 0.5) - (car._gr ?? 0)) * k;
}

// ---- seatAnchor(car, i) → LOCAL-space seat point { x, y, z } -------------
// Purely additive boarding/passenger API — nothing inside this module calls
// it; player.js walks people to it and the net layer places remote riders on
// it. Coordinates are the car's LOCAL frame: origin on the ground under the
// center, −z the nose, +x the RIGHT flank (world = rotate by car.heading).
// The y returned is the SEAT CUSHION TOP; a sitting citizen group (hip pivot
// 0.86·scale above its own origin) belongs ~0.78·scale below it.
//   i = 0 → driver (LEFT, Czech cars: x = −0.35·wid)   i = 1 → passenger
//   (right); i = 2/3 land on a rear bench one row (0.85 m) back.
// Occupancy is NOT tracked here: whoever seats people lazily creates
// `car.seats = [occupant0, occupant1, …]` on the car object and claims a
// seat by writing itself into the slot — see player.boardVehicle() and the
// registry comment beside main.js's E-handler.
export function seatAnchor(car, i = 0) {
  const K = kindOf(car.kind);
  const wid = car.wid ?? K.wid;
  const g = K.green, sts = K.hull.sts;
  let top = 0;
  for (const s of sts) if (s[2] > top) top = s[2];
  // cushion height: a hand under the greenhouse base keeps every roofline
  // clear of a seated head; the cab-over kinds (truck, bus — no greenhouse
  // loft) perch the driver at ~62 % of their tall slab hull instead
  const y = (g ? g.sts[0][1] : top * 0.62) - 0.42;
  // fore/aft: halfway up the windscreen rake (the first two greenhouse
  // stations) plus half a metre puts the front row right behind the glass;
  // blind-cab kinds sit hard against the front face, cab-over style
  const z = (g ? (g.sts[0][0] + g.sts[1][0]) / 2 + 0.5 : sts[0][0] + 1.15)
    + (i >> 1) * 0.85;
  return { x: (i % 2 ? 1 : -1) * wid * 0.35, y, z };
}

// Piecewise-linear read of a station column at an arbitrary z. Stations run
// front→rear, so this asks the greenhouse how high its roof (col 2) or its
// beltline (col 1) is exactly where the head is, instead of settling for a
// whole-car maximum that belongs over the back seat.
function stationAt(sts, z, col) {
  if (z <= sts[0][0]) return sts[0][col];
  for (let k = 1; k < sts.length; k++) {
    if (z > sts[k][0]) continue;
    const t = (z - sts[k - 1][0]) / (sts[k][0] - sts[k - 1][0]);
    return sts[k - 1][col] + (sts[k][col] - sts[k - 1][col]) * t;
  }
  return sts[sts.length - 1][col];
}

const EYE_SIT = 0.62;    // a seated adult's eyes above the cushion they're on
const EYE_ROOF = 0.13;   // rail: never closer than this to the headliner
const EYE_BROW = 0.12;   // rail: never sink below the doorline into the trim

// ---- eyeAnchor(car, i) → LOCAL-space EYE point { x, y, z } ---------------
// The first-person camera anchor: the same frame and the same seat as
// seatAnchor(), raised from the cushion to the rider's eyes. Callers rotate
// it by car.heading exactly like the seat point.
//
// Not one constant here is per-kind, and that is the point: a seated adult's
// eyes sit EYE_SIT above whatever they sit on, so the entire spread between a
// Tesla and a bus falls out of seatAnchor's cushion, which each kind derives
// from its OWN greenhouse base (or, for the cab-over kinds with no
// greenhouse, 62 % of their slab hull). It also keeps the camera exactly
// where the visible rider's head is, so a remote passenger looks out of the
// face other players can see.
//
// The clamps are rails, not tuning — no kind reaches either today (tightest
// headroom is the BMW's 0.35 m, smallest brow margin the Tesla's 0.17 m), but
// a future roofline edit in KIND must shove the camera out of the headliner
// rather than let it render from inside the roof.
//
// Checked against all eight rosters — eye Y / clearance under the roof at the
// seat's own z / gap to the windscreen measured AT eye level:
//   tesla   1.00 / 0.41 / 0.68     bmw    1.03 / 0.35 / 0.61
//   fabia   1.03 / 0.39 / 0.62     merc   1.06 / 0.37 / 0.62
//   octavia 1.07 / 0.37 / 0.63     van    1.22 / 0.72 / 0.73
//   truck   1.76 / 0.75 /  —       bus    2.05 / 0.92 /  —
// Truck and bus have no greenhouse loft; their screens are glass boxes over
// in DETAIL, and both eye points land inside those bands (truck screen spans
// 1.50–2.30, bus glazing 1.45–2.40) high up and a metre behind the glass, as
// a cab-over should feel. Sideways the tightest case is the BMW at 0.08 m
// from the door glass: the cabin is wider at eye height than at the roof
// rail, which is where the tumblehome bites.
export function eyeAnchor(car, i = 0) {
  const a = seatAnchor(car, i);
  const K = kindOf(car.kind), g = K.green;
  let y = a.y + EYE_SIT;
  if (g) {
    y = Math.max(y, stationAt(g.sts, a.z, 1) + EYE_BROW);
    y = Math.min(y, stationAt(g.sts, a.z, 2) - EYE_ROOF);
  } else {
    y = Math.min(y, stationAt(K.hull.sts, a.z, 2) - EYE_ROOF);
  }
  a.y = y;
  return a;
}

// ---- CABIN: the interior, built for ONE car at a time ---------------------
// makeCarMesh() deliberately models no interior: up to ~520 cars are alive in
// the city at peak and every one of them would pay for a dashboard nobody can
// see through opaque glass. First person changed that for exactly one car —
// the one the player is sitting in — so the cabin is a SEPARATE, opt-in graft:
// main.js calls attachCabin() on boarding and detachCabin() on exit.
//
// Three decisions worth the ink:
//
// 1. EVERY PART IS A SOLID, so every material stays FrontSide. A dashboard,
//    a seat and a steering wheel are objects the eye is OUTSIDE of, and the
//    surfaces that genuinely enclose the head — headliner, door cards, floor,
//    bulkhead — are modelled as thin SLABS rather than single planes, so their
//    inward face is a front face like everything else. Nothing here needs
//    BackSide or DoubleSide, which matters because flipping `side` on the
//    shared glassMat/bodyMat would have doubled the overdraw of the whole
//    fleet to fix one car.
//
// 2. IT PARENTS TO `group`, NOT TO `body`. Vehicles.update() leans `body` into
//    corners and sags it with damage, while the first-person camera in main.js
//    deliberately ignores roll and pitch (leaning the horizon is what makes
//    people ill). A cabin under `body` would therefore slosh around a head
//    that does not move with it. Under `group` the interior is welded to the
//    eye, and group.position.y still carries the offroad judder the camera
//    reads off the mesh — so the cabin shakes with the head, exactly once.
//
// 3. NOTHING IS DERIVED FROM A MAGIC NUMBER. The dash top IS the greenhouse
//    base station (which is also where seatAnchor drops its cushion from), the
//    A-pillar IS the windscreen's own rake between green.sts[0] and [1], the
//    headliner is the LOWEST roof station the cabin spans, and the door cards
//    ride the narrowest hull station between the cowl and the rear of the
//    cabin. A bus gets a wide dash 1.83 m up because its slab hull says so; a
//    BMW gets a low one at 0.83 m for the same reason.

// The interior is unlit — the city has a sun and a hemisphere and no cabin
// lamp — so a pure Lambert dash reads as a black hole under the roof. Each
// material carries a small emissive floor instead: enough to keep the SHAPE
// legible from inside, far too little to glow in a chase-cam shot. The
// headliner is deliberately the lightest surface in here, the way real ones
// are, so the ceiling never becomes the void the player is staring into.
const trimMat = new THREE.MeshLambertMaterial({ color: 0x33373e, emissive: 0x15181c });
const linerMat = new THREE.MeshLambertMaterial({ color: 0x767c84, emissive: 0x2b3037 });
const seatMat = new THREE.MeshLambertMaterial({ color: 0x424650, emissive: 0x17191e });
const rimMat = new THREE.MeshLambertMaterial({ color: 0x1a1c21, emissive: 0x0b0c0e });
// the only bright thing in the cabin: cluster + centre screen, lit like a
// screen rather than shaded like plastic, so night driving has a face to it
const screenMat = new THREE.MeshLambertMaterial({ color: 0x0c1a26, emissive: 0x2f6b9e, emissiveIntensity: 0.75, toneMapped: false });
// name → material, in the order the meshes get added (one draw call each)
const CABIN_MATS = [['trim', trimMat], ['liner', linerMat], ['seat', seatMat],
  ['rim', rimMat], ['screen', screenMat], ['chrome', chromeMat]];

const CAB_TRIM = 0.05;     // how far a panel sits inside the shell it lines
const CAB_BELT = 0.42;     // cushion → dash top; seatAnchor's own cushion drop
const CAB_REACH = 0.50;    // eye → steering wheel: an adult's arms, seated
const CAB_REACH_CO = 0.44; // cab-over: upright posture, big wheel held closer

// A hull ring is a PROFILE, not a cylinder: tucked under at the rocker (bw),
// full width between the arch line and the doorline, pulled back in over the
// shoulder (sh). An interior panel has to clear that profile at its own
// height — sizing anything to the ring's widest point is how a door card ends
// up poking out through the tumblehome at the C-pillar.
function hullHalfAt(K, z, y) {
  const sts = K.hull.sts, w = widthAt(sts, z, K.wid / 2);
  const yLo = stationAt(sts, z, 1), yHi = stationAt(sts, z, 2), h = yHi - yLo;
  if (h <= 0) return w;
  const yA = yLo + h * K.hull.yA, yB = yLo + h * K.hull.yB;
  if (y <= yLo) return w * K.hull.bw;
  if (y < yA) return w * (K.hull.bw + (1 - K.hull.bw) * (y - yLo) / (yA - yLo));
  if (y <= yB) return w;
  if (y >= yHi) return w * K.hull.sh;
  return w * (1 - (1 - K.hull.sh) * (y - yB) / (yHi - yB));
}
// worst case of f over a z range — the shell tapers, the panels do not
const spanMin = (z0, z1, f) => { let m = Infinity; for (let t = 0; t <= 10; t++) m = Math.min(m, f(z0 + (z1 - z0) * t / 10)); return m; };
const spanMax = (z0, z1, f) => { let m = -Infinity; for (let t = 0; t <= 10; t++) m = Math.max(m, f(z0 + (z1 - z0) * t / 10)); return m; };

// Everything the builder needs, as plain numbers and nothing from THREE — so
// the whole dimension table can be checked without a WebGL context.
function cabinSpec(kind) {
  const K = KIND[kind] ?? KIND.octavia;
  const g = K.green, sts = K.hull.sts, half = K.wid / 2;
  const seat = seatAnchor({ kind }, 0), eye = eyeAnchor({ kind }, 0);
  // dash top = the beltline. For a lofted greenhouse that is literally the
  // first base station; the cab-over kinds have no greenhouse, so the same
  // cushion→belt relationship seatAnchor used on the way down rebuilds it.
  const beltY = g ? g.sts[0][1] : seat.y + CAB_BELT;
  // the SAME z span the hull opened for us — never a second derivation
  const cutZ = cabinCut(K);
  const cowlZ = cutZ ? cutZ.z0 : sts[0][0] + 0.15;    // windscreen base
  const hdrZ = g ? g.sts[1][0] : cowlZ + 0.14;        // windscreen top (rake!)
  const scrY = g ? g.sts[0][2] : beltY + 0.03;        // where the glass starts
  // Roof heights are read AT the station that needs them, never as a whole-car
  // maximum: a truck's roof peaks a metre behind its header, and a header rail
  // built to that peak would stand proud of the paint above the screen.
  const roofSts = g ? g.sts : sts;
  const roofY = g ? g.sts[1][2] : stationAt(sts, hdrZ, 2);
  const backZ = cutZ ? cutZ.z1
    : Math.min(cowlZ + 3.0, sts[sts.length - 1][0] - 0.15);
  // headliner: the LOWEST roof over the cabin's span, so a fastback's dropping
  // roofline can never push the flat plate out through the paint
  const linerY = spanMin(hdrZ, backZ, (z) => stationAt(roofSts, z, 2)) - 0.035;
  // DOOR CARDS COME IN TWO TIERS, and the reason is the near plane. seatAnchor
  // parks the eye at ±0.35·wid, which on an Octavia is 0.63 m out — and at the
  // BELTLINE the hull has already tucked its shoulder in to 0.76 m, so a
  // single card up there would sit 7 cm from the eyeball: closer than FP_NEAR,
  // clipped into a hole, and filling the screen at full head-turn anyway.
  // The card proper therefore stops at the DOORLINE (hull.yB — the window
  // sill), where the ring is still at full width and the panel lands ~0.39 m
  // from the eye, comfortably solid. Only a thin sill strip carries on up to
  // the glass, and only that strip is ever near-plane fragile.
  const sillY = Math.min(beltY, spanMin(cowlZ, backZ, (z) => {
    const lo = stationAt(sts, z, 1);
    return lo + (stationAt(sts, z, 2) - lo) * K.hull.yB;
  }));
  const floor0 = Math.max(seat.y - 0.34, spanMax(cowlZ, backZ, (z) => stationAt(sts, z, 1)) + 0.05);
  // sized at BOTH ends of the panel: the sill above and the rocker tuck below
  const dw = Math.min(spanMin(cowlZ, backZ, (z) => hullHalfAt(K, z, sillY)),
    spanMin(cowlZ, backZ, (z) => hullHalfAt(K, z, floor0 - 0.04))) - 0.06;
  // The sill strip is the piece that MEETS the hull's door-top ledge, so it
  // takes its width from the same number the ledge did: strip outer face
  // (dwHi + half of its 0.04 thickness) lands exactly on cabinCut()'s x.
  // Identical arithmetic to the old spanMin(...) − 0.06, just not a second
  // copy of it.
  const dwHi = (cutZ ? cutZ.xIn
    : spanMin(cowlZ, backZ, (z) => hullHalfAt(K, z, beltY)) - 0.04) - 0.02;
  const wheelZ = seat.z - (g ? CAB_REACH : CAB_REACH_CO);
  // Above the beltline the greenhouse trapezoid is the limit, not the hull:
  // its TOP width is the tightest line anything up there has to clear, which
  // is why the A- and B-pillar trims share it.
  const topX = g ? g.topW * half : hullHalfAt(K, hdrZ, roofY - 0.08);
  return {
    kind, K, g: !!g, beltY, cowlZ, hdrZ, scrY, roofY, backZ, linerY, dw, dwHi, sillY,
    // interior half width at the dash (front) and at the rear panels; the
    // greenhouse base governs where it exists, the hull profile where it does not
    iwF: Math.min(g ? g.baseW * half : Infinity, hullHalfAt(K, cowlZ, beltY)) - CAB_TRIM,
    iwR: Math.min(g ? g.baseW * half : Infinity, hullHalfAt(K, backZ, beltY)) - CAB_TRIM,
    iwT: (g ? g.topW * half : spanMin(hdrZ, backZ, (z) => hullHalfAt(K, z, linerY))) - CAB_TRIM,
    pillarX: topX - 0.065,
    bpillarX: topX - 0.065,
    // Stations 2 and 3 bracket the narrow 'pp' segment — the B-pillar — but
    // only on the SIX-station saloons. The van's greenhouse has four, so 2/3
    // are its last pair and the midpoint lands at z 1.21: 1.11 m behind backZ,
    // walled off inside the cargo bay by the bulkhead, where the player cannot
    // see it from the seat or from outside. Clamping into the cabin puts it
    // where a panel van's B-pillar actually is, just ahead of the bulkhead,
    // and leaves all five saloons on the exact z they already had.
    bpillarZ: g ? clamp((g.sts[2][0] + g.sts[3][0]) / 2, cowlZ + 0.3, backZ - 0.15)
      : backZ - 0.2,
    // the floor pan never dips below the hull's own underside anywhere it
    // spans: a low-slung sedan would otherwise carpet the tarmac
    floorY: floor0,
    seatX: Math.abs(seat.x), seatZ: seat.z, eyeY: eye.y,
    wheelZ, wheelY: beltY - (g ? 0.13 : 0.17),
    wheelR: clamp(K.wid * 0.10, 0.165, 0.25),
    rake: g ? 0.38 : 1.02,
    dashZ: Math.max(wheelZ - 0.13, cowlZ + 0.16),  // the fascia facing the driver
    sw: Math.min(0.50, ((g ? g.baseW * half : hullHalfAt(K, seat.z, beltY)) - CAB_TRIM) * 0.62),
    nSeats: g && !g.capEnd ? 4 : 2,     // the van's bulkhead ends its cab
    bulkhead: !g || !!g.capEnd,
  };
}

// The cabin wall at a given height and station: the greenhouse trapezoid above
// the beltline (this is where the tumblehome bites), the hull profile below it.
function wallAt(K, g, z, y) {
  if (!g) return hullHalfAt(K, z, y);
  const yb = stationAt(g.sts, z, 1);
  if (y <= yb) return hullHalfAt(K, z, y);
  const yt = stationAt(g.sts, z, 2);
  const t = clamp((y - yb) / Math.max(1e-4, yt - yb), 0, 1);
  return (g.baseW + (g.topW - g.baseW) * t) * K.wid / 2;
}

// One seat: cushion, pedestal, raked backrest, headrest. The driver's own is
// almost entirely behind the near plane and that is fine — it exists so the
// three seats the player CAN turn and look at have a twin.
//
// The whole prop is fitted at SHOULDER height, not at the cushion. seatAnchor
// parks people at ±0.35·wid, which every roofline in the roster is narrower
// than by the time you get up to a seatback's top corner — so a seat built
// square on the anchor spears out through the door glass. The anchor is a
// contract (player.js walks to it, the net layer seats remote riders on it,
// eyeAnchor rides off it) and must not move, so the FURNITURE slides inboard
// instead: at most ~13 cm on the narrowest kinds, invisible from the seat.
function seatBox(d, K, g, ax, z, cy, fy, w) {
  const sgn = ax < 0 ? -1 : 1;
  const shoulder = wallAt(K, g, z, cy + 0.56) - 0.03;
  const hw = Math.min(w / 2, shoulder * 0.48);
  const x = sgn * Math.min(Math.abs(ax), Math.max(0.12, shoulder - hw));
  const ww = hw * 2;
  // …and the same story overhead: a rear bench sits under a fastback's DROPPING
  // backlight, so the backrest and the headrest are capped by the roof at
  // their own station rather than by a nominal seat height.
  const roofAt = (zz) => stationAt(g ? g.sts : K.hull.sts, zz, 2) - 0.05;
  B(d.seat, ww, 0.10, ww * 1.02, x, cy - 0.05, z);
  B(d.trim, ww * 0.66, Math.max(0.06, cy - 0.10 - fy), ww * 0.72, x, (fy + cy - 0.10) / 2, z);
  const brTop = Math.min(cy + 0.545, roofAt(z + 0.34)), brBot = cy - 0.02;
  if (brTop > brBot + 0.1)
    B(d.seat, ww, (brTop - brBot) * 0.95, 0.11, x, (brTop + brBot) / 2 - 0.025, z + 0.30, 0, 0.20);
  const hrTop = Math.min(cy + 0.685, roofAt(z + 0.40));
  if (hrTop > brTop - 0.06)
    B(d.seat, ww * 0.50, 0.17, 0.10, x, hrTop - 0.085, z + 0.40);
}

// The whole interior for one kind, merged per material — a cabin is six meshes
// plus the wheel badge, and it is built at most once per kind for the lifetime
// of the tab (cached beside the exterior geometry in _geo).
function buildCabin(kind) {
  const s = cabinSpec(kind);
  const d = { trim: [], liner: [], seat: [], rim: [], screen: [], chrome: [] };
  const { beltY, cowlZ, hdrZ, scrY, roofY, backZ, linerY, iwF, iwR, iwT, dw, dwHi,
    sillY, floorY, seatX, seatZ, wheelY, wheelZ, wheelR, rake, dashZ, sw } = s;
  // each panel's own half-thickness has to clear the shell too
  const cardX = dw - 0.023, sillX = dwHi - 0.023, cardL = backZ - cowlZ - 0.10;

  // ---- shell: floor, firewall, headliner, door cards -----------------------
  B(d.trim, cardX * 2, 0.04, backZ - cowlZ, 0, floorY - 0.02, (cowlZ + backZ) / 2);
  B(d.trim, iwF * 2, Math.max(0.10, beltY - 0.24 - floorY), 0.05,
    0, (floorY + beltY - 0.24) / 2, cowlZ + 0.04);
  B(d.liner, iwT * 1.96, 0.026, backZ - hdrZ, 0, linerY + 0.013, (hdrZ + backZ) / 2);
  pairB(d.trim, 0.045, Math.max(0.12, sillY - floorY - 0.02), cardL,
    cardX, (floorY + sillY) / 2, (cowlZ + backZ) / 2 + 0.05);
  if (sillY < beltY - 0.03)                                    // the sill strip
    pairB(d.trim, 0.04, beltY - sillY, cardL, sillX, (sillY + beltY) / 2, (cowlZ + backZ) / 2 + 0.05);
  pairB(d.trim, 0.085, 0.055, Math.min(0.60, backZ - cowlZ - 0.3),
    cardX - 0.05, sillY - 0.10, seatZ - 0.05);                 // armrests

  // ---- dashboard ----------------------------------------------------------
  // NOTHING here rises above the beltline. At the cowl station the greenhouse
  // ring is only a few centimetres tall (0.87 → 0.90 on an Octavia), so an
  // instrument hood standing proud of the dash pokes straight out through the
  // scuttle. The cluster therefore lives BEHIND the slab, on the face the
  // driver actually looks at, under a lip that overhangs it.
  B(d.trim, iwF * 2, 0.20, dashZ - cowlZ, 0, beltY - 0.10, (cowlZ + dashZ) / 2);
  B(d.trim, iwF * 2, 0.035, 0.11, 0, beltY - 0.020, dashZ + 0.05);   // the lip
  B(d.trim, iwF * 2, Math.max(0.12, beltY - 0.26 - floorY - 0.06), 0.05,
    0, (floorY + 0.06 + beltY - 0.20) / 2, dashZ + 0.02);      // lower fascia
  // the driver sits close to the door, so the cluster slides inboard until its
  // outer edge clears the fascia
  const inb = (w) => -Math.min(seatX, Math.max(0, iwF - w / 2));
  B(d.screen, 0.36, 0.14, 0.014, inb(0.36), beltY - 0.105, dashZ + 0.055, 0, -0.34);
  const cw = Math.min(0.34, iwF * 0.44);
  B(d.screen, cw, cw * 0.60, 0.014, 0, beltY - 0.17, dashZ + 0.048, 0, -0.18);
  pairB(d.chrome, 0.16, 0.028, 0.02, iwF * 0.62, beltY - 0.095, dashZ + 0.040);

  // ---- centre tunnel + shifter -------------------------------------------
  const conZ1 = seatZ + 0.42;
  if (conZ1 > dashZ + 0.1) {
    B(d.trim, cw, 0.24, conZ1 - dashZ, 0, floorY + 0.12, (dashZ + conZ1) / 2);
    B(d.rim, 0.05, 0.16, 0.05, 0, floorY + 0.30, dashZ + 0.24);
  }

  // ---- steering wheel: built flat in its own plane, then raked into place --
  // A torus in the XY plane has its axis on +z; rotateX(−rake) tips that axis
  // up and REARWARD, which is exactly where a driver's chest is.
  const tube = Math.max(0.017, wheelR * 0.095);
  const parts = [new THREE.TorusGeometry(wheelR, tube, 6, 18)];
  const hub = new THREE.CylinderGeometry(wheelR * 0.30, wheelR * 0.30, 0.05, 10);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);
  for (const a of [0, Math.PI, -Math.PI / 2]) {   // 3-spoke: two across, one down
    const sp = new THREE.BoxGeometry(wheelR * 0.80, 0.030, 0.024);
    sp.translate(wheelR * 0.46, 0, 0);
    sp.rotateZ(a);
    parts.push(sp);
  }
  // same inboard rule as the seat: on the wide-cabin kinds the rim would clip
  // the door glass if it stayed square on an anchor meant for a head
  const wx = -Math.min(seatX,
    Math.max(0.12, wallAt(s.K, s.K.green, wheelZ,
      wheelY + wheelR * Math.cos(rake) * 0.55) - 0.03 - wheelR - tube));
  for (const p of parts) { p.rotateX(-rake); p.translate(wx, wheelY, wheelZ); d.rim.push(p); }
  // column: a stub between the wheel and the fascia, on the same axis
  const col = new THREE.CylinderGeometry(0.045, 0.055, 0.20, 8);
  col.rotateX(Math.PI / 2 - rake);
  col.translate(wx, wheelY - Math.sin(rake) * 0.11, wheelZ - Math.cos(rake) * 0.11);
  d.trim.push(col);

  // ---- A-pillars + header rail + visors -----------------------------------
  // The pillar IS the windscreen's rake: it runs from the glass base at the
  // cowl to the roof at the header station, so every kind's own screen angle
  // falls out of KIND without a single per-car constant.
  const dy = roofY - scrY, dz = hdrZ - cowlZ, prx = Math.atan2(dz, dy), pt = 0.07;
  // Centring the prism ON the glass line would leave half of it OUTSIDE the
  // windscreen — a rotated box is also longer in y than its own length, since
  // half its thickness projects onto y as well. So: shorten it by its own
  // thickness, then push the whole thing along the screen's inward normal
  // (sin prx, −cos prx points outward) until it hangs entirely under the glass.
  const pLen = Math.max(0.15, Math.hypot(dy, dz) - pt * 1.6), pOff = pt / 2 + 0.008;
  // …and it LEANS IN with the glasshouse. The trim used to stand at the roof's
  // half width from top to bottom, which on a saloon is 18 cm inboard of where
  // the pillar actually meets the scuttle: a post rising out of the middle of
  // the dashboard, straight in front of a driver who sits this close to the
  // door. Foot at the glass base, head at the roof rail, like the pillar
  // outside it. Cab-over kinds have upright slab sides and keep the old post.
  const pFoot = s.g ? Math.max(s.pillarX, iwF - 0.03) : s.pillarX;
  const pLean = Math.atan2(pFoot - s.pillarX, Math.hypot(dy, dz));
  for (const sg of [-1, 1]) {
    const pg = new THREE.BoxGeometry(0.06, pLen, pt);
    pg.rotateZ(sg * pLean);                 // +z rotation tips the head toward −x
    pg.rotateX(prx);
    pg.translate(sg * (pFoot + s.pillarX) / 2,
      (scrY + roofY) / 2 - Math.sin(prx) * pOff,
      (cowlZ + hdrZ) / 2 + Math.cos(prx) * pOff);
    d.trim.push(pg);
  }
  B(d.trim, iwT * 2, 0.08, 0.16, 0, roofY - 0.055, hdrZ + 0.09);
  pairB(d.trim, 0.32, 0.022, 0.17, iwT * 0.50, roofY - 0.115, hdrZ + 0.17);
  // B-pillar: the deliberately narrow 'pp' greenhouse segment IS the pillar,
  // so its two stations bracket exactly where the trim belongs. Cab-over kinds
  // have no greenhouse loft and no B-pillar to line.
  if (s.g) {
    const bTop = stationAt(s.K.green.sts, s.bpillarZ, 2);
    pairB(d.trim, 0.05, Math.max(0.15, bTop - beltY - 0.02), 0.11,
      s.bpillarX, (beltY + bTop) / 2, s.bpillarZ);
  }

  // ---- rear of the cabin ---------------------------------------------------
  if (s.nSeats > 2) {
    B(d.trim, iwR * 1.92, 0.03, 0.40, 0, beltY + 0.03, backZ - 0.10);   // parcel shelf
    B(d.trim, iwR * 1.92, Math.max(0.10, beltY - floorY), 0.05,
      0, (floorY + beltY) / 2, backZ - 0.02);
  }
  if (s.bulkhead) B(d.trim, Math.min(iwR, iwT) * 2, Math.max(0.20, linerY - floorY), 0.05,
    0, (floorY + linerY) / 2, backZ - 0.03);

  // ---- seats ---------------------------------------------------------------
  for (let i = 0; i < s.nSeats; i++) {
    const a = seatAnchor({ kind }, i);
    seatBox(d, s.K, s.K.green, a.x, a.z, a.y, floorY, sw);
  }

  const out = {};
  for (const [key] of CABIN_MATS) out[key] = d[key].length ? mergeGeoms(d[key]) : null;
  // the marque on the wheel boss, reusing the cached badge texture the nose
  // already wears — one extra draw call, and the only colour in the cabin
  const K = KIND[kind] ?? KIND.octavia;
  out.badge = K.brand ? {
    brand: K.brand, size: wheelR * 0.46, rx: -rake,
    x: wx, y: wheelY + Math.sin(rake) * 0.034, z: wheelZ + Math.cos(rake) * 0.034,
  } : null;
  out.spec = s;
  return out;
}

// ---- attachCabin(car) → THREE.Group | null -------------------------------
// Grafts the interior onto ONE car and returns the group (idempotent: calling
// it twice hands back the same group). Geometry is cached per kind beside the
// exterior set in _geo, so the second time the player gets into an Octavia
// nothing is built at all. Safe to call on a car whose mesh has already been
// removed from the scene — the graft goes onto car.mesh either way and dies
// with it. Nothing here allocates a geometry or a material per CAR, so
// detachCabin() has nothing to dispose.
export function attachCabin(car) {
  const group = car?.mesh;
  if (!group) return null;
  if (group.userData.cabin) return group.userData.cabin;
  const kind = ALIAS[car.kind] ?? car.kind;
  const geo = geomFor(kind);
  const cab = geo.cabin ?? (geo.cabin = buildCabin(KIND[kind] ? kind : 'octavia'));
  const g = new THREE.Group();
  for (const [key, mat] of CABIN_MATS) {
    if (!cab[key]) continue;
    const m = new THREE.Mesh(cab[key], mat);
    // never casts (it would shadow itself into a black box and leak stripes
    // out through the glass) and never receives (the car's own shadow falls
    // straight across the dash otherwise)
    m.castShadow = m.receiveShadow = false;
    g.add(m);
  }
  if (cab.badge) {
    const b = cab.badge;
    const m = new THREE.Mesh(planeGeoFor(b.size, b.size), badgeMatFor(b.brand));
    m.rotation.x = b.rx;
    m.position.set(b.x, b.y, b.z);
    g.add(m);
  }
  group.add(g);
  group.userData.cabin = g;
  return g;
}

// ---- detachCabin(car) → boolean ------------------------------------------
// Removes the graft; true if there was one. Cheap and idempotent, so the
// caller can fire it from every path that can end a ride (E, a wreck, losing
// the seat to the net layer, a despawn under the player) without bookkeeping.
export function detachCabin(car) {
  const group = car?.mesh, cab = group?.userData.cabin;
  if (!cab) return false;
  group.remove(cab);
  group.userData.cabin = null;
  return true;
}

// Test/debug hook: the derived interior dimensions for a kind, no THREE needed.
export { cabinSpec };

// The traffic AI drives its near cars on the same tyres (js/aidriver.js, js/traffic.js).
export { tyreStep, kindOf };
