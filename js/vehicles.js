// ---- Vehicles: low-poly cars + arcade drive physics (v5: the branded fleet) ----
// Cars are the city's second citizens: traffic.js marches a swarm of them
// along the road graph (setting x/z/heading/speed directly) and the player
// steals one and drives it through driveStep(). Geometry is built ONCE per
// kind and materials are cached per paint color, so traffic can churn cars
// at the despawn ring without allocating anything that matters.
//
// v5 throws away the taper-box wedges for LOFTED HULLS. Every body is a 2D
// side profile — bumper lip, bonnet edge, scuttle, belt, deck, tail — lofted
// through 8-point cross-section rings whose width varies station to station
// (narrow nose, widest at the B-pillar, tapering tail), indexed so the paint
// shades smooth. The greenhouse is a second, crisper loft that emits every
// face as glass OR body-color by role: the windscreen and backlight are the
// raked end segments, the roof is the top run, and the A/B/C pillars are the
// side walls of deliberately narrow segments — which is how an Octavia keeps
// its fastback sail panel while the Tesla runs an unbroken glass canopy.
// Wheel arches are dark half-cylinder liners poked through the flanks (no
// CSG — a dark arc slightly wider than the tyre reads as a cutout from any
// distance this game renders at). Brands ride tiny cached CanvasTextures:
// the Škoda roundel, BMW quadrants, the Mercedes star, the Tesla T, plus a
// deterministic Czech "5E" plate hashed from kind+paint. Legacy kind names
// (sedan/hatch/kombi/suv) still resolve through ALIAS, and the v3 machinery
// underneath is untouched: the a = accel·(1 − v/vmax)^1.3 power curve,
// progressive drift, two-circle car-car collision, and the offroad shake.
//
// Convention (ARCHITECTURE.md): heading 0 faces −z (north); a mesh authored
// facing −z with mesh.rotation.y = heading moves along
// (dirX, dirZ) = (−sin h, −cos h); the right-hand side is (cos h, −sin h).
// ctl.steer > 0 means steer RIGHT, which in this frame DECREASES heading.

import * as THREE from 'three';
import { CAR, CAR_COLORS } from './config.js';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ---- shared materials (glass/rubber/lamps never vary; body paint is cached) --
const glassMat = new THREE.MeshLambertMaterial({ color: 0x1e242b });
const wheelMat = new THREE.MeshLambertMaterial({ color: 0x24262a });
const hubMat = new THREE.MeshLambertMaterial({ color: 0x989ea6 });
// truck cargo boxes are always that faded fleet-white, never body-color
const cargoMat = new THREE.MeshLambertMaterial({ color: 0xbcbfba });
// badge/trim: near-black bumper plastic (also arch liners + grilles), chrome
// brightwork, and the white DPMP livery band — shared across the fleet
const grilleMat = new THREE.MeshLambertMaterial({ color: 0x0b0d10 });
const chromeMat = new THREE.MeshLambertMaterial({ color: 0xd4dae2 });
const liveryMat = new THREE.MeshLambertMaterial({ color: 0xe9eae6 });
// lamps overbright (×2.5) so the bloom pass has something to bite on at night
const headMat = new THREE.MeshLambertMaterial({ color: 0xfff3d0, emissive: 0xffedb8, emissiveIntensity: 2.5, toneMapped: false });
const tailMat = new THREE.MeshLambertMaterial({ color: 0x7a1616, emissive: 0xff2418, emissiveIntensity: 2.5, toneMapped: false });
// main drives these at dusk: one assignment lights every car in the city
export const lampMats = { head: headMat, tail: tailMat };
const _bodyMats = new Map();
const bodyMatFor = (hex) => {
  let m = _bodyMats.get(hex);
  if (!m) _bodyMats.set(hex, m = new THREE.MeshLambertMaterial({ color: hex }));
  return m;
};

// ---- brand badges: tiny CanvasTextures drawn once, cached forever ----
// A 13 cm plane on the nose is only ever seen from a few meters, so 128 px is
// plenty. Each brand draws with plain 2D paths — no assets, no fetches — and
// the material is shared by every car of the brand. polygonOffset floats the
// decal off the paint it sits a centimeter in front of.
const _badgeMats = new Map();
function badgeMatFor(brand) {
  let m = _badgeMats.get(brand);
  if (m) return m;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d'), c = 64;
  const disc = (r, col) => { x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.fillStyle = col; x.fill(); };
  const ring = (r, w, col) => { x.beginPath(); x.arc(c, c, r, 0, Math.PI * 2); x.lineWidth = w; x.strokeStyle = col; x.stroke(); };
  if (brand === 'skoda') {
    // the green roundel: black face, emerald center, the white winged arrow
    // reduced to a swoosh + wing — abstract, but no other marque is a green
    // circle with a white bird in it
    disc(60, '#0d1310'); disc(50, '#0e5c38'); ring(56, 7, '#b9c2c4');
    x.fillStyle = '#eef3f0';
    x.beginPath();
    x.moveTo(30, 92); x.quadraticCurveTo(50, 56, 96, 38); x.lineTo(102, 46);
    x.quadraticCurveTo(66, 60, 48, 92); x.closePath(); x.fill();
    x.beginPath();
    x.moveTo(36, 60); x.quadraticCurveTo(52, 36, 78, 30); x.lineTo(64, 48);
    x.quadraticCurveTo(50, 50, 44, 62); x.closePath(); x.fill();
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
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  m = new THREE.MeshLambertMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  _badgeMats.set(brand, m);
  return m;
}

// ---- license plates: white EU plate, Pardubice's "5E" series ----
// The registration hashes off kind+paint so it is DETERMINISTIC — the same
// blue Octavia always wears the same number, front and rear, without storing
// anything per car. The cache is bounded by |kinds| × |color pools|.
const _plateMats = new Map();
function plateMatFor(kind, hex) {
  const key = kind + '|' + hex;
  let m = _plateMats.get(key);
  if (m) return m;
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
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _plateMats.set(key, m = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2 }));
  return m;
}

