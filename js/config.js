// ---- Among The City: all tunables in one place ----

// The world origin is the railway=station node of Pardubice hlavní nádraží.
// The 305 m functionalist hall spans x −145..160 at z −108..−50 (north of the
// origin); the spawn stands on the forecourt in front of it, facing the hall.
export const SPAWN = { x: 25, z: -25, heading: 0 }; // heading 0 = facing north (−z)
export const CITY_DATA_URL = 'data/pardubice.json';

// streaming
export const CHUNK = 120;        // meters per streaming cell
export const VIEW_CHUNKS = 5;    // cells streamed around the focus (±600 m)
export const CHUNKS_PER_FRAME = 2; // build budget — no hitching on the move

// vertical layering (meters above the y=0 base plane) — generous steps, the
// AmongTheWoods ground taught us tight offsets z-fight at 200 m
export const LAYER_Y = {
  green: 0.05, water: 0.08, paved: 0.10, rail: 0.14,
  footway: 0.16, road: 0.20, marking: 0.26,
};
export const BRIDGE_Y = 5.0;     // deck height over the Labe
export const BRIDGE_RAMP = 18;   // meters of ramp at each bridge end

// day clock — one in-game day in 24 real minutes, spawning mid-morning
export const DAY_LENGTH = 24 * 60;
export const START_TOD = 10.5 / 24;

// ---- palette (low-poly flat look, borrowed from the Woods art direction) ----
export const COLORS = {
  groundBase: 0x8f9484,      // suburb gray-green base plane
  green: { park: 0x6fa05a, wood: 0x4e7a44, grass: 0x7fa863, pitch: 0x6f9e75, cemetery: 0x7a9468 },
  paved: { parking: 0x8a8d90, plaza: 0x9d9a92 },
  water: 0x3f6f95,
  road: {
    motorway: 0x4c4f55, trunk: 0x4c4f55, primary: 0x53565c, secondary: 0x55585e,
    tertiary: 0x585b60, unclassified: 0x5c5f64, residential: 0x5c5f64,
    living_street: 0x67696d, service: 0x64666a, pedestrian: 0x8f8c84,
    footway: 0x9a968c, path: 0x8f8a7c, cycleway: 0x7d6f74, steps: 0xa09c92, track: 0x84796a,
  },
  marking: 0xd8d8d2,
  railBed: 0x6d6a62, rail: 0x3c3e42, sleeper: 0x5a5248,
  treeTrunk: 0x6b4a2e, treeCrown: [0x5d8a4a, 0x6a9a52, 0x527e42, 0x74a25e],
};

// building wall palettes by type — Czech city: pastel plasters in the old
// town, gray panel housing, brick industry. Roofs derived darker.
export const BUILDING_PALETTES = {
  apartments: [0xd9cfc0, 0xcfc4b2, 0xc9c9c4, 0xd4c8ae, 0xbfb9ad],
  residential: [0xd9cfc0, 0xd3c5ae, 0xcabfae, 0xd8d0c2],
  house: [0xe0d6c4, 0xd8c9a8, 0xd2c3a2, 0xe3d9c9, 0xc9b998],
  panel: [0xb5b8ba, 0xadb2b6, 0xc0c3c5],            // paneláky
  commercial: [0xb8bcc2, 0xc4c8ce, 0xaeb4bc],
  retail: [0xc7bfae, 0xbdb6a8],
  industrial: [0x9aa0a6, 0xa8a29a, 0x9c9489],
  civic: [0xd8d2c2, 0xdcd6c8],
  church: [0xe4ded0], school: [0xdcd2be], hotel: [0xd6c9b4],
  office: [0xaeb8c4, 0xb6c0ca], train_station: [0xd2c4a6],
  garage: [0x9d9d98, 0xa8a49c], shed: [0x94897a],
  default: [0xcec6b6, 0xc6bcaa, 0xd2cabc],
};
export const ROOF_DARKEN = 0.62;   // roof = wall color × this
export const WALL_AO = 0.78;       // ground-edge vertex darkening

// ---- cars ----
export const CAR_COLORS = [0xb8433a, 0x3a63a8, 0xd8d5ce, 0x35383d, 0x8a9096,
  0x9a7b3c, 0x476b46, 0x7a4a66, 0xc4c9cf, 0x2f4f72];
export const CAR = {
  accel: 6.5, brake: 11, vmax: 38, vrev: 8,   // m/s
  steerMax: 0.62, steerSpeedK: 0.045,          // wheel angle & its speed falloff
  grip: 7.5, drag: 0.35, roll: 0.55,
  len: 4.2, wid: 1.8,
};
export const TRAFFIC = {
  maxCars: 45, spawnR: 400, despawnR: 520,
  laneOffsetK: 0.27, laneOffsetMax: 2.1,
  lookAhead: 22, stopGap: 2.5,
};

// walk speeds
export const WALK = { jog: 4.2, sprint: 7.0, accel: 14, turn: 12, radius: 0.38 };
