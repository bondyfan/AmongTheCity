// ---- Regions: more than one world, each in its own frame ----
// For its whole life the game was ONE coordinate frame: metres from the
// railway node of Pardubice hlavní nádraží, x east, z south. Everything that
// was ever built (tiles, height maps, the campaign, every hard-coded corner of
// Prague) lives in it. Mahé, the main island of the Seychelles, is 7 800 km
// away; putting it in the same frame would put it at x ≈ 3·10⁶, where float32
// is a metre coarse, and it would drag every Czech-only system (the D11, the
// stations, the campaign) along to a place where none of them means anything.
//
// So a REGION is a separate world: its own origin and projection, its own data
// folder (tiles, terrain, ground classes), its own sun and time zone, its own
// side of the road. Exactly one region is live per page. Switching is a
// navigation behind the boot cover, not a teardown: main.js builds forty
// systems once per page, and the only teardown that is certainly complete is
// the browser's. The hand-over (where to stand, what you arrived in) rides in
// sessionStorage, which survives that reload and nothing else.
//
// Pure module: no three.js, no DOM until a function that needs it is called,
// so node tests import it as is.

// Metres per degree at a latitude, the same series scripts/lib/world-area.mjs
// has always used for the Czech frame (it gives 111230.7 / 71648.6 there).
export function metresPerDegree(lat) {
  const r = lat * Math.PI / 180;
  return {
    mPerLat: 111132.9 - 559.8 * Math.cos(2 * r),
    mPerLon: 111412.8 * Math.cos(r) - 93.5 * Math.cos(3 * r),
  };
}

export const REGIONS = {
  // The world as it has always been. Nothing here may change a byte of how a
  // Czech game boots: same folder, same origin, same everything.
  cz: {
    id: 'cz', name: 'Česko', to: 'do Česka', at: 'v Česku',
    data: 'data/',
    origin: { lat: 50.0317084, lon: 15.7560881 },
    tile: 4800,
    drive: 'right',
    // The shared world clock's own frame. Not real local time (one game day
    // is 24 real minutes): this is only the zero the other regions shift from.
    utcOffset: 1,
    ortho: true,          // ČÚZK aerial photos under the ground (js/ortho.js)
    czech: true,          // the D11, the stations, the campaign, the chains
    sun: { rise: 5, set: 21, peak: 75, dip: 40 },
    hospitals: null,      // config.js HOSPITALS (and the D11 services) stay the Czech list
    spawns: {},           // START_PLACES in config.js stay the Czech list
  },
  // Mahé. The origin is a round anchor just south of Victoria's harbour, NOT a
  // landmark: a frame needs a fixed zero, and a round one cannot be mistaken
  // for a surveyed point.
  //
  // `offset` is a FALSE ORIGIN, the trick every national grid uses (UTM's
  // 500 km false easting): the island is drawn 100 km NORTH of the Czech
  // world's northern edge (z -29 km), so it sits at z -108..-80 km. Dozens of
  // modules hold hand-measured Czech coordinates (the station hall, the D35,
  // the Labe weirs, the LKPD airfield, the terrain stamps); with the island
  // drawn around zero, every one of them within 25 km of Pardubice would have
  // turned up in Victoria. With the offset none of them can ever reach it,
  // including the ones nobody has written yet. 100 km also keeps float32 at
  // 7.8 mm, the precision Prague (x -95 km) has always run at.
  mahe: {
    id: 'mahe', name: 'Mahé', to: 'na Mahé', at: 'na Mahé',
    data: 'data/regions/mahe/',
    origin: { lat: -4.62, lon: 55.45 },
    offset: { x: 0, z: -100000 },
    tile: 4800,
    drive: 'left',        // Seychelles keeps left, cars are right-hand drive
    utcOffset: 4,         // Seychelles Time, no daylight saving
    ortho: false,         // ČÚZK has no photo of the Indian Ocean
    czech: false,
    // 4.6° south of the equator: a twelve-hour day all year and a sun that
    // climbs nearly overhead and drops through twilight fast.
    sun: { rise: 6.0, set: 18.3, peak: 78, dip: 70 },
    sea: { level: 0 },
    // Seychelles International on the reclaimed land at Pointe Larue, as OSM
    // surveyed it (scripts/mahe/extras.mjs → airport.json; the runway is three
    // OSM ways, 2 986 m end to end against the AIP's 2 987). Elevations are
    // the built terrain's. The shape is the contract js/flight-airports.js reads.
    // Headings: 0 faces north (-z), dirX = -sin h, dirZ = -cos h.
    airport: {
      icao: 'FSIA', iata: 'SEZ', name: 'Seychelles International',
      runway: {
        width: 46,
        ends: { '13': { x: 6745.8, z: -94847.6, elev: 3.8 }, '31': { x: 9197.2, z: -93142.5, elev: 4.4 } },
      },
      // on the apron before the terminal, parallel to the runway, nose to the
      // north-west, its left side (the doors) to the terminal
      stand: { x: 6870.4, z: -94500.4, heading: 0.9631 },
      terminal: { landside: { x: 6792.8, z: -94327.2 } },
    },
    // where you wake after the death card: beside the two hospitals' doors
    // (OSM's Victoria Hospital at Mont Fleuri and Anse Royale Hospital), each
    // on the pavement of the road that serves it and clear of every wall
    hospitals: [
      { x: 584.6, z: -98755.5, name: 'Victoria Hospital' },
      { x: 7395.2, z: -86742.8, name: 'Anse Royale Hospital' },
    ],
    home: 'victoria',
    spawns: {
      // on final for 13 from the north-west: 9 km out on a 3 degree path, which
      // is over Victoria's harbour, as the real approach is
      'sez-arrival': { x: -642.7, z: -99986.7, y: 490, heading: -2.1785 },
      // in front of the terminal, landside, facing its doors
      'sez-terminal': { x: 6792.8, z: -94327.2, heading: -0.608 },
      // Albert Street, beside the Clock Tower, facing it
      victoria: { x: 263.9, z: -99651.6, heading: 1.6 },
    },
  },
};