// ---- per-kind silhouette + engine specs ----
// hull: the lofted lower body. sts = stations [z, yLo, yHi, w] front→rear
// (w is a fraction of wid/2); the first and last stations become flat caps
// (grille face, tail panel) with their own crisp normals. yA/yB place the
// wheel-arch line and the doorline inside each ring, sh tucks the shoulders
// in (tumblehome), bw tucks the rocker under. The PROFILE is the identity:
// the Octavia's belt climbs into a liftback deck, the Fabia chops off high
// and early, the BMW sits 4 cm lower than anything Czech, the Mercedes
// stretches 20 cm statelier, the Tesla droops its grille-less nose.
//
// green: the greenhouse loft. sts = [z, yBase, yRoof]; each segment names
// its top and side face roles ('g' glass, 'p' paint), which is where the
// windscreen rake, the pillars and the roof come from. Tesla's segs run the
// top glass end to end — the continuous canopy. Truck/bus skip green and
// wear proud glass boxes instead (flat commercial glazing looks right).
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
};
// spawn code rolls from this — traffic.js picks BY NAME from its own pools
// (indexing broke the day the roster was renamed, so never rely on order)
export const CAR_KINDS = ['octavia', 'fabia', 'bmw', 'mercedes', 'tesla', 'van', 'truck', 'bus'];
// Legacy kind names — main.js's spawn list and pre-v4 saves still say sedan/
// hatch/kombi/suv. They resolve to the closest modern silhouette at every
// door into this module, so an old save gets an Octavia, not a crash.
const ALIAS = { sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' };
const kindOf = (k) => KIND[k] ?? KIND[ALIAS[k]] ?? KIND.octavia;

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
  bus: [0xb5271f, 0xb5271f, 0xb5271f, 0xd8d5ce, 0x9a2822],
};
export function pickCarColor(kind) {
  const pool = KIND_COLORS[ALIAS[kind] ?? kind] ?? CAR_COLORS;
  return pool[(Math.random() * pool.length) | 0];
}
export { CAR_COLORS };   // re-export so callers can grab the fallback pool here too

// ---- drift + collision tunables (module-local: config.js owns the shared CAR
// numbers, these are v3 vehicle-only feel constants) ----
const DRIFT_FREE = 2.5;   // steer(rad)×speed(m/s) the tyres absorb before slipping
const DRIFT_K = 0.35;     // how fast grip collapses past that (progressive slide)
const HB_GRIP = 0.18;     // handbrake grip multiplier — rear axle basically gone
const HB_YAW = 1.7;       // handbrake yaw gain: the flick that swings the tail
const HIT_SCRUB = 0.55;   // fraction of closing speed a car-car impact eats (40–70% band)
const HIT_RANGE2 = 144;   // 12 m center-distance gate — covers even bus vs bus nose-to-nose

// ---- geometry builders ----

