// ---- mapstyle: how the HUD map draws the world --------------------------------
// The minimap used to borrow the 3D palette (sunlit asphalt, plaster, mown
// grass) and lift it until it read; on a 220 px disc that came out as a grey
// wash in which a road, a car park and a roof were the same colour. A HUD map
// is not a photograph of the ground, it is a diagram of where you can drive,
// so it gets a palette of its own: the night-satnav look of a modern car or an
// open-world radar. Dark ground, the network bright and graded by class (the
// motorway amber, a side street a quiet grey), water and parks as tinted
// shapes, buildings as faint blocks that only matter up close.
//
// Pure data and arithmetic: no DOM, so the tests can read it, and the tile
// renderer (js/maptiles.js) and the route painter (js/maproute.js) share it.

export const MAP = {
  land: '#1b222d',          // the ground between everything
  void: '#151a22',          // past the streamed world
  paved: '#222a36',         // car parks, squares, yards
  apron: '#262d38',
  water: '#1c4c78',
  building: '#2f3949',
  buildingEdge: '#425066',
  rail: '#566072',
  path: '#364152',          // footways, cycleways, tracks
  pedestrian: '#2f3948',    // a pedestrian zone is a place, not a line
  aero: '#3a4250',          // runways and taxiways, at their real width
  casing: '#0b1017',        // the dark edge every drivable road gets
  bridgeCasing: '#05080c',  // …a shade darker on a bridge, so it reads as OVER
};

const GREEN = {
  park: '#1f3a2c', wood: '#1a3326', grass: '#20382b', pitch: '#22412f',
  cemetery: '#21352a', bush: '#1b3326',
  beach: '#4b4431', rock: '#2c3036', mangrove: '#183023', scrub: '#233827',
};
export const greenFill = (t) => GREEN[t] ?? GREEN.grass;

// Drivable classes: fill colour, draw rank (higher is drawn on top, so a main
// road runs THROUGH a junction with a side street instead of under it), the
// default width when a way carries none, and the narrowest it may be drawn in
// device pixels at any zoom (a lane must stay a line, not a hairline).
const ROAD = {
  motorway: { fill: '#f0a24c', rank: 6, w: 22, min: 3.2 },
  trunk: { fill: '#f2b55f', rank: 5, w: 16, min: 3 },
  primary: { fill: '#efcd7c', rank: 4, w: 12, min: 2.8 },
  secondary: { fill: '#e4e8ef', rank: 3, w: 10, min: 2.6 },
  tertiary: { fill: '#cbd2dc', rank: 2, w: 8, min: 2.4 },
  unclassified: { fill: '#a7b0bf', rank: 1, w: 6, min: 2.2 },
  residential: { fill: '#a7b0bf', rank: 1, w: 6, min: 2.2 },
  living_street: { fill: '#8c97a7', rank: 1, w: 5, min: 2 },
  service: { fill: '#788395', rank: 0, w: 4, min: 1.6 },
};
// links take their parent's colour a rank under it
for (const p of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])
  ROAD[p + '_link'] = { ...ROAD[p], rank: ROAD[p].rank - 1, w: Math.min(ROAD[p].w, 8) };

export const ROAD_RANKS = 7;
/** Style of a drivable way's class (unknown classes read as residential). */
export function roadStyle(t) { return ROAD[t] ?? ROAD.residential; }
/** The width a drivable way is drawn at, in metres. */
export function roadWidthM(f) {
  const st = roadStyle(f.t);
  const w = f.w > 0 ? f.w : st.w;
  return Math.min(30, Math.max(3, w));
}

export const AERO_CLASS = /^(runway|taxiway|taxilane|airstrip)$/;
const PED_CLASS = /^(pedestrian)$/;
export const isPedestrianWay = (t) => PED_CLASS.test(t);

// ---- the route ---------------------------------------------------------------
// One blue for every surface that draws the route (minimap, world map, and the
// ribbon on the road, js/navline.js), with a dark edge so it holds over amber
// motorways and a pale core that gives it the slightly lit look of a modern
// satnav line rather than a flat marker stroke.
export const ROUTE = {
  glow: 'rgba(58, 150, 255, 0.28)',
  casing: '#0a2b5e',
  fill: '#2f8cff',
  core: 'rgba(170, 214, 255, 0.85)',
  arrow: '#ffffff',
  arrowCasing: '#0a2b5e',
  hex: 0x2f8cff,
};

// ---- zoom with speed -----------------------------------------------------------
// Standing in a square you want the doors around you; at 130 km/h you want the
// next junction before you are in it. The view radius follows speed between
// two radii, eased so a tap on the brake does not breathe the whole map.
export const VIEW_NEAR = 95;   // m from centre to rim at walking pace
export const VIEW_FAR = 190;   // …and from about 110 km/h up
export function viewRadiusFor(speed) {
  const t = Math.max(0, Math.min(1, (Math.abs(speed) - 8) / 22));
  const e = t * t * (3 - 2 * t);
  return VIEW_NEAR + (VIEW_FAR - VIEW_NEAR) * e;
}

/** Tile resolution (px per metre) for a disc of `radiusPx` device pixels,
 *  quantised so a small resize does not throw the whole tile cache away. */
export function tilePpm(radiusPx) {
  const raw = radiusPx / VIEW_NEAR;
  return Math.max(0.75, Math.min(3.25, Math.round(raw * 4) / 4));
}