export const DEFAULT_REGION = 'cz';

// lat/lon ↔ region metres. Equirectangular about the region's origin, as the
// Czech pipeline has always projected: Mahé is 27 × 11 km, over which the
// error of a flat frame is centimetres.
// The false origin (`offset`, see Mahé above) is added after the projection.
export function project(lat, lon, r = region()) {
  const { mPerLat, mPerLon } = metresPerDegree(r.origin.lat);
  const o = r.offset ?? ZERO;
  return { x: o.x + (lon - r.origin.lon) * mPerLon, z: o.z + (r.origin.lat - lat) * mPerLat };
}
export function unproject(x, z, r = region()) {
  const { mPerLat, mPerLon } = metresPerDegree(r.origin.lat);
  const o = r.offset ?? ZERO;
  return { lat: r.origin.lat - (z - o.z) / mPerLat, lon: r.origin.lon + (x - o.x) / mPerLon };
}
const ZERO = { x: 0, z: 0 };

// ---- which region this page is ----
// Decided once, from the URL: ?region=mahe. Absent or unknown is the Czech
// world, so every link and bookmark that exists today still opens Pardubice.
let _active = null;
export function regionIdFrom(search) {
  const m = /[?&]region=([a-z0-9-]+)/i.exec(search || '');
  const id = m ? m[1].toLowerCase() : DEFAULT_REGION;
  return REGIONS[id] ? id : DEFAULT_REGION;
}
export function regionId() {
  if (_active === null) {
    const search = typeof location !== 'undefined' ? location.search : '';
    _active = regionIdFrom(search);
  }
  return _active;
}
export function region() { return REGIONS[regionId()]; }
/** tests and tools only: pretend this page is another region */
export function _setRegionForTest(id) { _active = id === null ? null : (REGIONS[id] ? id : DEFAULT_REGION); }

/** A runtime data path in the live region: dataUrl('terrain/0_0.bin'). */
export function dataUrl(path, r = region()) { return r.data + path; }

// +1 keeps right, −1 keeps left. Every lane offset in the engine is signed
// "+ to the right of travel" (js/ailane.js), so this one factor is the whole
// difference between Pardubice and Victoria.
export function laneSide(r = region()) { return r.drive === 'left' ? -1 : 1; }

// The local hour of a region as a shift of the shared clock (tod 0..1). The
// shared clock reads Czech time; Victoria is three hours ahead of CET.
export function todShift(r = region()) { return (r.utcOffset - REGIONS.cz.utcOffset) / 24; }