// The lower-body loft. Each station ring is 8 points — rocker, arch line,
// doorline, shoulder, mirrored — lofted with SHARED vertices so
// computeVertexNormals rounds the paint over the shoulders and along the
// bonnet, which under Lambert is what makes sheet metal read as sheet metal.
// The end caps duplicate their ring so the grille face and tail panel keep
// crisp flat normals instead of smearing around the bumper corners.
function bodyHull(spec, wid) {
  const half = wid / 2, sts = spec.sts, n = sts.length;
  const pos = [], idx = [];
  const ring = (st) => {
    const w = st[3] * half, yLo = st[1], yHi = st[2];
    const yA = yLo + (yHi - yLo) * spec.yA, yB = yLo + (yHi - yLo) * spec.yB;
    return [
      [-w * spec.bw, yLo], [-w, yA], [-w, yB], [-w * spec.sh, yHi],
      [w * spec.sh, yHi], [w, yB], [w, yA], [w * spec.bw, yLo],
    ];
  };
  for (let i = 0; i < n; i++) {
    const r = ring(sts[i]), z = sts[i][0];
    for (const p of r) pos.push(p[0], p[1], z);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      const a = i * 8 + j, b = (i + 1) * 8 + j, c = (i + 1) * 8 + j2, d = i * 8 + j2;
      idx.push(a, b, c, a, c, d);
    }
  }
  const cap = (i, flip) => {
    const st = sts[i], r = ring(st), z = st[0];
    const base = pos.length / 3;
    let cy = 0;
    for (const p of r) cy += p[1] / 8;
    for (const p of r) pos.push(p[0], p[1], z);
    pos.push(0, cy, z);
    const ctr = base + 8;
    for (let j = 0; j < 8; j++) {
      const j2 = (j + 1) % 8;
      if (flip) idx.push(ctr, base + j2, base + j);
      else idx.push(ctr, base + j, base + j2);
    }
  };
  cap(0, false);       // nose faces −z
  cap(n - 1, true);    // tail faces +z
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// The greenhouse loft: 4-point trapezoid rings (tumblehome baked in via
// topW < baseW). Each segment emits its top and two side quads into the
// glass OR the paint soup by role — the raked first segment's top IS the
// windscreen, narrow segments' side walls ARE the B-pillars, and because
// glass and paint faces share their boundary vertices exactly there is no
// z-fighting and no grow factor. Emitted non-indexed → flat normals →
// glazing stays crisp against the smooth-shaded hull below it.
function greenHull(spec, wid) {
  const half = wid / 2;
  const soup = { g: [], p: [] };
  const ring = (st) => {
    const wb = spec.baseW * half, wt = spec.topW * half;
    return [[-wb, st[1], st[0]], [-wt, st[2], st[0]], [wt, st[2], st[0]], [wb, st[1], st[0]]];
  };
  const quad = (arr, a, b, c, d) => arr.push(a, b, c, a, c, d);
  for (let i = 0; i < spec.sts.length - 1; i++) {
    const r0 = ring(spec.sts[i]), r1 = ring(spec.sts[i + 1]);
    const top = soup[spec.segs[i][0]], side = soup[spec.segs[i][1]];
    quad(side, r0[0], r1[0], r1[1], r0[1]);   // left wall (glass or pillar)
    quad(top, r0[1], r1[1], r1[2], r0[2]);    // roof / windscreen / backlight
    quad(side, r0[2], r1[2], r1[3], r0[3]);   // right wall
  }
  if (spec.capEnd) {   // vans end in a vertical rear wall, not a raked pinch
    const r = ring(spec.sts[spec.sts.length - 1]);
    quad(soup[spec.capEnd], r[3], r[2], r[1], r[0]);
  }
  return { glass: soupGeo(soup.g), paint: soup.p.length ? soupGeo(soup.p) : null };
}

