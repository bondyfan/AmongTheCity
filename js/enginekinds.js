// ---- which engine each vehicle has ------------------------------------------
// One entry per vehicle kind (vehicles.js KIND): `eng` is what the engine
// sounds like (read by public/worklets/enginedsp.js, see ENGINE_DEFAULTS there
// for what each number means) and `box` is how it is geared and shifted (read
// by js/drivetrain.js, BOX_DEFAULTS). Nothing here is tuned to a top speed:
// ratios are km/h per 1000 rpm, the way a gearbox is described on paper.
//
// The electric kinds (tesla, trolleybus) are not here on purpose. They have no
// cycle to synthesise and keep the motor voice in js/audio.js (buildEV). The
// Roadster is electric too but has a voice of its own in the worklet: see
// THRUST_KINDS below.
//
// `air` marks the vehicles that brake with compressed air and sigh when they
// stop; `loud` is how far the voice carries when the budget ranks traffic.

export const ENGINE_KINDS = {
  // 1.5 TSI four, seven-speed twin clutch: the Czech default, and the yardstick
  octavia: {
    eng: { cyl: 4, idle: 800, redline: 6400, exL: 2.4, mufLo: 300, mufHi: 2300,
      turbo: 0.22, bov: 0.25, intake: 0.5, knock: 0.1, mech: 0.16 },
    box: { redline: 6400, kph: [8.6, 14.2, 21.5, 29.5, 38.5, 47.5, 57], shift: 0.16, launch: 2200 },
    vmax: 64, accel: 7, loud: 1,
  },
  // 1.0 TSI three: firing every 240 degrees, so it thrums where a four hums
  fabia: {
    eng: { cyl: 3, idle: 860, redline: 6300, exL: 2.0, tailL: 0.7, boomF: 132,
      mufLo: 320, mufHi: 2200, rise: [1.0, 0.25], turbo: 0.28, bov: 0.3, intake: 0.45,
      knock: 0.12, mech: 0.2, cov: [0.2, 0.045], vol: 0.95 },
    box: { idle: 860, redline: 6300, kph: [7.2, 13.2, 20.3, 27.6, 34.5, 41.5],
      up: [1850, 6100], shift: 0.3, launch: 2400 },
    vmax: 56, accel: 6.5, loud: 0.95,
  },
  // straight six that revs to seven thousand, open intake, cracks on the overrun
  bmw: {
    eng: { cyl: 6, idle: 700, redline: 7000, exL: 2.9, exG: 0.55, tailL: 0.9, tailG: 0.45,
      mufLo: 340, mufHi: 3300, rise: [0.7, 0.16], decay: 2.6, intake: 0.8, inF: 290,
      rasp: 0.5, roar: 0.6, knock: 0.08, mech: 0.15, pops: 1, vol: 1.1 },
    box: { idle: 700, redline: 7000, kph: [8.5, 13.5, 20.2, 25.7, 33.5, 43, 51.5, 64],
      up: [1800, 6800], down: [1150, 4000], shift: 0.2, launch: 2600 },
    vmax: 69, accel: 9, loud: 1.15,
  },
  // the same six with opposite manners: everything behind a thick silencer
  mercedes: {
    eng: { cyl: 6, idle: 650, redline: 6500, exL: 3.1, exG: 0.42, mufLo: 260, mufHi: 1700,
      rise: [1.0, 0.3], intake: 0.3, rasp: 0.22, roar: 0.4, knock: 0.06, mech: 0.1, vol: 0.85 },
    box: { idle: 650, redline: 6500, kph: [8, 13.5, 20, 27, 34.5, 43, 52, 62, 72],
      up: [1600, 6100], down: [1050, 3300], shift: 0.34, fall: 3600, launch: 1900 },
    vmax: 67, accel: 8.5, loud: 0.85,
  },
  // two-litre turbodiesel in a panel van: clatter at idle, whistle under load
  van: {
    eng: { cyl: 4, diesel: 1, idle: 800, redline: 4500, exL: 3.2, mufLo: 260, mufHi: 1500,
      rise: [1.2, 0.4], decay: 3.8, knock: 0.18, mech: 0.3, turbo: 0.6, turboF: [2600, 7000],
      intake: 0.35, roar: 0.4, cov: [0.1, 0.03], vol: 1.05 },
    box: { idle: 800, redline: 4500, kph: [7.5, 14, 22, 31, 40, 49], up: [1700, 4000],
      down: [1100, 2500], shift: 0.36, fall: 3200, rise: 5000, launch: 1700 },
    vmax: 36.1, accel: 4.6, loud: 1.1,
  },
  // seven-litre six in a cab-over: felt as much as heard, and it never revs
  truck: {
    eng: { cyl: 6, diesel: 1, idle: 600, redline: 2500, exL: 4.6, tailL: 1.6, boomF: 90,
      mufLo: 220, mufHi: 1100, rise: [1.6, 0.55], decay: 5, radF: 110, knock: 0.2, mech: 0.34,
      turbo: 0.8, turboF: [1800, 5200], intake: 0.4, roar: 0.4, res: [480, 1050, 2100],
      cov: [0.08, 0.025], vol: 1.25 },
    box: { idle: 600, redline: 2500, kph: [5.5, 9.5, 15.5, 24, 34, 45], up: [1200, 2250],
      down: [880, 1450], shift: 0.7, fall: 1300, rise: 1800, launch: 1150 },
    vmax: 26.4, accel: 3.2, loud: 1.5, air: 1,
  },
  // thirteen-litre tractor unit: the truck, longer and lower
  semi: {
    eng: { cyl: 6, diesel: 1, idle: 580, redline: 2100, exL: 5.2, tailL: 1.8, boomF: 80,
      mufLo: 200, mufHi: 950, rise: [1.8, 0.6], decay: 5.5, radF: 100, knock: 0.18, mech: 0.36,
      turbo: 0.85, turboF: [1500, 4600], intake: 0.4, roar: 0.4, res: [450, 980, 1950],
      cov: [0.07, 0.02], vol: 1.35 },
    box: { idle: 580, redline: 2100, kph: [3.8, 6, 9, 13.5, 20, 28, 38, 50], up: [1150, 1850],
      down: [850, 1300], shift: 0.8, fall: 1000, rise: 1500, launch: 1050 },
    vmax: 25, accel: 2.4, loud: 1.7, air: 1,
  },
  // rear-engined city bus: a six behind the back seats on a slurring automatic
  bus: {
    eng: { cyl: 6, diesel: 1, idle: 580, redline: 2300, exL: 4.2, tailL: 1.2, boomF: 84,
      mufLo: 210, mufHi: 1000, rise: [1.6, 0.55], decay: 5, radF: 105, knock: 0.18, mech: 0.4,
      turbo: 0.55, turboF: [1900, 5200], intake: 0.3, roar: 0.4, res: [480, 1050, 2100],
      cov: [0.08, 0.025], vol: 1.2 },
    box: { idle: 580, redline: 2300, kph: [7, 12, 18.5, 27, 37, 50], up: [1150, 2100],
      down: [820, 1350], shift: 0.55, fall: 1100, rise: 1500, launch: 1250 },
    vmax: 29.2, accel: 3, loud: 1.5, air: 1,
  },
};

