# Among The City — architecture contract

GTA-lite in three.js. A faithful replica of Pardubice built from OpenStreetMap
data (RÚIAN building footprints, real road network). The player spawns on the
forecourt of **Pardubice hlavní nádraží**, walks the real streets, enters cars
and drives. Engine DNA (postfx, sunset system, input, low-poly art direction)
comes from ../AmongTheWoods.

## Hard rules for every module

- ES modules, `import * as THREE from 'three'` (importmap → libs/three.module.js).
- Plain JS, no TypeScript. Match the AmongTheWoods code style: dense, well-
  commented prose comments explaining WHY, ~100-col lines.
- **y is up. x is east. z is SOUTH (north = −z).** Ground level is y = 0
  (Pardubice is Polabí-flat). Angles: `heading` is radians, 0 = facing −z
  (north), positive turns clockwise when seen from above (i.e. mesh built
  facing −z, `mesh.rotation.y = -heading`... NO — convention: heading 0 = −z,
  `dirX = Math.sin(heading)`... we standardize: **`dirX = -Math.sin(heading)`,
  `dirZ = -Math.cos(heading)`, `mesh.rotation.y = heading`**, i.e. a mesh
  authored facing −z and yawed by `heading` moves along (dirX, dirZ).
- Low-poly flat-shaded look, NO textures (vertex colors + solid materials),
  matching AmongTheWoods. Materials: `MeshLambertMaterial` with
  `vertexColors: true` for merged geometry.
- Merged geometry per chunk — never one Mesh per building/road segment.
- No per-frame allocations in update loops (reuse scratch vectors).

## Data: public/data/pardubice.json

Produced by scripts/build-city.mjs. Local meters around the station
(origin lat 50.03824, lon 15.75648). Compact keys:

```
{ name, origin:{lat,lon}, mPerLat, mPerLon,
  buildings: [{ o:[[x,z]...], i:[[[x,z]...]]?, h, y?, lv?, t, c?, n?, r? }],
     // o=outer ring (no closing dup), i=inner rings (holes), h=height m,
     // y=min height (skyway), t=building type, c="#hex", n=name, r=roof shape
  roads: [{ p:[[x,z]...], t:class, w, v, d, ow?, br?, ln?, n? }],
     // w=width m, v=speed km/h, d=1 drivable, ow=oneway (p direction), br=bridge
  rails: [{ p, t:"rail"|"tram", br? }],
  water: [{ o, i?, t:"water" }], waterways: [{ p, w }],
  green: [{ o, i?, t:"park"|"wood"|"grass"|"pitch"|"cemetery" }],
  paved: [{ o, t:"parking"|"plaza" }],
  trees: [[x,z]...],
  pois:  [{ p:[x,z], t, n? }] }
```

## Modules & owners

### js/config.js (done — read it)
All constants: SPAWN, CHUNK size, view radius, colors, road layering heights,
bridge deck height, car specs, speeds.

### js/geo.js (done — read it)
`loadCity(url)` → fetches + returns `city` with a per-chunk spatial index:
`city.chunks: Map<"cx,cz", {buildings, roads, rails, water, green, paved, trees}>`
(features appear in EVERY chunk their bbox touches — dedupe at mesh time via
the `_id` stamped on each feature). Geometry helpers: `pointInPolygon`,
`polygonArea`, `distPointToSegment`, `roadElevation(road, i, t)` (bridge ramps),
`chunkKey(x,z)`, `forEachChunkInRadius`.

### js/city.js (done — read it)
`class CityWorld` — streams chunk Groups in/out around a focus point.
Calls `buildChunkMeshes(city, cx, cz, mats)` from meshes.js. Public:
`update(dt, focus)`, `heightAt(x,z)`, `collide(pos, radius)` (mutates a
{x,z}, returns true if pushed — buildings + water), `ready(pos)`.

### js/meshes.js — AGENT A
```js
export function makeMaterials() → mats            // shared, called once
export function buildChunkMeshes(city, cx, cz, mats) → THREE.Group|null
```
One Group per chunk, positioned at ORIGIN (geometry in world coords is fine —
chunks are ≤ ~2 km from origin, float32 is plenty). Inside, few merged meshes:
- **ground base**: one 120×120 quad per chunk at y=0, asphalt-suburb gray-green.
- **green/paved/water polys** (holes via THREE.Shape holes): y from config
  LAYER_Y, flat color per type (config COLORS). Clip is NOT needed — polys may
  overhang the chunk; dedupe via feature._id (a feature renders only in its
  HOME chunk = chunk of its first vertex; other chunks skip it. Overhang is
  fine because neighbours stream together).
- **roads**: ribbons from polyline p with width w (miter joins, round caps via
  disc fans at endpoints), y by class from config (footways slightly above
  roads), bridges: deck at BRIDGE_Y with geo.roadElevation ramps + gray side
  skirts. Drivable roads get center dashes (thin white quads) when w ≥ 6 and
  class ≥ tertiary; crossings none (v1).
- **rails**: two parallel dark steel ribbons 1.435 m apart + sleeper quads
  every 0.8 m (merged; cheap boxes are fine at this camera).
- **buildings**: THREE.Shape (+holes) → ExtrudeGeometry depth h, translated to
  y (min height). Vertex colors: walls from palette by type/`c` with subtle
  per-building tint jitter + slight darkening toward the ground (fake AO);
  flat roof face a darker desaturated shade. `r` (roof shape) ignored in v1
  EXCEPT `gabled` on small houses (< 300 m²): add a simple ridge prism.
  Windows: NONE in v1 (flat style) — but named landmarks (n present) keep
  full saturation so they pop.
- **trees**: instanced low-poly tree (trunk cylinder + 2 stacked cones or
  icosphere crown), slight scale/hue jitter, at [x, 0, z].
Return null if the chunk index has no entry.

### js/vehicles.js — AGENT B
```js
export function makeCarMesh(colorHex) → { group, wheels: [Mesh×4] }
export class Vehicles {
  constructor(scene)
  add(kind, x, z, heading, color?) → car     // kind: 'sedan'|'hatch'|'van'
  remove(car)
  update(dt)                                  // spin wheels, settle suspension tilt
}
export function driveStep(car, ctl, dt, world)
```
`car` = { mesh, wheels, x, z, heading, speed (m/s, +fwd), steer, kind, color,
len, wid, ai: null }. `driveStep` arcade physics: throttle/brake/handbrake from
`ctl = {gas: -1..1, steer: -1..1, brake: 0|1}`; accel ~6 m/s², vmax ~38 m/s,
reverse ~8 m/s, steering angle shrinks with speed (stable at 130 km/h), light
lateral grip slide (drift factor), deceleration by drag+rolling. Collision:
sample 4 corner points against `world.collide` — on hit, push out, kill 60% of
speed, small heading bounce. Low-poly car mesh: body box + cabin trapezoid
(BoxGeometry scaled verts), dark window band, 4 cylinder wheels, headlight/
taillight small emissive boxes (overbright ~2.5 for night bloom later).

### js/traffic.js — AGENT C
```js
export class Traffic {
  constructor(city, vehicles)
  update(dt, playerPos, playerCar)
  steal(car) → removes from AI control (player takes it)
  cars → Set
}
```
Build a directed graph ONCE from `city.roads` where `d=1`: nodes keyed by
`x.toFixed(1)+','+z.toFixed(1)` of way endpoints AND interior points shared
between ways (build a point→ways multimap first; any point used by ≥2 drivable
ways or being a way end is a graph node; split ways into edges between
consecutive nodes). Edge: { pts, len, speed (m/s = v/3.6), oneway, road }.
AI cars: spawn on random edges within 400 m of player (cap ~45 alive, despawn
past 520 m), travel along edge pts with **right-hand lane offset** of
`min(road.w*0.27, 2.1)` m perpendicular to travel direction; at node end pick a
random outgoing edge (respect oneway, prefer ± straight, no immediate U-turn
unless dead end); speed = edge.speed capped by curve sharpness ahead; brake
smoothly (IDM-ish: gap/2s rule) for the car or player-car ahead within a 22 m
look-ahead cone on the same heading (±35°), full stop at 2.5 m. Elevation via
`geo.roadElevation` on bridges. Sets car.x/z/heading/speed directly (no
driveStep). Every car gets a random muted color from config CAR_COLORS.

### js/player.js + js/citizen.js — AGENT D
```js
// citizen.js
export function makeCitizen(look?) → { group, walk(walkT, speedK), parts }
// player.js
export class Player {
  constructor(scene, x, z, heading)
  update(dt, { input, camYaw, world })   // ignores input while .inCar
  pos {x,z}, heading, speed, walkT, mesh, inCar: car|null
  setInCar(car|null)                     // hides mesh, parks it at car pos on exit
}
```
Citizen: AmongTheWoods box-people style (torso box, head, arm/leg boxes with
pivot groups at shoulders/hips), ~1.75 m tall, palette (jacket/pants/skin).
walk(): legs/arms swing sin(walkT), slight bob. Player movement: WASD relative
to camYaw (W = away from camera), jog 4.2 m/s, Shift sprint 7 m/s, accel/brake
~14 m/s² for snap, heading turns toward move dir (12 rad/s), `world.collide`
with r=0.38. walkT advances with distance (walkT += speed*dt*1.6).

### js/sky.js — AGENT E
Port AmongTheWoods' *new* elevation-driven sun/sunset system into a
self-contained module (source: ../AmongTheWoods/js/main.js — solarPhase,
sunElevAt, nightAtHour, SUN_DAY/SUN_LOW/GOLDEN_TOP/SUNSET_FOG/SUNSET_SKY,
updateAtmosphere's hemi/sun intensity + fog/sky lerp; and models.js
makeSkyDome with uMoon). Public:
```js
export function makeSky(scene) → sky   // adds hemi + dir sun (castShadow) + dome
export function updateSky(sky, tod, camera, scene)  // tod 0..1; drives colors,
   // fog color (scene.fog assumed FogExp2 OR linear set by main), dome uniforms
export function sunDirOf(tod, out)     // for shadow placement in main
```
City palette: day sky #87b5e8→zenith, urban fog gray-blue; keep the sunset/
night constants. Moon included. No biome logic, no cave logic.

### js/minimap.js — AGENT F
```js
export class Minimap {
  constructor(canvas, city)
  update(playerX, playerZ, heading, cars)  // circular, north-up world,
     // player arrow rotates; roads pre-rendered once to an offscreen canvas
     // (2048², whole city, roads by class width/color + water + green), blit
     // translated so player is centered, ~90 m radius view; AI cars = dots.
}
```

### js/main.js (integrator — NOT yours, do not create)
Boot, camera (walk orbit-follow + drive chase cam with FOV kick), E to
enter/exit, clock (24 min day, start 10:30), HUD (speedo, clock, hints,
banner), postfx hookup later.

## Verification
- `npm run dev` port 5180. tests/ = node --test for geo + traffic graph.
- Browser check: load, zero console errors, screenshot at spawn shows the
  station building + streets + moving cars.

---

# v2 upgrade contract (realism pass)

## Bridges & water — REALITY FIX
Bridges do NOT hump. `BRIDGE_Y = 0.85` (config), `geo.bridgeElevation(dist,
totalLen)` returns a FLAT 0.85 deck with a 6 m blend at each way end. What
makes a bridge read as a bridge is the RIVER SUNK BELOW IT: water polygons
render at `WATER_Y = −2.0` and every water outline (outer + holes) grows a
vertical BANK skirt from y 0.05 down to −2.4 (earthy #6b5f4c). Bridge roads
get thin side railings (0.9 m tall dark strips at both ribbon edges).

## js/ortho.js — real aerial ground (ČÚZK ortofoto, open data CC-BY)
`scripts/fetch-ortho.mjs` downloads WMS supertiles:
`https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84&BBOX=<lonW,latS,lonE,latN>&WIDTH=1024&HEIGHT=1024&FORMAT=image/jpeg`
Supertile = 480×480 m (4×4 chunks), saved `public/data/ortho/<sx>_<sz>.jpg`
where sx = floor(x/480), sz = floor(z/480), covering x,z ∈ [−2400, 2400).
Convert local meters ↔ lon/lat with mPerLon/mPerLat + origin from the city
JSON. Runtime: `initOrtho()` → manager; `orthoGroundMesh(cx, cz)` returns a
120 m ground quad Mesh at y=0 with the right THREE texture + UV window (or
null when the tile file is missing → caller falls back to flat color).
Textures: SRGBColorSpace, LinearFilter, anisotropy 4, cache per supertile.

## meshes.js v2
- ground: if `mats.ortho` (an ortho manager) is set, use its quad; else flat.
  When ortho is on, SKIP green/paved fills (the photo shows them) but KEEP
  water (sunken), roads, rails, buildings, trees.
- buildings: procedural FACADES — one shared 1024² CanvasTexture atlas built
  once: a grid of window-band variants (plaster columns of lit/dark windows,
  ground-floor storefront band, panel-building seams). Walls UV-map so one
  window row ≈ one RÚIAN storey (b.lv), one window ≈ 2.7 m of wall run;
  vertex-color still tints per building (palette × jitter). Roofs stay flat
  color. `facades: false` in mats → v1 plain walls (settings toggle).

## js/audio.js
`initAudio()` (first user gesture), `sfx(name, vol)` (files from
assets/sounds/*.mp3, generated by scripts/gen-sounds.mjs via ElevenLabs —
door_open, door_close, engine_start, horn), and a PROCEDURAL engine loop:
`engineStart()/engineStop()/engineSet(speed01, throttle01)` — WebAudio graph
(2 detuned saw/triangle oscillators + lowpass + subtle noise), base 55 Hz
idle → ~190 Hz flat out, gain ducks with throttle off. `setVolume(0..1)`.
No dependency on main.js internals.

## js/settings.js — Woods-style graphics panel
`initSettings(apply)` injects a ⚙️ button (top-right) + modal (DOM built in
JS, styles injected). Persisted in localStorage `atc-settings`. Presets
low/medium/high + advanced: shadows (on/off), shadowRes (1024/2048/4096),
resScale (0.75/1/native), viewChunks (3/4/5/6), traffic (0/20/45/80),
ortho (on/off), facades (on/off), trees (on/off), mouseLook (on/off),
volume (0..1). Changing anything calls `apply(settings, changedKey)`;
preset writes all keys then apply('preset'). Defaults = medium + ortho on +
mouseLook ON. Export `getSettings()`.

---

# v3 contract (region + driving feel)

## Tiled world (agent TILES)
The world is now the whole agglomeration (~30×38 km), streamed as 4.8 km data
tiles produced by scripts/build-region.mjs from data/raw-region/*.json (one
combined Overpass response per tile — see fetch-region.mjs). Same origin
(Pardubice hl.n.), same feature format as pardubice.json plus per-tile
`signals: [[x,z],…]` (highway=traffic_signals). Output:
`public/data/tiles/<tx>_<tz>.json` + `public/data/manifest.json`
{ origin, mPerLat, mPerLon, tile: 4800, tiles: [{tx,tz,f,n}] }.
Runtime (geo.js): `loadCity(url)` detects a manifest (`.tiles`) vs the legacy
single file and returns the same `city` object either way; city gains
`ensureTiles(x, z)` → Promise (fetches+indexes every manifest tile whose
bounds come within 2600 m; incremental bucketize into chunkIndex; tiles never
unload in v3), `city.signals` (growing array) and `city.onTileLoaded(cb)`
(cb({roads, signals}) AFTER indexing). city.js CityWorld.update() calls
`city.ensureTiles(focus.x, focus.z)` (throttled ~1 s, fire-and-forget) so the
world grows as you drive. minimap.js re-renders its offscreen city bitmap
(debounced 2 s) on tile load and re-centers its world window when the player
strays >1500 m from the last render center.

## Vehicles v3 (agent VEHICLES)
`driveStep(car, ctl, dt, world, others)` — others: iterable of other cars.
- Realistic acceleration: per-kind engine curve `a = accel * (1 − v/vmax)^1.3`
  (sedan 0–100 in ~9 s), so top speed approaches asymptotically.
- Kinds with distinct silhouettes AND specs { accel, vmax(m/s), grip }:
  sedan (175 km/h), hatch (150), kombi (165), suv (160), van (130), truck (95,
  box body), bus (105, long). Muted real-world colors.
- DRIFT: lateral grip drops as steer×speed grows (progressive rear slip →
  visible countersteer slides), handbrake cuts grip hard (proper smyk).
- CAR-CAR collision: each car ≈ two circles (front/rear, r≈wid·0.62). Test
  against `others` within 12 m; on overlap separate both bodies, exchange a
  momentum impulse along the contact normal (other car gets shoved), scrub
  40-70% of closing speed, small yaw kick, set `other._rammedT = 2.5` so the
  traffic AI knows it was hit.
## Traffic v3 (agent TRAFFIC)
- `addTile({roads, signals})` — incremental graph growth: node keys are
  rounded coordinates, so cross-tile edges stitch themselves. Re-run spawn
  logic against the grown graph. Called via city.onTileLoaded (wire it in the
  constructor: `city.onTileLoaded(t => this.addTile(t))`; the initial
  city.roads array may already hold pre-loaded tiles).
- `this.maxCars` honored (settings sends 0/30/60/120); spawnR 400→460.
- TRAFFIC LIGHTS: cluster signals within 30 m → one junction controller,
  2-phase (N-S-ish vs E-W-ish by approach bearing), green 11 s / amber 1.5 s
  alternating, phase offset hashed per junction. Simple pole meshes (dark
  cylinder 3.6 m + 3-lamp box, emissive lamp of the active color) at each
  signal node, oriented to its road, added to vehicles.scene, ONE shared
  geometry+materials, state flips by material emissive swap on ≤4 Meshes per
  junction (cheap). AI: a red/amber light on the car's edge ahead → smooth
  stop 5 m short (reuse the follow-brake math); pull away on green.
- Cars with `_rammedT > 0`: AI control suspended (car keeps momentum, decays
  by friction), timer down, then re-snap onto the nearest own-edge point and
  resume driving.
- Use the full kind roster: mostly sedan/hatch/kombi/suv, sprinkle van/truck/
  bus on big roads (speed ≥ 50 km/h edges).
## Audio v2 (agent AUDIO)
Engine gains VIRTUAL GEARS: 5 ratios; rpm01 cycles 0.25→1 within a gear as
speed01 crosses its band, drops on upshift (~120 ms dip in freq+gain — the
"shift"). Richer voice: add a square osc at 2× fundamental (−14 dB), mild
frequency vibrato (~4 Hz, ±1.5 %) at low rpm for idle lope, sharper filter
response to throttle. Keep API identical (engineSet(speed01, throttle01)).
## Facades v2 + runtime ortho (agent FACADES)
- meshes.js atlas grows real variety: aged Czech plaster (subtle streaking),
  brick industrial, panel prefab with joint grid, glass storefront, sills +
  lintels around windows, window glass with sky-gradient reflections + a few
  warm lit rooms; 12+ generic variants; keep cell layout/UV contract.
- ortho.js: RUNTIME WMS (CORS confirmed working) — no local tiles: fetch
  `https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?...`
  480 m tiles at **2048 px** (0.23 m/px, 4× current detail) straight into
  THREE.Texture via TextureLoader/createImageBitmap, LRU-cache ~48 tiles
  (dispose evicted), same orthoGroundMesh(cx,cz) API, flat-color fallback
  while loading. public/data/ortho/*.jpg are DELETED (integrator does it).

---

# v4 contract (helicopter, clouds, forests, city sound)

## js/helicopter.js — AGENT HELI
```js
export function makeHelipad(x, z)                  → THREE.Group (static pad)
export class Helicopter {
  constructor(scene, x, z, heading)
  update(dt, ctl, world)   // ctl {pitch,roll,yaw,lift} each -1..1
  x, z, y, heading, mesh, rotorSpeed, airborne
}
```
Low-poly Robinson-ish: cabin (rounded box + glass band), tail boom, tail
rotor, skids, main rotor = 2 thin blades on a hub (spin by rotorSpeed, blur
to a translucent disc past ~40 rad/s). Flight model, arcade but weighty:
lift builds with rotorSpeed (spin-up ~3 s after start); collective from
ctl.lift (arrows ↑/↓) sets target climb rate ±9 m/s with lag; WASD is
pitch/roll — the machine BANKS (mesh tilts up to 0.35 rad) and accelerates
along its tilt, vmax ~62 m/s, drag pulls it back level; yaw eases with roll
so turns coordinate. Ground: y never below world.heightAt(x,z); landing
below 0.4 m of ground with descent <3 m/s settles it (airborne=false), a
harder impact just clamps. Collision: buildings via world.collide at the
fuselage radius while below 40 m. No per-frame allocation.
Heliport: `makeHelipad` = dark asphalt disc + painted H + white ring +
4 corner lights (emissive, toneMapped:false so bloom bites at night).

## clouds — AGENT SKY (js/clouds.js + a small sky.js hook)
```js
export class Clouds { constructor(scene); update(dt, camera, sunDir, nightK) }
```
VOLUMETRIC-LOOKING without a raymarch: a field of ~90 camera-facing billboard
puffs grouped into ~14 clusters drifting on the wind, each puff a soft radial
CanvasTexture sprite, cluster puffs jittered in 3 axes so a cluster reads as a
volume from any angle; sprites lit per-cluster by dot(sunDir, offsetDir) →
bright rims toward the sun, grey-blue undersides; they sit 260–420 m up, cover
±1800 m around the camera and RECENTER on it (infinite sky, no seams);
opacity/tint follow nightK. Additive-free (normal blend, depthWrite false,
fog false, renderOrder −900 so the city always draws over them).
Also: helicopters must be able to fly INTO them — no special casing.

## forests — AGENT FOREST (js/meshes.js only)
Where the data says `green.t === 'wood'|'forest'` (and large `park`), scatter
REAL trees instead of a flat green polygon: deterministic Poisson-ish points
(hash the polygon _id, ~1 tree per 55 m², capped 400/chunk-polygon), each a
2-cone-or-icosphere crown + trunk, size/hue jitter, clipped to the polygon
(pointInPolygon) AND to the chunk rect, merged into the existing per-chunk
tree InstancedMeshes. Keep the ground polygon underneath (dark forest floor).
Respect mats.trees === false. This is what makes Kunětická hora and the
Labe floodplain read like AmongTheWoods rather than green paint.

## sounds — AGENT AUDIO2 (scripts/gen-sounds.mjs + js/audio.js)
Generate via ElevenLabs (same pattern as the existing script, env
ELEVENLABS_API_KEY) into assets/sounds/: `city_ambience` (10 s loopable urban
hum: distant traffic, faint voices), `traffic_pass` (a single car passing at
speed), `horn_far`, `horn_angry`, `heli_start`, `siren_far`.
js/audio.js gains: `ambientStart()/ambientStop()` (looping city_ambience via
a GainNode, ducked while driving fast), `nearbyTrafficHum(nCars, avgDist)`
(a cheap procedural low rumble scaled by how much traffic is close — no
per-car audio), `horn()` (random of the two), and a procedural HELI rotor
loop `heliStart/heliStop/heliSet(rotor01, speed01)` (thumping LFO-gated
noise + low osc, blade-slap rate follows rotor01).

---

# v5 contract: the world map (M)

## public/data/places.json (done — produced by scripts/fetch-places.mjs)
`{ origin, mPerLat, mPerLon, places: [{ n, t, r, p:[x,z], pop? }] }` — 429
named settlements in local metres, sorted by rank r (0 city … 5 isolated
dwelling). Fetch it alongside the city; a failure must leave the map working
without labels.

## js/worldmap.js — AGENT MAP
```js
export class WorldMap {
  constructor(city, minimap)          // reads the LIVE city arrays like Minimap
  toggle(force?)  → bool              // open/close; returns the new state
  get open()                          // bool
  update(player, car, heli)           // per-frame while open: markers + HUD
  waypoint                            // {x, z} | null — main drives the HUD arrow
}
```
Behaviour (model it on ../AmongTheWoods `#bigmap` + `Minimap.drawBig`, but
this is a REGION map, not a round island):
- Full-screen overlay built in JS (inject its own `<style>`; touch no HTML).
  Dark translucent backdrop, a centred canvas that fills ~92 % of the viewport
  keeping the region's aspect, a title bar and a legend/hint line in Czech.
- Renders the whole loaded region: water, green, roads by class (thin for
  service, thick for motorway/trunk), rails, and building fill as a light
  wash. Reuse the Minimap's palette so the two read as one map. Render ONCE
  into an offscreen canvas at open, and again when `city.onTileLoaded` fires
  while open (debounced 1 s) — never per frame.
- PAN + ZOOM: drag to pan, wheel to zoom 1×…12×, double-click to recentre on
  the player. Clamp the view to the region bounds.
- LABELS from places.json, drawn biggest-rank first with a simple screen-space
  collision reject (skip a label whose box overlaps one already drawn), and a
  per-rank zoom threshold so villages only appear once zoomed in. White text,
  dark outline, a small dot at the place position; cities get a bigger dot.
- MARKERS: the player as a heading arrow, the parked helicopter as an icon,
  and the waypoint. Left-click sets/moves the waypoint, right-click clears it.
  Expose it as `.waypoint`.
- Escape or M closes; opening pauses nothing (the city keeps streaming).
- Zero per-frame allocation while open; all geometry work happens in the
  offscreen render.

## main.js integration (MINE, not the agent's)
`input.onKey('KeyM')` toggles; a HUD arrow points to `map.waypoint` with the
distance in metres, and the minimap draws the same waypoint.

---

# v5 contract (interiors, people, demolition)

Every roof in Pardubice now has rooms under it, you can walk in through a real
front door, and the helicopter carries a rocket pod that takes buildings apart
the way Teardown does. Five new modules, none of which knows about the others'
internals.

## js/interiors.js — the floor plan (pure data, no three.js)
```js
export function classify(f) → use            // 'flats'|'house'|'mall'|…
export function entranceOf(f, roads?, neighbours?) → {i,t,x,z,nx,nz,w}
export function buildingPlan(f, roads?, neighbours?) → plan   // cached on f._plan
export function hasInterior(f) → bool
export function planToWorld(fr, u, v, out)
export const USE_LABEL
```
**Classification** layers, in order: a `shop=`/`amenity=` tag from the data
pipeline (`f.u`), a BRAND table of the real Pardubice chains, name regexes, the
OSM `building=` type, then pure geometry (area × levels) for the 2 400 buildings
tagged `yes`/`no`/`roof`. Over the real data that lands 3 869 houses, 3 378
garages, 1 165 blocks of flats, 511 industrial, 53 schools, 28 supermarkets and
7 malls.

**Brands** encode the real thing, not a generic: Palác Pardubice (AFI Palác) is
three levels, 116-odd units around an atrium with a Cinema City under the roof;
Obchodní dům Prior is the 1974 department store, escalators, grocery on the
ground; Kaufland is a single ~4 200 m² hall with eight-plus tills; Lidl six
aisles, four tills and the non-food middle aisle; Penny the 2026 "Market Hall"
refit. Sources are cited in the BRANDS block.

**Layouts** are drawn in the footprint's own OBB (u along the longest edge) and
CLIPPED to the true polygon at geometry time, so an L-shape gets a plausible
plan with the overhang trimmed. `corridorLayout` (flats/school/hotel/hospital/
office/civic), `mallLayout`, `openLayout` (industrial/parking/church/garage/
supermarket), `houseLayout` (BSP). The **stair core** is the one thing that must
land inside the real outline — candidate positions are tested against the
polygon and a building where none fits becomes single-storey rather than a lie.

## js/pieces.js — plan → boxes (pure data, no three.js)
```js
export function interiorPieces(plan) → piece[]   // floors, lining, partitions,
export function shellPieces(plan) → piece[]      // stairs, rails, furniture
```
BOTH are built the moment a building is ACTIVATED — the shell is not held back
for damage. That is what makes windows real openings with real panes (you can
see into a building without shooting it) and what removes the on-hit pop
entirely: before and after are the same geometry. Each exterior BAY becomes
plaster-below-sill, plaster-above-lintel, two jambs and a pane, and every solid
one samples the exact atlas sub-rectangle the painted facade would have used —
WIN_BAND / WIN_FRAC in meshes.js are the shared agreement on where a window sits
inside a cell. Slabs subdivide at the footprint boundary so nothing pokes out
through the facade; ceilings and roofs do not (nobody stands on them).
Nothing emits a surface. Slabs are grids of TILES, walls rows of PANELS, stairs
stacks of STEPS — so a wall is not a thing that can be holed, it is forty things
that can be deleted. A tile touching a void (stair well, atrium) subdivides 4×4
so the hole stays open; getting that wrong sealed the first version's staircases
shut. The outer leaf wears the FACADE's own colour, window rhythm and AO
(`plan.wallHex`, stamped by interiorsim from `meshes.buildingWallHex`) so a
building does not change identity the instant a rocket promotes it to boxes.

## js/destructible.js — BuildingModel, Debris, Dust
One InstancedMesh per building (plus one for glass); a hit rewrites the instance
buffers and drops `count`. **Structure is a grid**: ~1.6 m cells, support
propagates DOWN a column for free and SIDEWAYS at a cost of one unit per cell
(SPAN = 6), so a wall stands, a floor plate spans ~10 m, and anything further
out falls. A second BRACING test drops splinters that have no lateral neighbours
above stub height. `_collapse` releases the condemned pieces in WAVES lowest
first, so a collapse travels through the building instead of happening in one
frame. Cost on a 12 800-piece tower: ~13 ms for the first hit (the pair-wise
graph this replaced cost 150 ms), ~2 ms after.

## js/interiorsim.js — Interiors (policy + people)
Activates the interiors of the ~8 nearest buildings while the player is on foot
(a building whose DOOR you are standing at always wins a slot and is built
immediately), keeps every wrecked building for the session, owns the shared
debris/dust pools, and answers `supportY` / `pushOut` / `occupied` / `modelAt`
for the walk controller and the chase camera. Occupants are the same box people
as the pavement crowd: they walk between the rooms of their floor, run for the
stairs when something goes off, and — if the floor is blown out from under them
— GRAB THE LEDGE and hang there before climbing back or losing their grip.

## js/weapons.js — the rocket pod (V)
Unguided, 55 m/s off the rail to 210 m/s on the motor, slight droop. Impact is
resolved by sub-stepping the flight path in 1.2 m bites against the footprint
index AND `world.solidAt` (the box models), which is what lets a second rocket
fly through the hole the first one made. `aimPoint()` runs the same integrator
ahead of time; main.js projects its answer onto the screen, so the reticle hangs
over the helicopter and slides onto the target as you nose down.

## Integration
- **city.js** owns `interiors`, and gains `supportY`, `roofY` (land the
  helicopter on a roof, walk on it), `buildingHitAt`, `solidAt`,
  `damageBuilding`, `hideBuilding` and `_rebuildBuildings` (re-mesh ONE chunk's
  building batch in place). `collide(pos, r, opts)` takes `opts.interior` (use
  the boxes) and `opts.aboveY` (a roof below you is not an obstacle).
- **player.js** has a `y` now: gravity, and a 0.55 m step-up that turns eighteen
  tread boxes into a staircase with no stair code at all.
- **meshes.js** cuts the front door into the facade and dresses it with a
  surround, a canopy and a lit sign board (two extra batches per chunk), and
  exports `buildBuildingsMesh` + `buildingWallHex`.
- **settings.js** gains `interiors` (off on Low). Wrecks survive the toggle.

## Verification
`npm test` covers classification against the real chains, "every multi-storey
building has treads you can climb", "no slab roofs over its own staircase",
piece sanity, and the door being on the footprint.

---

# v6 contract: České dráhy

The region holds 1465 rail ways (532 km) and 25 named `pois` with `t:'station'`
— Pardubice hl.n., Hradec Králové hl.n., Chrudim, Přelouč, Holice and the rest.
Trains run on that real network and the player can ride them.

## js/trains.js — AGENT TRAIN
```js
export class Trains {
  constructor(scene, city, opts)      // opts { onBoard?, onAlight? }
  update(dt, focus)                   // stream, drive, stop at stations
  nearestBoardable(x, z, r)  → train|null   // a HALTED train within r
  board(train) / alight()  → bool
  riding                              // the train being ridden, or null
  trains                              // live Set
}
```
- ROUTES, not a graph: chain rail ways whose endpoints coincide (≤3 m) into
  long polylines ONCE per streamed tile, keep routes ≥ 800 m, and drop any
  `t:'tram'`. Trains own a route + a direction and simply advance along it;
  at the end they reverse. This is far more stable than the road graph — rails
  do not need junction choice to look right.
- STOPS: a station POI within 60 m of a route point becomes a stop on that
  route. Approaching one, the train brakes to a halt, waits DWELL≈14 s with
  doors "open" (a lit strip + the door sound), then pulls away. vmax 40 m/s
  (144 km/h), accel 0.55 m/s², brake 0.9 m/s² — a train must feel heavy.
- CONSIST: locomotive + 3–5 carriages, coupled and following the SAME
  polyline offset back by their length, so the set articulates through curves
  instead of sliding as one rigid box. Bogies ride `world.heightAt`.
- ČD LIVERY: modern České dráhy — dark blue body (#12305e), a white band at
  window height, a light-grey roof, dark window strip, and the ČD red accent
  (#c8102e) on the nose. Low-poly to match the cars. Cab windows, headlights
  (emissive, toneMapped:false so bloom bites at night), and a small painted
  "ČD" plate. Carriages get the same band and window rhythm.
- STREAMING: keep ~6 trains alive within 3.5 km of the focus, spawn beyond
  600 m so none pops in view, despawn past 4 km. Zero per-frame allocation.
- RIDING: `board()` hides the player mesh and parks them in the cab; `update`
  keeps `player.pos` on the train so the camera and streaming follow it.
  `alight()` only succeeds while halted, and places the player beside the
  train clear of the track.

## js/audio.js additions — AGENT TRAIN (same agent, keep the existing API)
`trainStart()/trainStop()/trainSet(speed01)` — a procedural rolling loop:
filtered noise for wheel roar plus a periodic rail-joint clatter whose rate
follows speed, and a low traction hum. Plus `sfx()` clips generated by
scripts/gen-sounds.mjs: `train_horn` (two-tone Czech loco horn), `train_pass`,
`station_bell` (the ČD platform chime), `train_doors`.

## main.js integration (MINE)
E boards/alights a halted train the way it does cars; the HUD shows the
station name and "odjezd" countdown while stopped.