function soupGeo(tris) {
  const a = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    a[i * 3] = tris[i][0]; a[i * 3 + 1] = tris[i][1]; a[i * 3 + 2] = tris[i][2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  g.computeVertexNormals();
  return g;
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
const Cz = (arr, r, len, x, y, z) => {   // cylinder poking along z (lamp rings, exhausts)
  const g = new THREE.CylinderGeometry(r, r, len, 10);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  arr.push(g);
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

// Wheel arches without CSG: a dark half-cylinder liner a touch wider than
// the body at that station. Its half-disc caps poke through both flanks and
// draw the black arc around the tyre; the curved shell hides inside the sill.
function arches(arr, K) {
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const r = K.wheelR + 0.10;
  for (const s of [-1, 1]) {
    const hw = widthAt(K.hull.sts, s * ax, K.wid / 2);
    const g = new THREE.CylinderGeometry(r, r, hw * 2 + 0.05, 12, 1, false, 0, Math.PI);
    g.rotateZ(Math.PI / 2);   // axis onto x, open chord facing down
    g.translate(0, K.wheelR + 0.02, s * ax);
    arr.push(g);
  }
}

function mirrors(arr, W, y, z, hw = 0.13, hh = 0.09) {
  for (const s of [-1, 1]) {
    B(arr, 0.14, 0.03, 0.04, s * (W + 0.05), y + 0.02, z);   // arm
    B(arr, hw, hh, 0.05, s * (W + 0.14), y, z);              // head
  }
}
// doorhandle nubs: one full-width sliver per door line pokes 1 cm out of
// both flanks at once — two boxes dress four doors
function handles(arr, wid, y, zs) {
  for (const z of zs) B(arr, wid + 0.02, 0.028, 0.16, 0, y, z);
}

// ---- per-kind dressing ----
// Shaped lights, grilles, mirrors, creases, exhausts — the pieces that carry
// the brand at 15 m. Everything lands in a per-material soup and merges, so
// none of this costs meshes. Lamp boxes straddle the nose/tail surface so
// roughly half pokes proud of the paint; headMat/tailMat glow through the
// dusk toggle in main.js exactly as before.
const DETAIL = {
  octavia(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 0.90, -0.50);
    handles(d.paint, K.wid, 0.76, [-0.15, 0.85]);
    B(d.paint, K.wid + 0.024, 0.05, 2.6, 0, 0.60, 0.35);            // doorline crease
    B(d.paint, 0.05, 0.07, 0.20, 0, 1.43, 1.28);                    // shark-fin antenna
    pairB(d.head, 0.46, 0.07, 0.12, 0.55, 0.60, c.zN + 0.07, 0.35); // slim swept LED wedges
    B(d.dark, 1.02, 0.09, 0.12, 0, 0.50, c.zN + 0.05);              // the one wide grille slit
    B(d.dark, 1.10, 0.15, 0.10, 0, 0.30, c.zN + 0.02);              // lower intake valance
    pairB(d.tail, 0.40, 0.07, 0.12, 0.52, 0.70, c.zT - 0.03, -0.35);
    B(d.dark, 1.26, 0.10, 0.08, 0, 0.24, c.zT - 0.01);              // diffuser strip
    Cz(d.chrome, 0.035, 0.14, -0.55, 0.27, c.zT + 0.02);            // single exhaust tip
  },
  fabia(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 0.86, -0.36);
    handles(d.paint, K.wid, 0.72, [-0.05, 0.82]);
    B(d.paint, K.wid + 0.024, 0.05, 2.2, 0, 0.56, 0.45);
    B(d.paint, 0.05, 0.07, 0.18, 0, 1.42, 1.25);
    pairB(d.head, 0.38, 0.08, 0.12, 0.52, 0.57, c.zN + 0.06, 0.30);
    B(d.dark, 0.92, 0.08, 0.12, 0, 0.49, c.zN + 0.05);
    B(d.dark, 1.02, 0.14, 0.10, 0, 0.29, c.zN + 0.02);
    pairB(d.tail, 0.16, 0.22, 0.10, 0.58, 0.68, c.zT - 0.02);       // upright hatch lamps
    B(d.dark, 1.14, 0.09, 0.08, 0, 0.24, c.zT - 0.01);
    Cz(d.chrome, 0.032, 0.12, -0.52, 0.26, c.zT + 0.015);
  },
  bmw(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 0.86, -0.20);
    handles(d.paint, K.wid, 0.72, [0.05, 1.00]);
    B(d.paint, K.wid + 0.024, 0.05, 2.7, 0, 0.55, 0.50);
    B(d.paint, 0.05, 0.06, 0.18, 0, 1.39, 1.18);
    pairB(d.dark, 0.36, 0.17, 0.10, 0.55, 0.58, c.zN + 0.05, 0.20); // dark lens housings…
    Cz(d.head, 0.055, 0.10, -0.46, 0.58, c.zN + 0.015);             // …with the twin round
    Cz(d.head, 0.055, 0.10, -0.64, 0.58, c.zN + 0.03);              // elements behind them
    Cz(d.head, 0.055, 0.10, 0.46, 0.58, c.zN + 0.015);
    Cz(d.head, 0.055, 0.10, 0.64, 0.58, c.zN + 0.03);
    B(d.dark, 0.24, 0.26, 0.12, -0.15, 0.50, c.zN + 0.03, 0, -0.12);   // twin kidneys,
    B(d.dark, 0.24, 0.26, 0.12, 0.15, 0.50, c.zN + 0.03, 0, -0.12);    // leaning forward,
    B(d.chrome, 0.26, 0.28, 0.10, -0.15, 0.50, c.zN + 0.055, 0, -0.12);// chrome-framed
    B(d.chrome, 0.26, 0.28, 0.10, 0.15, 0.50, c.zN + 0.055, 0, -0.12);
    B(d.dark, 1.15, 0.13, 0.10, 0, 0.28, c.zN + 0.02);
    pairB(d.tail, 0.42, 0.09, 0.10, 0.58, 0.66, c.zT - 0.03, -0.30);
    B(d.dark, 1.20, 0.10, 0.08, 0, 0.23, c.zT - 0.01);
    Cz(d.chrome, 0.036, 0.12, -0.60, 0.26, c.zT + 0.015);           // twin exhausts
    Cz(d.chrome, 0.036, 0.12, 0.60, 0.26, c.zT + 0.015);
  },
  mercedes(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 0.89, -0.32);
    handles(d.paint, K.wid, 0.75, [-0.05, 0.95]);
    B(d.paint, K.wid + 0.024, 0.05, 2.8, 0, 0.58, 0.50);
    B(d.paint, 0.05, 0.07, 0.20, 0, 1.43, 1.30);
    pairB(d.head, 0.40, 0.10, 0.12, 0.54, 0.60, c.zN + 0.06, 0.40); // swept wedge lamps
    B(d.dark, 1.02, 0.22, 0.10, 0, 0.51, c.zN + 0.05);              // grille panel…
    B(d.chrome, 1.00, 0.045, 0.12, 0, 0.565, c.zN + 0.04);          // …with two chrome
    B(d.chrome, 1.00, 0.045, 0.12, 0, 0.475, c.zN + 0.04);          // louvres; star rides proud
    B(d.dark, 1.20, 0.12, 0.10, 0, 0.28, c.zN + 0.02);
    pairB(d.tail, 0.44, 0.09, 0.12, 0.56, 0.70, c.zT - 0.03, -0.40);
    B(d.dark, 1.24, 0.10, 0.08, 0, 0.23, c.zT - 0.01);
    B(d.chrome, 0.18, 0.06, 0.06, -0.60, 0.27, c.zT + 0.01);        // integrated trim tips
    B(d.chrome, 0.18, 0.06, 0.06, 0.60, 0.27, c.zT + 0.01);
  },
  tesla(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 0.85, -0.76);
    // no doorhandles — they sit flush on the real car, so their absence IS the detail
    B(d.paint, K.wid + 0.024, 0.05, 2.7, 0, 0.55, 0.50);
    B(d.paint, 0.05, 0.06, 0.18, 0, 1.39, 1.22);
    pairB(d.head, 0.34, 0.05, 0.10, 0.55, 0.55, c.zN + 0.05, 0.35); // slim DRL strips only
    B(d.dark, 0.90, 0.10, 0.10, 0, 0.26, c.zN + 0.02);              // just a lower intake slit
    B(d.tail, K.wid * 0.86, 0.06, 0.10, 0, 0.68, c.zT - 0.02);      // full-width light bar
    B(d.dark, 1.10, 0.10, 0.08, 0, 0.23, c.zT - 0.01);
  },
  van(K, d, c) {
    arches(d.dark, K);
    mirrors(d.paint, c.W, 1.12, -1.58, 0.12, 0.15);
    handles(d.paint, K.wid, 0.92, [-1.00, 0.50]);                   // cab door + sliding door
    B(d.paint, K.wid + 0.024, 0.06, 3.2, 0, 0.70, 0.40);
    pairB(d.head, 0.30, 0.16, 0.12, 0.60, 0.72, c.zN + 0.04, 0.10);
    B(d.dark, 1.15, 0.22, 0.12, 0, 0.60, c.zN + 0.03);
    B(d.dark, 1.25, 0.14, 0.10, 0, 0.30, c.zN + 0.02);
    pairB(d.tail, 0.12, 0.30, 0.10, 0.80, 0.90, c.zT - 0.02);       // tall rear-door lamps
    B(d.dark, 1.30, 0.10, 0.08, 0, 0.26, c.zT - 0.01);
    Cz(d.chrome, 0.03, 0.12, -0.55, 0.25, c.zT + 0.01);
  },
  truck(K, d, c) {
    arches(d.dark, K);
    for (const s of [-1, 1]) {                                      // tall stalked mirrors
      B(d.paint, 0.04, 0.55, 0.04, s * (c.W + 0.10), 2.02, -3.55);
      B(d.paint, 0.09, 0.34, 0.06, s * (c.W + 0.17), 2.02, -3.55);
    }
    B(d.glass, 2.00, 0.80, 0.10, 0, 1.90, c.zN + 0.03, 0, 0.08);    // one-piece windscreen
    B(d.glass, K.wid + 0.04, 0.55, 1.00, 0, 1.95, -2.85);           // cab side windows
    B(d.dark, 1.90, 0.55, 0.10, 0, 0.95, c.zN + 0.03);              // full-width grille panel
    B(d.dark, 2.10, 0.30, 0.10, 0, 0.35, c.zN + 0.02);              // steel bumper
    B(d.dark, 1.30, 0.45, 4.60, 0, 0.55, 1.20);                     // chassis rails under the box
    pairB(d.head, 0.34, 0.14, 0.10, 0.80, 0.62, c.zN + 0.02);
    pairB(d.tail, 0.14, 0.30, 0.08, 0.95, 1.06, 3.66);              // on the cargo box tail
  },
  bus(K, d, c) {
    arches(d.dark, K);
    for (const s of [-1, 1]) {                                      // long-arm coach mirrors
      B(d.paint, 0.22, 0.03, 0.03, s * (c.W + 0.06), 2.46, c.zN + 0.30);
      B(d.paint, 0.09, 0.30, 0.06, s * (c.W + 0.16), 2.32, c.zN + 0.30);
    }
    B(d.glass, 2.15, 1.15, 0.10, 0, 1.95, c.zN + 0.04, 0, 0.10);    // one-piece raked screen
    B(d.glass, K.wid + 0.05, 0.95, 9.40, 0, 1.92, -0.10);           // full-length glazing band
    B(d.glass, 1.80, 0.70, 0.08, 0, 2.30, c.zT + 0.01);             // rear window
    B(d.glass, 0.07, 1.95, 1.25, c.W + 0.01, 1.10, -3.55);          // curbside door recesses
    B(d.glass, 0.07, 1.95, 1.25, c.W + 0.01, 1.10, 0.45);
    B(d.white, K.wid + 0.04, 0.24, 9.60, 0, 1.34, -0.10);           // DPMP livery strips
    B(d.white, K.wid + 0.04, 0.20, 9.60, 0, 2.50, -0.10);           // framing the glass
    B(d.white, 1.70, 0.26, 2.60, 0, 3.07, 0.90);                    // roof A/C pod
    B(d.head, 1.35, 0.28, 0.10, 0, 2.62, c.zN + 0.05, 0, 0.06);     // destination box (glows
    pairB(d.head, 0.30, 0.16, 0.10, 0.85, 0.70, c.zN + 0.02);       // at night via headMat)
    B(d.dark, 2.20, 0.25, 0.10, 0, 0.32, c.zN + 0.02);
    B(d.dark, 1.60, 0.60, 0.08, 0, 1.30, c.zT - 0.01);              // rear engine grille
    pairB(d.tail, 0.16, 0.34, 0.10, 0.98, 0.80, c.zT - 0.02);
  },
};