// What has no piston engine still rolls: these get the road layer of the mixer
// (tyres or steel wheels, brakes, brake air) and nothing else from it.
export const ROLLING_KINDS = {
  tesla: { loud: 0.7 },
  trolleybus: { loud: 1, heavy: 1, air: 1 },
  tram: { loud: 1.5, heavy: 1, rail: 1 },       // steel on steel, and a traction whine
};

// A third class of voice: electric motors with cold gas thrusters behind them.
// No cycle and no gearbox, so neither `eng` nor `box`: `thr` is the sound
// (public/worklets/thrusterdsp.js, THRUSTER_DEFAULTS) and `drive` is how the
// motor and the valves answer the pedal (js/thrustdrive.js, THRUST_DEFAULTS).
export const THRUST_KINDS = {
  // the Roadster: three motors, one reduction, and a tank of compressed air
  roadster: {
    thr: { vol: 1.3 },
    drive: {},
    vmax: 111, accel: 27.8, loud: 0.8,
  },
};

// pre-v4 saves and a few spawn lists still say sedan/hatch/kombi/suv
const ALIAS = { sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' };

/** The piston engine for a vehicle kind, or null for the electric ones. */
export function engineKind(kind) {
  if (ROLLING_KINDS[kind] || THRUST_KINDS[kind]) return null;
  return ENGINE_KINDS[kind] ?? ENGINE_KINDS[ALIAS[kind]] ?? ENGINE_KINDS.octavia;
}

/** The key engineKind() resolved to, or null for a kind with no piston engine. */
export function engineKey(kind) {
  if (ROLLING_KINDS[kind] || THRUST_KINDS[kind]) return null;
  return ENGINE_KINDS[kind] ? kind : (ALIAS[kind] ?? 'octavia');
}

/** Which synthesis in the worklet voices this kind: 'piston', 'thrust', or
 *  null for the kinds that only roll there (their motor is in js/audio.js). */
export function voiceClass(kind) {
  if (THRUST_KINDS[kind]) return 'thrust';
  return ROLLING_KINDS[kind] ? null : 'piston';
}

/** The name a kind's voice is cached and sent to the mixer under, or null. */
export function voiceKey(kind) { return THRUST_KINDS[kind] ? kind : engineKey(kind); }

/** Whatever the mixer needs to know about a kind, piston or not. */
export function vehicleVoice(kind) { return THRUST_KINDS[kind] ?? ROLLING_KINDS[kind] ?? engineKind(kind); }
