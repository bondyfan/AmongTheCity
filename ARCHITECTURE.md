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

---

# v8 contract: the world reaches Prague

The world was a 30×38 km rectangle around Pardubice: 72 tiles, 163 k buildings.
It is now the **D11 corridor** — Prague, the motorway, the villages strung along
it, Hradec Králové and Pardubice — **185 tiles, 110 km end to end, 831 k
buildings, 245 MB**. Everything below exists because that is a different order
of magnitude, not a bigger number.

## The shape of the world — scripts/lib/world-area.mjs
A rectangle spanning Prague to Hradec would be 252 tiles, most of them farmland
nobody drives through. The world is a UNION of shapes: the original
agglomeration box, a ±8 km BAND along the D11/D35 centreline (sampled at its
junctions), and a box over Prague. `tileWanted(tx, tz)` is the single answer to
"is this tile part of the world", and the splitter, the builder and the manifest
all ask it — the world's shape is one edit away and the scripts cannot disagree.

## Getting the data — scripts/{fetch-world,split-extracts}.mjs + lib/osmpbf.mjs
Overpass was one bbox query per tile. At 185 tiles — and with Prague's density —
it answers "runtime error: the server is probably too busy" more often than it
answers data, and a clean run is hours. Replaced by four Geofabrik `.osm.pbf`
extracts (praha, středočeský, královéhradecký, pardubický; ~320 MB) and a
**zero-dependency PBF reader** (`lib/osmpbf.mjs`: varints, packed fields, zigzag
deltas, zlib blobs — the format's field numbers ARE the schema). Whole-country
parse is seconds, not hours. `npm run fetch-world` is download → split → IPR →
build → gazetteer, all re-runnable.

`split-extracts.mjs` writes `data/raw-region/<tx>_<tz>.json` in exactly the
shape Overpass' `out geom` produced, so build-region needed no new parsing —
only `"owned": true`, which says "this element is already in its one tile, skip
the first-vertex test". A raw file without the flag is an old Overpass download
and still gets tested.

## Prague's real heights — scripts/fetch-ipr.mjs + the join in build-region
OSM has a height for barely half of Prague's 447 k footprints; the rest fell
back to "2 storeys ≈ 7.4 m", which flattens Staré Město into a village. IPR
Praha publishes its own survey (CC BY): 145 123 buildings with a storey count
and a coded roof shape. The join is spatial — IPR and OSM drew the same city
twice and share no ids — an IPR centroid inside an OSM footprint is the strong
match, nearest-centroid within 9 m the fallback for courtyard blocks whose
centroid lands in the yard. **109 700 buildings** now carry surveyed storeys and
roofs. An explicit OSM `height` still wins: that is a measurement.
`h` is the wall height to the EAVES in both paths — the pitched roof above it is
geometry, so adding a ridge allowance to `h` as well would count it twice.
Attribution is required and lives in README: *datový podklad © IPR Praha*.

## Roofs that follow the plan — meshes.js `roofCap`
A village house is one ridge over one rectangle and `ridgePrism` (OBB, < 300 m²)
is right for it. Prague's blocks are 400–2000 m² and L- or U-shaped around a
courtyard, where one ridge would sail over the yard. Those get a CAP: the real
outline offset inward along each vertex's angle bisector and lifted — which is
what a hipped or mansard roof IS, and it turns every corner of the plan.
Naive offsetting folds through thin wings: measured over the real footprints,
**55 % self-intersect at full depth**, and the area/winding guards do not catch
it. So the depth STEPS DOWN (1, ½, ¼, ⅛) until `ringSelfIntersects` says the
ring is simple, the rise follows the depth that survived, and anything still
knotted stays flat. Result over the whole world: 12 310 of 13 742 pitched blocks
capped, 440 866 triangles, **zero down-facing, zero below the eaves**.

## Surviving 110 km — the engine
- **float32.** Geometry was authored in world coordinates with chunk Groups at
  the origin. At Prague (x ≈ −95 000) float32 spacing is 7.8 mm and, worse, the
  vertex shader subtracts two ~10⁵ numbers, so the city SWIMS. `meshes.rebase()`
  shifts each finished chunk to be local to its own centre and puts the offset
  in `Group.position`, where three.js computes it in float64 on the CPU. The
  shift runs on already-float32 arrays, so vertices stay snapped to that 7.8 mm
  grid — invisible on a low-poly city; it is the jitter the eye catches, not the
  snap. `city._rebuildBuildings` re-applies it to a re-meshed batch.
- **Eviction.** Tiles never unloaded. Driving the D11 end to end crosses ~50 of
  them, and holding every building would be about a gigabyte. A tile 9 km behind
  goes SLIM: buildings and trees are unpicked from the chunk index and compacted
  OUT OF THE FLAT ARRAYS IN PLACE (every consumer holds those by reference
  forever), and re-fetched if you come back. Roads, rails, water and green stay
  resident — the world map draws them, the traffic graph is built from them, and
  they are a third of the weight. Feature `_id`s are derived from the tile slot,
  not a global counter, so a building that leaves and returns is the SAME
  building (ids seed tree jitter, lamp stagger, which shed is a franchise).
  A wrecked building pins its tile: `city.keepAlive`.
- **Traffic.** Four passes answered "what is near this point?" by scanning every
  junction or every edge. Fine for 2 000 roads; for one central Prague tile's
  18 000 it is hundreds of millions of distance tests and the tab stops dead.
  All four now query a 64 m bucket grid (`Buckets`) — every radius involved is
  ≤ 45 m, so the 3×3 neighbourhood is exhaustive. This is what made Prague load.
- **Ortho** clamps to a data-shaped box, not the old ±30 km radius.

## The map — public/data/overview.json + worldmap.js
The map draws the LIVE city arrays, which over 110 km means Prague is not on it
until you have personally driven there. `build-region.mjs` also emits a sketch
of the WHOLE world — motorway→secondary roads, main lines, big water, big
forests, and built-up area as run-length-merged 200 m cells — ~3 MB, in the same
feature shape the map's own helpers take, so it goes through `_polys`/`_roads`
unchanged and live detail paints over it. `places.json` is rebuilt from the same
extracts: **2 331 named settlements** (was 429), Praha included.

## Verification
`npm test` (17 tests) still passes. Prague renders at 56–78 fps at max settings
with zero console errors; the Vltava, its bridges, the tram network and the
signals are all there. meshes.js imports in node under a `three` resolver, which
is how `roofCap` was checked over all 13 742 real pitched footprints.

---

# v9 contract: airfields and the Gripen

## The data — aeroway, at last
The pipeline never fetched `aeroway`, so both airports were blank fields with a
terminal on them. `split-extracts.mjs` now wants every aeroway way, and
`build-region.mjs` sorts them into the layers that already exist rather than a
parallel one: **runways and taxiways ride the ROAD layer** (they are polylines
with a width — which is what a road is), and aprons/helipads ride `paved`.
That buys streaming, collision, the minimap and the world map for free.

Runways carry `d: 0` so the traffic AI never routes a Škoda onto one, and the
road `width` sanity cap opens from 30 m to 90 m for aeroways or a 45 m strip
would be clamped to a bus lane. `ref` ("09/27") comes through for the paint.
What the world got: **Pardubice LKPD** 09/27, 2 499 m × 75 m, 102 taxiways,
6 aprons; **Praha LKPR** 12/30 at 3 200 m and 06/24 at 3 724 m (two ways),
182 taxiways, 30 aprons.

## The paint — meshes.js `runwayPaint`/`taxiPaint`
A runway is not a wide road, and the entire difference is paint. Three marks at
real ICAO dimensions: the 30 m / 20 m dashed centreline, the threshold "piano
keys" (30 m × 1.8 m, count scaled from the strip's width), and edge stripes set
3 m in from each lip. Taxiways get the one mark that matters — a continuous
YELLOW centreline, which is the thread that visibly ties apron to threshold.

## js/aircraft.js — Saab JAS 39 Gripen
The type the Czech Air Force actually flies. Mach 2 (2 484 km/h), 14.1 m long,
delta-canard, single fin — modelled from the three shapes that make it
recognisable at a glance and nothing else.

The flight model is deliberately NOT the helicopter's. A helicopter hangs under
a thrust vector and can stop in the air; a fighter is a dart that has to keep
moving. Velocity follows the NOSE, and everything interesting falls out of three
real relationships:
- **Top speed is not a constant.** It is where thrust meets drag, and drag
  scales with air density (`ρ = exp(−y/8500)`). Sea level tops out at
  1 410 km/h; Mach 2 costs ~12 km of altitude. Climbing IS the throttle.
- **A turn is a banked turn**, ω = g·tan(φ)/V. Roll and the heading follows;
  because V is in the denominator the turn widens as you go faster. There is no
  separate steering input in the air.
- **Control authority scales with dynamic pressure.** Parked, the stick does
  nothing; below V_ROTATE (70 m/s) the nose will not come up.

Thrust is quoted in g because that is what makes it checkable: 0.56 g dry,
1.12 g in reheat. The first cut used 4.5 g and rotated after **77 metres**,
which is a catapult — `tests/aircraft.test.mjs` exists to catch exactly that
class of drift and pins rotation speed, take-off roll, both top speeds, the
turn-rate/airspeed relationship, the stall, and the landing rollout against
Pardubice's 2 499 m.

## js/airfield.js — where the machines live
The helicopter used to sit on the station forecourt, which was convenient and
slightly absurd. `AIRFIELDS` places a pad, a helicopter and 2–3 Gripens on the
real apron at each airport. Every parking spot was chosen by testing candidate
points against the actual apron polygons and rejecting anything inside — or
within 22 m of — a building, so nothing is parked in a hangar wall.
main.js keeps flat `helis`/`fighters` lists and one rule: walk up, press E.

## main.js integration
`game.jet` beside `game.heli` (never both). The stick is W/S pitch (back = nose
up, as in every aircraft), A/D roll, arrows throttle and rudder, Shift for the
burner — deliberately not the helicopter's mapping, because a jet has no
collective and sharing a key between thrust and climb would bury the one
control that matters. The chase camera hangs 14–40 m back and widens 22° with
speed; the streamer gets `chunksPerFrame = 14` while a jet is up, because a
Gripen crosses a 120 m chunk in a sixth of a second.

---

# v7 contract: navigation

Roads carry `n` (street name) on ~23 % of ways — every named street; the rest
are service roads and footways. `public/data/places.json` holds 429+ named
settlements with a rank. Together these are enough to answer "where am I" and
"how do I get there" without any new download.

## js/navigation.js — AGENT NAV
```js
export class Navigation {
  constructor(city)
  setDestination(x, z) / clear()
  update(dt, x, z)                 // re-routes when the player leaves the path
  route                            // [[x,z]…] world polyline, or null
  remainingM                       // metres left along the route, or null
  nextTurn                         // { dist, dir: 'left'|'right'|'straight', street } | null
}
```
- Build a DRIVING graph from `city.roads` with `d === 1`, exactly the way
  traffic.js already keys its nodes (round the coordinate) so the two agree;
  grow it incrementally from `city.onTileLoaded`.
- A* over that graph, cost = length / speed (so it prefers main roads), with a
  straight-line heuristic scaled by the fastest speed in the graph so it stays
  admissible. Cap the expansion (~40 k nodes) and return the best partial路
  route if the target is unreachable — a car in a village must still get a
  line toward the motorway rather than nothing.
- Snap start and destination to the nearest graph edge, not node.
- Re-route only when the player is > 35 m from the route, and at most once a
  second: a route is expensive and a driver weaving in a lane is not lost.

## js/navline.js — AGENT NAV (same agent)
```js
export class NavLine { constructor(scene); set(route); clear(); update(dt, x, z, world) }
```
The GPS line drawn ON the road: a ribbon ~1.6 m wide following the route
polyline, laid at LAYER_Y.marking + 0.02 so it sits above the tarmac and the
lane dashes, bright cyan (#25d0ff) with a soft emissive glow (toneMapped:false
so bloom catches it), and a subtle scrolling texture offset so it reads as
"flow toward the destination". Only the next ~400 m of route is built into
geometry; rebuild when the player advances past a threshold. Fades out behind
the car. Hidden when the player is not driving.

## js/place.js — AGENT PLACE
```js
export class PlaceFinder {
  constructor(city)                        // loads places.json itself
  update(x, z)                             // throttled internally
  town     // "Pardubice" | null
  street   // "Masarykovo náměstí" | null
}
```
- Street = the nearest `city.roads` way with a name whose distance to (x,z) is
  under (w/2 + 12) m, searched through the chunk index (never the whole array).
- Town = the nearest place from places.json, weighted by rank so a city wins
  over a neighbourhood at similar distance; report nothing past ~4 km.
- Both are sticky: a name only changes after the new one has held for ~0.6 s,
  so walking a junction does not flicker between two streets.

## Labels on the maps — AGENT LABELS
- `js/minimap.js`: draw street names along the road they belong to, inside the
  circular clip, only for roads whose class is >= residential and only when
  the name fits the drawn length; rotate the text to the road's angle, keep it
  upright (flip if it would read upside down), and cap the number drawn.
- `js/worldmap.js`: the same, at map scale — street labels appear from zoom
  >= 3, with the same collision-box rejection the place labels already use.

## main.js (MINE)
A HUD readout bottom-left showing town + street, and the destination handed to
Navigation whenever the world map's waypoint changes.

## Chunks are meshed off the main thread — js/meshworker.js + js/meshpool.js
A dense Pardubice chunk is 30–330 ms of geometry. Slicing the builder against a
frame budget spread that cost out; it never removed any of it. Now the work
happens in a pool of `hardwareConcurrency − 1` module workers (capped at 4) and
the frame's share is a spec and a decode.

    js/chunkspec.js   the INPUT codec: one chunk's cells, junction pads,
                      waterways, pois, hidden set, terrain + canopy rasters and
                      the ortho plan, as plain data postMessage can clone.
    js/meshworker.js  buildChunkPayload(state, spec) → geomcodec bytes. The
                      message handling is a pure (state, msg) function so node,
                      which has no DOM Worker, can test the real code.
    js/geomcodec.js   the OUTPUT codec (already there): one transferable
                      ArrayBuffer per chunk.
    js/meshpool.js    the main-thread half: submit / poll / finish, plus every
                      road back to the synchronous builder.

Measured over the ten densest chunks of central Pardubice with facades on:
**79.5 ms → 3.85 ms of main thread a chunk (20.6×)**, worst chunk 179 ms → 4.1 ms.
With the aerial photo on (a cheaper ground) 41.8 ms → 3.8 ms.

Three things a worker cannot build, because each is painted on a `<canvas>`:
the facade window atlas, the brand wordmarks and the aerial photo material. All
three are handled by NAMING rather than by switching off — the geometry comes
back with its atlas uvs and a material key, and the main thread resolves the key
to its own singleton (`facadeMaterial`, `brandMarkMat`, the ortho plan's `mat`).

Two invariants worth knowing before touching js/city.js:
- **A key in `_inflight` is being built and is in neither `built` nor the
  queue.** The Map holds every flight; the ring scan, `_requeueCells`,
  `_dropTileChunks` and `_rebuildBuildings` all consult it.
- **At most one flight is synchronous.** It is a generator pumped against the
  frame budget, and two of those would divide the budget rather than spend it.

The fallback is not decorative. Under vite the bare `three` specifier resolves
for workers as it does for the page; opening index.html straight off disk, the
`<script type="importmap">` does NOT cover workers, so the worker fails to load
— and every chunk is built the old way. Same road out for a browser with no
Worker, a postMessage that throws, or three failed builds in a row.

No SharedArrayBuffer: it needs COOP/COEP, and `require-corp` would break the
ČÚZK ortophoto WMS (no CORP header) — the photos would silently stop loading.
The rasters are copied and transferred instead, once per worker per tile, with
a version bumped whenever the earthworks reshape a height grid in place.

# v10 contract: the city speaks

The crowd has been walking past the player since v5 and had never once noticed
they existed. You could clip a man with a wing mirror at fifty and he would get
up and keep walking. This contract gives Pardubice a mouth: **314 authored
Czech lines**, spoken aloud and shown in a bubble over the speaker's head.

## The four files, and why it is four and not one

    js/chatterlines.js   PURE DATA. 240 lines + 24 two-handers (74 turns), the
                         four-voice cast, and the id→filename rules. No imports.
    js/chatter.js        THE BRAIN. Who speaks, when, about what, and the rate
                         limits that stop it becoming a market. Imports only
                         the corpus, worldclock and audio — never three.js, so
                         it is testable headless.
    js/chatbubbles.js    THE RENDERER. A sprite with a canvas texture. No
                         timers, no policy; it is handed a list of live
                         utterances once a frame and draws them.
    scripts/gen-voices.mjs  Renders every line to mp3 through ElevenLabs.

The split between the brain and the renderer is what makes `tests/chatter.test.mjs`
possible: 31 assertions about casting, gender, cooldowns and conversation
lifecycle, with no canvas, no WebGL and no AudioContext in the process.

## The corpus

Twelve categories, each a situation: `nearmiss` `horn` `bump` `hit` `victim`
`bang` `driver` `player` `idle` `local` `tod` `phone`. Plus the two-handers.

**Point of view is part of the category.** `horn` and `hit` are pools chatter
only ever hands to a *pedestrian*, so lines written from inside a car ("Zhaslo
mi to, no!", "Já ho neviděl, vběhl mi pod kola!") were coming out of a
passer-by's mouth — seven of them, caught by review. They live under `driver`
now, and a test guards the property rather than the individual lines. `victim`
is the four lines the person **you** knocked down says once they are back on
their feet: `pedestrians.js` puts a survivor through rag → down (2–4 s on the
tarmac) → walk, and chatter watches for that state to come back round, because
"Bolí mě hlavně hrdost" from a man still in the air is a joke told too early.

**A line's `id` IS its filename.** `assets/voices/<id>__<cast key>.mp3`. Ids are
ASCII-only (a diacritic in a filename is a 404 waiting for a case-folding
difference between macOS and Linux — one was caught by the test) and may be
added freely but never renamed: a rename orphans a rendered file and bills a
new one.

`when` gates a line on `worldclock.tod()` — `morning` `noon` `evening` `night`.
The weather values (`rain` `cold` `hot` `fog`, 16 lines) are deliberately
present and deliberately dead: this build has no weather, so nothing can
satisfy them and those lines never play. They are written, rendered, and
waiting for the day sky.js grows a rain cloud.

## The cast is four, and a citizen keeps their voice

Two men, two women. **Every line is rendered by every cast member who could say
it** — 898 clips — and that is what buys the property worth having: a citizen's
voice is `hash32(seed)` off the same integer that already picked their jacket,
so it never changes between sentences, holds across both halves of a
conversation, and is the same voice on a co-op partner's machine. A per-person
pitch offset of ±7 % on top of four recordings is what stops forty walkers
sounding like four people. Nothing about the box people is gendered, so `g` is
a voice attribute and not a claim about the character.

## Distance has to FILTER, not just attenuate — js/audio.js `speakAt()`

`sfxAt()` was the wrong tool and the reason is physical. A bang forty metres
away really is mostly a quieter bang; a *voice* forty metres away has lost its
consonants. So a spoken line gets four things off the one distance number:

| | at your elbow | at 42 m |
|---|---|---|
| gain | full | the same 1/r law every other cue uses |
| lowpass | 16 kHz | **1.1 kHz** — this is what "far" actually sounds like |
| highpass | 20 Hz | 300 Hz — distance takes the chest weight out too |
| reverb send | 0 | 0.55 into a shared 1.1 s convolver, tapped *after* the filtering |

Range is **42 m** and that is content, not mixing: past that you cannot make out
words on a real street, and a readable bubble over an unintelligible voice is
worse than silence. What fills in beyond it is already in the mix —
`city_ambience.mp3` is, by its own generation prompt, "faint indistinct
murmuring voices far off". **Polyphony is 3.** A buffer name prefixed `v/`
routes `loadBuffer` to `assets/voices/` instead of `assets/sounds/`; that one
prefix is the whole integration.

## Determinism, and its limits

**Ambient is deterministic. Reactions are local.**

Which line a citizen says in a given 8-second slot is `hash32(their seed, slot)`
— no `Math.random` on that path, so two players on the same corner hear the same
sentence. What stays local is whether you were near enough to hear it, because
the budgets are about your ears and not about the world. Reactions are local
outright, exactly as the traffic horn is (traffic.js:2291) and for the same
reason: the event that caused them happened on one machine. Speech never moves
anybody, so local divergence is survivable here in a way it would not be for
the walk itself.

`pedestrians.js` gained one field for this: **`pid: s.seed`** on the body at
`_attach`. `_cutLoose()` nulls `sch`, and being run over or ghosted is exactly
when a body most needs to still be somebody.

## The rate limits ARE the design

The failure mode of this feature is not silence, it is a market square: eight
bubbles, three overlapping voices, and a player who switches it off in a minute.

- one ambient line near you every ~5 s, never the same sentence within 45 s
- at most 2 conversations running
- a 16–28 s cooldown per person, a 0.85 s global floor between reactions
  (armed by reactions only — a mutter is not an event and must not spend an
  event's budget, which was costing about one reaction in six)
- at most 2 witnesses answer any one event
- 10 bubbles drawn at once, hard cap (legibility, not performance)
- and under all of it, audio.js's three voices

Every cooldown here is an **absolute deadline**, not a countdown. The first
version copied `pedestrians.js`'s `hitCd` idiom — stamp a duration, test `> 0` —
but pedestrians.js decrements `hitCd` in its walk loop and nothing ever
decremented ours. A citizen who said one word was mute for the rest of their
420-second life, the busiest street went quiet after a minute, and every test
still passed, because "he does not speak twice" is what a working cooldown
looks like from the outside too. A timestamp cannot rot: no per-frame pass to
forget, no question about who ticks whose field. `tests/chatter.test.mjs` now
asserts the cooldown **ends**, which is the assertion whose absence hid it.

## Wiring (main.js, MINE)

    peds.onPedHit    → chatter.pedHit()      (and the scream now uses the
                       SAME seed as the speaking voice, so the person who
                       yells is the person who talks)
    peds.panic       → chained, so every present and future panic source
                       (weapons, corpses) feeds chatter.bang() for free
    city.crashDebris → chained: a car folding round a lamp post is the best
                       thing that can happen to a bystander's day
    traffic.onHonk   → new single-slot sink, fired from BOTH honk sites

**H is the horn**, and it is new: the AI has been honking at the player since v7
and the player could never honk back. It goes through the same sink as an AI
honk, so a pedestrian cannot tell who leaned on it.

`chatter.update()` runs **after `updateCamera()`**, not next to `peds.update()`.
Bubbles are screen-referred sprites scaled off view distance, so pumping them
before the camera moves sizes every one of them against last frame — visible as
a bubble that lags a hard corner.

## Generating the voices

    ELEVENLABS_API_KEY=sk_... node scripts/gen-voices.mjs

904 clips, ~26 000 characters, `eleven_v3` with `language_code: 'cs'`. Each
line's `tts` field (an English delivery direction) is prepended as a bracketed
tag — **verified by transcribing the output that v3 shapes the delivery without
speaking the tag**. `stability: 0.35` is what lets a shout be a shout; the
default sits the model in its audiobook register, which is the most common way
street dialogue comes back sounding like a museum guide.

Only missing files are billed. Concurrency is **3**: at six, a Creator-tier key
answers ~180 clips and 429s the other 720 — measured. 429 and 5xx retry with
jittered exponential backoff; a non-429 4xx fails immediately, because waiting
does not fix being wrong. `--stale` deletes orphaned mp3s.

**Editing a line's text does not orphan its mp3** — same id, same filename — so
the bubble would read one sentence while the voice said another. Delete those
by hand or `FORCE=1`.

## Verification

    npm test          # tests/chatter.test.mjs — 38 assertions

The one that matters most is *"every line a citizen can say has a clip rendered
in their own voice"*: it walks 270 seeds × 240 lines and asserts the file the
game will ask for is one the generator was told to produce. Nothing else in the
build connects those two halves, and a mismatch is inaudible rather than loud.

---

# v11 contract: the shops have their real names

Until this contract the pipeline threw away **every named shop and eatery node
in the country**. `scripts/split-extracts.mjs` kept four amenity values
(`fuel|hospital|police|fire_station`) and the string `shop` did not appear in
the file at all, so the loss happened at stage 1 and nothing downstream could
have recovered it even in principle — measured in the product, not the extract:
`grep -c McDonald data/raw-region/0_0.json` was **0**.

What the game did instead was **invent** the missing trade. `js/interiors.js`
`stampFranchises()` picked buildings by hash near a station or a hypermarket car
park and renamed them McDonald's or KFC. Meanwhile the real McDonald's
(node/13970695060, 241 m from the origin), the real Lidl (node/3394785494), the
real Česká pošta (node/12569453187) and the real coraHB (node/13634813428) stood
within 450 m of Pardubice hlavní nádraží and reached nothing.

Measured over the six extracts inside the world mask, node ids deduplicated:
shop 19 317 (16 559 named), restaurant 5 603 (5 302), cafe 1 809 (1 704),
fast_food 1 778 (1 500), pharmacy 1 094 (1 044), post_office 1 075 (1 060),
bank 608 (594) — **31 284 nodes, 27 763 of them named, and the pipeline kept
zero.** Full survey: `docs/OSM-COVERAGE.md`.

## scripts/lib/venues.mjs — ONE definition, two scripts

The splitter must keep the node and the builder must emit it, and the two must
never disagree about the tag list again, so both import the same module.

    venueKind(tags)  → the OSM value that says what a place SELLS, or null.
                       shop=* (minus no/vacant/closed), a named list of
                       amenity=*, tourism=hotel|museum|attraction, and office=*
                       collapsed to one 'office' (its 73 values look identical
                       from the street and the tiles are committed to git).
    venueName(tags)  → name ?? brand. NOT operator — on Czech data that is
                       mostly "Česká pošta, s.p." bolted onto street furniture.
    isVenue(tags)    → both of the above. The wantNode/wantWay clause.
    joinVenues(buildings, venues) → hangs each venue on the footprint it stands
                       in; MUTATES `n` and `u`; returns the claim statistics.

## THE JOIN IS A BUILD-TIME JOIN

OSM maps a shop three ways — tags on the building way, a node inside the
footprint, or a node in the doorway — and only the first ever reached a tile.
`scripts/build-region.mjs` now resolves the other two **per tile, offline**:

- INSIDE wins, and the **smallest** containing footprint wins, so a bakery
  inside a gallery names the unit it was drawn in and never the whole gallery.
- BESIDE (≤ 10 m) is the fallback for a doorway node, and only onto an unnamed
  building under 2 000 m² and 12 m tall. That gate is what stops a bistro
  renaming the eight-storey block it occupies the corner of.
- A surveyed building name ALWAYS outranks a POI node standing in it.
- Several venues in one block resolve by trade rank (a supermarket defines a
  building, the accountant on its third floor does not), then by name order, so
  the answer never depends on the order the PBF stored two nodes in.

Measured on the two Pardubice tiles (`-1,-1` and `0,-1`, 15 339 buildings):
1 384 venues landed inside a footprint, 25 in a doorway, **641 buildings took a
real OSM name**. Named buildings 721 → 1 362. Buildings wearing a fascia
200 → 706, of which the fascia shows the building's **own OSM name** 61 → 584.
New use classes that no guess could ever have produced: restaurant 0 → 125,
supermarket 23 → 62, school 59 → 89, hotel 18 → 26. Tile cost **+1.4 %**.

## The tile format gains one layer

    venues: [{ p:[x,z], t:kind, n:name, b:brand? }]

…and buildings gain `u`, the shop/amenity value. `js/interiors.js` `classify()`
had read `f.u` since v7 and **no build script had ever written it**.

A venue whose name is now ON a building is dropped from the layer — the same
string twice is the one cost this change does not have to pay. What ships is
the trade no footprint absorbed: a block's other tenants, the units inside a
gallery, a stall on a market square. `js/geo.js` bucketizes them by chunk (not a
flat list — `evictFar` gives back buildings and trees and nothing else, so a
linear scan would grow for as long as the session runs) and `venueAt(city, x, z,
maxD)` reads one 3×3 of cells. The on-foot HUD hint asks it when nothing
actionable is in range: 🏪 Sportisimo.

## `u` describes the GROUND FLOOR

The one place the trade must not win is Czech mixed use. A potraviny in the
corner of a panelák is a potraviny, not a five-storey supermarket — and it would
be, because `shop` is promoted past 900 m² and `restaurant` is laid out as a
single open volume, so the block would come out one storey tall. `classify()`
therefore refuses to let `u` retype a building OSM explicitly typed as housing,
and `signBrandOf()` reads `u` on its own so the shop still gets its fascia.

## What was deleted

`stampFranchises()`, `anchorsOf()`, `FRANCHISES`, `HOST_USES`, `HOST_TYPES`,
`ANCHOR_R`, the `_frAnchors` / `_frServed` caches on `city`, `CityWorld._stamped`
and its two call sites, and the three tests that pinned the guess's behaviour.
The `BRANDS` table stays: it is the LOOK of a chain (wall colour, cladding,
storey rules), and it is now keyed off a name that came out of OSM.

## Verification

    npm test          # tests/venues.test.mjs — 8 assertions

`tests/fixtures/pardubice-hlavni-nadrazi.json` is 45 kB of **verbatim stage-1
output** — every building way and every shop/amenity/office/tourism node in a
600 × 260 m box on the world origin, at OSM's own coordinate precision — because
`data/raw-region` is 2.1 GB and gitignored. The test that matters asserts the
McDonald's by Pardubice hlavní nádraží comes from **node/13970695060** and lands
within 40 m of where the surveyor put it (measured: 5 m). If the extraction
filter ever loses the shops again, that is the test that says so.

## Regenerating the world

    node scripts/split-extracts.mjs      # ~6 min, rewrites data/raw-region/
    node scripts/build-region.mjs        # HOURS, rewrites all 342 tiles

Both are required — the names are lost at stage 1, so rebuilding tiles alone
changes nothing. `--tiles=-1,-1 0,-1` rebuilds a subset, but note it also
rewrites `overview.json` from only those tiles, so it is for scratch `OUT_DIR`
runs and never for `public/data`.


# v11 contract: the crowd stops being one person

The city had ONE body — eleven boxes, 1.75 m tall, and only the palette changed
between them. The user's word for it was "Minecraft". Five bodies now walk
around Pardubice, and the whole design rests on one observation: **at twenty
metres the eye reads structure, not colour.** Fifteen centimetres of height, a
narrower shoulder, a stoop and a walking stick are legible down a street; a
different jacket is not.

## js/people.js — the third module that exists so two others can agree

    m30  1.78  28 %   the default bloke
    f30  1.69  26 %   narrow shoulders, waist, long hair
    f60  1.63  18 %   shorter, fuller waist, bun, hip-length coat
    m60  1.76  20 %   heavier, greying, shorter stride
    m90  1.67   8 %   stooped, thin, slow, walking stick

It imports **nothing** — not three.js, not the clock — and that is its purpose.
`js/citizen.js` builds the mesh and therefore needs three; `js/chatter.js` picks
the voice and must never touch three, or the headless tests die. A grandmother
has to *sound* like a grandmother, so both have to draw the same archetype from
the same seed, and the only way to guarantee that without one importing the
other is a third module that imports neither. `ARCH_SALT` lives there for the
same reason: a constant two modules must agree on belongs to neither of them.

The weights are not uniform on purpose — a ninety-year-old on a stick is
something you notice *because* it is rare. Uniform weights put one in five.

## The model got better and got CHEAPER

|                | old | new |
|---|---|---|
| meshes per body | 15 | **13** (14 with a stick) |
| materials | up to 5 | 1 shared + limbs |
| geometry | all shared | shared limbs + one ~9 kB cluster per body |

Everything that does not articulate — head, hair, eyes, pupils, nose, mouth,
neck, chest, waist, shoulder yoke, hips, coat — is **merged into one mesh with
vertex colours**, drawn with a single material every citizen in the world
shares. (The old header claimed eleven meshes; it was counting the eleven
*children* of the body group, four of which were pivot Groups holding two
meshes each. Measured with a traverse, the old figure drew fifteen.)

That merge is what pays for the detail: **static boxes are free**. The torso is
four boxes (hips → waist → chest → shoulder yoke) instead of one slab, because
a waist narrower than the chest and shoulders wider than both is the entire
difference between a person and a wardrobe. The head gets a nose, a mouth, and
hair that *wraps the skull* rather than sitting on it as a lid — a flat slab on
top of a cube leaves a cube, and that was the last thing still reading as
Minecraft after the shoulders landed.

The price is one per-instance BufferGeometry, so `dispose()` is no longer
optional bookkeeping — it is what stops a 24/7 room leaking VRAM as walkers
come and go.

## Joints, and where a stoop actually bends

The old figure had a one-piece arm and a one-piece leg, so the walk was two
pendulums. There is now an **elbow and a knee**, and the knee is most of the
improvement: a leg that folds under the body on the back-swing is the strongest
single cue that something is walking rather than being slid along the pavement.
Flexion peaks a quarter-cycle after the thigh reaches its rearmost point and is
clamped positive, because a knee bends one way only.

A `torso` group at hip height carries the upper body and the arms. `stoop` used
to be applied to `body`, whose origin is the **feet** — so an old man's bend
rotated the whole figure about his ankles and he leaned forward like a plank
with his legs in line with his spine. Bending at the hip with the legs left
vertical is what a stoop is. His stoop is 0.17 rad and not the 0.22 it was first
drawn at: the head rides in the same merged mesh as the chest, so it tips with
the back, and past about a fifth of a radian he is looking at the pavement and
the face stops being visible from street level.

## The voice follows the body

`voiceOf()` used to flip its own gender coin. That was fine while every citizen
was the same box and became wrong the moment there were five: a stooped
ninety-year-old would open his mouth and a young woman came out. Archetype
first, voice second, both off the same seed through the same salt:

    m30 → m1   m60 → m2   m90 → m2 (pitched a further −6 %)
    f30 → f2   f60 → f1

The mapping uses the cast that already existed, so **all 904 clips stayed valid
and nothing was re-rendered**. `pedestrians.js` also stamps `headTop` on each
body, and `chatter.js` hangs the speech bubble off *that* rather than a constant
— the five archetypes span 15 cm, which is exactly the amount that makes a fixed
1.75 m assumption look like a bug.

The hero and every peer stay on the default adult, deliberately: they come
through the uid path, their name tags and seat anchors were measured against a
1.75 m figure, and turning somebody else's avatar into a pensioner is not
`makeCitizen`'s decision to make.

## Also tuned

Drivers got their own 4.5 s floor (`DRIVER_CD`) on top of the general reaction
gap. Stand in the road, traffic.js piles up a queue, every car in it passes the
`heldT` test — and at the shared 0.85 s floor four of them shouted inside four
seconds. Screenshotted, that is a mob with two bubbles overlapping illegibly.
The queue is the joke; the volume is not.

# v13 contract: the road under the wheels

The complaint, verbatim: *"Když jedu v Tesle, která je elektro, tak to jenom
hučí jako vysavač, ale neslyším žádnou jízdu, jako zvuk jako kol, že se točí."*
And: *"Trošku víc realističtější ten smyk, ať se to fakt víc smýká, ať je to
fakt jako v nějakém GTAčku."* Four things came out of it — new recordings, a
banded playback layer, a real tyre model, and rubber left on the road.

## The bands, and why they were measured before they were trusted

`scripts/gen-sounds.mjs` grew twelve entries: three tyre-roll loops on asphalt,
two on gravel, three of airflow, two skid loops, and the two transients
(`skid_chirp`, `skid_bark`) that a loop faded up from zero cannot supply.

`js/audio.js` already carried a hard-won warning about exactly this shape of
asset — the four `eng_*` rpm bands came back with spectral centroids of
169–208 Hz and *no monotonic trend*, so crossfading them would have been
crossfading a sound with itself. The lesson taken from it was not "never band"
but **"write the bands to differ in KIND, then measure"**:

| clip | rms | centroid | <250 Hz | >2 kHz |
|---|---|---|---|---|
| `roll_asph_low`  | 0.077 | 321 Hz  | 79.6 % | 1.9 % |
| `roll_asph_mid`  | 0.193 | 810 Hz  | 47.9 % | 5.7 % |
| `roll_asph_high` | 0.192 | 1432 Hz | 35.1 % | 15.3 % |
| `wind_car_low`   | 0.183 | 792 Hz  | 60.0 % | 8.2 % |
| `wind_car_mid`   | 0.195 | 681 Hz  | 62.7 % | 5.6 % |
| `wind_car_high`  | 0.353 | 367 Hz  | 81.8 % | 3.4 % |

The roll ladder climbs (countable tread patter → fused hiss → hard sizzling
roar) and the wind ladder deliberately *descends* in brightness while climbing
in level, because that is what air does: a thin rush at town speed becomes a
deep pounding wall at two hundred. `roll_asph_high` had to be written twice —
the first version asked for "a bright roar sizzling on top with a heavy rumble
beneath", got only the rumble, and measured 521 Hz, i.e. duller than the band
below it. **Accelerating would have sounded like slowing down.** Offering the
generator two characters and letting it choose is the mistake; naming the one
you want and forbidding the other is the fix.

`car_wind` survives and is demoted. Measured, it is almost pure low buffeting
(centroid 123 Hz, 96 % under 250) — a superb bed and a poor portrait of speed —
so it keeps gusting underneath at two thirds of its old level while the three
bands carry what changes.

## bandLayer — one crossfader, three users

`audio.js` gained a small shared machine rather than three copies: `[name,
vRef]` ascending, weight is a tent over the ladder (only ever two bands audible)
taken to **sqrt for equal power**, and each audible band's `playbackRate` tracks
`v / vRef` inside a clamp. A linear crossfade between two uncorrelated noise
sources dips 3 dB in the middle, and that hole lands at exactly the speed you
spend most of your time at. A missing clip falls back to `noiseBuffer()`, the
bargain `rwindBuild` already struck: a bare checkout must still make a noise
when it moves. Cost: ~16 MB of resident decoded PCM once the player first
drives, on top of what `chatter.js` already holds.

## The tyre model (js/vehicles.js `tyreStep`)

The old model was a kinematic bicycle: heading changed instantly with the wheel
and a scalar `_lat` was spawned from the heading change and exponentially
damped. It has no memory, so the car could not be pointed one way and travelling
another for any length of time, and countersteer did nothing recognisable
because there was no rotation to catch.

The replacement is the standard bicycle with real lateral forces and **yaw rate
as an actual state**: slip angle per axle, a simplified Pacejka curve
(`sin(C·atan(B·α))`, peak near 8°, falling to ~0.6 of peak — the falling tail is
the whole reason a drift can be *held*), yaw acceleration from the two moments,
longitudinal load transfer, and a friction circle split by pedal (drive 75 % to
the rear, brakes 65 % to the front). Everything is in **specific** force so
`KIND.mass` keeps meaning what its comment says: a ratio for collisions only.

Three details that are not decoration:

* **It runs at `SUB_DT = 1/120` regardless of the frame.** `stepGame` hands
  `driveStep` up to twenty steps of 1/20 s after a hidden tab, and a stiff tyre
  model integrated at 20 Hz oscillates and then spins the car.
* **Below `KIN_V` the kinematic constraint is blended back.** Real tyres do not
  slip at parking pace; they roll, and geometry alone sets the yaw rate. The
  force model's forces vanish with speed, so without this a car parks like a
  boat.
* **`car.speed` still means exactly what it meant** — signed m/s along the nose
  — because nine consumers outside `vehicles.js` depend on it.

Measured against the numbers the old model was tuned to: 0–100 km/h in 5.67 s
(the spec in the KIND comment says ~5.7), 0.64 g corners clean and silent,
a handbrake flick at 22 m/s reaches 79°/s of yaw and 90° of body slip,
countersteer takes a 63° slide back to under 2°, and dt = 1/20 with full lock
and handbrake stays finite and bounded.

### The trap the slide sprang

A sliding car reports `|car.speed| ≈ 0` while travelling 25 m/s sideways. The
old model made real slides rare enough to hide what that breaks; this one does
not. `car.vGround` is published alongside and now feeds the **speedometer**, the
**wall-impact damage**, the **pedestrian run-over test**, the **tyre and wind
audio** and the **speed streaks** — a car arriving at a wall out of a drift used
to hit it for free. The engine is the one correct exception: revs follow the
wheels, which roll forwards.

`car.offroad` was also being NaN'd by `undefined += …` on any hand-built car.
Every reader compared it (`> 0.05`, always false) and comparisons swallow NaN
silently; the tyre model *multiplies* by it, so the same latent bug went from
invisible to fatal on the first frame.

## js/skidmarks.js

One mesh, one preallocated indexed geometry, a ring of 2400 quads = four
independent wheel tracks of 600 segments each. It follows the **navline.js**
ribbon idiom (cut once at maximum size, drawn through `setDrawRange`, faded
through a per-vertex RGBA attribute) and not the pedestrians.js blood idiom,
because a pool sharing one material fades every decal at once — blood hit that
wall and had to sink corpses instead of fading them.

Four tracks rather than two: in a slide the front wheels point somewhere quite
different from the rears, and four crossing arcs is most of what makes a mark
read as a mark. Colour and lift come off the surface — near-black rubber at
+3.5 cm on tarmac, turned-over earth at +7.5 cm on soft ground, where grass.js
plants blades at +5 cm and would otherwise swallow the gouge. Height comes from
`world.surfaceY(x, z, car.y).y`, never `terrain.heightAt`: the `near` argument is
what keeps a mark under a flyover from snapping up onto the deck.

Emission is gated on **distance travelled**, never on frames, for the same
twenty-substeps reason as above, and the threshold is `SLIP_MARK`, exported from
`vehicles.js` so the marks and `SKID.on` in `audio.js` cannot disagree about
when a skid started. 3 m/s of scrub, not less: a brisk main-road bend runs 2.4,
and rubber through every fast corner is wallpaper rather than a skid mark.

The pool cap **is** the memory bound. `city.js` unloads only the chunks in its
own `built` map, so these outlive the street they were painted on — which is
what we want, and also why an unbounded emitter would leak forever.