// one geometry set per kind, built lazily and shared by every car forever
const _geo = new Map();
function geomFor(kind) {
  kind = ALIAS[kind] ?? kind;            // cache under the modern name only
  let g = _geo.get(kind);
  if (g) return g;
  const K = KIND[kind] ?? KIND.octavia;
  const sts = K.hull.sts;
  const c = { W: K.wid / 2, zN: sts[0][0], zT: sts[sts.length - 1][0] };
  const d = { paint: [], glass: [], dark: [], chrome: [], head: [], tail: [], white: [] };
  d.paint.push(bodyHull(K.hull, K.wid));
  if (K.green) {
    const gh = greenHull(K.green, K.wid);
    d.glass.push(gh.glass);
    if (gh.paint) d.paint.push(gh.paint);   // pillars + roof, body-color
  }
  DETAIL[kind]?.(K, d, c);
  const merged = (list) => (list.length ? mergeGeoms(list) : null);
  let cargo = null;
  if (K.cargo) {                         // truck: separate box body riding the chassis
    const cg = K.cargo;
    cargo = new THREE.BoxGeometry(cg.w, cg.h, cg.l);
    cargo.translate(0, cg.y + cg.h / 2, cg.z);
  }
  const wheel = new THREE.CylinderGeometry(K.wheelR, K.wheelR, K.wheelW ?? 0.24, 12);
  wheel.rotateZ(Math.PI / 2);            // cylinder axis onto x → rolling = rotation.x
  const hub = new THREE.CylinderGeometry(K.wheelR * 0.54, K.wheelR * 0.54, 0.035, 10);
  hub.rotateZ(Math.PI / 2);
  _geo.set(kind, g = {
    K, zN: c.zN, zT: c.zT,
    paint: merged(d.paint), glass: merged(d.glass), dark: merged(d.dark),
    chrome: merged(d.chrome), head: merged(d.head), tail: merged(d.tail),
    white: merged(d.white), cargo, wheel, hub,
  });
  return g;
}