// ---- crossing between regions ----
const ARRIVAL_KEY = 'atc-region-arrival';
// A hand-over older than this is a stale tab, not a flight that just landed.
const ARRIVAL_TTL_MS = 120000;

/** Spawn poses another module owns (js/airport-plan.js registers the LKPD ones
 *  at import), so this file never imports a module that may not exist yet. */
export function registerSpawns(id, spawns) {
  if (!REGIONS[id]) throw new Error('unknown region ' + id);
  Object.assign(REGIONS[id].spawns, spawns);
}

// main.js registers what the live game is (wallet, vitals, stars, the menu's
// choice) so that a crossing carries it without the caller knowing any of it:
// saves are only written at autosave points, and a reload would otherwise roll
// back the ticket you just paid for.
let _carryHook = null;
export function setCarryHook(fn) { _carryHook = typeof fn === 'function' ? fn : null; }

/** The URL of this page in another region: ?region= replaced, every other
 *  parameter (devmode, a co-op flag) kept. The Czech world drops it. */
export function regionHref(id, href) {
  const u = new URL(href);
  // by hand, not searchParams: that rewrites a bare "?devmode" as "devmode="
  const parts = u.search.replace(/^\?/, '').split('&').filter((p) => p && !/^region=/i.test(p));
  if (id !== DEFAULT_REGION) parts.push('region=' + id);
  u.search = parts.length ? '?' + parts.join('&') : '';
  return u.toString();
}

/** The pose a spawn id or an explicit pose stands for in region `id`. */
export function spawnPose(id, spawn) {
  const pose = typeof spawn === 'string' ? REGIONS[id]?.spawns[spawn] : spawn;
  if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.z)) return null;
  return { x: pose.x, z: pose.z, heading: pose.heading ?? 0, y: Number.isFinite(pose.y) ? pose.y : null };
}

/**
 * Leave this region for another. `spawn` is a spawn id of the target region
 * (REGIONS[id].spawns) or an explicit pose { x, z, heading, y? }. `carry` is
 * whatever the caller needs on the other side, JSON only (the flight); the
 * live game state is added as `carry.live` by the hook above. Writes the
 * hand-over, then navigates; the boot cover covers the load.
 */
export function enterRegion(id, spawn, carry = {}, env = globalThis) {
  if (!REGIONS[id]) throw new Error('unknown region ' + id);
  const pose = spawnPose(id, spawn);
  if (!pose) throw new Error('unknown spawn ' + spawn + ' in region ' + id);
  let live = null;
  try { live = _carryHook ? _carryHook() : null; } catch (e) { console.warn('[regions] carry hook failed', e); }
  const handover = {
    v: 1, from: regionId(), to: id, spawn: typeof spawn === 'string' ? spawn : null,
    pose, carry: live ? { ...carry, live } : carry, t: Date.now(),
  };
  try { env.sessionStorage?.setItem(ARRIVAL_KEY, JSON.stringify(handover)); } catch { /* private mode */ }
  env.location?.assign(regionHref(id, env.location.href));
  return handover;
}

/**
 * The hand-over that brought this page here, once: read and cleared, so a
 * reload afterwards is an ordinary boot. null when there was none, when it was
 * for another region (a back button), or when it is stale.
 */
export function takeArrival(env = globalThis, now = Date.now()) {
  let raw = null;
  try { raw = env.sessionStorage?.getItem(ARRIVAL_KEY) ?? null; env.sessionStorage?.removeItem(ARRIVAL_KEY); } catch { return null; }
  if (!raw) return null;
  let h;
  try { h = JSON.parse(raw); } catch { return null; }
  if (!h || h.to !== regionId() || !(now - h.t < ARRIVAL_TTL_MS)) return null;
  if (!h.pose || !Number.isFinite(h.pose.x) || !Number.isFinite(h.pose.z)) return null;
  return h;
}

// The hand-over of THIS page, taken once at the first ask and kept: boot asks
// before the world exists, the flight asks after, both get the same object.
let _arrival;
export function arrival(env = globalThis) {
  if (_arrival === undefined) _arrival = takeArrival(env);
  return _arrival;
}
/** tests only */
export function _resetArrivalForTest() { _arrival = undefined; }
