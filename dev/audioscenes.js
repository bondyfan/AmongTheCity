// ---- driving scenes for listening to the car audio offline --------------------
// The game runs muted in the built-in browser, so the sound is judged from
// rendered files instead. A scene is a short scripted drive: pedals over time
// for the player's car, and/or traffic going past a listener. The same scenes
// feed the node renderer (dev/render-car-audio.mjs, the new synthesis alone)
// and the browser renderer (dev/audiorender.html, the whole mix through the
// real js/audio.js, old engine or new), so "before" and "after" are the same
// drive, frame for frame.
//
// The car here is a few lines of longitudinal physics, not vehicles.js: enough
// to give a believable speed trace, with nothing to load.

import { ENGINE_KINDS } from '../js/enginekinds.js';

const KMH = 1 / 3.6;
const seg = (t, steps) => {          // piecewise constant: [[untilT, value], ...]
  for (const [until, v] of steps) if (t < until) return v;
  return steps[steps.length - 1][1];
};

// A car driving straight past a listener standing at the origin, facing +z...
// the road runs along x at `side` metres in front. Starts at x = -from.
const pass = (id, kind, t0, from, side, kmh, accel = 0) => (t) => {
  const tt = t - t0;
  if (tt < 0) return null;
  const v = Math.max(0, kmh * KMH + accel * tt);
  const x = -from + kmh * KMH * tt + 0.5 * accel * tt * tt;
  return Math.abs(x) > 160 ? null : { id, kind, x, z: side, speed: v };
};

export const SCENES = {
  volnobeh_rozjezd: {
    title: 'Volnoběh a rozjezd přes převody (Octavia)', kind: 'octavia', dur: 22,
    gas: (t) => seg(t, [[3.5, 0], [12.5, 1], [15.5, 0], [18, -0.6], [22, 0]]),
  },
  mesto: {
    title: 'Jízda městem s lehkou nohou (Fabia)', kind: 'fabia', dur: 22,
    gas: (t) => seg(t, [[1, 0], [6, 0.45], [9, 0.12], [11, 0], [12.5, -0.5], [13.5, 0], [18, 0.6], [22, 0.15]]),
  },
  dalnice_130: {
    title: 'Dálnice 130 km/h, ustálená jízda (Octavia)', kind: 'octavia', dur: 14, v0: 130 * KMH,
    gas: (t) => seg(t, [[5, 0.34], [7, 0], [10, 0.8], [14, 0.34]]),
  },
  kabina: {
    title: 'Stejná jízda zvenku a potom zevnitř auta (Octavia)', kind: 'octavia', dur: 16, v0: 60 * KMH,
    gas: (t) => seg(t, [[3, 0.25], [6, 0.9], [8, 0.2], [11, 0.25], [14, 0.9], [16, 0.2]]),
    cabin: (t) => (t < 8 ? 0 : 1),
  },
  brzdy_smyk: {
    title: 'Prudké brzdění, zatáčka se smykem, ruční brzda, omezovač (BMW)', kind: 'bmw', dur: 18, v0: 95 * KMH,
    //          cruise     brake      through the bend  handbrake turn  power out, sideways  away        lift
    gas: (t) => seg(t, [[2, 0.3], [3.6, -1], [7.5, 0.16], [8.9, 0], [11.4, 1], [14, 0.7], [18, 0]]),
    slip: (t) => (t > 3.9 && t < 6.5 ? 0.7 : t > 7.5 && t < 8.9 ? 0.9 : t > 8.9 && t < 11.4 ? 0.8 : 0),
    hb: (t) => t > 7.5 && t < 8.8,
  },
  dlazba: {
    title: 'Z asfaltu na dlažební kostky a zpět (Octavia)', kind: 'octavia', dur: 14, v0: 35 * KMH,
    gas: (t) => seg(t, [[14, 0.2]]),
    cobble: (t) => (t > 3.5 && t < 10 ? 1 : 0),
  },
  tridy: {
    title: 'Rozjezdy: Fabia, BMW, dodávka, nákladní, autobus', dur: 40,
    // five cars in a row, eight seconds each
    kindAt: (t) => ['fabia', 'bmw', 'van', 'truck', 'bus'][Math.min(4, (t / 8) | 0)],
    gas: (t) => seg(t % 8, [[0.8, 0], [5.6, 1], [6.6, 0], [8, -0.7]]),
    resetEvery: 8,
  },
  autobus_projizdi: {
    title: 'Stojíš u silnice: projede autobus, pak nákladní a osobní auta', dur: 26,
    ears: { x: 0, z: 0, dx: 0, dz: 1 },
    traffic: [
      pass('bus1', 'bus', 0.5, 110, 6, 42),
      pass('oct1', 'octavia', 6.5, 120, 6, 55),
      pass('fab1', 'fabia', 8.2, 120, 9.5, -48),       // the other way, far lane
      pass('trk1', 'truck', 11.5, 120, 6, 50),
      pass('bmw1', 'bmw', 16.5, 130, 6, 88, 2.5),      // someone in a hurry
      pass('van1', 'van', 19, 120, 9.5, -52),
    ],
  },
  autobus_zastavka: {
    title: 'Autobus zastaví u zastávky a rozjede se', dur: 20,
    ears: { x: 0, z: 0, dx: 0, dz: 1 },
    traffic: [(t) => {
      // brakes from 40 km/h to a stop at x = 2, waits, pulls away
      const v0 = 40 * KMH, a = 1.6, tb = v0 / a, x0 = 2 - v0 * tb / 2 - v0 * 2;
      let x, v;
      if (t < 2) { x = x0 + v0 * t; v = v0; }
      else if (t < 2 + tb) { const u = t - 2; x = x0 + v0 * 2 + v0 * u - a * u * u / 2; v = v0 - a * u; }
      else if (t < 10 + tb) { x = 2; v = 0; }
      else { const u = t - 10 - tb; v = Math.min(11, 1.1 * u); x = 2 + (v < 11 ? 0.55 * u * u : 55 + 11 * (u - 10)); }
      return { id: 'bus2', kind: 'bus', x, z: 5, speed: v };
    }],
  },
  naraz: {
    title: 'Tři nárazy: ťuknutí, střední, tvrdý', dur: 7,
    hits: [[0.5, 0.15], [2.5, 0.5], [4.5, 1]],
  },
};