// shared plane geometries for the flat decals (badges by size, plates fixed)
const _planes = new Map();
function planeGeoFor(w, h) {
  const k = w + 'x' + h;
  let g = _planes.get(k);
  if (!g) _planes.set(k, g = new THREE.PlaneGeometry(w, h));
  return g;
}
// Front decals face −z (rotation.y = π); spec.rx (already sign-corrected for
// the YXZ order) lays a badge back onto a raked bonnet — the BMW roundel lies
// nearly flat on the hood like the real one, the Tesla T leans up the nose.
function badgeMesh(brand, spec, zBase, rear) {
  const m = new THREE.Mesh(planeGeoFor(spec.size, spec.size), badgeMatFor(brand));
  m.rotation.order = 'YXZ';
  if (!rear) m.rotation.y = Math.PI;
  if (spec.rx) m.rotation.x = spec.rx;
  m.position.set(spec.x ?? 0, spec.y, zBase + spec.dz);
  return m;
}
function plateMesh(mat, y, z, rear) {
  const m = new THREE.Mesh(planeGeoFor(0.52, 0.11), mat);
  if (!rear) m.rotation.y = Math.PI;
  m.position.set(0, y, z);
  return m;
}

// ---- makeCarMesh(colorHex[, kind]) → { group, wheels } ----
// group origin sits at ground level under the car's center. Everything but
// the wheels lives in an inner "body" group so suspension roll/pitch tilts
// the shell while the wheels stay planted. wheels = [FL, FR, RL, RR] (front
// = −z); front wheels use YXZ euler order so steering yaw and rolling spin
// compose. Budget: one mesh per material soup + decals + wheels/hubs — a car
// is 14–18 meshes, well under the 28 cap, and every geometry is shared.
export function makeCarMesh(colorHex, kind = 'octavia') {
  kind = ALIAS[kind] ?? kind;
  const g = geomFor(kind), K = g.K;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = bodyMatFor(colorHex);
  const add = (geo, mat, shadow = false) => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    body.add(m);
  };
  add(g.paint, paint, true);
  add(g.glass, glassMat, true);
  add(g.dark, grilleMat);
  add(g.chrome, chromeMat);
  add(g.white, liveryMat);
  add(g.head, headMat);
  add(g.tail, tailMat);
  if (g.cargo) add(g.cargo, cargoMat, true);
  if (K.brand && K.badgeF) body.add(badgeMesh(K.brand, K.badgeF, g.zN, false));
  if (K.brand && K.badgeR) body.add(badgeMesh(K.brand, K.badgeR, g.zT, true));
  const pm = plateMatFor(kind, colorHex);
  if (K.plateF !== undefined) body.add(plateMesh(pm, K.plateF, g.zN - 0.015, false));
  if (K.plateR !== undefined) body.add(plateMesh(pm, K.plateR, K.plateRz ?? g.zT + 0.015, true));
  // long kinds tuck the axles inside the overhangs (a bus pivots mid-body,
  // not at the bumpers) — K.axle overrides the wheels-at-the-corners default
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const hubX = (K.wheelW ?? 0.24) / 2 + 0.012;
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(g.wheel, wheelMat);
    w.rotation.order = 'YXZ';
    const side = i & 1 ? 1 : -1;
    w.position.set(side * (K.wid / 2 - 0.07), K.wheelR, (i < 2 ? -1 : 1) * ax);
    // alloy face on the outer side only; it spins with the tyre (invisibly —
    // it's radially symmetric) but yaws with the steering, which is what shows
    const hub = new THREE.Mesh(g.hub, hubMat);
    hub.position.x = side * hubX;
    w.add(hub);
    group.add(w);
    wheels.push(w);
  }
  group.userData.body = body;
  group.userData.wheelR = K.wheelR;
  return { group, wheels };
}

// ---- Vehicles: owns every car mesh in the scene, animates the dressing ----
export class Vehicles {
  constructor(scene) {
    this.scene = scene;
    this.cars = new Set();
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
    const car = { mesh: group, wheels, x, z, heading, speed: 0, steer: 0,
      kind, color, len: K.len, wid: K.wid, ai: null,
      y: 0, _lat: 0, _pv: 0, _acc: 0, _roll: 0, _pitch: 0, _rammedT: 0,
      offroad: 0, _bumpT: 0 };
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    this.scene.add(group);
    this.cars.add(car);
    return car;
  }

