// ---- Among The City: all tunables in one place ----

// The world origin is the railway=station node of Pardubice hlavní nádraží —
// which OSM parks amid the TRACKS. The 305 m functionalist hall spans
// x −145..160 at z −108..−50, and the forecourt with the bus terminal (every
// "Hlavní nádraží" stop) lies just past it at z −120..−157. Spawn there,
// facing the hall (heading π = facing +z in this frame).
export const SPAWN = { x: 25, z: -122, heading: Math.PI };
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
// Real bridges don't hump: the deck runs FLAT barely above street level and
// what sells the bridge is the river sunk below it (Labe embankments), so
// water renders at WATER_Y with vertical bank skirts down from the ground.
export const BRIDGE_Y = 0.85;    // flat deck height
export const BRIDGE_RAMP = 6;    // short end blend, not a climb
export const WATER_Y = -2.0;     // rivers sit sunken between their banks
export const BANK_DEPTH = -2.4;  // bank skirts reach just under the water

// ČÚZK ortofoto ground (open data, CC BY 4.0 — "Podkladová data ČÚZK"):
// 480 m supertiles fetched by scripts/fetch-ortho.mjs into public/data/ortho
export const ORTHO = { tile: 480, px: 1024, dir: 'data/ortho', extent: 2400 };

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

// Character scale. The model is anatomically right (1.77 m against a 4.9 m
// car), but on a third-person camera it read as oversized, so the player is
// rendered smaller by request. 1 = true human scale (1.77 m); 0.9 ≈ 1.6 m.
export const PLAYER_SCALE = 0.9;

// walk speeds
export const WALK = { jog: 4.2, sprint: 7.0, accel: 14, turn: 12, radius: 0.38 };

// ---- v5: interiors ----
// Every roof in the city has rooms under it. The numbers here are the ones a
// Czech building inspector would recognise (2.1 m door leaf, 175 mm riser,
// 2.3 m corridor), because a plan laid out from real dimensions needs no art
// direction to read as a building — it just IS one.
export const INTERIOR = {
  activateR: 34,        // m — an interior is built this close on foot…
  deactivateR: 74,      // …and thrown away past here (damaged ones never are)
  maxActive: 8,         // undamaged interiors alive at once
  maxDamaged: 10,       // wrecks kept; the oldest is restored past this
  buildPerSec: 8,       // activations per second — spreads the cost over frames

  tile: 1.9,            // floor-slab tile (m); coarsened for huge footprints
  panel: 1.55,          // wall-panel width
  slabT: 0.26,          // slab thickness
  wallT: 0.15,          // interior partition thickness
  linT: 0.14,           // inner lining of the outer wall
  extT: 0.36,           // the outer wall itself (only built once damaged)

  doorW: 1.0, doorH: 2.1,      // interior door leaf
  entryW: 2.0, entryH: 2.4,    // street entrance (cut into the facade too)
  corridorW: 2.35,
  stepRise: 0.175, stepGo: 0.29,  // 18 risers ≈ one 3.1 m storey
  coreW: 2.95,          // stair shaft: 1.45 m run + 1.45 m landing
  minStorey: 2.55, maxStorey: 5.6,
  pieceBudget: 5800,    // per building — tiles coarsen until the plan fits
  groundLift: 0.30,     // ground floor sits above config's whole LAYER_Y ladder
  stepUp: 0.55,         // how high the player walks up without jumping
  headroom: 1.72,       // collider height (a real person, not the scaled model)
};

// Interior palettes — floor / wall / ceiling / trim / accent per use class.
// Deliberately warmer and dirtier than the facades: a room lit only by the sky
// through one window needs its own value range or it reads as a cave.
export const INTERIOR_PALETTES = {
  flats:       { floor: 0x9a7549, wall: 0xe4dfd3, ceil: 0xf2eee6, trim: 0xbdb5a5, accent: 0x9c6a4e },
  house:       { floor: 0xa07c4c, wall: 0xe8e2d4, ceil: 0xf4f0e8, trim: 0xc3bba8, accent: 0x8f6b46 },
  mall:        { floor: 0xd6d2ca, wall: 0xeceae6, ceil: 0xf6f5f2, trim: 0xa8adb4, accent: 0xc8562f },
  supermarket: { floor: 0xc9c6bf, wall: 0xe6e6e2, ceil: 0xececeb, trim: 0x9aa0a6, accent: 0x2f6bb0 },
  shop:        { floor: 0xc0b9ac, wall: 0xe7e2d8, ceil: 0xf0ece4, trim: 0xa79f90, accent: 0xb0602f },
  office:      { floor: 0x8d9298, wall: 0xeaecef, ceil: 0xf4f6f8, trim: 0x9aa2ac, accent: 0x3b6ea8 },
  school:      { floor: 0xa8845a, wall: 0xe6e8dc, ceil: 0xf2f4ec, trim: 0xb2ad98, accent: 0x4f7c4a },
  hospital:    { floor: 0xcdd6d8, wall: 0xeef2f2, ceil: 0xf8fafa, trim: 0xa9b6b8, accent: 0x3f8f92 },
  hotel:       { floor: 0x8a5f46, wall: 0xe2d6c4, ceil: 0xf0e8da, trim: 0xb59a74, accent: 0x8a3a3a },
  industrial:  { floor: 0x7f8288, wall: 0xb8bcbe, ceil: 0xc4c8ca, trim: 0x8e9298, accent: 0xc08a24 },
  parking:     { floor: 0x86898d, wall: 0x9ea1a4, ceil: 0xaaadb0, trim: 0x74787c, accent: 0xd8d4c8 },
  church:      { floor: 0xa89a80, wall: 0xe6e0cf, ceil: 0xefe9da, trim: 0xc0b294, accent: 0x8a6a2c },
  garage:      { floor: 0x8b8d8f, wall: 0xc6c2b8, ceil: 0xd0ccc2, trim: 0x9c9890, accent: 0x7a6a52 },
  restaurant:  { floor: 0x8c5a3a, wall: 0xe8ddc8, ceil: 0xf2ead8, trim: 0xb08c5c, accent: 0xda291c },
  civic:       { floor: 0xa3937a, wall: 0xe6e1d4, ceil: 0xf2eee4, trim: 0xb8b0a0, accent: 0x6a7f9c },
};

// ---- v5: destruction ----
// Teardown's grammar: a wall is not a surface, it is a pile of panels that
// happen to be touching. These numbers decide how big a panel is, how hard a
// missile shoves it, and how much of the pile the frame budget can watch fall.
export const DESTRUCTION = {
  debrisMax: 900,       // flying chunks alive at once (one InstancedMesh)
  dustMax: 120,         // smoke/dust sprites
  gravity: 19,          // punchier than 9.81 — game debris must land, not float
  bounce: 0.24, friction: 0.6,
  debrisLife: 14,       // s before a chunk shrinks away
  collapseMax: 260,     // unsupported pieces turned into falling debris per hit
  crackDarken: 0.72,    // scorched-but-standing pieces multiply by this
};

// The helicopter's rocket pod. Deliberately fast and flat: an unguided rocket
// fired from a hover should hit roughly where the nose points, and the flight
// time across a street has to be short enough that aiming feels like aiming.
export const MISSILE = {
  v0: 55, accel: 150, vmax: 210,   // m/s — the motor burns the whole flight
  gravity: 3.2,                     // just enough droop to read as ballistic
  life: 6.5,
  blast: 9.5,
  cool: 0.42, mag: 8, reload: 3.4,
  shake: 1.0,                       // camera kick at the blast
};