/**
 * Plays a scene and calls onFrame(state) once per simulated frame.
 * state: { t, dt, kind, kindChanged, player: {speed, throttle, gas, slip, brake, hb, cobble} | null,
 *          cabin, traffic: [...], ears, hits: [k, ...] }
 */
export function playScene(scene, onFrame, fps = 60) {
  const dt = 1 / fps;
  let v = scene.v0 ?? 0, kind = scene.kind ?? scene.kindAt?.(0) ?? null, prevKind = null;
  let hitI = 0;
  for (let i = 0, n = Math.round(scene.dur * fps); i < n; i++) {
    const t = i * dt;
    if (scene.kindAt) kind = scene.kindAt(t);
    if (scene.resetEvery && i && Math.abs((t % scene.resetEvery)) < dt * 0.5) v = 0;
    let player = null;
    if (kind) {
      const K = ENGINE_KINDS[kind] ?? { accel: 7, vmax: 64 };
      const gas = scene.gas ? scene.gas(t) : 0;
      const hb = scene.hb ? !!scene.hb(t) : false;
      let a = -(0.3 + 0.0011 * v * v) * (v > 0.05 ? 1 : 0);
      if (gas > 0) a += K.accel * gas * (1 - (v / K.vmax) ** 2);
      else if (gas < 0 && v > 0) a -= 11 * -gas;
      if (hb) a -= 6;
      v = Math.max(0, v + a * dt);
      player = {
        speed: v, gas, hb, throttle: gas > 0 ? gas : 0, brake: Math.max(gas < 0 ? -gas : 0, hb ? 0.6 : 0),
        slip: scene.slip ? scene.slip(t) : 0, cobble: scene.cobble ? scene.cobble(t) : 0,
      };
    }
    const traffic = [];
    for (const f of scene.traffic ?? []) { const c = f(t); if (c) traffic.push(c); }
    const hits = [];
    while (scene.hits && hitI < scene.hits.length && scene.hits[hitI][0] <= t) hits.push(scene.hits[hitI++][1]);
    onFrame({
      t, dt, kind, kindChanged: kind !== prevKind, player, cabin: scene.cabin ? scene.cabin(t) : 0,
      traffic, ears: scene.ears ?? { x: 0, z: 0, dx: 0, dz: 1 }, hits,
    });
    prevKind = kind;
  }
}