  remove(car) {
    this.cars.delete(car);
    this.scene.remove(car.mesh);         // geometry + materials are shared: keep them
  }

  // Sync meshes from car state, spin wheels, settle the suspension tilt.
  // Works the same for AI cars (traffic writes x/z/heading/speed) and the
  // player's (driveStep writes them) — pitch is derived from the measured
  // speed delta, so braking AI cars dip their nose too.
  update(dt) {
    if (dt <= 0) return;
    const k = Math.min(1, 8 * dt);
    for (const car of this.cars) {
      const m = car.mesh;
      m.position.set(car.x, car.y, car.z);
      m.rotation.y = car.heading;
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
      car._roll += (clamp(car.steer * car.speed * 0.004, -0.05, 0.05) - car._roll) * k;
      car._pitch += (clamp(car._acc * 0.008, -0.05, 0.05) - car._pitch) * k;
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
      const b = m.userData.body;
      b.rotation.z = car._roll + bumpR;  // +z roll lifts the right flank = lean left
      b.rotation.x = car._pitch;         // +x pitch lifts the nose
    }
  }
}

// ---- driveStep(car, ctl, dt, world, others): the player's arcade physics ----
// ctl = { gas: −1..1, steer: −1..1, brake: 0|1 (handbrake) }; others is an
// iterable of other cars for car-car collision (may contain `car` — skipped;
// omit it and the step degrades gracefully to walls-only, v2 behavior).
const _pt = { x: 0, z: 0 };
export function driveStep(car, ctl, dt, world, others) {
  dt = Math.min(dt, 1 / 20);             // tab-return dt spikes must not teleport us
  const K = kindOf(car.kind);            // alias-safe: an old save may still say 'sedan'

  // steering lock falls with speed (falloff runs on km/h — the config K was
  // tuned so full lock at 130 km/h is a sane sweep, not a spin): parking-lot
  // tight at walking pace, highway-stable flat out. car.steer chases the
  // target so the wheel visibly winds over instead of snapping.
  const lock = CAR.steerMax / (1 + CAR.steerSpeedK * Math.abs(car.speed) * 3.6);
  car.steer += (clamp(ctl.steer ?? 0, -1, 1) * lock - car.steer) * Math.min(1, 9 * dt);

  // longitudinal: gas>0 accelerates (or brakes out of reverse), gas<0 brakes
  // then backs up. Engine force follows a = accel·(1 − v/vmax)^1.3 — strong
  // off the line, wheezing near the top, vmax approached asymptotically (an
  // octavia does 0–100 in ~5.7 s, then crawls toward 64 m/s). With the pedals
  // released, drag + rolling resistance bleed the speed off on their own —
  // that's the only place they apply, so vmax really is vmax at full throttle.
  const gas = clamp(ctl.gas ?? 0, -1, 1);
  let s = car.speed;
  if (gas > 0.01) {
    if (s < -0.05) s = Math.min(0, s + CAR.brake * gas * dt);
    else {
      // max(0,…): a collision impulse can leave s a hair over vmax, and a
      // negative base under ^1.3 is NaN — clamp the headroom, not the speed
      const a = K.accel * Math.pow(Math.max(0, 1 - s / K.vmax), 1.3);
      s = Math.min(K.vmax, s + a * gas * dt);
    }
  } else if (gas < -0.01) {
    s = s > 0.05 ? Math.max(0, s + CAR.brake * gas * dt)      // gas is negative
      : Math.max(-CAR.vrev, s + K.accel * 0.7 * gas * dt);
  } else {
    const res = (CAR.drag * Math.abs(s) + CAR.roll) * dt;
    s = Math.abs(s) <= res ? 0 : s - Math.sign(s) * res;
  }
  // PROGRESSIVE DRIFT: tyres hold up to DRIFT_FREE of steer×speed for free,
  // then grip collapses the harder you push — a gentle bend tracks clean, the
  // same wheel angle at twice the speed breaks the rear loose and the slide
  // grows until you unwind the wheel (countersteer works because grip
  // recovers the instant steer×speed drops).
  const slip = Math.abs(car.steer * s);
  let grip = K.grip / (1 + DRIFT_K * Math.max(0, slip - DRIFT_FREE));
  let yawGain = 1;
  if (ctl.brake) {                       // handbrake: hard scrub + rear grip gone
    const b = CAR.brake * 1.3 * dt;
    s = Math.abs(s) <= b ? 0 : s - Math.sign(s) * b;
    grip *= HB_GRIP;
    // with the rear locked the car rotates around the FRONT axle — boost yaw
    // so a flick of steer swings the tail out (proper smyk), but only at
    // speed: stationary handbrake donuts are not a thing
    if (Math.abs(s) > 4) yawGain = HB_YAW;
  }
  car.speed = s;

  // yaw from a kinematic bicycle; the heading change sheds a slice of the
  // velocity into a lateral component (the nose turns, momentum lags), which
  // grip then damps away — mild drift in a fast bend, a proper slide on the
  // handbrake. Reversing flips s and with it the turn direction, for free.
  // Long wheelbases (truck/bus) yaw slower through the same len·0.6 term.
  const dTh = -Math.tan(car.steer) * (s / (car.len * 0.6)) * yawGain * dt;
  car.heading += dTh;
  car._lat = ((car._lat ?? 0) + s * dTh) * Math.exp(-grip * dt);

  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);   // forward
  const rx = Math.cos(h), rz = -Math.sin(h);    // right
  car.x += (fx * s + rx * car._lat) * dt;
  car.z += (fz * s + rz * car._lat) * dt;

  // ---- CAR-CAR: two-circle bodies, mass-weighted shove ----
  // Each car ≈ two discs riding its long axis (front/rear, r ≈ wid·0.62) —
  // the cheapest shape that lets glancing hits slide off and T-bones connect
  // at the door instead of a phantom bbox corner. Runs BEFORE the wall pass
  // so a shoved player still ends the frame outside the architecture.
  if (others) {
    const rA = car.wid * 0.62, dA = Math.max(0, car.len / 2 - rA);
    for (const o of others) {
      if (o === car) continue;           // the iterable may contain ourselves
      const cdx = car.x - o.x, cdz = car.z - o.z;
      if (cdx * cdx + cdz * cdz > HIT_RANGE2) continue;   // 12 m gate
      const ofx = -Math.sin(o.heading), ofz = -Math.cos(o.heading);
      const rB = o.wid * 0.62, dB = Math.max(0, o.len / 2 - rB);
      const mA = kindOf(car.kind).mass;
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
        // impulse: scrub HIT_SCRUB of the closing speed along the normal and
        // hand it out by mass ratio — a truck barely feels a hatch, a hatch
        // very much feels a truck
        const vRx = (fx * s + rx * car._lat) - ofx * o.speed;
        const vRz = (fz * s + rz * car._lat) - ofz * o.speed;
        const closing = -(vRx * nx + vRz * nz);           // >0 when approaching
        if (closing > 0) {
          const imp = closing * HIT_SCRUB;
          // our delta-v decomposed back into the scalar speed + lateral slide
          car.speed += (nx * fx + nz * fz) * imp * wA;
          car._lat += (nx * rx + nz * rz) * imp * wA;
          // the other car only carries a scalar speed — project its shove onto
          // its own forward, clamp against absurd launches
          o.speed = clamp(o.speed - (nx * ofx + nz * ofz) * imp * wB, -55, 55);
          // off-center hits twist both cars (same torque form as the wall hit)
          car.heading += clamp((aoz * nx - aox * nz) * imp * 0.02, -0.05, 0.05);
          o.heading += clamp((boz * -nx - box * -nz) * imp * 0.02, -0.04, 0.04);
        }
        o._rammedT = 2.5;                // tell the traffic AI it just got hit
      }
    }
  }

  // 4-corner sampling against buildings + water (6 points on truck/bus — a
  // long flank must not thread itself through a building corner): any pushed
  // point drags the whole car with it, the 2D torque of the push glances the
  // nose off the wall, and the impact scrubs 60% of the speed. Points are
  // pulled slightly inboard so brushing a wall reads as paint contact, not a
  // force field.
  const hl = car.len / 2 - 0.2, hw = car.wid / 2 - 0.1;
  const nPts = car.len > 5.5 ? 6 : 4;
  let hit = false;
  for (let i = 0; i < nPts; i++) {
    const of = i < 2 ? hl : i < 4 ? -hl : 0, os = i & 1 ? hw : -hw;
    const wox = fx * of + rx * os, woz = fz * of + rz * os;
    _pt.x = car.x + wox; _pt.z = car.z + woz;
    const ox = _pt.x, oz = _pt.z;
    if (world.collide(_pt, 0.5)) {
      const px = _pt.x - ox, pz = _pt.z - oz;
      car.x += px; car.z += pz;
      car.heading += clamp((woz * px - wox * pz) * 0.03, -0.05, 0.05);
      hit = true;
    }
  }
  if (hit) { car.speed *= 0.4; car._lat *= 0.3; }

  // ---- what the tyres are touching ----
  // surfaceY puts the wheels ON the rendered deck (LAYER_Y.road above the
  // ground plane — riding heightAt() sank the tyres 20 cm into every bridge).
  // Off the tarmac the car is OFFROAD: grass and dirt cap the speed around
  // 40 km/h through heavy drag, and vehicles.update() reads car.offroad to
  // shake the body. The transition eases over ~0.3 s so a kerb-hop doesn't
  // snap the suspension.
  if (world.surfaceY) {
    const s = world.surfaceY(car.x, car.z);
    car.offroad += ((s.road ? 0 : 1) - (car.offroad ?? 0)) * Math.min(1, dt * 3.5);
    car.y = s.y;
    if (car.offroad > 0.05 && Math.abs(car.speed) > 0.5) {
      // rolling resistance of soft ground: quadratic past ~11 m/s so 40 km/h
      // is where drag eats all of a typical engine's push
      const k = car.offroad;
      const v = Math.abs(car.speed);
      const drag = (1.2 + v * v * 0.055) * k;
      car.speed -= Math.sign(car.speed) * Math.min(v, drag * dt);
    }
  } else {
    car.y = world.heightAt(car.x, car.z);  // tests stub heightAt only
  }
}
